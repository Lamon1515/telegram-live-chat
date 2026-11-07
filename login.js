// login.js — ONE-TIME GramJS userbot login (run locally, NEVER on Render).
//
// What it does:
//   Logs in with YOUR Telegram account (phone number + the OTP code Telegram
//   sends you, plus your 2FA password if you have one) and PRINTS the GramJS
//   session string. Copy that string into the Render env var TG_SESSION.
//   The server then uses it to act as your user account (the userbot bridge)
//   so it can message income bots on the website's behalf.
//
// How to run (once, on your own computer):
//   1. npm install
//   2. Get api_id / api_hash at https://my.telegram.org/apps (log in, create
//      an app, copy the two values).
//   3. TG_API_ID=123456 TG_API_HASH=abcdef... node login.js
//      (or put TG_API_ID / TG_API_HASH in a local .env file — dotenv loads it)
//   4. Enter your phone number (with country code, e.g. +8801XXXXXXXXX),
//      then the login code Telegram sends you, then your 2FA password
//      if you have one (just press Enter if you do not).
//   5. Copy the printed session string into Render:
//      Render dashboard → your service → Environment → TG_SESSION.
//
// It NEVER saves the session string to any file. Keep it SECRET — it logs in
// as your Telegram account. Never share it, never commit it, never paste it
// into a chat.
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || '';

async function main() {
  if (!TG_API_ID || !TG_API_HASH) {
    console.error('Missing TG_API_ID or TG_API_HASH.');
    console.error('Get them at https://my.telegram.org/apps (log in, create an app, copy api_id and api_hash).');
    console.error('Then run: TG_API_ID=123456 TG_API_HASH=abcdef... node login.js');
    process.exit(1);
  }
  const client = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => await input.text('Enter your phone number (with country code, e.g. +8801XXXXXXXXX): '),
    password: async () => await input.text('Enter your 2FA password (press Enter if you have none): '),
    phoneCode: async () => await input.text('Enter the login code Telegram sent you: '),
    onError: (err) => console.error('Login error:', err && err.message ? err.message : err),
  });
  console.log('\nLogged in. Your GramJS session string — copy it into the Render env var TG_SESSION:\n');
  console.log(client.session.save());
  console.log('\nKeep this string SECRET — it logs in as your Telegram account. Never share or commit it.');
  await client.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
