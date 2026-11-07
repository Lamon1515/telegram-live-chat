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

// GramJS userbot bridge (OPTIONAL — for operating income bots). The userbot
// logs in as YOUR Telegram account. All three must be set, or the bridge
// stays disabled and the owner live-chat keeps working normally.
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';
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

// Map a Telegram message_id (of a visitor message we forwarded to the owner)
// back to the visitor session. This is how the unique session id stays HIDDEN:
// the owner just replies to the message (long-press Reply) and we route the
// reply to the right visitor via this map — the [v_xxx] tag never appears in
// the message text the bot/owner sees, so a bot command stays a clean command.
const tgMsgToSession = new Map(); // telegram message_id -> sessionId
function rememberTgMsg(messageId, sid) {
  if (typeof messageId !== 'number') return;
  tgMsgToSession.set(messageId, sid);
  if (tgMsgToSession.size > 2000) {
    const first = tgMsgToSession.keys().next().value;
    if (first !== undefined) tgMsgToSession.delete(first);
  }
}

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

// ---------- GramJS userbot bridge (operate other people's income bots) ----------
// A Bot API bot CANNOT message another bot. Only a Telegram USER account can.
// So this server also runs a GramJS (MTProto) user client: it sends the
// visitor's CLEAN command to an income bot and routes that bot's REAL reply
// back to the exact visitor session. No AI, no canned messages.
// The bridge is OPTIONAL: if TG_API_ID / TG_API_HASH / TG_SESSION are not
// set (or the `telegram` package is missing), the server still starts and
// the normal owner live-chat keeps working; only the income-bot bridge is off.
let userbotClient = null;
let userbotReady = false;
const BOT_REPLY_TIMEOUT_MS = 30000; // wait this long for an income bot's reply

// bot username (lowercase, no @) -> numeric Telegram user id (as string)
const botUserIds = new Map();
// numeric Telegram user id (as string) -> bot username (lowercase, no @)
const botIdToUsername = new Map();
// bot username (lowercase, no @) -> { queue: [], busy: false, pending: null }
// pending: { sessionId, text, sentMsgId, timer, resolve }
const botQueues = new Map();

function peerUserIdStr(peer) {
  if (!peer) return '';
  const v = peer.userId !== undefined ? peer.userId
    : (peer.channelId !== undefined ? peer.channelId : peer.chatId);
  return (v === undefined || v === null) ? '' : String(v);
}

function botQueueFor(botKey) {
  if (!botQueues.has(botKey)) botQueues.set(botKey, { queue: [], busy: false, pending: null });
  return botQueues.get(botKey);
}

// Find the connected bot a visitor's text names (by @username or by name).
// Returns the bots.json entry, or null when no bot is named.
function findNamedBot(text) {
  if (!connectedBots.length) return null;
  const q = String(text || '').toLowerCase();
  return connectedBots.find((b) => {
    const u = String(b.username || '').toLowerCase().replace(/^@/, '');
    const n = String(b.name || '').toLowerCase();
    return (u && q.includes(u)) || (n && q.includes(n));
  }) || null;
}

// Strip the bot's own @username / name out of the visitor's text so the bot
// receives a CLEAN command (e.g. "@SomeBot /start" -> "/start").
// If nothing is left, the visitor only named the bot, so open it with /start.
function extractBotCommand(text, bot) {
  let t = String(text || '');
  const u = String(bot.username || '').replace(/^@/, '');
  const n = String(bot.name || '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (u) t = t.replace(new RegExp('@?' + esc(u), 'ig'), ' ');
  if (n) t = t.replace(new RegExp(esc(n), 'ig'), ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t || '/start';
}

// Connect the GramJS user client once at startup (non-blocking).
// Uses the StringSession from TG_SESSION — no interactive login on the server.
// If credentials or the `telegram` package are missing, logs a warning and
// leaves the bridge disabled; the owner live-chat is unaffected.
async function initUserbot() {
  if (!TG_API_ID || !TG_API_HASH || !TG_SESSION) {
    console.warn('[userbot] disabled — set TG_API_ID, TG_API_HASH and TG_SESSION to enable the income-bot bridge. (Run `node login.js` once locally to create TG_SESSION.)');
    return;
  }
  let TelegramClient, StringSession, NewMessage;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
    ({ NewMessage } = require('telegram/events'));
  } catch (e) {
    console.warn('[userbot] disabled — `telegram` package not installed. Run `npm install` to enable the income-bot bridge.');
    return;
  }
  try {
    const client = new TelegramClient(new StringSession(TG_SESSION), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
    await client.connect();
    userbotClient = client;
    userbotReady = true;
    console.log('[userbot] connected as a user account — income-bot bridge is ON.');
    client.addEventHandler(onUserbotMessage, new NewMessage({}));
  } catch (e) {
    console.error('[userbot] failed to connect:', e && e.message ? e.message : e);
    userbotClient = null;
    userbotReady = false;
  }
}

// Incoming-message handler for the userbot client.
// MATCHING — how a bot reply finds the right visitor (no mix-ups):
//  - Requests to the SAME bot are SERIALISED (a per-bot FIFO queue): only one
//    command is outstanding per bot at a time. So when that bot sends a
//    message, it can only be the reply to the one outstanding request.
//  - We also check `replyToMsgId` when the bot replies with one: if it does
//    not match the sent message id of the outstanding request, the message is
//    ignored (it is a reply to something else, not our command).
//  - Outgoing messages (our own sends, echoed back) are ignored.
//  - A message with no text is ignored (we only route text replies).
//  - If the bot never replies, the request times out after 30s and resolves
//    with null — nothing is sent to the visitor (no canned fallback).
async function onUserbotMessage(event) {
  try {
    const msg = event && event.message;
    if (!msg || msg.out === true) return; // ignore our own outgoing messages
    const senderId = peerUserIdStr(msg.senderId);
    if (!senderId) return;
    const botKey = botIdToUsername.get(senderId);
    if (!botKey) return; // not from a connected income bot
    const q = botQueues.get(botKey);
    if (!q || !q.pending) return; // no visitor is waiting on this bot right now
    const replyToId = msg.replyTo ? msg.replyTo.replyToMsgId : undefined;
    if (replyToId !== undefined && replyToId !== null && Number(replyToId) !== Number(q.pending.sentMsgId)) return; // reply to something else
    const text = String((msg.text !== undefined && msg.text !== null ? msg.text : (msg.message || ''))).trim();
    if (!text) return; // non-text reply — keep waiting for a text reply (or timeout)
    const pending = q.pending;
    q.pending = null;
    q.busy = false;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(text);
    processBotQueue(botKey);
  } catch (e) {
    console.error('[userbot] event handler error:', e && e.message ? e.message : e);
  }
}

// Send the next queued command to a bot (one outstanding request per bot).
// The visitor's CLEAN command text is sent (no session id, no tag).
async function processBotQueue(botKey) {
  const q = botQueues.get(botKey);
  if (!q || q.busy || !q.queue.length) return;
  if (!userbotClient || !userbotReady) {
    // Bridge went down — drop the queued requests silently (no canned message).
    while (q.queue.length) { const r = q.queue.shift(); r.resolve(null); }
    return;
  }
  const req = q.queue.shift();
  q.busy = true;
  try {
    // Resolve the bot entity once and remember its numeric id so incoming
    // replies can be matched to this bot.
    let entityId = botUserIds.get(botKey);
    if (!entityId) {
      const entity = await userbotClient.getEntity(botKey);
      entityId = entity && entity.id !== undefined ? String(entity.id) : '';
      if (entityId) {
        botUserIds.set(botKey, entityId);
        botIdToUsername.set(entityId, botKey);
      }
    }
    const sent = await userbotClient.sendMessage(botKey, { message: req.text });
    const sentMsgId = sent && sent.id !== undefined ? Number(sent.id) : null;
    req.sentMsgId = sentMsgId;
    q.pending = req;
    req.timer = setTimeout(() => {
      // Timed out (bot did not reply in 30s): resolve with null, no message
      // is sent to the visitor (no canned fallback).
      if (q.pending === req) { q.pending = null; }
      q.busy = false;
      req.resolve(null);
      processBotQueue(botKey);
    }, BOT_REPLY_TIMEOUT_MS);
  } catch (e) {
    console.error('[userbot] send to @' + botKey + ' failed:', e && e.message ? e.message : e);
    q.busy = false;
    req.resolve(null);
    processBotQueue(botKey);
  }
}

// Route a visitor's command to a named income bot via the userbot bridge.
// Returns a Promise that resolves with the bot's REAL reply text, or null
// when the bot does not reply in time / the send fails / the bridge is off.
// The reply is NOT sent here — the caller pushes it to the visitor with
// pushToVisitor() (so it appears via WebSocket / history polling).
// The visitor's session id is NEVER included in the text sent to the bot.
function sendToIncomeBot(sessionId, botUsername, text) {
  return new Promise((resolve) => {
    if (!userbotClient || !userbotReady) { resolve(null); return; }
    const botKey = String(botUsername || '').toLowerCase().replace(/^@/, '');
    if (!botKey) { resolve(null); return; }
    const q = botQueueFor(botKey);
    // Fire-and-forget from the caller's side: the HTTP response returns
    // immediately; this promise resolves later when the bot replies (or times
    // out), and the caller then routes the reply to the visitor.
    q.queue.push({ sessionId, text, sentMsgId: null, timer: null, resolve });
    processBotQueue(botKey);
  });
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
    await send('Website live chat is ON. Just reply to a visitor message (long-press → Reply) to answer it, or send:\n/reply <session> <your message>');
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

  // Reply-to a visitor message: route it back via the hidden message_id map
  // (the unique session id never appears in the message text anymore).
  // Fallback: the old [v_xxx] tag, for messages sent before this change.
  let sid = null;
  if (msg.reply_to_message && typeof msg.reply_to_message.message_id === 'number') {
    sid = tgMsgToSession.get(msg.reply_to_message.message_id) || null;
  }
  if (!sid && msg.reply_to_message && msg.reply_to_message.text) {
    sid = findSessionId(msg.reply_to_message.text);
  }
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

// ---------- Real bot answers for site visitors ----------
// NO canned/default messages here — the bot never invents a reply.
// It only returns a connected bot's REAL info (from bots.json, which Lemon
// fills with real bots). When nothing matches, it returns null and the
// message goes to the owner as live chat.
function botCommandAnswer(text) {
  return findBotAnswer(String(text || '').trim());
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
  // If the visitor named a specific connected bot, route the CLEAN command
  // to that bot via the GramJS userbot bridge and send its REAL reply back
  // to this visitor when it arrives. (No canned reply while waiting.)
  const namedBot = findNamedBot(text);
  if (namedBot && userbotReady) {
    const cleanText = extractBotCommand(text, namedBot);
    sendToIncomeBot(sid, namedBot.username, cleanText).then((replyText) => {
      if (replyText) pushToVisitor(sid, newMsg(getSession(sid), 'owner', replyText));
      // No reply in time / send failed: send nothing (no canned fallback).
    }).catch(() => { /* ignore — no canned fallback */ });
    return res.json({ ok: true, session_id: sid, tg_ok: true, bot_routed: true });
  }
  // If the visitor asked about a connected bot, answer with that bot's real
  // info (no canned text). Otherwise the message goes to the owner as live chat.
  const botAnswer = botCommandAnswer(text);
  if (botAnswer) {
    pushToVisitor(sid, newMsg(s, 'owner', botAnswer));
    return res.json({ ok: true, session_id: sid, tg_ok: true, bot_answered: true });
  }
  // Live chat: forward the CLEAN text to the owner (no [session] tag — the
  // unique id stays hidden). Remember the Telegram message_id so the owner's
  // reply-to routes back to this visitor.
  try {
    const r = await tg('sendMessage', { chat_id: OWNER_CHAT_ID, text });
    if (r && r.ok && r.result && typeof r.result.message_id === 'number') {
      rememberTgMsg(r.result.message_id, sid);
    }
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

// ---------- TEMPORARY one-time GramJS login (REMOVE after TG_SESSION is set) ----------
// The user only has an iPhone — he cannot run login.js on a computer, and the
// Muse VM's network blocks MTProto. So the login runs ON this server (Render
// can reach Telegram): /tg-login-start sends the OTP to his phone, and
// /tg-login-verify completes the login and returns the session string.
// SECURITY: both endpoints require ADMIN_LOGIN_SECRET (a random env var).
// If it is not set, both return 403. The OTP code and the session string are
// NEVER logged. REMOVE this whole section (and the env var) once TG_SESSION
// is set and the bridge is live.
const ADMIN_LOGIN_SECRET = process.env.ADMIN_LOGIN_SECRET || '';
let pendingLogin = null; // { client, phone, phoneCodeHash } — one login at a time

function loginAdminOk(req) {
  if (!ADMIN_LOGIN_SECRET) return false;
  const s = (req.body && req.body.secret) || '';
  return s === ADMIN_LOGIN_SECRET;
}

// POST /api/admin/tg-login-start { phone, secret } — sends the OTP to the phone.
app.post('/api/admin/tg-login-start', async (req, res) => {
  if (!loginAdminOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const phone = String((req.body && req.body.phone) || '').trim();
  if (!/^\+[0-9]{8,15}$/.test(phone)) return res.status(400).json({ ok: false, error: 'bad phone' });
  if (!TG_API_ID || !TG_API_HASH) return res.status(500).json({ ok: false, error: 'TG_API_ID/TG_API_HASH not set on server' });
  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'telegram package not installed' });
  }
  try {
    if (pendingLogin && pendingLogin.client) { try { await pendingLogin.client.disconnect(); } catch (e) { /* ignore */ } }
    const client = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, { connectionRetries: 3 });
    await client.connect();
    const { phoneCodeHash } = await client.sendCode({ apiId: TG_API_ID, apiHash: TG_API_HASH }, phone);
    pendingLogin = { client, phone, phoneCodeHash };
    console.log('[tg-login] OTP sent to', phone);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[tg-login] start failed:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: (e && e.message) || 'send failed' });
  }
});

// POST /api/admin/tg-login-verify { code, secret } — completes login, returns the session string.
app.post('/api/admin/tg-login-verify', async (req, res) => {
  if (!loginAdminOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ ok: false, error: 'bad code' });
  if (!pendingLogin) return res.status(400).json({ ok: false, error: 'no pending login — call tg-login-start first' });
  let Api;
  try { ({ Api } = require('telegram')); } catch (e) { return res.status(500).json({ ok: false, error: 'telegram package not installed' }); }
  const { client, phone, phoneCodeHash } = pendingLogin;
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
    const sessionString = client.session.save();
    console.log('[tg-login] verified — session created (value not logged).');
    try { await client.disconnect(); } catch (e) { /* ignore */ }
    pendingLogin = null;
    return res.json({ ok: true, session: sessionString });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('[tg-login] verify failed:', msg);
    if (/SESSION_PASSWORD_NEEDED|PASSWORD/i.test(msg)) {
      return res.json({ ok: false, needPassword: true, error: '2FA password required' });
    }
    return res.status(400).json({ ok: false, error: msg });
  }
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
    // Named a specific connected bot? Route the CLEAN command to that bot via
    // the GramJS userbot bridge; its REAL reply is pushed back when it arrives.
    const namedBot = findNamedBot(text);
    if (namedBot && userbotReady) {
      const cleanText = extractBotCommand(text, namedBot);
      sendToIncomeBot(sid, namedBot.username, cleanText).then((replyText) => {
        if (replyText) pushToVisitor(sid, newMsg(getSession(sid), 'owner', replyText));
      }).catch(() => { /* ignore — no canned fallback */ });
      return;
    }
    // Connected-bot question? Answer with that bot's real info (no canned text).
    const botAnswer = botCommandAnswer(text);
    if (botAnswer) {
      pushToVisitor(sid, newMsg(s, 'owner', botAnswer));
      return;
    }
    // Live chat: forward the CLEAN text (unique id hidden) and remember the
    // Telegram message_id so the owner's reply-to routes back to this visitor.
    try {
      const r = await tg('sendMessage', { chat_id: OWNER_CHAT_ID, text });
      if (r && r.ok && r.result && typeof r.result.message_id === 'number') {
        rememberTgMsg(r.result.message_id, sid);
      }
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
  initUserbot().catch((e) => console.error('[userbot]', e && e.message ? e.message : e));
});
