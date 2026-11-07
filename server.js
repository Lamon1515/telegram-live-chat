// server.js — Telegram Live Chat (Express + WebSocket, in-memory sessions, NO database)
// Flow: visitor --WS/REST--> this server --sendMessage--> owner on Telegram
//       owner replies on Telegram --webhook--> this server --WebSocket--> only that visitor
// Safety built in: update_id dedupe (no duplicate delivery), per-session + per-IP rate
// limits, Telegram 429 backoff, getUpdates drain on startup (recovers missed webhooks).
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
const MAX_LEN = 1000; // max characters per visitor message
const SEND_LIMIT = 10; // max visitor messages per minute per session
const IP_LIMIT = 30; // max /api/send calls per minute per IP
const HISTORY_MAX = 200; // max stored messages per session

// ---------- Connected Telegram bots (income bots) ----------
// Registry of other Telegram bots the site connects to. Add a bot by appending
// an entry to bots.json: { username, name, description, how_to_earn }.
// The server serves them at GET /api/bots and answers visitors with the
// matching bot's real info + t.me link (real-time bot answer).
let connectedBots = [];
try {
  const botsData = require('./bots.json');
  if (botsData && Array.isArray(botsData.bots)) connectedBots = botsData.bots;
} catch (e) {
  console.warn('[bots] bots.json not found or invalid — starting with no connected bots.');
}

if (!BOT_TOKEN) console.warn('[warn] BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
if (!OWNER_CHAT_ID) console.warn('[warn] OWNER_CHAT_ID is not set. Copy .env.example to .env and fill it in.');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy — needed for req.ip

// CORS: the chat runs on the WordPress site (a different origin), so the
// browser blocks /api/* fetches unless the server allows that origin.
// Without this, the page's REST fallback and history fetch fail silently
// (the browser blocks the response; the page shows no error).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory storage (Map). No database. ----------
const sessions = new Map(); // sessionId -> { ws, messages, nextId, createdAt, lastSeen }
let lastActiveSessionId = null; // most recent visitor session — plain-text fallback target

// Sessions with a visitor message in the last `maxAgeMs` (default 60 min), newest first.
function recentSessions(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  return [...sessions.entries()]
    .filter(([, s]) => now - s.lastSeen < maxAgeMs)
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .map(([sid]) => sid);
}

function newSessionId() { return 'v_' + crypto.randomBytes(9).toString('hex'); } // e.g. v_9f3ka82kd91x4b2c

function getSession(sid) {
  if (!sessions.has(sid)) {
    sessions.set(sid, { ws: null, messages: [], nextId: 1, createdAt: Date.now(), lastSeen: Date.now() });
  }
  return sessions.get(sid);
}

function newMsg(session, from, text) { return { id: session.nextId++, from, text, time: Date.now() }; }

// Find a session id inside text like [v_abc123...]
function findSessionId(text) {
  const m = String(text || '').match(/\[([A-Za-z0-9_\-]{6,32})\]/);
  return m ? m[1] : null;
}

// ---------- Telegram API with 429 backoff ----------
let tgRetryAfterUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, body, attempt = 0) {
  const wait = tgRetryAfterUntil - Date.now();
  if (wait > 0) await sleep(wait);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { data = { ok: false, error: 'bad telegram response' }; }
  if (res.status === 429 && attempt < 3) {
    const retryAfter = (data.parameters && data.parameters.retry_after) || 5;
    tgRetryAfterUntil = Date.now() + retryAfter * 1000;
    console.warn(`[tg] 429 rate limited, retrying ${method} in ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return tg(method, body, attempt + 1);
  }
  return data;
}

// ---------- Dedupe: processed Telegram update_ids (stops duplicate delivery) ----------
const processedUpdates = new Set();

function markUpdateSeen(id) {
  processedUpdates.add(id);
  if (processedUpdates.size > 2000) {
    const it = processedUpdates.values();
    for (let i = 0; i < 500; i++) { const v = it.next().value; if (v === undefined) break; processedUpdates.delete(v); }
  }
}

// ---------- Per-IP rate limit for /api/send (spam protection) ----------
const ipHits = new Map(); // ip -> [timestamps]

function ipAllowed(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= IP_LIMIT) return false;
  arr.push(now);
  ipHits.set(ip, arr);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipHits) {
    const a = arr.filter((t) => now - t < 60000);
    if (a.length) ipHits.set(ip, a); else ipHits.delete(ip);
  }
}, 5 * 60 * 1000);

// ---------- Push an owner reply to one visitor only ----------
function pushToVisitor(sessionId, msg) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.messages.push(msg);
  if (s.messages.length > HISTORY_MAX) s.messages = s.messages.slice(-HISTORY_MAX);
  s.lastSeen = Date.now();
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    try { s.ws.send(JSON.stringify({ type: 'message', message: msg })); } catch (e) { /* ignore */ }
  }
  return true;
}

// Handle one Telegram update (an owner reply). Only the owner can trigger replies.
async function handleOwnerUpdate(update) {
  const msg = update && update.message;
  if (!msg) return;
  const fromId = msg.from && msg.from.id;
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const send = (t) => tg('sendMessage', { chat_id: chatId, text: t }).catch(() => {});

  if (fromId !== OWNER_CHAT_ID) {
    if (text) await send('This bot is for the website live chat. Please use the chat box on the website.');
    return;
  }
  if (!text) return;

  if (text === '/start') {
    await send('Website live chat is ON. Reply to a visitor message to answer it, or send:\n/reply <session> <your message>');
    return;
  }

  // /reply <session> <text>
  const m = text.match(/^\/reply\s+([A-Za-z0-9_\-]{6,32})\s+([\s\S]+)$/);
  if (m) {
    if (!sessions.has(m[1])) {
      await send('❌ Session not found (the visitor may have left). Send /list to see active visitors.');
      return;
    }
    const ok = pushToVisitor(m[1], newMsg(getSession(m[1]), 'owner', m[2]));
    await send(ok ? '✅ Sent to the visitor.' : '❌ Session not found (the visitor may have left).');
    return;
  }

  // /list — show active visitors with a /reply shortcut for each.
  if (text === '/list') {
    const ids = recentSessions();
    if (!ids.length) { await send('No active visitors right now. Ask the visitor to send a message on the website first.'); return; }
    const lines = ids.map((sid) => {
      const s = sessions.get(sid);
      const last = [...(s.messages || [])].reverse().find((x) => x.from === 'visitor');
      const ago = Math.max(0, Math.round((Date.now() - s.lastSeen) / 60000));
      return `• [${sid}] ${ago}m ago${last ? ` — "${String(last.text).slice(0, 60)}"` : ''}\n  /reply ${sid} <your message>`;
    });
    await send(`Active visitors (${ids.length}):\n${lines.join('\n')}`);
    return;
  }

  // Reply-to a visitor message: the session id sits inside the quoted message.
  const sid = msg.reply_to_message && msg.reply_to_message.text
    ? findSessionId(msg.reply_to_message.text)
    : null;
  if (sid) {
    const ok = pushToVisitor(sid, newMsg(getSession(sid), 'owner', text));
    if (ok) await send('✅ Sent to the visitor.');
    return;
  }

  // Plain text with no reply context (e.g. just typing "Hi"): route it to the
  // most recent active visitor instead of dropping it. With several active
  // visitors, ask the owner to pick one — guessing would send it to the wrong person.
  if (!text.startsWith('/')) {
    const ids = recentSessions();
    if (ids.length === 1) {
      const target = ids[0];
      lastActiveSessionId = target;
      const ok = pushToVisitor(target, newMsg(getSession(target), 'owner', text));
      await send(ok ? `✅ Sent to the visitor [${target}].` : '❌ Session not found (the visitor may have left).');
      return;
    }
    if (ids.length > 1) {
      const lines = ids.map((id) => `• [${id}] — /reply ${id} <your message>`).join('\n');
      await send(`Several visitors are active — reply to one of their messages, or use:\n${lines}`);
      return;
    }
    await send('No active visitor to send this to. Ask the visitor to send a message on the website first, then reply to it.');
    return;
  }

  await send('Reply to a visitor message to answer it, or use: /reply <session> <your message>');
}

// ---------- Recover updates missed while the server was down ----------
// Runs once shortly after boot (only when PUBLIC_URL is set): deletes the webhook,
// drains queued updates via getUpdates, confirms them, then re-sets the webhook.
async function drainMissedUpdates() {
  if (!BOT_TOKEN || !PUBLIC_URL) {
    if (BOT_TOKEN) console.log('[drain] skipped — set PUBLIC_URL in .env to enable missed-update recovery.');
    return;
  }
  try {
    await tg('deleteWebhook', { drop_pending_updates: false });
    const res = await tg('getUpdates', { timeout: 0, limit: 100 });
    if (res && res.ok && Array.isArray(res.result) && res.result.length) {
      let maxId = 0;
      for (const u of res.result) {
        if (typeof u.update_id === 'number') {
          if (u.update_id > maxId) maxId = u.update_id;
          if (processedUpdates.has(u.update_id)) continue;
          markUpdateSeen(u.update_id);
        }
        try { await handleOwnerUpdate(u); } catch (e) { /* ignore */ }
      }
      await tg('getUpdates', { offset: maxId + 1, timeout: 0, limit: 1 }); // confirm them
      console.log(`[drain] recovered ${res.result.length} missed update(s).`);
    }
  } catch (e) { console.error('[drain]', e.message); }
  try {
    const r = await tg('setWebhook', { url: `${PUBLIC_URL}/webhook`, secret_token: WEBHOOK_SECRET });
    if (r && r.ok) console.log('[webhook] set to ' + PUBLIC_URL + '/webhook');
    else console.warn('[webhook] setWebhook failed:', JSON.stringify(r));
  } catch (e) { console.error('[webhook]', e.message); }
}

// ---------- Connected-bot answers (real-time, no manual reply) ----------
// Find a connected bot's real answer for a visitor message.
// Returns the reply text, or null when nothing matches / no bots connected.
function findBotAnswer(text) {
  if (!connectedBots.length) return null;
  const q = String(text || '').toLowerCase();
  const wantsBot = /bot|বট|earn|income|ইনকাম|টেলিগ্রাম বট/.test(q);
  // A specific bot mentioned by username or name.
  const named = connectedBots.find((b) => {
    const u = String(b.username || '').toLowerCase().replace(/^@/, '');
    const n = String(b.name || '').toLowerCase();
    return (u && q.includes(u)) || (n && q.includes(n));
  });
  const list = named ? [named] : (wantsBot ? connectedBots : []);
  if (!list.length) return null;
  const lines = list.map((b) => {
    const url = `https://t.me/${String(b.username || '').replace(/^@/, '')}`;
    return `🤖 ${b.name || b.username}\n${b.description || ''}\nকিভাবে আয়: ${b.how_to_earn || 'বটটি খুলে নির্দেশনা অনুসরণ করুন'}\nখুলুন: ${url}`;
  });
  return `এই বটগুলো থেকে ইনকাম করতে পারবেন:\n\n${lines.join('\n\n')}`;
}

// ---------- REST API (website -> Telegram) ----------
// POST /api/send { session_id?, text } — forwards a visitor message to the owner.
app.post('/api/send', async (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!ipAllowed(ip)) return res.status(429).json({ ok: false, error: 'slow down' });
  const text = String((req.body && req.body.text) || '').trim();
  let sid = String((req.body && req.body.session_id) || '').trim();
  if (!text || text.length > MAX_LEN) return res.status(400).json({ ok: false, error: 'bad text' });
  if (sid && !/^[A-Za-z0-9_\-]{6,32}$/.test(sid)) return res.status(400).json({ ok: false, error: 'bad session' });
  if (!sid) sid = newSessionId();

  const s = getSession(sid);
  const now = Date.now();
  const recent = s.messages.filter((m) => m.from === 'visitor' && now - m.time < 60000).length;
  if (recent >= SEND_LIMIT) return res.status(429).json({ ok: false, error: 'slow down' });

  s.messages.push(newMsg(s, 'visitor', text));
  s.lastSeen = now;
  lastActiveSessionId = sid;
  // If the visitor asked about a connected bot, answer instantly with that
  // bot's real info + link (real-time bot answer, no manual reply needed).
  const botAnswer = findBotAnswer(text);
  if (botAnswer) pushToVisitor(sid, newMsg(s, 'owner', botAnswer));
  try {
    const r = await tg('sendMessage', { chat_id: OWNER_CHAT_ID, text: `💬 [${sid}] New website message:\n${text}` });
    return res.json({ ok: true, session_id: sid, tg_ok: !!r.ok });
  } catch (e) {
    return res.json({ ok: true, session_id: sid, tg_ok: false });
  }
});

// GET /api/history?session_id=... — past messages (reload restores the chat).
app.get('/api/history', (req, res) => {
  const sid = String(req.query.session_id || '');
  if (!/^[A-Za-z0-9_\-]{6,32}$/.test(sid)) return res.status(400).json({ ok: false, error: 'bad session' });
  const s = sessions.get(sid);
  res.json({ ok: true, messages: s ? s.messages : [] });
});

// GET /api/bots — list of connected Telegram bots (income bots).
app.get('/api/bots', (req, res) => {
  res.json({ ok: true, bots: connectedBots });
});

// ---------- Telegram webhook (Telegram -> us) ----------
app.post('/webhook', (req, res) => {
  const secret = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return res.sendStatus(403);
  const uid = req.body && req.body.update_id;
  if (typeof uid === 'number') {
    if (processedUpdates.has(uid)) return res.sendStatus(200); // duplicate delivery — ignore
    markUpdateSeen(uid);
  }
  res.sendStatus(200); // answer fast; Telegram retries on slow/non-200
  handleOwnerUpdate(req.body).catch((e) => console.error('[webhook]', e));
});

app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

// ---------- WebSocket (realtime visitor <-> server) ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  let sid = url.searchParams.get('session_id') || '';
  if (!sid || !/^[A-Za-z0-9_\-]{6,32}$/.test(sid)) sid = newSessionId();
  const s = getSession(sid);

  // If this session already had a socket (old tab), replace it.
  if (s.ws && s.ws !== ws && s.ws.readyState === WebSocket.OPEN) {
    try { s.ws.close(); } catch (e) { /* ignore */ }
  }
  s.ws = ws;
  ws.send(JSON.stringify({ type: 'hello', session_id: sid }));
  if (s.messages.length) ws.send(JSON.stringify({ type: 'history', messages: s.messages }));

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(String(raw)); } catch (e) { return; }
    if (!data || data.type !== 'send') return;
    const text = String(data.text || '').trim();
    if (!text || text.length > MAX_LEN) return;
    const now = Date.now();
    const recent = s.messages.filter((m) => m.from === 'visitor' && now - m.time < 60000).length;
    if (recent >= SEND_LIMIT) {
      ws.send(JSON.stringify({ type: 'error', error: 'slow down' }));
      return;
    }
    const msg = newMsg(s, 'visitor', text);
    s.messages.push(msg);
    s.lastSeen = now;
    lastActiveSessionId = sid;
    ws.send(JSON.stringify({ type: 'message', message: msg })); // echo so the sender sees it instantly
    try {
      await tg('sendMessage', { chat_id: OWNER_CHAT_ID, text: `💬 [${sid}] New website message:\n${text}` });
    } catch (e) { console.error('[tg]', e.message); }
  });

  ws.on('close', () => { if (s.ws === ws) s.ws = null; });
  ws.on('error', () => {});
});

// Drop sessions idle for 24h (memory hygiene — in-memory storage has no persistence).
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > 24 * 60 * 60 * 1000) sessions.delete(sid);
  }
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Live chat server running on http://localhost:${PORT}`);
  console.log(`Webhook URL: ${PUBLIC_URL ? PUBLIC_URL + '/webhook' : '<set PUBLIC_URL in .env>'}`);
  setTimeout(() => { drainMissedUpdates().catch((e) => console.error('[drain]', e.message)); }, 3000);
});
