import express from 'express';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URL).then(() => console.log("✅ MongoDB Connected"));

const UserSchema = new mongoose.Schema({ phoneNumber: String, sessionString: String });
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

let activeClient = null;
let loginData = { phone: '', phoneCodeHash: '', otp: '' };

// Client creation helper
const getClient = (session = "") => {
    return new TelegramClient(new StringSession(session), apiId, apiHash, {
        connectionRetries: 15,
        useWSS: false, // Network error ရှောင်ရန်
        deviceModel: "TG Cloud Production",
    });
};

app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        loginData.phone = phone;
        activeClient = getClient();
        await activeClient.connect();
        const result = await activeClient.sendCode({ apiId, apiHash }, phone);
        loginData.phoneCodeHash = result.phoneCodeHash;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { code } = req.body;
        loginData.otp = code;
        try {
            await activeClient.invoke(new Api.auth.SignIn({
                phoneNumber: loginData.phone,
                phoneCodeHash: loginData.phoneCodeHash,
                phoneCode: loginData.otp,
            }));
            const sessionString = activeClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: loginData.phone }, { sessionString }, { upsert: true });
            res.json({ success: true });
        } catch (err) {
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') return res.json({ success: false, requiresPassword: true });
            throw err;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password } = req.body;
        await activeClient.start({
            phoneNumber: async () => loginData.phone,
            password: async () => password,
            phoneCode: async () => loginData.otp,
            onError: (err) => { throw err; }
        });
        const sessionString = activeClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: loginData.phone }, { sessionString }, { upsert: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Files list & Download Streaming
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "No Login Found" });
        const client = getClient(user.sessionString);
        await client.connect();
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        res.json(messages.filter(m => m.media).map(m => ({ id: m.id, text: m.message || "File", date: m.date })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = getClient(user.sessionString);
        await client.connect();
        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        res.setHeader('Content-Type', 'application/octet-stream');
        for await (const chunk of client.iterDownload({ file: messages[0].media, chunkSize: 512 * 1024 })) res.write(chunk);
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Production Server on port ${PORT}`));
