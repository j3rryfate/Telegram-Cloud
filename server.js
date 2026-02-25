// ... အပေါ်ပိုင်း အရင်အတိုင်း (import, mongoose, etc.)

let tempClient; // တစ်ခါတည်း သုံးမယ့် client (concurrent များရင် ပိုကောင်းအောင် ပြင်ဆင်နိုင်ပါတယ်)

// 1. Send OTP (မပြောင်းပါ)
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;

        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
            deviceModel: "TG Cloud Web",
        });

        await tempClient.connect();

        const sentCode = await tempClient.sendCode(
            { apiId, apiHash },
            phone
        );

        res.json({
            success: true,
            phoneCodeHash: sentCode.phoneCodeHash,
            phone,
        });
    } catch (err) {
        console.error("Send Code Error:", err);
        res.status(500).json({ error: err.message || "ဖုန်းနံပါတ်ပို့ရာတွင် အမှားရှိနေပါသည်" });
    }
});

// 2. Verify OTP → 2FA လိုအပ်မလိုအပ် စစ်ဆေး
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;

        if (!tempClient) {
            return res.status(400).json({ error: "Session မရှိပါ။ OTP ပြန်ပို့ပါ" });
        }

        try {
            // OTP နဲ့ sign in ကြိုးစား
            await tempClient.signIn({
                phoneNumber: phone,
                phoneCodeHash,
                phoneCode: code,
            });

            // ဒီနေရာရောက်ရင် 2FA မလိုပဲ login အောင်မြင်ပြီ
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate(
                { phoneNumber: phone },
                { sessionString },
                { upsert: true }
            );

            tempClient.destroy(); // ရှင်းပစ်ပါ
            tempClient = null;

            return res.json({ success: true, message: "Login အောင်မြင်ပါပြီ (2FA မလို)" });
        } catch (err) {
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                // 2FA လိုအပ်တယ် → frontend ကို password ထည့်ခိုင်းပါ
                return res.json({
                    success: false,
                    requiresPassword: true,
                    message: "2FA password လိုအပ်ပါသည်",
                });
            }

            if (err.errorMessage === 'PHONE_CODE_INVALID') {
                return res.status(400).json({ error: "OTP မမှန်ကန်ပါ" });
            }

            console.error("SignIn Error:", err);
            throw err;
        }
    } catch (err) {
        console.error("Verify Code Error:", err);
        res.status(500).json({ error: err.message || "အမှားတစ်ခုခု ဖြစ်သွားပါပြီ" });
    }
});

// 3. Verify 2FA Password → အပြီးသတ် login
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!tempClient) {
            return res.status(400).json({ error: "Session မရှိတော့ပါ။ အစကနေ ပြန်စပါ" });
        }

        // GramJS မှာ password ကို တိုက်ရိုက် သုံးပြီး check လုပ်နိုင်တယ်
        // ဒီနေရာမှာ client.start() ကို ဆက်သုံးလို့ ရပါတယ် (password callback နဲ့)
        await tempClient.start({
            phoneNumber: async () => phone,
            phoneCode: async () => { throw new Error("Code မလိုတော့ပါ"); }, // မသုံးတော့ဘူး
            password: async () => password,  // ဒီနေရာက အဓိက
            onError: (err) => {
                console.error("Start error during 2FA:", err);
                throw err;
            },
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

        if (err.errorMessage?.includes('PASSWORD_HASH_INVALID') || err.message?.includes('Invalid')) {
            return res.status(400).json({ error: "2FA password မမှန်ပါ" });
        }

        res.status(500).json({ error: "2FA အတည်ပြုရာတွင် အမှားရှိနေပါသည် - " + (err.message || "") });
    }
});

// ကျန်တဲ့ endpoint တွေ (files, download) က အရင်အတိုင်း ဆက်ထားပါ
// ဒါပေမယ့် client အသစ်ဖန်တီးတိုင်း session ကနေ သုံးနေတာမို့ အဆင်ပြေပါတယ်။

// ... app.listen အဆုံး
