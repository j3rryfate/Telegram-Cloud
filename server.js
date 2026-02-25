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

// MongoDB Connection
mongoose.connect(process.env.MONGO_URL).then(() => console.log("✅ MongoDB Connected"));

const UserSchema = new mongoose.Schema({ phoneNumber: String, sessionString: String });
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// Login လုပ်နေစဉ် state ကို ယာယီသိမ်းထားရန်
let tempClient;
let authData = { phone: '', phoneCodeHash: '', otp: '' };

// 1. OTP ပို့ခြင်း
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        authData.phone = phone;
        
        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { 
            connectionRetries: 5,
            deviceModel: "TG Cloud Web"
        });
        
        await tempClient.connect();
        const result = await tempClient.sendCode({ apiId, apiHash }, phone);
        authData.phoneCodeHash = result.phoneCodeHash;
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. OTP စစ်ဆေးခြင်း နှင့် 2FA ရှိမရှိ စစ်ခြင်း
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { code } = req.body;
        authData.otp = code;

        try {
            // Manual SignIn invoke ကို သုံးခြင်းက အမှားအယွင်း အနည်းဆုံးဖြစ်သည်
            await tempClient.invoke(
                new Api.auth.SignIn({
                    phoneNumber: authData.phone,
                    phoneCodeHash: authData.phoneCodeHash,
                    phoneCode: authData.otp,
                })
            );
            
            // Success (No 2FA)
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: authData.phone }, { sessionString }, { upsert: true });
            res.json({ success: true });

        } catch (err) {
            // 2FA Password လိုအပ်ပါက
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({ success: false, requiresPassword: true });
            }
            throw err;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. 2FA Password စစ်ဆေးခြင်း
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password } = req.body;
        
        // GramJS ၏ signIn function ကို password စစ်ရန် သုံးသည်
        await tempClient.signIn({
            phoneNumber: authData.phone,
            password: async () => password,
            phoneCode: async () => authData.otp,
            phoneCodeHash: async () => authData.phoneCodeHash,
            onError: (err) => { throw err; }
        });

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: authData.phone }, { sessionString }, { upsert: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Password မှားယွင်းနေပါသည်။ " + err.message });
    }
});

// 4. ဖိုင်များဆွဲထုတ်ခြင်း (Streaming)
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

// 5. Download Streaming
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
