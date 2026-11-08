// server.js — Telegram Live Chat (Express + WebSocket, in-memory sessions, NO database)
// Flow: visitor --WS/REST--> this server --sendMessage--> owner on Telegram
//       owner replies on Telegram --webhook--> this server --WebSocket--> only that visitor
// Safety built in: update_id dedupe (no duplicate delivery), per-session + per-IP rate
// limits, Telegram 429 backoff, getUpdates drain on startup (recovers missed webhooks).
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
// Secret for the WordPress admin panel's bot sync (POST /api/admin/bots/sync).
// Only the wp-admin "MLA Bots" page knows it — it is never on a user page.
const ADMIN_BOTS_SECRET = process.env.ADMIN_BOTS_SECRET || '';

// GramJS userbot bridge (OPTIONAL — for operating income bots). The userbot
// logs in as YOUR Telegram account. TG_API_ID / TG_API_HASH plus at least
// one session must be set, or the bridge stays disabled and the owner
// live-chat keeps working normally.
// v8 — MULTI-ACCOUNT POOL: several userbot accounts can share the work.
// Sessions come from TG_SESSION (primary), TG_SESSION_2, TG_SESSION_3
// (optional), or a single TG_SESSIONS env var holding a JSON array of
// session strings. The wp-admin "Telegram Accounts" section can add more
// accounts at runtime (they are kept in userbot-sessions.json and re-synced
// from WordPress after a deploy). If one account hits a FloodWait or drops,
// the next one takes over automatically (auto-shift).
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';
const TG_SESSION_2 = process.env.TG_SESSION_2 || '';
const TG_SESSION_3 = process.env.TG_SESSION_3 || '';
const TG_SESSIONS = process.env.TG_SESSIONS || '';
const MAX_LEN = 1000; // max characters per visitor message
const SEND_LIMIT = 10; // max visitor messages per minute per session
const IP_LIMIT = 30; // max /api/send calls per minute per IP
const HISTORY_MAX = 200; // max stored messages per session

// ---------- Connected Telegram bots (income bots) ----------
// Registry of other Telegram bots the site connects to. Each entry:
// { username, name, description, how_to_earn }.
// The list is managed from the WordPress ADMIN panel only ("MLA Bots" page in
// wp-admin — never a user page). The admin page saves the list in WordPress
// and pushes it here via POST /api/admin/bots/sync. The server keeps the
// synced list in bots-runtime.json so it survives a process restart; on a
// fresh deploy it falls back to bots.json from the repo. The admin page also
// re-pushes the list whenever it is opened, so a redeploy self-heals.
// NOTE (v8): a bot added in wp-admin must ALSO be added to bots.json in the
// repo, or it will disappear from the baseline on the next deploy (only the
// bots.json entries survive a deploy without a re-sync).
const RUNTIME_BOTS_FILE = path.join(__dirname, 'bots-runtime.json');
let connectedBots = [];
try {
  const botsData = require('./bots.json');
  if (botsData && Array.isArray(botsData.bots)) connectedBots = botsData.bots;
} catch (e) {
  console.warn('[bots] bots.json not found or invalid — starting with no connected bots.');
}
try {
  if (fs.existsSync(RUNTIME_BOTS_FILE)) {
    const runtimeData = JSON.parse(fs.readFileSync(RUNTIME_BOTS_FILE, 'utf8'));
    if (runtimeData && Array.isArray(runtimeData.bots)) {
      connectedBots = runtimeData.bots;
      console.log(`[bots] loaded ${connectedBots.length} bot(s) from bots-runtime.json (synced from wp-admin).`);
    }
  }
} catch (e) {
  console.warn('[bots] bots-runtime.json unreadable — using bots.json.');
}

// Persist the synced bot list to disk (best-effort; survives a process
// restart within the same deploy). Never logs the list contents.
function saveRuntimeBots() {
  try {
    fs.writeFileSync(RUNTIME_BOTS_FILE, JSON.stringify({ bots: connectedBots }, null, 2));
  } catch (e) {
    console.warn('[bots] could not write bots-runtime.json:', e && e.message ? e.message : e);
  }
}

// ---------- v8: per-bot command control ----------
// Each bot may carry:
//   custom_commands: [{ label, command }] — extra commands the admin adds
//     (shown as chips next to /start; label <= 30 chars, max 20).
//     v8.1: the command is the EXACT text to send. If it starts with '/'
//     it is a slash command (must match /^\/[A-Za-z0-9_]{1,31}$/ and be
//     <= 32 chars). Otherwise it is plain text (any non-empty text,
//     <= 64 chars) — e.g. "ব্যালেন্স" sends exactly that text.
//   blocked_commands: ['/withdraw', ...] — entries the admin blocks for
//     this bot (max 20). v8.1: slash entries block that slash command
//     (first word); plain-text entries block a message whose WHOLE trimmed
//     text equals the entry. A blocked entry is never forwarded to
//     Telegram; the visitor gets error 'blocked' instead.
function cleanCustomCommands(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, 20)) {
    if (!c || typeof c !== 'object') continue;
    const label = String(c.label || '').trim().slice(0, 30);
    const command = String(c.command || '').trim();
    if (!label || !command) continue;
    if (command.startsWith('/')) {
      if (!/^\/[A-Za-z0-9_]{1,31}$/.test(command) || command.length > 32) continue;
    } else if (command.length > 64) continue;
    if (out.some((o) => o.command.toLowerCase() === command.toLowerCase())) continue;
    out.push({ label, command });
  }
  return out;
}
function cleanBlockedCommands(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, 20)) {
    const cmd = String(c || '').trim().toLowerCase();
    if (!cmd) continue;
    if (cmd.startsWith('/')) {
      if (!/^\/[a-z0-9_]{1,31}$/.test(cmd) || cmd.length > 32) continue;
    } else if (cmd.length > 64) continue;
    if (!out.includes(cmd)) out.push(cmd);
  }
  return out;
}
// Is the visitor's message blocked for this bot?
// Slash message: only the first word counts (e.g. '/withdraw 100' blocks
// on '/withdraw'). Plain-text message: the WHOLE trimmed text must equal
// a plain-text blocked entry (case-insensitive).
function isCommandBlocked(bot, text) {
  if (!bot || !Array.isArray(bot.blocked_commands) || !bot.blocked_commands.length) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('/')) {
    const first = t.split(/\s+/)[0].toLowerCase();
    return bot.blocked_commands.some((b) => String(b).toLowerCase() === first);
  }
  const low = t.toLowerCase();
  return bot.blocked_commands.some((b) => String(b).toLowerCase() === low);
}

// ---------- v8: per-session secret ----------
// The client generates a random 32-hex-char secret on first load and sends
// it with every request for its session. The server binds it to the session
// on first contact and rejects (403) any later request for that session that
// presents a different secret — or none at all once one is bound. So a
// leaked/stolen session id alone cannot read or send as that visitor.
// The secret is stored in memory only and is never logged.
function checkSessionSecret(s, secret) {
  const provided = String(secret || '').trim();
  if (!s.secret) {
    if (provided) s.secret = provided; // first-contact binding
    return true;
  }
  return provided === s.secret;
}

// ---------- v8: log-safe message preview ----------
// NEVER log a full visitor message or a full bot reply. Logs carry only the
// bot username, the message length, the first 15 characters, and the event.
function msgPreview(text) {
  const t = String(text || '');
  return `len=${t.length} head="${t.slice(0, 15)}"`;
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
    sessions.set(sid, { ws: null, messages: [], nextId: 1, createdAt: Date.now(), lastSeen: Date.now(), secret: '' });
  }
  return sessions.get(sid);
}

function newMsg(session, from, text, buttons, bot, tgMsgId) {
  const m = { id: session.nextId++, from, text, time: Date.now() };
  if (buttons) m.buttons = buttons; // inline keyboard rows: [[{text, url?}, ...], ...]
  if (bot) m.bot = bot; // which bot this message belongs to (per-bot separate chats)
  if (tgMsgId) m.tgMsgId = tgMsgId; // the real Telegram message id (for clicking its buttons later)
  return m;
}

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
// v8 — MULTI-ACCOUNT USERBOT POOL (auto-shift).
// Several Telegram user accounts share the bridge work. Each pool entry:
//   { id: 'acc1'..., client, status: 'connected'|'disconnected'|'cooling',
//     activeSends, phoneMasked, coolingUntil, reconnectTries, reconnectTimer,
//     sessionStr }.
// A send goes to the CONNECTED account with the fewest active sends. If
// that account hits a FloodWait/rate-limit or drops, it is cooled down /
// marked disconnected and the send retries ONCE with the next-best account.
// The bridge is "ready" whenever at least one account is connected and not
// cooling — checked live (isBridgeReady), never cached, so a cooling
// account stops receiving work the moment it cools.
const BOT_REPLY_TIMEOUT_MS = 30000; // wait this long for an income bot's reply
const RUNTIME_SESSIONS_FILE = path.join(__dirname, 'userbot-sessions.json');
const userbotPool = []; // pool accounts, in the order their sessions were added
let nextAccountNum = 1;

// Lazy-load the GramJS (`telegram`) package once. Returns
// { TelegramClient, StringSession, NewMessage, Api } or null when the
// package is missing (bridge stays disabled, live chat keeps working).
let _tgLib = null;
function telegramLib() {
  if (_tgLib) return _tgLib;
  try {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const { NewMessage } = require('telegram/events');
    const { Api } = require('telegram');
    _tgLib = { TelegramClient, StringSession, NewMessage, Api };
    return _tgLib;
  } catch (e) { return null; }
}

// Mask a phone number for logs: +8801XXXXXXX57 -> +8801******57.
// Never log a full phone number.
function maskPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 8) return '';
  return '+' + p.slice(0, 4) + '******' + p.slice(-2);
}

// Short fingerprint of a session string (SHA-256, first 12 hex chars).
// Used so wp-admin can match a pool account to the session it stored,
// without the session string ever leaving the server. Never reversible.
function sessionFingerprint(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 12);
}

// The connected account with the fewest active sends (skips disconnected
// and cooling accounts). Returns the pool entry or null.
function pickUserbot(excludeIds) {
  const now = Date.now();
  let best = null;
  for (const acc of userbotPool) {
    if (acc.status !== 'connected' || !acc.client) continue;
    if (acc.coolingUntil && acc.coolingUntil > now) continue; // cooling — skip
    if (excludeIds && excludeIds.has(acc.id)) continue;
    if (!best || acc.activeSends < best.activeSends) best = acc;
  }
  return best;
}
function poolClient() { const acc = pickUserbot(); return acc ? acc.client : null; }
function isBridgeReady() { return !!pickUserbot(); }

// Sessions for the pool, from env vars FIRST (baseline): TG_SESSIONS (a JSON
// array) or TG_SESSION / TG_SESSION_2 / TG_SESSION_3. A runtime file
// (userbot-sessions.json, written by the admin account endpoints) OVERRIDES
// the baseline when it exists — same precedence as bots.json vs
// bots-runtime.json. Session strings are secrets: they are never logged.
function collectUserbotSessions() {
  const list = [];
  if (TG_SESSIONS) {
    try {
      const arr = JSON.parse(TG_SESSIONS);
      if (Array.isArray(arr)) for (const s of arr) if (typeof s === 'string' && s.trim() && !list.includes(s.trim())) list.push(s.trim());
    } catch (e) { console.warn('[userbot] TG_SESSIONS is not valid JSON — ignored.'); }
  }
  for (const s of [TG_SESSION, TG_SESSION_2, TG_SESSION_3]) {
    if (s && s.trim() && !list.includes(s.trim())) list.push(s.trim());
  }
  try {
    if (fs.existsSync(RUNTIME_SESSIONS_FILE)) {
      const d = JSON.parse(fs.readFileSync(RUNTIME_SESSIONS_FILE, 'utf8'));
      if (d && Array.isArray(d.sessions) && d.sessions.length) {
        const runtime = d.sessions.filter((s) => typeof s === 'string' && s.trim());
        if (runtime.length) {
          console.log(`[userbot] loaded ${runtime.length} session(s) from userbot-sessions.json (synced from wp-admin).`);
          return runtime;
        }
      }
    }
  } catch (e) { console.warn('[userbot] userbot-sessions.json unreadable — using env vars.'); }
  return list;
}

// Persist the pool's session strings to disk (best-effort; survives a
// process restart within the same deploy). This file holds secrets — it is
// a runtime file only, never committed, never logged.
function saveRuntimeSessions() {
  try {
    const list = userbotPool.map((a) => a.sessionStr).filter(Boolean);
    fs.writeFileSync(RUNTIME_SESSIONS_FILE, JSON.stringify({ sessions: list }, null, 2));
  } catch (e) {
    console.warn('[userbot] could not write userbot-sessions.json:', e && e.message ? e.message : e);
  }
}

// bot username (lowercase, no @) -> numeric Telegram user id (as string)
const botUserIds = new Map();
// numeric Telegram user id (as string) -> bot username (lowercase, no @)
const botIdToUsername = new Map();
// bot username (lowercase, no @) -> { queue: [], busy: false, pending: null }
// pending: { sessionId, text, sentMsgId, timer, resolve }
const botQueues = new Map();

// sessionId -> the latest bot reply message (GramJS object) + its buttons.
// Kept so the visitor can TAP a button on the site and the userbot can click
// it on the real message (sending the callback to the bot). One entry per
// session (the newest reply replaces the older one).
const botReplyMsgBySession = new Map();

// Extract a bot message's inline keyboard as plain JSON rows:
// [[{text, url?}, ...], ...]. Callback buttons are clicked by row/col index
// on the stored message object, so their raw callback data never leaves the
// server. Returns null when the message has no inline keyboard.
function extractInlineButtons(msg) {
  try {
    const rm = msg && msg.replyMarkup;
    if (!rm || !Array.isArray(rm.rows)) return null;
    const rows = [];
    for (const row of rm.rows) {
      if (!row || !Array.isArray(row.buttons)) continue;
      const brow = [];
      for (const b of row.buttons) {
        if (!b || !b.text) continue;
        const btn = { text: String(b.text) };
        if (b.url) btn.url = String(b.url);
        brow.push(btn);
      }
      if (brow.length) rows.push(brow);
    }
    return rows.length ? rows : null;
  } catch (e) { return null; }
}

function peerUserIdStr(peer) {
  if (!peer) return '';
  const v = peer.userId !== undefined ? peer.userId
    : (peer.channelId !== undefined ? peer.channelId : peer.chatId);
  return (v === undefined || v === null) ? '' : String(v);
}

// Extract the sender's numeric id from a GramJS message, trying every
// field Telegram may put it in. `senderId` is normally set, but some bot
// replies arrive with it empty — then `fromId` (raw sender peer) or
// `peerId` (in a DM, the peer IS the other party — the bot) still has it.
// Without this fallback the bot's reply is silently ignored as "no sender".
function extractSenderId(msg) {
  if (!msg) return '';
  let id = peerUserIdStr(msg.senderId);
  if (id) return id;
  id = peerUserIdStr(msg.fromId);
  if (id) return id;
  id = peerUserIdStr(msg.peerId);
  return id;
}

function botQueueFor(botKey) {
  if (!botQueues.has(botKey)) botQueues.set(botKey, { queue: [], busy: false, pending: null });
  return botQueues.get(botKey);
}

// Find a connected bot by its exact username (for the `bot` field the site
// sends when the visitor picked a bot in the selector). Returns the entry
// or null.
function findBotByUsername(username) {
  const u = String(username || '').toLowerCase().replace(/^@/, '');
  if (!u) return null;
  return connectedBots.find((b) => String(b.username || '').toLowerCase().replace(/^@/, '') === u) || null;
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

// Backoff delays for reconnecting a dropped account: 1s, 5s, 15s, 30s,
// then every 60s, up to 10 tries. After 10 failed tries the account stays
// disconnected until an admin re-syncs it (it can still be revived from
// wp-admin — the session is kept in wp_options).
const RECONNECT_DELAYS_MS = [1000, 5000, 15000, 30000, 60000, 60000, 60000, 60000, 60000, 60000];

// Connect (or reconnect) ONE pool account. A fresh client is built each
// time so a stale/broken connection is never reused. The incoming-message
// handler is registered BEFORE connecting, so no reply arriving right after
// connect is missed. One account failing never stops the others.
// The client acts as a NORMAL Telegram user: when it sends a command to a
// bot, that bot answers it exactly as it would answer any user typing the
// command. (A Bot API bot cannot message another bot — only a user account can.)
async function connectAccount(acc) {
  const lib = telegramLib();
  if (!lib) { acc.status = 'disconnected'; return; }
  try {
    if (!acc.client) {
      acc.client = new lib.TelegramClient(new lib.StringSession(acc.sessionStr), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
      acc.client.addEventHandler(onUserbotMessage, new lib.NewMessage({}));
    }
    await acc.client.connect();
    // Verify the session really logged in as a user (and log who it is,
    // masked). If the session is bad/expired this throws and the account
    // stays disconnected while the rest of the pool keeps working.
    const me = await acc.client.getMe();
    acc.status = 'connected';
    acc.coolingUntil = 0;
    acc.reconnectTries = 0;
    if (me && me.phone) acc.phoneMasked = maskPhone(String(me.phone));
    console.log(`[userbot] ${acc.id} connected as a user account (${acc.phoneMasked || 'phone hidden'}, id=${me && me.id ? me.id : '?'}) — income-bot bridge is ON.`);
  } catch (e) {
    acc.client = null; // drop the broken client; a fresh one is built next try
    acc.status = 'disconnected';
    console.error(`[userbot] ${acc.id} failed to connect:`, e && e.message ? e.message : e);
    scheduleReconnect(acc);
  }
}

// Schedule a reconnect for a dropped account with backoff. No-op if one is
// already scheduled or the account already gave up (10 tries).
function scheduleReconnect(acc) {
  if (acc.reconnectTimer) return;
  if (acc.reconnectTries >= RECONNECT_DELAYS_MS.length) {
    console.log(`[userbot] ${acc.id} gave up reconnecting after ${RECONNECT_DELAYS_MS.length} tries — marked disconnected (re-sync from wp-admin to revive).`);
    return;
  }
  const delay = RECONNECT_DELAYS_MS[acc.reconnectTries];
  acc.reconnectTries += 1;
  console.log(`[userbot] ${acc.id} will retry connecting in ${delay / 1000}s (try ${acc.reconnectTries}/${RECONNECT_DELAYS_MS.length}).`);
  acc.reconnectTimer = setTimeout(async () => {
    acc.reconnectTimer = null;
    await connectAccount(acc);
  }, delay);
}

// Mark an account disconnected (send failure / watchdog) and start its
// reconnect backoff. The other accounts keep serving.
function markAccountDisconnected(acc, reason) {
  if (acc.status === 'disconnected') return;
  acc.status = 'disconnected';
  acc.client = null;
  acc.coolingUntil = 0;
  console.warn(`[userbot] ${acc.id} disconnected${reason ? ' — ' + reason : ''}.`);
  scheduleReconnect(acc);
}

// Connect the GramJS user clients once at startup (non-blocking).
// Uses the session strings from TG_SESSION(S) / TG_SESSION_2 / TG_SESSION_3
// or userbot-sessions.json — one client per session. If credentials or the
// `telegram` package are missing, logs a warning and leaves the bridge
// disabled; the owner live-chat is unaffected.
async function initUserbotPool() {
  if (!TG_API_ID || !TG_API_HASH) {
    console.warn('[userbot] disabled — set TG_API_ID and TG_API_HASH to enable the income-bot bridge. (Run `node login.js` once locally to create a session.)');
    return;
  }
  if (!telegramLib()) {
    console.warn('[userbot] disabled — `telegram` package not installed. Run `npm install` to enable the income-bot bridge.');
    return;
  }
  const sessions = collectUserbotSessions();
  if (!sessions.length) {
    console.warn('[userbot] disabled — set TG_SESSION (or TG_SESSIONS) to enable the income-bot bridge. (Run `node login.js` once locally to create TG_SESSION.)');
    return;
  }
  for (const s of sessions) {
    const acc = { id: 'acc' + (nextAccountNum++), client: null, status: 'disconnected', activeSends: 0, phoneMasked: '', coolingUntil: 0, reconnectTries: 0, reconnectTimer: null, sessionStr: s };
    userbotPool.push(acc);
    // Connect each account independently — one bad session must not stop
    // the others.
    connectAccount(acc).catch((e) => console.error('[userbot]', acc.id, e && e.message ? e.message : e));
  }
}

// Watchdog: every 30s, check whether a "connected" account's client actually
// dropped (GramJS exposes .connected). A dropped one is marked disconnected
// and its reconnect backoff starts. A single bad account never takes the
// bridge down — the others keep serving.
setInterval(() => {
  for (const acc of userbotPool) {
    if (acc.status !== 'connected' || !acc.client) continue;
    try {
      if (acc.client.connected === false) markAccountDisconnected(acc, 'connection lost (watchdog)');
    } catch (e) { /* ignore */ }
  }
}, 30000);

// Clear a bot queue's pending request: stop its timer, release the sending
// account's active-send slot, and free the queue for the next command.
function clearPending(q, req) {
  if (!q || !req) return;
  if (q.pending === req) q.pending = null;
  if (req.timer) { clearTimeout(req.timer); req.timer = null; }
  if (req.account) {
    req.account.activeSends = Math.max(0, req.account.activeSends - 1);
    req.account = null;
  }
  q.busy = false;
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
    if (!msg) return;
    // Log every incoming message the userbot sees (sender + first 80 chars),
    // so a missing bot reply is visible in the logs instead of silent.
    const senderId = extractSenderId(msg);
    const rawText = String((msg.text !== undefined && msg.text !== null ? msg.text : (msg.message || ''))).trim();
    if (msg.out === true) { console.log(`[userbot] <- outgoing (ignored) to=${senderId} ${msgPreview(rawText)}`); return; }
    if (!senderId) { console.log(`[userbot] <- incoming with no sender id (ignored) ${msgPreview(rawText)}`); return; }
    const botKey = botIdToUsername.get(senderId);
    console.log(`[userbot] <- incoming from=${senderId} bot=${botKey || '(unknown)'} ${msgPreview(rawText)}`);
    if (!botKey) return; // not from a connected income bot
    const q = botQueues.get(botKey);
    if (!q || !q.pending) { console.log(`[userbot] no visitor waiting on @${botKey} (ignored)`); return; }
    const replyToId = msg.replyTo ? msg.replyTo.replyToMsgId : undefined;
    if (replyToId !== undefined && replyToId !== null && Number(replyToId) !== Number(q.pending.sentMsgId)) {
      console.log(`[userbot] replyTo ${replyToId} != sent ${q.pending.sentMsgId} (ignored)`);
      return;
    }
    const text = rawText;
    if (!text) { console.log('[userbot] non-text reply (ignored, still waiting)'); return; } // non-text reply — keep waiting for a text reply (or timeout)
    const pending = q.pending;
    clearPending(q, pending);
    // Extract the inline keyboard (options) so the site can show them as
    // tappable buttons, and remember this message so a tap can click the
    // button on the real Telegram message (sending the callback to the bot).
    const buttons = extractInlineButtons(msg);
    const tgMsgId = (msg && msg.id !== undefined && msg.id !== null) ? Number(msg.id) : null;
    botReplyMsgBySession.set(pending.sessionId, { msg, botKey, buttons, tgMsgId, time: Date.now() });
    console.log(`[userbot] reply from @${botKey} matched session ${pending.sessionId} — routing to visitor.${buttons ? ` (${buttons.length} button row(s))` : ''}`);
    pending.resolve({ text, buttons, tgMsgId });
    processBotQueue(botKey);
  } catch (e) {
    console.error('[userbot] event handler error:', e && e.message ? e.message : e);
  }
}

// How many seconds a FloodWait error asks us to wait (capped at 60s).
// GramJS exposes it as error.seconds; the message form is FLOOD_WAIT_<n>.
function floodWaitSeconds(e) {
  if (!e) return 0;
  if (typeof e.seconds === 'number' && e.seconds > 0) return Math.min(e.seconds, 60);
  const m = String(e.message || e);
  const f = m.match(/FLOOD_WAIT_(\d+)/i) || m.match(/FloodWait[^0-9]*(\d+)/i);
  if (f) return Math.min(Number(f[1]) || 0, 60);
  return 0;
}
// Is this error a dropped/disconnected connection (rather than a bad bot)?
function isDisconnectError(e) {
  const m = String((e && e.message) || e || '').toLowerCase();
  return /disconnect|not connected|connection (closed|lost|reset)|network|econnreset|econnrefused|timed out/i.test(m);
}

// Send one command to a bot via the pool (auto-shift).
// Picks the connected account with the fewest active sends. If that
// account hits a FloodWait it is cooled down (until now + wait seconds,
// capped at 60s); if it disconnects it is marked disconnected and its
// reconnect backoff starts. Either way the send retries ONCE with the
// next-best account. Returns { acc, sent } or null when no account could
// send. Other errors (e.g. a bad bot) are NOT retried — they are returned
// to the caller as a failure.
async function sendBotCommand(req, botKey) {
  const tried = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    const acc = pickUserbot(tried);
    if (!acc) return null;
    tried.add(acc.id);
    try {
      const sent = await acc.client.sendMessage(botKey, { message: req.text });
      return { acc, sent };
    } catch (e) {
      const wait = floodWaitSeconds(e);
      if (wait > 0) {
        acc.coolingUntil = Date.now() + wait * 1000;
        console.log(`[userbot] @${botKey}: account ${acc.id} hit FloodWait — cooling ${wait}s, retrying with another account.`);
        continue;
      }
      if (isDisconnectError(e)) {
        markAccountDisconnected(acc, 'send failed: ' + (e && e.message ? e.message : e));
        continue;
      }
      throw e; // other error — do not retry
    }
  }
  return null;
}

// Send the next queued command to a bot (one outstanding request per bot).
// The visitor's CLEAN command text is sent (no session id, no tag).
async function processBotQueue(botKey) {
  const q = botQueues.get(botKey);
  if (!q || q.busy || !q.queue.length) return;
  if (!isBridgeReady()) {
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
      try {
        const client = poolClient();
        if (client) {
          const entity = await client.getEntity(botKey);
          entityId = entity && entity.id !== undefined ? String(entity.id) : '';
          if (entityId) {
            botUserIds.set(botKey, entityId);
            botIdToUsername.set(entityId, botKey);
          }
          console.log(`[userbot] resolved @${botKey} -> id=${entityId || '(none)'}`);
        }
      } catch (e) { console.warn(`[userbot] getEntity @${botKey} failed (will still try to send):`, e && e.message ? e.message : e); }
    }
    console.log(`[userbot] sending to @${botKey} as a user: ${msgPreview(req.text)} (session ${req.sessionId})`);
    const result = await sendBotCommand(req, botKey);
    if (!result) {
      console.log(`[userbot] send to @${botKey} failed on every account — no reply will be sent.`);
      q.busy = false;
      req.resolve(null);
      processBotQueue(botKey);
      return;
    }
    const { acc, sent } = result;
    // If the entity id is still unknown, learn it from the sent message's
    // peer (the conversation peer IS the bot) so its reply can be matched.
    if (!entityId && sent && sent.peerId) {
      const pid = peerUserIdStr(sent.peerId);
      if (pid) { botUserIds.set(botKey, pid); botIdToUsername.set(pid, botKey); entityId = pid; }
    }
    const sentMsgId = sent && sent.id !== undefined ? Number(sent.id) : null;
    console.log(`[userbot] sent to @${botKey} via ${acc.id}, message_id=${sentMsgId} — waiting for the bot's reply (up to ${BOT_REPLY_TIMEOUT_MS / 1000}s).`);
    req.sentMsgId = sentMsgId;
    req.account = acc;
    acc.activeSends += 1;
    q.pending = req;
    req.timer = setTimeout(() => {
      // Timed out (bot did not reply in 30s): resolve with null, no message
      // is sent to the visitor (no canned fallback).
      console.log(`[userbot] TIMEOUT waiting for @${botKey} (no reply in ${BOT_REPLY_TIMEOUT_MS / 1000}s, session ${req.sessionId}).`);
      clearPending(q, req);
      req.resolve(null);
      processBotQueue(botKey);
    }, BOT_REPLY_TIMEOUT_MS);
  } catch (e) {
    console.error('[userbot] send to @' + botKey + ' failed:', e && e.message ? e.message : e);
    clearPending(q, req);
    req.resolve(null);
    processBotQueue(botKey);
  }
}

// Route a visitor's command to a named income bot via the userbot bridge.
// Returns a Promise that resolves with { text, buttons } — the bot's REAL
// reply text plus its inline keyboard (or null when the bot does not reply
// in time / the send fails / the bridge is off). `buttons` is null when the
// reply has no inline keyboard. The reply is NOT sent here — the caller
// pushes it to the visitor with pushToVisitor() (so it appears via WebSocket
// / history polling). The visitor's session id is NEVER included in the text
// sent to the bot.
function sendToIncomeBot(sessionId, botUsername, text) {
  return new Promise((resolve) => {
    if (!isBridgeReady()) { resolve(null); return; }
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

// Wait for a bot's next message after the visitor TAPPED one of its inline
// buttons (the callback was already sent via msg.click). Sets up a pending
// request for that bot so onUserbotMessage routes the bot's response to this
// visitor. Resolves with { text, buttons } or null on timeout / if busy.
function waitForBotReply(sessionId, botKey) {
  return new Promise((resolve) => {
    const q = botQueueFor(botKey);
    if (q.busy || q.pending) { resolve(null); return; } // a command is still in flight — wait for it first
    const pending = { sessionId, text: '', sentMsgId: null, timer: null, resolve };
    pending.timer = setTimeout(() => {
      clearPending(q, pending);
      resolve(null);
      processBotQueue(botKey);
    }, BOT_REPLY_TIMEOUT_MS);
    q.pending = pending;
    q.busy = true;
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

  // /start — the bot's REAL answer to a user: a welcome, not an instruction.
  // (The owner instruction lives under /help now, so the bridge's /start
  // gets a proper bot answer instead of an owner-only message.)
  if (text === '/start') {
    await send('👋 MLA Bot-এ স্বাগতম!\n\nসাইট থেকেই বট চালাতে এখানে মেসেজ লিখুন — /start, /help বা যেকোনো কমান্ড পাঠান, বট নিজে উত্তর দেবে।');
    return;
  }

  // /help — owner live-chat instructions.
  if (text === '/help') {
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
// POST /api/send { session_id?, text, bot? } — forwards a visitor message to the owner.
// `bot` (optional) is the username the visitor picked in the bot selector —
// the message goes to THAT bot via the bridge. Without it, a bot named in
// the text is used, else the message goes to the owner as live chat.
app.post('/api/send', async (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!ipAllowed(ip)) return res.status(429).json({ ok: false, error: 'slow down' });
  const text = String((req.body && req.body.text) || '').trim();
  let sid = String((req.body && req.body.session_id) || '').trim();
  if (!text || text.length > MAX_LEN) return res.status(400).json({ ok: false, error: 'bad text' });
  if (sid && !/^[A-Za-z0-9_\-]{6,32}$/.test(sid)) return res.status(400).json({ ok: false, error: 'bad session' });
  if (!sid) sid = newSessionId();

  const s = getSession(sid);
  // v8: per-session secret — a request for this session must present the
  // secret bound to it on first contact, or it is rejected (403).
  if (!checkSessionSecret(s, req.body && req.body.secret)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const now = Date.now();
  const recent = s.messages.filter((m) => m.from === 'visitor' && now - m.time < 60000).length;
  if (recent >= SEND_LIMIT) return res.status(429).json({ ok: false, error: 'slow down' });

  // The visitor picked a bot in the selector (or named one in the text).
  // Tag the visitor message with that bot so each bot's chat stays separate.
  const pickedBot = findBotByUsername(req.body && req.body.bot);
  const namedBot = pickedBot || findNamedBot(text);
  // v8: a command blocked for this bot is rejected here — it is never
  // stored, never forwarded to Telegram, and the visitor gets error
  // 'blocked' (the page shows "এই কমান্ডটি বন্ধ আছে।"). Live-chat
  // (owner) messages are not affected — blocking only applies to
  // bot-routed commands.
  if (namedBot && isCommandBlocked(namedBot, text)) {
    return res.json({ ok: false, error: 'blocked' });
  }
  const targetBot = namedBot ? namedBot.username : null;
  s.messages.push(newMsg(s, 'visitor', text, null, targetBot));
  s.lastSeen = now;
  lastActiveSessionId = sid;
  // Route the CLEAN command to that bot via the GramJS userbot bridge and
  // send its REAL reply back to this visitor when it arrives. The reply is
  // marked from:'bot' (and tagged with the bot) so the site shows it as the
  // BOT answering in THAT bot's own chat. (No canned reply while waiting.)
  if (namedBot && isBridgeReady()) {
    // When a bot was picked, the text is already the clean command.
    // When it was only named in the text, strip the name out first.
    const cleanText = pickedBot ? text : extractBotCommand(text, namedBot);
    sendToIncomeBot(sid, namedBot.username, cleanText).then((reply) => {
      if (reply && reply.text) pushToVisitor(sid, newMsg(getSession(sid), 'bot', reply.text, reply.buttons || null, namedBot.username, reply.tgMsgId || null));
      // No reply in time / send failed: send nothing (no canned fallback).
    }).catch(() => { /* ignore — no canned fallback */ });
    return res.json({ ok: true, session_id: sid, tg_ok: true, bot_routed: true });
  }
  // If the visitor asked about a connected bot, answer with that bot's real
  // info (no canned text). Otherwise the message goes to the owner as live chat.
  const botAnswer = botCommandAnswer(text);
  if (botAnswer) {
    pushToVisitor(sid, newMsg(s, 'bot', botAnswer));
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

// GET /api/history?session_id=...&secret=... — past messages (reload restores the chat).
app.get('/api/history', (req, res) => {
  const sid = String(req.query.session_id || '');
  if (!/^[A-Za-z0-9_\-]{6,32}$/.test(sid)) return res.status(400).json({ ok: false, error: 'bad session' });
  const s = sessions.get(sid);
  // v8: if this session already has a secret bound, the request must present it.
  if (s && !checkSessionSecret(s, req.query.secret)) return res.status(403).json({ ok: false, error: 'forbidden' });
  res.json({ ok: true, messages: s ? s.messages : [] });
});

// GET /api/bots — list of connected Telegram bots (income bots).
app.get('/api/bots', (req, res) => {
  res.json({ ok: true, bots: connectedBots });
});

// GET /api/bots/:username/commands — the bot's command list, MERGED (v8):
// the bot's REAL commands from the bot itself (via the userbot, GramJS
// GetBotCommands), MINUS any the admin blocked for this bot, PLUS the
// admin's custom commands (label shown as the chip description). /start is
// always included unless it is blocked or already present. When the bot has
// no real commands and no custom ones, the list is just [{command:'start'}].
// Commands are returned WITHOUT the leading '/' (the site's chips add it),
// matching the v7 format — EXCEPT v8.1 plain-text customs, whose `command`
// IS the text itself. Every entry also carries `text`: the EXACT text to
// send ('/name' for slash commands, as-is for plain text). The response
// also carries `blocked` (the bot's blocked entries, slash with '/' and
// plain text as-is) so the page can hide the /start fallback chip when
// /start itself is blocked.
app.get('/api/bots/:username/commands', async (req, res) => {
  const bot = findBotByUsername(req.params.username);
  if (!bot) return res.json({ ok: true, commands: [], blocked: [] });
  // v8.1: blocked entries are either slash ('/withdraw') or plain text.
  const blockedSlash = new Set();
  const blockedPlain = new Set();
  for (const c of (bot.blocked_commands || [])) {
    const s = String(c || '').toLowerCase();
    if (!s) continue;
    if (s.startsWith('/')) blockedSlash.add(s);
    else blockedPlain.add(s);
  }
  const isBlockedSlash = (cmd) => blockedSlash.has('/' + String(cmd).toLowerCase().replace(/^\//, ''));
  const isBlockedPlain = (txt) => blockedPlain.has(String(txt).toLowerCase().trim());
  const blocked = [...blockedSlash, ...blockedPlain];
  // Real commands from the bot itself (via the pool's best account).
  let real = [];
  if (isBridgeReady()) {
    try {
      const lib = telegramLib();
      const client = poolClient();
      const peer = await client.getInputEntity(bot.username);
      const result = await client.invoke(new lib.Api.bots.GetBotCommands({
        scope: new lib.Api.BotCommandScopePeer({ peer }),
        langCode: '',
      }));
      const list = (result && result.commands) || result || [];
      for (const c of (Array.isArray(list) ? list : [])) {
        if (c && c.command) {
          const name = String(c.command).replace(/^\//, '');
          real.push({ command: name, description: String(c.description || ''), text: '/' + name });
        }
      }
    } catch (e) {
      console.error('[userbot] GetBotCommands failed for @' + bot.username + ':', e && e.message ? e.message : e);
      real = [];
    }
  }
  // Remove blocked commands, then append the admin's custom commands.
  // v8.1: dedupe keys are '/name' for slash entries and the full text for
  // plain-text entries (they send different text, so they never collide).
  real = real.filter((c) => !isBlockedSlash(c.command));
  const seen = new Set(real.map((c) => ('/' + c.command).toLowerCase()));
  for (const c of (bot.custom_commands || [])) {
    if (!c || !c.command) continue;
    const raw = String(c.command).trim();
    if (!raw) continue;
    if (raw.startsWith('/')) {
      const cmd = raw.replace(/^\//, '');
      if (isBlockedSlash(cmd) || seen.has(raw.toLowerCase())) continue;
      real.push({ command: cmd, description: String(c.label || ''), text: raw });
      seen.add(raw.toLowerCase());
    } else {
      if (isBlockedPlain(raw) || seen.has(raw.toLowerCase())) continue;
      real.push({ command: raw, description: String(c.label || ''), text: raw });
      seen.add(raw.toLowerCase());
    }
  }
  // Always include /start (unless blocked or already present).
  if (!isBlockedSlash('start') && !seen.has('/start')) real.push({ command: 'start', description: '', text: '/start' });
  return res.json({ ok: true, commands: real, blocked });
});

// POST /api/click { session_id, bot, row, col, tgMsgId? } — the visitor TAPPED
// one of the bot's inline buttons on the site. The userbot clicks that button
// on the real Telegram message (sending the callback to the bot), then the
// bot's response is routed back to this visitor (from:'bot') when it arrives.
// The button is clicked on the message identified by tgMsgId (the real
// Telegram message id, sent with the reply) — re-fetched fresh via
// getMessages, so the tap works even after a server restart or on an older
// message. Falls back to the in-memory stored message when tgMsgId is absent.
app.post('/api/click', async (req, res) => {
  const sid = String((req.body && req.body.session_id) || '').trim();
  const botKey = String((req.body && req.body.bot) || '').toLowerCase().replace(/^@/, '');
  const row = parseInt(req.body && req.body.row, 10);
  const col = parseInt(req.body && req.body.col, 10);
  const tgMsgId = parseInt(req.body && req.body.tgMsgId, 10);
  if (!/^[A-Za-z0-9_\-]{6,32}$/.test(sid) || !botKey || Number.isNaN(row) || Number.isNaN(col)) {
    return res.status(400).json({ ok: false, error: 'bad request' });
  }
  // v8: per-session secret — a click for this session must present the
  // secret bound to it.
  const s = sessions.get(sid);
  if (s && !checkSessionSecret(s, req.body && req.body.secret)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (!isBridgeReady()) return res.json({ ok: false, error: 'bridge off' });
  // Find the button's label (for the log + URL buttons) from the stored reply.
  const stored = botReplyMsgBySession.get(sid);
  let btn = null;
  if (stored && stored.buttons && stored.buttons[row] && stored.buttons[row][col]) {
    btn = stored.buttons[row][col];
  }
  if (btn && btn.url) return res.json({ ok: true, url: btn.url }); // URL button — the site opens the link
  // Resolve the message to click: prefer the real Telegram message (by id),
  // re-fetched fresh so it works after restarts and on older messages.
  let targetMsg = null;
  if (!Number.isNaN(tgMsgId) && tgMsgId) {
    try {
      const client = poolClient();
      const peer = await client.getInputEntity(botKey);
      const msgs = await client.getMessages(peer, { ids: [tgMsgId] });
      if (msgs && msgs[0]) targetMsg = msgs[0];
    } catch (e) {
      console.error('[userbot] getMessages for click failed:', e && e.message ? e.message : e);
    }
  }
  if (!targetMsg && stored && stored.msg && stored.botKey === botKey) targetMsg = stored.msg;
  if (!targetMsg) return res.json({ ok: false, error: 'no button message' });
  // Validate the button exists on the message we are about to click.
  const liveButtons = extractInlineButtons(targetMsg);
  if (!liveButtons || !liveButtons[row] || !liveButtons[row][col]) {
    return res.json({ ok: false, error: 'bad button' });
  }
  const label = (liveButtons[row][col] && liveButtons[row][col].text) || (btn && btn.text) || '';
  if (liveButtons[row][col] && liveButtons[row][col].url) {
    return res.json({ ok: true, url: liveButtons[row][col].url });
  }
  try {
    // Click the button on the real message (sends the callback to the bot).
    await targetMsg.click({ i: row, j: col });
    console.log(`[userbot] clicked @${botKey} button [${row},${col}] ${msgPreview(label)} (session ${sid}) — waiting for the bot's reply.`);
  } catch (e) {
    console.error('[userbot] click failed:', e && e.message ? e.message : e);
    return res.json({ ok: false, error: 'click failed' });
  }
  // Wait for the bot's response and route it back to this visitor.
  // Tag it with the bot's proper username (original case) so the page's
  // per-bot filter (m.bot === selectedBot) matches it.
  const botEntry = findBotByUsername(botKey);
  const botTag = botEntry ? botEntry.username : botKey;
  waitForBotReply(sid, botKey).then((reply) => {
    if (reply && reply.text) pushToVisitor(sid, newMsg(getSession(sid), 'bot', reply.text, reply.buttons || null, botTag, reply.tgMsgId || null));
  }).catch(() => { /* ignore — no canned fallback */ });
  return res.json({ ok: true, clicked: true });
});

// POST /api/admin/bots/sync — replace the connected-bot list (WordPress ADMIN
// panel only). Body: { bots: [{ username, name, description, how_to_earn }],
// secret }. The secret (ADMIN_BOTS_SECRET) lives only in the wp-admin page
// and in Render env vars — it is NEVER on a user-facing page. The list is
// kept in memory and persisted to bots-runtime.json. Returns the bot count.
app.post('/api/admin/bots/sync', (req, res) => {
  if (!ADMIN_BOTS_SECRET || String((req.body && req.body.secret) || '') !== ADMIN_BOTS_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const bots = req.body && req.body.bots;
  if (!Array.isArray(bots)) return res.status(400).json({ ok: false, error: 'bots must be an array' });
  const clean = [];
  for (const b of bots.slice(0, 100)) {
    if (!b || typeof b !== 'object') continue;
    const username = String(b.username || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) continue; // must be a valid bot username
    clean.push({
      username,
      name: String(b.name || username).slice(0, 100),
      description: String(b.description || '').slice(0, 500),
      how_to_earn: String(b.how_to_earn || '').slice(0, 500),
      // v8: per-bot command control (validated: max 20 each, command must
      // start with '/' and be <= 32 chars, label <= 30 chars).
      custom_commands: cleanCustomCommands(b.custom_commands),
      blocked_commands: cleanBlockedCommands(b.blocked_commands),
    });
  }
  connectedBots = clean;
  saveRuntimeBots();
  console.log(`[bots] synced ${connectedBots.length} bot(s) from wp-admin.`);
  return res.json({ ok: true, count: connectedBots.length });
});

// ---------- v8: admin endpoints for Telegram accounts (multi-account pool) ----------
// All of these are protected by the same ADMIN_BOTS_SECRET as
// /api/admin/bots/sync. The secret may arrive in the JSON body (`secret`),
// as a query param, or as the `x-admin-secret` header (GET requests have
// no body). Only the wp-admin "MLA Bots" page knows it.
function adminSecretOk(req) {
  if (!ADMIN_BOTS_SECRET) return false;
  const s = (req.body && req.body.secret) || req.query.secret || req.get('x-admin-secret') || '';
  return String(s) === ADMIN_BOTS_SECRET;
}

// Disconnect and remove one pool account (stops its reconnect timer, drops
// its client, and persists the shorter session list). Called by the admin
// remove endpoint and by accounts/sync when a session leaves the list.
async function removeAccount(acc, save = true) {
  const i = userbotPool.indexOf(acc);
  if (i >= 0) userbotPool.splice(i, 1);
  if (acc.reconnectTimer) { clearTimeout(acc.reconnectTimer); acc.reconnectTimer = null; }
  if (acc.client) { try { await acc.client.disconnect(); } catch (e) { /* ignore */ } acc.client = null; }
  acc.status = 'disconnected';
  if (save) saveRuntimeSessions();
}

// Pending Telegram logins (phone -> { client, phoneCodeHash, createdAt }).
// Kept in server memory only; entries older than 10 minutes are dropped.
const pendingLogins = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [phone, p] of pendingLogins) {
    if (now - p.createdAt > 10 * 60 * 1000) {
      pendingLogins.delete(phone);
      if (p.client) { try { p.client.disconnect(); } catch (e) { /* ignore */ } }
    }
  }
}, 5 * 60 * 1000);

// POST /api/admin/tg-login-start { phone, secret } — start a Telegram login
// for a NEW account (admin only). Sends the OTP code to that phone via
// GramJS and keeps the pending login in server memory. The phone number is
// validated but never logged.
app.post('/api/admin/tg-login-start', async (req, res) => {
  if (!adminSecretOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const lib = telegramLib();
  if (!lib || !TG_API_ID || !TG_API_HASH) return res.json({ ok: false, error: 'userbot not configured' });
  const phone = String((req.body && req.body.phone) || '').trim();
  if (!/^\+?[0-9]{7,15}$/.test(phone)) return res.status(400).json({ ok: false, error: 'bad phone' });
  try {
    const client = new lib.TelegramClient(new lib.StringSession(''), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
    // Register the message handler now so the account is ready the moment
    // it joins the pool (after verify).
    client.addEventHandler(onUserbotMessage, new lib.NewMessage({}));
    await client.connect();
    const sent = await client.sendCode({ apiId: TG_API_ID, apiHash: TG_API_HASH }, phone);
    pendingLogins.set(phone, { client, phoneCodeHash: sent && sent.phoneCodeHash ? sent.phoneCodeHash : '', createdAt: Date.now() });
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, error: e && e.message ? e.message : 'send code failed' });
  }
});

// POST /api/admin/tg-login-verify { phone, code, secret } — verify the OTP
// for a pending login (admin only). On success the account joins the pool,
// its session is persisted to userbot-sessions.json, and the session string
// is RETURNED so wp-admin can save it in wp_options (mla_telegram_sessions)
// for re-sync after a deploy. The session string is a secret: it appears
// ONLY in this response (to wp-admin) — never in logs, never in any other
// response, never in a file except userbot-sessions.json and wp_options.
// If the account has 2FA, signIn throws a password error — the admin panel
// shows that error (2FA password entry is not part of this flow).
app.post('/api/admin/tg-login-verify', async (req, res) => {
  if (!adminSecretOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const lib = telegramLib();
  if (!lib || !TG_API_ID || !TG_API_HASH) return res.json({ ok: false, error: 'userbot not configured' });
  const phone = String((req.body && req.body.phone) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ ok: false, error: 'bad code' });
  const pending = pendingLogins.get(phone);
  if (!pending) return res.json({ ok: false, error: 'no pending login — request a new OTP first' });
  try {
    await pending.client.signIn({ phoneNumber: phone, phoneCodeHash: pending.phoneCodeHash, phoneCode: code });
    const sessionStr = pending.client.session.save();
    pendingLogins.delete(phone);
    // The client is already connected — add it to the pool as a new account.
    const me = await pending.client.getMe().catch(() => null);
    const acc = { id: 'acc' + (nextAccountNum++), client: pending.client, status: 'connected', activeSends: 0, phoneMasked: me && me.phone ? maskPhone(String(me.phone)) : '', coolingUntil: 0, reconnectTries: 0, reconnectTimer: null, sessionStr };
    userbotPool.push(acc);
    saveRuntimeSessions();
    console.log(`[userbot] ${acc.id} added to the pool via admin login (${acc.phoneMasked || 'phone hidden'}).`);
    return res.json({ ok: true, session: sessionStr, account: { id: acc.id, phone: acc.phoneMasked, status: acc.status } });
  } catch (e) {
    const msg = e && e.message ? e.message : 'verify failed';
    // A wrong/expired code ends this pending login — the admin requests a new OTP.
    pendingLogins.delete(phone);
    if (pending.client) { try { pending.client.disconnect(); } catch (err) { /* ignore */ } }
    return res.json({ ok: false, error: msg });
  }
});

// GET /api/admin/accounts — the pool accounts (admin only). Each entry has
// id, masked phone, status and active sends — plus a fingerprint (a short
// hash of the session string) so wp-admin can match an account to the
// session it stored, without the session string ever leaving the server.
app.get('/api/admin/accounts', (req, res) => {
  if (!adminSecretOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  res.json({
    ok: true,
    accounts: userbotPool.map((a) => ({ id: a.id, phone: a.phoneMasked, status: a.status, activeSends: a.activeSends, fingerprint: sessionFingerprint(a.sessionStr) })),
  });
});

// POST /api/admin/accounts/sync { sessions: [...], secret } — replace the
// pool's session list with the one from wp-admin (admin only). New sessions
// are (re)connected, removed ones are disconnected, the runtime file is
// updated. This is what restores the pool after a Render deploy wipes
// userbot-sessions.json. Returns the account count + masked phones.
app.post('/api/admin/accounts/sync', async (req, res) => {
  if (!adminSecretOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const list = req.body && req.body.sessions;
  if (!Array.isArray(list)) return res.status(400).json({ ok: false, error: 'sessions must be an array' });
  const clean = [];
  for (const s of list.slice(0, 10)) {
    if (typeof s === 'string' && s.trim() && !clean.includes(s.trim())) clean.push(s.trim());
  }
  if (!telegramLib() || !TG_API_ID || !TG_API_HASH) {
    return res.json({ ok: false, error: 'userbot not configured' });
  }
  // Disconnect accounts whose session left the list.
  for (const acc of [...userbotPool]) {
    if (!clean.includes(acc.sessionStr)) await removeAccount(acc, false);
  }
  // (Re)connect sessions not already in the pool.
  for (const s of clean) {
    if (!userbotPool.some((a) => a.sessionStr === s)) {
      const acc = { id: 'acc' + (nextAccountNum++), client: null, status: 'disconnected', activeSends: 0, phoneMasked: '', coolingUntil: 0, reconnectTries: 0, reconnectTimer: null, sessionStr: s };
      userbotPool.push(acc);
      connectAccount(acc).catch((e) => console.error('[userbot]', acc.id, e && e.message ? e.message : e));
    }
  }
  saveRuntimeSessions();
  console.log(`[userbot] accounts synced from wp-admin — ${userbotPool.length} account(s) in the pool.`);
  return res.json({ ok: true, count: userbotPool.length, accounts: userbotPool.map((a) => ({ id: a.id, phone: a.phoneMasked, status: a.status })) });
});

// POST /api/admin/accounts/remove { id, secret } — disconnect and remove one
// account from the pool + runtime file (admin only). The matching session
// string is removed from wp_options by the admin panel (by fingerprint).
app.post('/api/admin/accounts/remove', async (req, res) => {
  if (!adminSecretOk(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const id = String((req.body && req.body.id) || '').trim();
  const acc = userbotPool.find((a) => a.id === id);
  if (!acc) return res.json({ ok: false, error: 'not found' });
  await removeAccount(acc, true);
  return res.json({ ok: true });
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

app.get('/health', (req, res) => {
  const connected = userbotPool.filter((a) => a.status === 'connected').length;
  res.json({ ok: true, sessions: sessions.size, userbots: { connected, total: userbotPool.length } });
});

// ---------- WebSocket (realtime visitor <-> server) ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  let sid = url.searchParams.get('session_id') || '';
  if (!sid || !/^[A-Za-z0-9_\-]{6,32}$/.test(sid)) sid = newSessionId();
  const s = getSession(sid);
  // v8: per-session secret — the WS must present the secret bound to this
  // session (first contact binds it). A mismatch closes the socket.
  if (!checkSessionSecret(s, url.searchParams.get('secret') || '')) {
    try { ws.send(JSON.stringify({ type: 'error', error: 'forbidden' })); } catch (e) { /* ignore */ }
    try { ws.close(); } catch (e) { /* ignore */ }
    return;
  }

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
    // v8: every WS send must also carry the session secret.
    if (!checkSessionSecret(s, data.secret)) {
      ws.send(JSON.stringify({ type: 'error', error: 'forbidden' }));
      return;
    }
    const text = String(data.text || '').trim();
    if (!text || text.length > MAX_LEN) return;
    const now = Date.now();
    const recent = s.messages.filter((m) => m.from === 'visitor' && now - m.time < 60000).length;
    if (recent >= SEND_LIMIT) {
      ws.send(JSON.stringify({ type: 'error', error: 'slow down' }));
      return;
    }
    // The visitor picked a bot in the selector (data.bot) or named one in
    // the text. Tag the message with that bot so each bot's chat stays separate.
    const pickedBot = findBotByUsername(data.bot);
    const namedBot = pickedBot || findNamedBot(text);
    // v8: a blocked command is rejected — never stored, never forwarded.
    if (namedBot && isCommandBlocked(namedBot, text)) {
      ws.send(JSON.stringify({ type: 'error', error: 'blocked' }));
      return;
    }
    const targetBot = namedBot ? namedBot.username : null;
    const msg = newMsg(s, 'visitor', text, null, targetBot);
    s.messages.push(msg);
    s.lastSeen = now;
    lastActiveSessionId = sid;
    ws.send(JSON.stringify({ type: 'message', message: msg })); // echo so the sender sees it instantly
    // Route the CLEAN command to that bot via the GramJS userbot bridge;
    // its REAL reply is pushed back when it arrives (from:'bot', tagged).
    if (namedBot && isBridgeReady()) {
      const cleanText = pickedBot ? text : extractBotCommand(text, namedBot);
      sendToIncomeBot(sid, namedBot.username, cleanText).then((reply) => {
        if (reply && reply.text) pushToVisitor(sid, newMsg(getSession(sid), 'bot', reply.text, reply.buttons || null, namedBot.username, reply.tgMsgId || null));
      }).catch(() => { /* ignore — no canned fallback */ });
      return;
    }
    // Connected-bot question? Answer with that bot's real info (no canned text).
    const botAnswer = botCommandAnswer(text);
    if (botAnswer) {
      pushToVisitor(sid, newMsg(s, 'bot', botAnswer));
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
  initUserbotPool().catch((e) => console.error('[userbot]', e && e.message ? e.message : e));
});
