# ပိုမိုတည်ငြိမ်သော Node version ကို သုံးပါ
FROM node:20-bullseye-slim

# လိုအပ်သော system packages များ ထည့်သွင်းပါ (GramJS အတွက် လိုအပ်နိုင်သောကြောင့်)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Package files အရင်ကူးယူပါ
COPY package*.json ./

# npm install error ကို ရှောင်လွှဲရန် legacy-peer-deps ကို သုံးပါ
RUN npm install --legacy-peer-deps

# ကျန်ရှိသော files များ ကူးယူပါ
COPY . .

# Environment variable အတွက် default သတ်မှတ်ချက်
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
