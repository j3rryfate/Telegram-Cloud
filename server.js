import express from 'express';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB ချိတ်ဆက်ခြင်း
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

let tempClient;          // login flow အတွက်
let tempPhone;           // phone ကို ယာယီ သိမ်းထားဖို့ (verify-password မှာ ပြန်သုံး)
let tempCode;            // OTP code ကို ယာယီ သိမ်းထားဖို့ (2FA phase မှာ ပြန်ပေးဖို့)

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) return res.status(400).json({ error: "Phone number လိုအပ်ပါသည်" });

        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
            deviceModel: "TG Cloud Web"
        });

        await tempClient.connect();

        const sentCode = await tempClient.sendCode({ apiId, apiHash }, phone);

        tempPhone = phone;  // သိမ်းထား

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
        const { phone, code } = req.body;

        if (!tempClient || !phone || !code) {
            return res.status(400).json({ error: "Session, phone သို့မဟုတ် code မရှိပါ" });
        }

        tempCode = code;  // 2FA phase မှာ ပြန်သုံးဖို့ သိမ်းထား

        try {
            await tempClient.start({
                phoneNumber: async () => phone,
                phoneCode: async () => code,
                password: async () => { throw new Error("PASSWORD_NEEDED"); },
                onError: (err) => { throw err; }
            });

            // 2FA မလိုပဲ အောင်မြင်ရင်
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });

            tempClient.destroy();
            tempClient = null;
            tempPhone = null;
            tempCode = null;

            return res.json({ success: true, message: "Login အောင်မြင်ပါပြီ (no 2FA)" });
        } catch (err) {
            if (err.message === "PASSWORD_NEEDED" || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({
                    success: false,
                    requiresPassword: true,
                    message: "2FA password လိုအပ်ပါသည်"
                });
            }

            if (err.errorMessage === 'PHONE_CODE_INVALID' || err.errorMessage === 'PHONE_CODE_EXPIRED') {
                return res.status(400).json({ error: "OTP မမှန်ကန်ပါ (သို့မဟုတ် သက်တမ်းကုန်သွားပါပြီ)" });
            }

            console.error("Verify Code Error:", err);
            res.status(500).json({ error: err.message || "အမှားတစ်ခုခု ဖြစ်သွားပါပြီ" });
        }
    } catch (err) {
        console.error("Outer Verify Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Verify 2FA Password (အဓိက ပြင်ဆင်ထားတဲ့ နေရာ)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!tempClient || !tempPhone || !tempCode) {
            return res.status(400).json({ error: "Session သို့မဟုတ် အရင် OTP ဒေတာ မရှိတော့ပါ။ အစကနေ ပြန်စပါ" });
        }

        if (!password) {
            return res.status(400).json({ error: "Password ထည့်ပါ" });
        }

        await tempClient.start({
            phoneNumber: async () => tempPhone,   // အရင်သိမ်းထားတာ သုံး
            phoneCode: async () => tempCode,      // ← အရင် OTP ကို ပြန်ပေး (library က error မပစ်တော့ဘူး)
            password: async () => password,
            onError: (err) => { throw err; }
        });

        const sessionString = tempClient.session.save();

        await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });

        tempClient.destroy();
        tempClient = null;
        tempPhone = null;
        tempCode = null;

        res.json({ success: true, message: "2FA အတည်ပြုပြီး login အောင်မြင်ပါပြီ" });
    } catch (err) {
        console.error("2FA Verify Error:", err);

        let errorMsg = err.message || "အမှားရှိနေပါသည်";

        if (err.errorMessage?.includes('PASSWORD_HASH_INVALID') || 
            err.message?.toLowerCase().includes('password') || 
            err.message?.includes('invalid')) {
            errorMsg = "2FA password မမှန်ပါ";
            return res.status(400).json({ error: errorMsg });
        }

        res.status(500).json({ error: "2FA အတည်ပြုရာတွင် အမှားရှိနေပါသည် - " + errorMsg });
    }
});

// ကျန်တဲ့ endpoints (files, download) က အရင်အတိုင်း ဆက်ထားပါ
// ဥပမာ app.get('/api/files', ...) နဲ့ app.get('/api/download/:msgId', ...)

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
