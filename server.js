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

let tempClient;  // login process အတွက် ယာယီ client

// 1. Send OTP (phone ထည့်ပြီး code ပို့)
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({ error: "Phone number လိုအပ်ပါသည်" });
        }

        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
            deviceModel: "TG Cloud Web"
        });

        await tempClient.connect();

        const sentCode = await tempClient.sendCode(
            { apiId, apiHash },
            phone
        );

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

// 2. Verify OTP (2FA ရှိ/မရှိ စစ်ဆေး)
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code } = req.body;

        if (!tempClient) {
            return res.status(400).json({ error: "Session မရှိပါ။ OTP ပြန်ပို့ပါ" });
        }

        if (!phone || !code) {
            return res.status(400).json({ error: "Phone နဲ့ code လိုအပ်ပါသည်" });
        }

        try {
            await tempClient.start({
                phoneNumber: async () => phone,
                phoneCode: async () => code,  // frontend က ပို့လိုက်တဲ့ OTP
                password: async () => {
                    // 2FA လိုအပ်ရင် ဒီ callback ရောက်လာမယ် → error နဲ့ ဖမ်းပြီး frontend ကို ပြန်ပြော
                    throw new Error("PASSWORD_NEEDED");
                },
                onError: (err) => { throw err; }
            });

            // ဒီနေရာရောက်ရင် 2FA မလိုပဲ login အောင်မြင်ပြီ
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate(
                { phoneNumber: phone },
                { sessionString },
                { upsert: true }
            );

            tempClient.destroy();
            tempClient = null;

            return res.json({ success: true, message: "Login အောင်မြင်ပါပြီ (2FA မလိုအပ်ပါ)" });
        } catch (err) {
            if (err.message === "PASSWORD_NEEDED" || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({
                    success: false,
                    requiresPassword: true,
                    message: "2FA password လိုအပ်ပါသည်"
                });
            }

            if (err.errorMessage === 'PHONE_CODE_INVALID') {
                return res.status(400).json({ error: "OTP မမှန်ကန်ပါ" });
            }

            console.error("Verify Code Error:", err);
            res.status(500).json({ error: err.message || "အမှားတစ်ခုခု ဖြစ်သွားပါပြီ" });
        }
    } catch (err) {
        console.error("Outer Verify Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Verify 2FA Password (လိုအပ်ရင်ပဲ ခေါ်မယ်)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!tempClient) {
            return res.status(400).json({ error: "Session မရှိတော့ပါ။ အစကနေ ပြန်စပါ" });
        }

        if (!phone || !password) {
            return res.status(400).json({ error: "Phone နဲ့ password လိုအပ်ပါသည်" });
        }

        await tempClient.start({
            phoneNumber: async () => phone,
            phoneCode: async () => { throw new Error("Code မလိုတော့ပါ"); },  // dummy (အရင် OTP ပြီးသား)
            password: async () => password,  // 2FA password ကို ဒီနေရာမှာ ပေး
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

        if (err.message?.toLowerCase().includes('password') || 
            err.errorMessage?.includes('PASSWORD_HASH_INVALID') || 
            err.errorMessage?.includes('INVALID')) {
            return res.status(400).json({ error: "2FA password မမှန်ပါ" });
        }

        res.status(500).json({ error: "2FA အတည်ပြုရာတွင် အမှားရှိနေပါသည် - " + (err.message || "") });
    }
});

// --- File Management (လိုအပ်ရင် ဆက်သုံးပါ) ---
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();  // လက်ရှိ တစ်ခုတည်းပဲ ရှိတယ်ဆိုရင်
        if (!user?.sessionString) return res.status(401).json({ error: "Please login first!" });

        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();

        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || "Media File",
            date: m.date
        }));

        res.json(files);
    } catch (err) {
        console.error("Files Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- Direct Stream Download ---
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user?.sessionString) return res.status(401).json({ error: "Please login first!" });

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
    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
