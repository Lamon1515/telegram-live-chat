# Telegram Live Chat — PLAN (HELD — কাজ শুরু করো না, যতক্ষণ না Lemon বলে)

## সিদ্ধান্ত (agreed)
- Stack: Node.js + Express + WebSocket (`ws`), Telegram Bot API (webhook), **কোনো DB না** — in-memory `Map` + visitor-এর `localStorage` history।
- Deploy: Render.com free tier। Sleep ঠেকাতে UptimeRobot দিয়ে ৫ মিনিট পরপর `/health` ping।

## Backend (`server.js`)
- `sessions`: `Map<sessionId, { ws, messages, nextId, createdAt, lastSeen }>` — প্রতি ভিজিটর একটা Unique Session ID (`v_` + random)।
- `POST /api/send` — ভিজিটরের মেসেজ `sendMessage` দিয়ে owner-এর Telegram-এ পাঠায় (`[session-id]` সহ)। Rate limit: প্রতি session-এ মিনিটে ১০টা; Telegram 429 এলে `retry_after` মেনে backoff।
- `POST /webhook` — owner-এর reply রিসিভ করে শুধু ওই session-এর WebSocket-এ পাঠায়। **Deduplication: `update_id` `Set`-এ রেখে চেক** (Telegram retry-তে একই update দুইবার এলে দ্বিতীয়বার ignore)। Secret token (`X-Telegram-Bot-Api-Secret-Token`) যাচাই। ২০০ সঙ্গে সঙ্গে, তারপর process।
- `GET /ws` — WebSocket; connect-এ `hello` + history পাঠায়; disconnect-এ auto-reconnect (widget-এ)।
- `GET /health` — UptimeRobot ping-এর জন্য। `GET /api/history` — reload-এ history।
- Owner reply নিয়ম: ভিজিটরের মেসেজে Reply, অথবা `/reply <session> <text>`। ২৪ ঘণ্টা idle session cleanup; প্রতি session-এ সর্বোচ্চ ২০০ মেসেজ।

## Frontend (`public/index.html`, `widget.js`, `widget.css`)
- Floating chat widget (slim, minimal, mobile-first); WebSocket real-time; WS down থাকলে REST fallback।
- **localStorage:** সব মেসেজ + reply `localStorage`-এ সেভ — refresh, tab close, server restart-এও history দেখাবে (শুধু ওই browser/device-এ)।

## Deploy (Render + UptimeRobot)
- `package.json` (express, ws, dotenv), `render.yaml` (free plan, `npm install` / `npm start`), `.env.example` (BOT_TOKEN, OWNER_CHAT_ID, WEBHOOK_SECRET, PORT)।
- Webhook সেট: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_URL>/webhook&secret_token=<SECRET>`।
- UptimeRobot: free monitor, ৫ মিনিট interval, URL = `<PUBLIC_URL>/health`।

## জানা ঝুঁকি + ব্যাকআপ (reviewed 2026-11-07)
- Render sleep (১৫ মিনিট idle) → UptimeRobot ping; বিকল্প serv00 / Oracle free VPS।
- Render free ৭৫০ ঘণ্টা/মাস → একটাই service রাখতে হবে (৩০ দিনে ~৭২০, ৩১ দিনে ~৭৪৪ ঘণ্টা)।
- Restart-এ in-memory session মুছে যায় → startup-এ getUpdates drain; শক্ত সমাধান Upstash Redis free।
- Spam (খোলা endpoint) → IP rate limit + Cloudflare Turnstile।
- Reply-to ভঙ্গুরতা → `/admin` ড্যাশবোর্ড (ভবিষ্যৎ), `/reply` fallback আছেই।
- Single point of failure → পুরনো userbot চ্যাট fallback হিসেবে রেখে দেওয়া (নতুনটা প্রমাণ না হওয়া পর্যন্ত)।

## Status
- **BUILT 2026-11-07 ~14:50 +06** — Lemon gave the go-ahead ("সম্পূর্ণ সিস্টেম বানানো শুরু করো")। Final code in `~/workspace/telegram-live-chat-node/` per this spec: update_id dedupe (Set), per-session + per-IP rate limits, Telegram 429 backoff, getUpdates drain on startup, localStorage history in widget, `render.yaml`, UptimeRobot guide in README. Syntax-checked + smoke-tested locally. NOT deployed yet — needs his BotFather token + owner chat ID (via Secure Vault) and his GitHub/Render for deploy; widget install on the site needs his preview yes.
- **DEPLOY ATTEMPT 2026-11-07 ~15:03 +06 — BLOCKED on browser access.** Lemon supplied the bot token + owner ID in chat (~15:00-15:01) and gave blanket approval to finish. Code re-verified (syntax + fresh local smoke test on dummy token: health/send/webhook 403-200/dedupe all PASS). But the deployment subagent has NO live-browser access, so GitHub upload, Render deploy, UptimeRobot, WordPress install and live verification could NOT be executed. Parent agent must run the browser steps (runbook in the handoff report). No credentials were written anywhere; token/ID remain only in the user's chat messages.
- **DEPLOY RESUMED 2026-11-07 ~15:06 +06 — parent running the browser steps.** getMe verified: bot @mlazonet1_bot, token valid. GitHub repo upload task running (repo telegram-live-chat, Lamon1515). Next: Render service + env vars, UptimeRobot ping, WordPress widget install, end-to-end verification. Token/ID used only transiently for the deploy; not saved in any file.
- **BOT-CONNECTOR 2026-11-07 ~19:07 +06** — Lemon wants his bot to bring other Telegram bots' real answers so income bots can be added later (NOT a chat bot, NOT AI, NOT fixed auto-reply). Added: `bots.json` registry (empty to start), `GET /api/bots`, and `findBotAnswer()` in `/api/send` — when a visitor asks about a bot/earning, the server instantly replies with the matching bot's real info + t.me link. Locally tested with a test bot (bot answer pushed as id 2; unrelated msg did not trigger) — syntax OK, bots.json reverted to empty for deploy. To add an income bot later: append an entry to bots.json and redeploy.
