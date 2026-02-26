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

const UserSchema = new mongoose.Schema({ phoneNumber: String, sessionString: String });
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// Global Client for persistence
let tempClient;
let authData = { phone: '', phoneCodeHash: '', otp: '' };

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        authData.phone = phone;

        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { 
            connectionRetries: 5,
            deviceModel: "TG Cloud Web Production",
            proxy: undefined 
        });

        await tempClient.connect();
        const result = await tempClient.sendCode({ apiId, apiHash }, phone);
        authData.phoneCodeHash = result.phoneCodeHash;

        res.json({ success: true });
    } catch (err) {
        console.error("Send Code Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Detect 2FA (Fixed)
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { code } = req.body;
        authData.otp = code;

        try {
            // Manual Invoke login - standard way for all versions
            await tempClient.invoke(
                new Api.auth.SignIn({
                    phoneNumber: authData.phone,
                    phoneCodeHash: authData.phoneCodeHash,
                    phoneCode: authData.otp,
                })
            );
            
            // Login Success (No 2FA)
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: authData.phone }, { sessionString }, { upsert: true });
            res.json({ success: true });

        } catch (err) {
            // Check for 2FA Password requirement
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED' || err.code === 401) {
                return res.json({ success: false, requiresPassword: true });
            }
            throw err;
        }
    } catch (err) {
        console.error("OTP Verification Error:", err);
        res.status(500).json({ error: "OTP ကုဒ်မှားယွင်းနေပါသည်။ " + err.message });
    }
});

// 3. Verify 2FA Password (Final Solution for 'Code is empty' error)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password } = req.body;
        
        // Use client.start only for 2FA password handling with all callbacks provided
        await tempClient.start({
            phoneNumber: async () => authData.phone,
            password: async () => password,
            phoneCode: async () => authData.otp,
            onError: (err) => { throw err; }
        });

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: authData.phone }, { sessionString }, { upsert: true });
        res.json({ success: true });

    } catch (err) {
        console.error("2FA Error:", err);
        res.status(500).json({ error: "Password မှားယွင်းနေပါသည်။ " + err.message });
    }
});

// 4. Get File List
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

// 5. Streaming Download
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();

        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        
        if (!messages[0] || !messages[0].media) return res.status(404).send("File not found");

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="TG_Cloud_${msgId}"`);

        for await (const chunk of client.iterDownload({ file: messages[0].media, chunkSize: 512 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
