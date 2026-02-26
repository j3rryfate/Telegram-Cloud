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

// Global state for 2FA handling
let tempClient = null;
let currentPhone = '';
let currentHash = '';

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        currentPhone = phone;
        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
        await tempClient.connect();
        
        const result = await tempClient.sendCode({ apiId, apiHash }, phone);
        currentHash = result.phoneCodeHash;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Handle 2FA (Manual Invoke Way)
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { code } = req.body;
        try {
            // Manual SignIn invoke - version တွေကြားမှာ syntax မကွဲနိုင်ပါ
            await tempClient.invoke(
                new Api.auth.SignIn({
                    phoneNumber: currentPhone,
                    phoneCodeHash: currentHash,
                    phoneCode: code,
                })
            );
            
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: currentPhone }, { sessionString }, { upsert: true });
            res.json({ success: true });
        } catch (err) {
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({ success: false, requiresPassword: true });
            }
            throw err;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. 2FA Password Verification
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password } = req.body;
        // 2FA အတွက် helper function ကို သုံးပါမယ်
        await tempClient.signInUserPassword(password);

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: currentPhone }, { sessionString }, { upsert: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Password မှားနေပါသည် - " + err.message });
    }
});

// --- Files List & Download (Streaming) ---
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "Please login!" });
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || "File",
            date: m.date
        }));
        res.json(files);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        
        res.setHeader('Content-Type', 'application/octet-stream');
        for await (const chunk of client.iterDownload({ file: messages[0].media, chunkSize: 512 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(8080, () => console.log("🚀 Server running on port 8080"));
