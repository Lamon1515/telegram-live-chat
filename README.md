# Telegram Live Chat — Node.js + Express + WebSocket (In-Memory, No Database)

ভিজিটর সাইটের চ্যাট বক্সে মেসেজ লেখে → সার্ভার Telegram bot দিয়ে তোমার Telegram-এ পাঠায় → তুমি Telegram-এ reply দিলে Webhook হয়ে সার্ভারে আসে → WebSocket দিয়ে শুধু ওই ভিজিটরের চ্যাট বক্সে real-time-এ পৌঁছায়। History ভিজিটরের ব্রাউজারের `localStorage`-এ থাকে — refresh, tab close, server restart-এও মুছে না।

## Project Structure

```
telegram-live-chat-node/
├── server.js            # Express + WebSocket সার্ভার, in-memory Map, /webhook, /api/send + GramJS userbot bridge
├── login.js             # একবারের GramJS লগইন (লোকালি চালিয়ে TG_SESSION বানানো)
├── package.json         # dependencies: express, ws, dotenv, telegram (GramJS), input
├── render.yaml          # Render Blueprint (free plan, build/start, env vars)
├── .env.example         # BOT_TOKEN, OWNER_CHAT_ID, WEBHOOK_SECRET, PORT, PUBLIC_URL + TG_API_ID/TG_API_HASH/TG_SESSION
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

## বটের আসল উত্তর (কোনো ডিফল্ট/বানানো মেসেজ নেই)

বট নিজে থেকে কোনো বানানো উত্তর দেয় না। ভিজিটর কোনো যুক্ত বটের নাম/username বা "ইনকাম" লিখলে সার্ভার শুধু ওই বটের আসল তথ্য + লিংক দেয় (নিচে দেখো)। আর কিছু না মিললে মেসেজ সরাসরি তোমার কাছে (মালিকের কাছে) যায় — তুমি উত্তর দাও।

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

### WordPress এডমিন প্যানেল থেকে বট যুক্ত করা (MLA Bots) — ইউজার পেজ নয়

কোড না ঘেঁটে, শুধু wp-admin থেকেই বট যুক্ত/মুছে ফেলা যায়:

- **কোথায়:** WordPress এডমিন প্যানেলে (wp-admin) **MLA Bots** মেনু — এটা শুধু এডমিনের জন্য; ইউজার পেজে (MLA Bot পেজে) বট যুক্ত করার কোনো অপশন নেই।
- **কীভাবে:** `mla-bots-admin.php` (এই রিপোর Code Snippets-এ পেস্ট করো, "Only run in administration area" দিয়ে Activate করো) — ফর্মে বটের username, নাম, বিবরণ, কিভাবে আয় লিখে "বট যুক্ত করুন" চাপলেই হবে। মুছতে চাইলে লিস্ট থেকে "মুছুন" চাপো।
- **কী হয়:** বটের লিস্ট WordPress-এ (`mla_connected_bots` option) সেভ হয়, আর ব্রাউজার থেকেই Render সার্ভারে পাঠানো হয় (`POST /api/admin/bots/sync`) — সার্ভার সাথে সাথে নতুন বটটা চিনে নেয়, redeploy লাগে না।
- **সার্ভার রিস্টার্ট হলে:** সার্ভার `bots-runtime.json` থেকে লিস্টটা ফিরিয়ে আনে; আর MLA Bots পেজ খুললেই নিজে থেকে আবার Sync হয়ে যায় (পেজে "সার্ভারে আবার পাঠান" বোতামও আছে)।
- **নিরাপত্তা:** Sync-এ একটা গোপন কোড (`ADMIN_BOTS_SECRET` env var) লাগে — এটা শুধু wp-admin-এর snippet-এ আর Render-এ থাকে, ইউজার পেজে কখনো থাকে না। তাই ভিজিটররা বট যুক্ত/বদলাতে পারে না।

## GramJS userbot bridge — সাইট থেকে অন্যের বট চালানো (আসল উত্তর)

Bot API দিয়ে এক বট আরেক বটকে মেসেজ পাঠাতে পারে না। তাই সার্ভার GramJS (MTProto) দিয়ে তোমার **নিজের Telegram অ্যাকাউন্ট** (userbot) হিসেবেও লগইন থাকে — ওই অ্যাকাউন্ট ইনকাম বটকে কমান্ড পাঠায়, বটের আসল উত্তর সাইটে ফিরে আসে। কোনো AI নেই, কোনো বানানো মেসেজ নেই।

- ভিজিটর কোনো যুক্ত বটের নাম/username লিখে কমান্ড দিলে (যেমন `@SomeEarnBot /start`), সার্ভার বটের নামটা সরিয়ে শুধু পরিষ্কার কমান্ড (`/start`) userbot দিয়ে ওই বটকে পাঠায়। ভিজিটরের session id কখনো মেসেজে যায় না (গোপন থাকে)।
- বটের আসল উত্তর এলে সেটা ঠিক ওই ভিজিটরের চ্যাটেই যায় (WebSocket / history polling দিয়ে)। একই বটে দুজন ভিজিটর একসাথে লিখলে উত্তর গুলিয়ে যায় না — প্রতি বটে একবারে একটাই কমান্ড যায় (per-bot FIFO queue), আর বটের reply `replyToMsgId` দিয়েও মিলিয়ে নেওয়া হয়। বট ৩০ সেকেন্ডে উত্তর না দিলে কিছুই পাঠানো হয় না (বানানো মেসেজ নেই)।
- **Bridge optional:** `TG_API_ID` / `TG_API_HASH` / `TG_SESSION` না থাকলে সার্ভার এমনিই চলে (owner live-chat আগের মতো কাজ করে); শুধু ইনকাম-বট bridge বন্ধ থাকে।

### একবারের লগইন (`login.js` — লোকালি চালাও, Render-এ নয়)

1. https://my.telegram.org/apps-এ গিয়ে একটা app বানিয়ে `api_id` আর `api_hash` নাও।
2. লোকালি চালাও:
   ```
   npm install
   TG_API_ID=123456 TG_API_HASH=abcdef... node login.js
   ```
3. ফোন নম্বর দাও → Telegram-এ আসা OTP কোড দাও → 2FA পাসওয়ার্ড থাকলে সেটা দাও।
4. একটা session string ছাপা হবে — সেটা Render-এর Environment-এ `TG_SESSION` হিসেবে বসাও। এই string কখনো শেয়ার করো না, ফাইলে সেভ করো না, GitHub-এ দিও না — এটা তোমার Telegram অ্যাকাউন্টের লগইন।
5. Render-এ আরও দুটো env var বসাও: `TG_API_ID`, `TG_API_HASH`। Deploy হলেই bridge চালু হবে।

## v8 — নতুন যা এসেছে (2026-11-07 রাত)

### ১) প্রতি বটের কমান্ড কন্ট্রোল (এডমিন প্যানেল থেকে)

- প্রতিটা বটের এখন দুটো নতুন ফিল্ড আছে:
  - **`custom_commands`** — এডমিনের যুক্ত করা কমান্ড (সর্বোচ্চ ২০টি; প্রতিটা `{label, command}`, লেবেল ≤৩০ অক্ষর, কমান্ড `/` দিয়ে শুরু, ≤৩২ অক্ষর)। এগুলো বটের আসল কমান্ডের সাথে `/start`-এর পাশে চিপ হিসেবে দেখায়।
  - **`blocked_commands`** — বন্ধ করা কমান্ড (সর্বোচ্চ ২০টি, প্রতিটা `/` দিয়ে শুরু)। ভিজিটর এগুলো পাঠাতে পারবে না — পাঠালে "এই কমান্ডটি বন্ধ আছে।" দেখাবে, আর কিছুই Telegram-এ যাবে না।
- `GET /api/bots/:username/commands` এখন **মার্জ করা লিস্ট** দেয়: বটের আসল কমান্ড (GramJS `GetBotCommands`) থেকে বন্ধগুলো বাদ দিয়ে, তারপর কাস্টম কমান্ডগুলো যোগ করে। `/start` সবসময় থাকে (বন্ধ না থাকলে)। কোনো কমান্ড না থাকলে শুধু `/start` দেয়।
- **এডমিন প্যানেলে (wp-admin → MLA Bots):** বট যুক্ত করার ফর্মে "কাস্টম কমান্ড" (প্রতি লাইনে `লেবেল|কমান্ড`) আর "বন্ধ কমান্ড" (কমা দিয়ে, যেমন `/withdraw, /admin`) ফিল্ড আছে। বটের লিস্টে প্রতিটা বটের কাস্টম/বন্ধ কমান্ড দেখায়, আর **✏️ সম্পাদনা** বোতামে ফর্মে ভরে বদলানো যায়। নতুন বট wp-admin-এ যুক্ত করলে `bots.json`-এও যোগ করে রাখতে হবে — নাহলে পরের ডেপ্লয়ে বেসলাইন থেকে মুছে যাবে।

### ২) মেসেজ সিকিউরিটি — প্রতি সেশনে গোপন কোড (session secret)

- ভিজিটরের ব্রাউজার প্রথম লোডে একটা র‍্যান্ডম ৩২-অক্ষরের গোপন কোড বানায় (`localStorage`-এ `mla_chat_secret`)। `/api/send`, `/api/history`, `/api/click` আর WebSocket — সব জায়গায় এই কোড যায়।
- সার্ভার প্রথমবার কোডটা সেশনে বেঁধে রাখে; পরে অন্য/ভুল কোড এলে **403** দেয় — session id চুরি গেলেও অন্য কেউ ওই ভিজিটরের চ্যাট পড়তে বা পাঠাতে পারবে না।
- সার্ভারের লগে এখন আর পুরো মেসেজ লেখা হয় না — শুধু বটের নাম, মেসেজের দৈর্ঘ্য আর প্রথম ১৫ অক্ষর।

### ৩) মাল্টি-অ্যাকাউন্ট Userbot Pool + Auto-Shift

- একাধিক Telegram অ্যাকাউন্ট একসাথে ব্রিজের কাজ করতে পারে। Env var:
  - `TG_SESSION` (প্রধান), `TG_SESSION_2`, `TG_SESSION_3` — অথবা একটাই `TG_SESSIONS` (JSON array, যেমন `["sess1","sess2"]`)।
  - চালু হওয়ার সময় `userbot-sessions.json` (runtime ফাইল, wp-admin থেকে sync হয়) থাকলে সেটাই env-এর বদলে ব্যবহার হয় — `bots.json` vs `bots-runtime.json`-এর মতোই।
- মেসেজ যায় **সবচেয়ে ফাঁকা (কম active send) চালু অ্যাকাউন্ট** দিয়ে। কোনো অ্যাকাউন্ট FloodWait পেলে সেটা ঠান্ডা হয় (wait সেকেন্ড, সর্বোচ্চ ৬০s) আর মেসেজটা **একবার** আরেক অ্যাকাউন্ট দিয়ে আবার চেষ্টা করা হয়। অ্যাকাউন্ট ডিসকানেক্ট হলে নিজে থেকে আবার কানেক্ট হয় (backoff: 1s, 5s, 15s, 30s, তারপর ৬০s — সর্বোচ্চ ১০ বার)।
- `GET /health` এখন পুলও জানায়: `{"ok":true,"sessions":N,"userbots":{"connected":2,"total":2}}`।
- **এডমিন প্যানেলে (wp-admin → MLA Bots) "Telegram অ্যাকাউন্ট" সেকশন:** যুক্ত অ্যাকাউন্টের লিস্ট (মাস্কড ফোন, স্ট্যাটাস, চলমান মেসেজ, মুছুন বোতাম), আর "অ্যাকাউন্ট যুক্ত করুন" — ফোন নম্বর দিয়ে **OTP পাঠান** → OTP দিয়ে **Verify**। সফল হলে সেশনটা WordPress-এ (`mla_telegram_sessions`) সেভ হয়, আর পেজ খুললেই সার্ভারে আবার Sync হয় (ডেপ্লয়ের পর পুল ফিরে আসে)। সেশন string কখনো পেজে দেখানো হয় না, লগে লেখা হয় না — শুধু wp-admin আর সার্ভারের runtime ফাইলে থাকে।
- নতুন এডমিন এন্ডপয়েন্ট (সব `ADMIN_BOTS_SECRET` দিয়ে সুরক্ষিত):
  - `POST /api/admin/tg-login-start` `{phone}` — নতুন অ্যাকাউন্টের OTP পাঠানো।
  - `POST /api/admin/tg-login-verify` `{phone, code}` — OTP যাচাই; সফল হলে অ্যাকাউন্ট পুলে যুক্ত হয় আর **সেশন string রেসপন্সে ফেরত** যায় (শুধু wp-admin-এর জন্য)।
  - `GET /api/admin/accounts` — পুলের অ্যাকাউন্ট: id, মাস্কড ফোন, স্ট্যাটাস, active sends (সেশন string নেই)।
  - `POST /api/admin/accounts/sync` `{sessions:[...]}` — wp-admin থেকে পুলের সেশন লিস্ট বদলানো (ডেপ্লয়ের পর পুনরুদ্ধার)।
  - `POST /api/admin/accounts/remove` `{id}` — একটি অ্যাকাউন্ট মুছে ফেলা।

### ৪) ভবিষ্যতের জন্য (self-healing)

- একটা বট বা একটা অ্যাকাউন্ট খারাপ হলেও সার্ভার থামে না — প্রতিটা init/send `try/catch`-এ মোড়ানো, বাকিগুলো চলতে থাকে।
- নতুন বট wp-admin-এ যুক্ত করলে `bots.json`-এও যোগ করতে হবে (server.js-এ কমেন্ট আছে) — নাহলে ডেপ্লয়ে বেসলাইন থেকে মুছে যাবে।

## সত্যি কথাগুলো (জেনে রাখো)

- **In-memory মানে restart = server-side history মুছে যাবে।** ভিজিটরের `localStorage`-এ history থাকবে, কিন্তু server down থাকার সময়ের মেসেজ হারাতে পারে (drain যতটা পারে টেনে আনে)।
- **InfinityFree-তে এটা চলবে না।** Node.js/WebSocket/webhook ওখানে block — Render/VPS লাগবে।
- **Render free ঘুমায়।** UptimeRobot ping থাকলে দিনের বেলায় প্রায় পুরোটা সামলানো যায়; deploy/restart-এর পর একটা cold start (~৩০-৬০ সেকেন্ড) আসবে।
- **এটা নতুন সিস্টেম**, তোমার live userbot চ্যাট (Railway) থেকে আলাদা। এটা deploy করলে পুরনোটা বন্ধ করতে হবে — বললে আমি করে দিবো।
- **Token গোপন রাখো।** `.env` কখনো শেয়ার করো না, GitHub-এ push করো না।
