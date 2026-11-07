# Telegram Live Chat — Node.js + Express + WebSocket (In-Memory, No Database)

ভিজিটর সাইটের চ্যাট বক্সে মেসেজ লেখে → সার্ভার Telegram bot দিয়ে তোমার Telegram-এ পাঠায় → তুমি Telegram-এ reply দিলে Webhook হয়ে সার্ভারে আসে → WebSocket দিয়ে শুধু ওই ভিজিটরের চ্যাট বক্সে real-time-এ পৌঁছায়। History ভিজিটরের ব্রাউজারের `localStorage`-এ থাকে — refresh, tab close, server restart-এও মুছে না।

## Project Structure

```
telegram-live-chat-node/
├── server.js            # Express + WebSocket সার্ভার, in-memory Map, /webhook, /api/send
├── package.json         # dependencies: express, ws, dotenv
├── render.yaml          # Render Blueprint (free plan, build/start, env vars)
├── .env.example         # BOT_TOKEN, OWNER_CHAT_ID, WEBHOOK_SECRET, PORT, PUBLIC_URL
├── PLAN.md              # প্ল্যানের সারাংশ (held → built)
├── public/
│   ├── index.html       # ডেমো পেজ (widget সহ)
│   ├── widget.js        # চ্যাট উইজেট (WebSocket + localStorage history + REST fallback)
│   └── widget.css       # উইজেটের ডিজাইন
└── README.md            # এই ফাইল
```

## কীভাবে কাজ করে

1. ভিজিটর সাইট খুললে `localStorage`-এ একটা Unique Session ID (`v_...`) তৈরি হয়; পুরোনো history-ও `localStorage` থেকে লোড হয়।
2. ভিজিটর মেসেজ পাঠায় (REST `/api/send` primary, WebSocket `/ws` শুধু reply পাওয়ার জন্য) → সার্ভার `sendMessage` দিয়ে তোমার Telegram-এ পাঠায় — মেসেজে শুধু আসল লেখাটাই থাকে, কোনো `[session-id]` ট্যাগ থাকে না (ইউনিক আইডি গোপন থাকে)। সার্ভার Telegram-এর `message_id` মনে রাখে, তাই তুমি ওই মেসেজে Reply দিলেই সঠিক ভিজিটরের কাছে উত্তর যায়।
3. তুমি Telegram-এ ওই মেসেজে Reply দিলে (বা `/reply <session> <text>` লিখলে) Telegram Webhook (`/webhook`) হয়ে সার্ভারে আসে।
4. সার্ভার `sessions` Map থেকে ওই session-এর WebSocket খুঁজে শুধু তাকেই reply পাঠায় — অন্য ভিজিটররা কিছু দেখে না।

## Safety (কোডে যা হ্যান্ডেল করা আছে)

- **Deduplication:** প্রতিটা Telegram `update_id` `Set`-এ রেখে চেক করা হয় — Telegram একই update দুইবার পাঠালেও ভিজিটর একবারই reply পায়।
- **Rate limit:** প্রতি session-এ মিনিটে ১০টা মেসেজ, প্রতি IP-তে মিনিটে ৩০টা `/api/send` কল — spam ঠেকায়।
- **Telegram 429 backoff:** Telegram rate limit দিলে `retry_after` মেনে ৩ বার পর্যন্ত retry করে।
- **Missed-update recovery:** সার্ভার চালু হওয়ার সময় webhook delete → `getUpdates` দিয়ে মিস হওয়া reply টেনে আনে → webhook আবার বসায় (শুধু `PUBLIC_URL` সেট থাকলে)।
- **localStorage history:** মেসেজ + reply ব্রাউজারে সেভ থাকে (সর্বোচ্চ ২০০টা) — refresh/server restart-এও দেখা যায়।

## Setup — Local

```
npm install
cp .env.example .env        # তারপর .env-এ BOT_TOKEN, OWNER_CHAT_ID, WEBHOOK_SECRET, PUBLIC_URL বসাও
npm start                   # http://localhost:3000 খুলে টেস্ট করো
```

## Setup — Render (Free)

1. এই ফোল্ডারটা GitHub-এ push করো।
2. Render → New → Web Service → repo সিলেক্ট করো (বা `render.yaml` Blueprint ব্যবহার করো) → Build Command: `npm install`, Start Command: `npm start`।
3. Environment-এ `BOT_TOKEN`, `OWNER_CHAT_ID`, `WEBHOOK_SECRET`, `PUBLIC_URL` (যেমন `https://your-app.onrender.com`) বসাও।
4. Deploy হলে সার্ভার নিজেই webhook বসিয়ে নেবে (startup drain-এ)। না হলে নিচের Webhook ধাপটা করো।

## Webhook সেট করা (একবারই — সার্ভার নিজে না করলে)

ব্রাউজারে এই URL খুলো (TOKEN, PUBLIC_URL, SECRET বদলে নাও):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_URL>/webhook&secret_token=<SECRET>
```

`{"ok":true,...}` দেখলে done। তারপর bot-কে Telegram-এ `/start` পাঠাও।

## UptimeRobot — সার্ভার জাগিয়ে রাখা (একটাই পিং সার্ভিস)

Render free ১৫ মিনিট idle থাকলে ঘুমিয়ে যায়। একটা পিং-ই যথেষ্ট:

1. [uptimerobot.com](https://uptimerobot.com)-এ free account খুলো।
2. **Add New Monitor** → Monitor Type: **HTTP(s)** → Friendly Name: `telegram-live-chat` → URL: `https://your-app.onrender.com/health` → Monitoring Interval: **5 Minutes** → Create Monitor।
3. Alert Contact-এ তোমার email অন করো — সার্ভার down হলে জানতে পারবে।

এতেই সার্ভার ২৪/৭ জেগে থাকবে (Render free ৭৫০ ঘণ্টা/মাস — একটাই service হলে ৩০ দিনে ~৭২০ ঘণ্টা, ক্যাপের মধ্যে থাকে)।

## Bot বানানো + তোমার Telegram ID

1. Telegram-এ `@BotFather` → `/newbot` → নাম দাও → token পাবে (`.env`-এ `BOT_TOKEN`)।
2. `@userinfobot` কে `/start` পাঠাও → তোমার numeric ID পাবে (`.env`-এ `OWNER_CHAT_ID`)।

## WordPress সাইটে বসানো (WPCode snippet)

```html
<link rel="stylesheet" href="https://YOUR-SERVER/widget.css">
<script>
  window.MLA_CHAT_WS_URL = 'wss://YOUR-SERVER/ws';
  window.MLA_CHAT_API_URL = 'https://YOUR-SERVER/api';
</script>
<script src="https://YOUR-SERVER/widget.js"></script>
```

`YOUR-SERVER` এর জায়গায় Render-এর URL বসাও (যেমন `your-app.onrender.com`)।

## Owner হিসেবে reply করার নিয়ম

- ভিজিটরের মেসেজে **Reply** (swipe/long-press → Reply) করে উত্তর লেখো — সবচেয়ে সহজ। মেসেজে কোনো session id দেখা যায় না; সার্ভার Telegram-এর `message_id` দিয়ে সঠিক ভিজিটর খুঁজে নেয়।
- অথবা লেখো: `/reply v_abc123... তোমার উত্তর` (session id দেখতে `/list` লেখো)।
- Plain মেসেজ (Reply ছাড়া) লিখলে সবচেয়ে recent active ভিজিটরের কাছে যাবে — একাধিক active ভিজিটর থাকলে বট `/reply` দিয়ে বেছে নিতে বলবে। `/list` লিখলে active ভিজিটরদের লিস্ট দেখাবে।

## বটের আসল কমান্ড (ভিজিটর সাইট থেকে পাঠালে বট নিজেই উত্তর দেয়)

- `/start` — বটের আসল স্বাগতম মেসেজ (ম্যানুয়াল reply লাগে না)।
- `/help` — কমান্ডের তালিকা।
- "ইনকাম" / বটের নাম / username — নিচের connected বটের আসল তথ্য + লিংক।

## Connected bots — অন্য টেলিগ্রাম বট যুক্ত করা (ইনকাম বট)

তোমার বট অন্য টেলিগ্রাম বটের আসল উত্তর ভিজিটরকে real-time-এ দিতে পারে। বট যুক্ত করতে `bots.json`-এ একটা entry যোগ করো, তারপর redeploy করো:

```json
{
  "bots": [
    {
      "username": "SomeEarnBot",
      "name": "Some Earn Bot",
      "description": "টাস্ক করে আয় করার বট।",
      "how_to_earn": "বটটি খুলে /start দিন, টাস্ক করুন।"
    }
  ]
}
```

- ভিজিটর "বট", "ইনকাম", "earn" বা কোনো বটের নাম/username লিখলেই সার্ভার ওই বটের আসল তথ্য + `t.me/username` লিংক instant reply দেবে (ম্যানুয়াল reply লাগে না)।
- যুক্ত বটগুলোর লিস্ট দেখা যায়: `GET /api/bots` → `{"ok":true,"bots":[...]}` — সাইটে বটের directory বানাতে এই API ব্যবহার করা যায়।
- নতুন বট যুক্ত করতে শুধু `bots.json`-এ entry যোগ করে GitHub-এ push করলেই হবে (Render auto/manual deploy)।

## সত্যি কথাগুলো (জেনে রাখো)

- **In-memory মানে restart = server-side history মুছে যাবে।** ভিজিটরের `localStorage`-এ history থাকবে, কিন্তু server down থাকার সময়ের মেসেজ হারাতে পারে (drain যতটা পারে টেনে আনে)।
- **InfinityFree-তে এটা চলবে না।** Node.js/WebSocket/webhook ওখানে block — Render/VPS লাগবে।
- **Render free ঘুমায়।** UptimeRobot ping থাকলে দিনের বেলায় প্রায় পুরোটা সামলানো যায়; deploy/restart-এর পর একটা cold start (~৩০-৬০ সেকেন্ড) আসবে।
- **এটা নতুন সিস্টেম**, তোমার live userbot চ্যাট (Railway) থেকে আলাদা। এটা deploy করলে পুরনোটা বন্ধ করতে হবে — বললে আমি করে দিবো।
- **Token গোপন রাখো।** `.env` কখনো শেয়ার করো না, GitHub-এ push করো না।
