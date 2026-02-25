// server.js
import express from 'express';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();  // ← ဒီ line က အရေးကြီးဆုံး! မရှိရင် app မရှိဘူး ဆိုပြီး error ထွက်တယ်

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB Setup
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("MongoDB connection error:", err));

const UserSchema = new mongoose.Schema({
    phoneNumber: String,
    sessionString: String
});
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

let tempClient;  // temporary client for login flow

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;

        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
            deviceModel: "TG Cloud Web"
        });

        await tempClient.connect();

        const sentCode = await tempClient.sendCode({ apiId, apiHash }, phone);

        res.json({
            success: true,
            phoneCodeHash: sentCode.phoneCodeHash,
            phone
        });
    } catch (err) {
        console.error("Send Code Error:", err);
        res.status(500).json({ error: err.message || "ဖုန်းနံပါတ်ပို့ရာတွင် အမှားရှိနေပါသည်" });
    }
});

// 2. Verify OTP
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;

        if (!tempClient) {
            return res.status(400).json({ error: "Session မရှိပါ။ OTP ပြန်ပို့ပါ" });
        }

        try {
            await tempClient.signIn({
                phoneNumber: phone,
                phoneCodeHash,
                phoneCode: code,
            });

            // No 2FA needed → save session
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate(
                { phoneNumber: phone },
                { sessionString },
                { upsert: true }
            );

            tempClient.destroy();
            tempClient = null;

            return res.json({ success: true, message: "Login အောင်မြင်ပါပြီ (no 2FA)" });
        } catch (err) {
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({
                    success: false,
                    requiresPassword: true,
                    message: "2FA password လိုအပ်ပါသည်"
                });
            }

            if (err.errorMessage === 'PHONE_CODE_INVALID') {
                return res.status(400).json({ error: "OTP မမှန်ကန်ပါ" });
            }

            console.error("SignIn Error:", err);
            res.status(500).json({ error: err.message });
        }
    } catch (err) {
        console.error("Verify Code Error:", err);
        res.status(500).json({ error: err.message || "အမှားတစ်ခုခု ဖြစ်သွားပါပြီ" });
    }
});

// 3. Verify 2FA Password (using client.start with password callback)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!tempClient) {
            return res.status(400).json({ error: "Session မရှိတော့ပါ။ အစကနေ ပြန်စပါ" });
        }

        await tempClient.start({
            phoneNumber: async () => phone,
            phoneCode: async () => { throw new Error("Code မလိုတော့ပါ"); }, // dummy, since we already passed code
            password: async () => password,
            onError: (err) => { throw err; }
        });

        const sessionString = tempClient.session.save();

        await User.findOneAndUpdate(
            { phoneNumber: phone },
            { sessionString },
            { upsert: true }
        );

        tempClient.destroy();
        tempClient = null;

        res.json({ success: true, message: "2FA အတည်ပြုပြီး login အောင်မြင်ပါပြီ" });
    } catch (err) {
        console.error("2FA Verify Error:", err);

        if (err.errorMessage?.includes('PASSWORD_HASH_INVALID') || err.message?.toLowerCase().includes('password')) {
            return res.status(400).json({ error: "2FA password မမှန်ပါ" });
        }

        res.status(500).json({ error: "2FA အတည်ပြုရာတွင် အမှားရှိနေပါသည် - " + (err.message || "") });
    }
});

// ကျန်တဲ့ endpoints (files, download) ကို လိုအပ်ရင် ဆက်ထည့်ပါ
// ဥပမာ:
// app.get('/api/files', async (req, res) => { ... });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
