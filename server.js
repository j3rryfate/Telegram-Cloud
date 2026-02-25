import express from 'express';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// --- MongoDB Setup ---
mongoose.connect(process.env.MONGO_URL).then(() => console.log("MongoDB Connected"));

const UserSchema = new mongoose.Schema({
    phoneNumber: String,
    sessionString: String
});
const User = mongoose.model('User', UserSchema);

// --- GramJS Client Helper ---
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// --- API Routes ---

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    const { phone } = req.body;
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
    res.json({ phoneCodeHash });
});

// 2. Direct Stream Download (RAM Usage Minimization)
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne(); // Simplified for demo
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();

        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        const message = messages[0];

        if (!message || !message.media) return res.status(404).send("File not found");

        const media = message.media.document || message.media.video || message.media.photo;
        const fileSize = media.size;

        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="file_${msgId}"`);

        // RAM မတက်စေရန် Buffer မသုံးဘဲ Chunk အလိုက် Stream လုပ်ခြင်း
        for await (const chunk of client.iterDownload({
            file: message.media,
            chunkSize: 512 * 1024, // 512KB per chunk
        })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 3. Get File List
app.get('/api/files', async (req, res) => {
    const user = await User.findOne();
    const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
    await client.connect();
    const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
    
    const files = messages.filter(m => m.media).map(m => ({
        id: m.id,
        text: m.message,
        date: m.date,
        type: m.media.className
    }));
    res.json(files);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));