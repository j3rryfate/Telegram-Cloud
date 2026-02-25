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

// MongoDB Schema
const UserSchema = new mongoose.Schema({
    phoneNumber: String,
    sessionString: String
});
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// Global client variable to keep track of temporary login session
let tempClient;

// 1. Send OTP (Modified)
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
        await tempClient.connect();
        
        const { phoneCodeHash } = await tempClient.sendCode({ apiId, apiHash }, phone);
        res.json({ success: true, phoneCodeHash, phone });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP and Save Session
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        
        await tempClient.signIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
            onError: (err) => console.log(err),
        });

        const sessionString = tempClient.session.save();
        
        // MongoDB ထဲမှာ သိမ်းမယ် (ရှိပြီးသားဆို update လုပ်မယ်)
        await User.findOneAndUpdate(
            { phoneNumber: phone }, 
            { sessionString: sessionString }, 
            { upsert: true }
        );

        res.json({ success: true, message: "Logged in successfully!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Get Files (Error Handle လုပ်ထားသည်)
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "Please login first!" });

        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || "No description",
            date: m.date,
            type: m.media.className
        }));
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stream Download (Same as before but with null check)
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).send("Unauthorized");

        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();

        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        const message = messages[0];

        if (!message || !message.media) return res.status(404).send("File not found");

        for await (const chunk of client.iterDownload({
            file: message.media,
            chunkSize: 512 * 1024,
        })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
