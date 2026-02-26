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

let tempClient = null;
let authData = { phone: '', phoneCodeHash: '', otp: '' };

// Telegram Client ကို တည်ငြိမ်စွာ ဆောက်ပေးမည့် Helper Function
const createClient = (session = "") => {
    return new TelegramClient(new StringSession(session), apiId, apiHash, {
        connectionRetries: 10,
        useWSS: false, // InvalidBufferError ကို ကျော်လွှားရန် WSS ပိတ်ထားသည်
        testMode: false,
        deviceModel: "TG Cloud Web",
    });
};

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        authData.phone = phone;
        
        tempClient = createClient();
        
        // Error logs များကို သေချာဖမ်းရန်
        await tempClient.connect();
        
        const result = await tempClient.sendCode({ apiId, apiHash }, phone);
        authData.phoneCodeHash = result.phoneCodeHash;
        
        res.json({ success: true });
    } catch (err) {
        console.error("Connection Error:", err);
        res.status(500).json({ error: "Telegram Connection ကျရှုံးပါသည်။ ခဏနားပြီးမှ ပြန်စမ်းပါ။ " + err.message });
    }
});

// 2. Verify OTP & Detect 2FA
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { code } = req.body;
        authData.otp = code;

        try {
            await tempClient.invoke(
                new Api.auth.SignIn({
                    phoneNumber: authData.phone,
                    phoneCodeHash: authData.phoneCodeHash,
                    phoneCode: authData.otp,
                })
            );
            
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: authData.phone }, { sessionString }, { upsert: true });
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

// 3. Verify 2FA Password
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password } = req.body;
        await tempClient.signInUserPassword(password);

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: authData.phone }, { sessionString }, { upsert: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Password မှားနေပါသည်။" });
    }
});

// 4. File Management & Stream Download
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "Please login first!" });
        
        const client = createClient(user.sessionString);
        await client.connect();
        
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || "File Attached",
            date: m.date
        }));
        res.json(files);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = createClient(user.sessionString);
        await client.connect();
        
        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        
        if (!messages[0] || !messages[0].media) return res.status(404).send("File not found");

        res.setHeader('Content-Type', 'application/octet-stream');
        for await (const chunk of client.iterDownload({ file: messages[0].media, chunkSize: 512 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server ready on port ${PORT}`));
