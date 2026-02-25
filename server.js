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

// MongoDB Setup
mongoose.connect(process.env.MONGO_URL).then(() => console.log("✅ MongoDB Connected"));

const UserSchema = new mongoose.Schema({
    phoneNumber: String,
    sessionString: String
});
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// Global tempClient ကို login process တစ်လျှောက် သိမ်းထားဖို့ လိုပါတယ်
let tempClient;

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        // StringSession အလွတ်ဖြင့် စတင်ခြင်း
        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { 
            connectionRetries: 5,
            deviceModel: "TG Cloud Web"
        });
        await tempClient.connect();
        
        const { phoneCodeHash } = await tempClient.sendCode({ apiId, apiHash }, phone);
        res.json({ success: true, phoneCodeHash, phone });
    } catch (err) {
        console.error("Send Code Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Handle 2FA
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        
        try {
            // GramJS version အသစ်များတွင် login workflow အား client.start သို့မဟုတ် client.signIn ဖြင့်သာ သုံးရသည်
            await tempClient.start({
                phoneNumber: async () => phone,
                phoneCode: async () => code,
                onError: (err) => { throw err; }
            });

            // အကယ်၍ password မတောင်းဘဲ login အောင်မြင်လျှင်
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });
            return res.json({ success: true });

        } catch (err) {
            // Error ထဲမှာ PASSWORD_NEEDED ပါလျှင် Frontend သို့ အသိပေးမည်
            if (err.message.includes('PASSWORD_NEEDED') || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({ success: false, requiresPassword: true });
            }
            throw err;
        }
    } catch (err) {
        console.error("Verify Code Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Verify Password (2FA)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password, phone } = req.body;
        
        // 2FA Password ကို verify လုပ်ခြင်း
        await tempClient.start({
            phoneNumber: async () => phone,
            password: async () => password,
            onError: (err) => { throw err; }
        });

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });

        res.json({ success: true });
    } catch (err) {
        console.error("2FA Error:", err);
        res.status(500).json({ error: "Password မှားယွင်းနေပါသည်။ " + err.message });
    }
});

// --- File Management ---
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "Please login first!" });

        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || "Media File",
            date: m.date
        }));
        res.json(files);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Direct Stream Download ---
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();

        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        const message = messages[0];

        if (!message || !message.media) return res.status(404).send("File not found");

        res.setHeader('Content-Type', 'application/octet-stream');
        for await (const chunk of client.iterDownload({ file: message.media, chunkSize: 512 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
