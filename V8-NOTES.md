# v8 — Notes (2026-11-07, night)

## What changed per file

- **server.js** (full v8)
  - Per-bot command control: `cleanCustomCommands()` / `cleanBlockedCommands()` /
    `isCommandBlocked()`; `POST /api/admin/bots/sync` validates and stores
    `custom_commands` + `blocked_commands`; `GET /api/bots/:username/commands`
    returns the MERGED list (real GramJS commands − blocked + custom,
    `/start` always included unless blocked); `POST /api/send` and the WS
    send path reject a blocked command with `{ok:false, error:'blocked'}`
    (never stored, never forwarded to Telegram). Live-chat (owner) messages
    are not affected.
  - Session secret: `checkSessionSecret()` — first contact binds a random
    32-hex-char secret to the session (stored in memory, never logged);
    later `/api/send`, `/api/history`, `/api/click` and WS requests for that
    session must present the same secret or get 403. Session object gains a
    `secret` field.
  - Logging: `msgPreview()` — userbot/forwarding logs carry only bot
    username, message length, first 15 chars, event type. No full visitor
    message or bot reply is logged anywhere. (The owner's `/list` Telegram
    message still shows the visitor's last text (60 chars) — that goes to
    the owner only, who is the intended recipient; it is not a server log.)
  - Multi-account pool: `userbotPool` (`acc1`, `acc2`, …) replaces the single
    `userbotClient`/`userbotReady`. `pickUserbot()` chooses the connected
    account with the fewest active sends. `sendBotCommand()` retries ONCE
    with the next-best account on FloodWait (account cools for the wait
    seconds, capped 60s) or disconnect (account marked disconnected,
    reconnect backoff starts). `connectAccount()` / `scheduleReconnect()`
    (1s, 5s, 15s, 30s, then 60s, max 10 tries) / `markAccountDisconnected()`
    plus a 30s watchdog on `client.connected`. `GET /health` reports
    `userbots: {connected, total}`. `clearPending()` releases the sending
    account's active-send slot on reply/timeout/error.
  - New admin endpoints (all `ADMIN_BOTS_SECRET`-protected, same secret as
    bots/sync; it may come in the JSON body, a `?secret=` query param, or
    the `x-admin-secret` header): `POST /api/admin/tg-login-start`,
    `POST /api/admin/tg-login-verify` (returns the session string — ONLY
    here, to wp-admin), `GET /api/admin/accounts`, `POST
    /api/admin/accounts/sync`, `POST /api/admin/accounts/remove`.
  - Sessions: env `TG_SESSION` / `TG_SESSION_2` / `TG_SESSION_3` or
    `TG_SESSIONS` (JSON array); `userbot-sessions.json` (runtime file)
    overrides the env baseline when present — same precedence as
    bots.json vs bots-runtime.json. `saveRuntimeSessions()` persists the pool.
  - One-line comment near the bots loading: new bots added in wp-admin must
    ALSO be added to `bots.json` in the repo or they vanish from the
    baseline on the next deploy.
  - All v7 behaviour kept: bot selector, per-bot separate chats, live
    commands (60s refresh), inline-keyboard buttons with tgMsgId clicks,
    case-insensitive bot filtering, hidden session-id routing, bots.json
    baseline fallback, `/health`, `/api/bots`, `/api/send`, `/api/click`, WS.
- **public/widget.js** — generates/stores the session secret
  (`mla_chat_secret` in localStorage, 32 hex chars via
  `crypto.getRandomValues`), sends it in `/api/send`, `/api/history`
  (query param), `/api/click`, and the WS URL; shows
  "এই কমান্ডটি বন্ধ আছে।" when a send is rejected as blocked.
- **public/bot-page-snippet.html** — same secret handling as the widget;
  blocked-send toast; commands row now receives the `blocked` list from the
  server and hides the `/start` fallback chip when `/start` itself is
  blocked. Header version string left as **v7** (bump at deploy time).
- **mla-bots-admin.php** — add-bot form gains "Custom commands" (textarea,
  one per line `label|command`) and "Blocked commands" (comma-separated);
  the bot list shows each bot's custom/blocked commands and has an
  ✏️ সম্পাদনা button that pre-fills the form (Add becomes "সংরক্ষণ করুন").
  New **"Telegram অ্যাকাউন্ট"** section below the bots: account list
  (masked phone, status, active sends, Remove), add-account form (phone →
  "OTP পাঠান" → OTP → "Verify"), and an accounts Sync button. The page
  auto-syncs accounts on open via a **server-side** AJAX action
  (`mla_accounts_sync`, wp_remote_post from PHP) — session strings never
  enter the browser. New AJAX actions: `mla_bots_save_session` (store one
  session string), `mla_accounts_sync`, `mla_accounts_remove` (by
  fingerprint = first 12 hex chars of SHA-256(session)). The existing
  `ADMIN_BOTS_SECRET` value is preserved unchanged (it was already in this
  file in v7).
- **bots.json** — both baseline bots now carry `"custom_commands":[]` and
  `"blocked_commands":[]` (documents the v8 shape; empty = no change).
- **README.md** — new "v8" section (command control, session secret, pool
  env vars, admin accounts section, new endpoints).

## New endpoints (server)

| Endpoint | Purpose |
|---|---|
| `GET /api/bots/:username/commands` | MERGED commands (real − blocked + custom + `/start`); also returns `blocked: [...]` |
| `POST /api/admin/tg-login-start` | `{phone, secret}` → sends OTP to a new account (admin) |
| `POST /api/admin/tg-login-verify` | `{phone, code, secret}` → joins the pool, persists session, **returns the session string** (wp-admin only) |
| `GET /api/admin/accounts` | Pool accounts: id, masked phone, status, activeSends, fingerprint (no session strings) |
| `POST /api/admin/accounts/sync` | `{sessions:[...], secret}` → replace pool list (re-sync after deploy) |
| `POST /api/admin/accounts/remove` | `{id, secret}` → disconnect + remove one account |

## New env vars

- `TG_SESSION_2`, `TG_SESSION_3` — extra userbot sessions (optional).
- `TG_SESSIONS` — JSON array of session strings (alternative to the three
  separate vars). `userbot-sessions.json` (runtime, written by the admin
  endpoints) overrides the env baseline when it exists.
- No new npm dependencies. No AI, no canned replies.

## Verification done here (no deploy)

- `node --check server.js` — OK. `node --check public/widget.js` — OK.
  Snippet JS extracted and `node --check` — OK. Admin-panel JS extracted
  (PHP tags replaced with dummies) and `node --check` — OK.
- Live smoke test (dummy token, no Telegram): `/health` returns
  `userbots:{connected:0,total:0}`; `/api/bots` returns the 2 baseline bots;
  commands (bridge off) returns just `/start`; a sync with custom
  `[{label:'ব্যালেন্স',command:'/balance'}]` + blocked
  `['/withdraw','/admin']` is stored (bad entries dropped, dupes deduped,
  40-char label truncated to 30); merged commands return the custom chip +
  `/start` + `blocked` list; a blocked send returns `{ok:false,
  error:'blocked'}` (case-insensitive); a plain-text message to the bot is
  NOT blocked; session secret binds on first send and a wrong/missing
  secret gets 403 on history and send; admin endpoints reject a bad secret
  (403); `tg-login-start` with no TG creds returns `userbot not configured`
  (no crash). Test `bots-runtime.json` created by the smoke test was
  deleted afterwards.
- **PHP syntax NOT lint-checked** — no PHP binary on this VM (`php -l`
  unavailable). Run `php -l mla-bots-admin.php` before uploading the
  plugin, and verify the admin page renders.

## Known limitations / things to check at deploy

- **2FA accounts:** `tg-login-verify` does not handle a 2FA password. If
  the account has 2FA, verify returns the password error and the admin
  must use an account without 2FA (or the `login.js` flow, which asks for
  the 2FA password).
- **wp_remote_post from InfinityFree:** the accounts auto-sync runs
  server-side in PHP (`mla_accounts_sync_to_server`, 45s timeout). If
  InfinityFree blocks outbound POSTs to Render, the auto-sync will fail
  with a visible error in the admin panel; the add-account flow still
  works (verify adds the account to the pool directly), but the pool will
  not self-restore after a deploy until the sync succeeds. Check the
  accounts section status message after the first deploy.
- **Commands endpoint format:** commands are returned WITHOUT the leading
  `/` (e.g. `{command:'start'}`), matching v7 chip rendering (the chips
  add `/`). The task's `[{command:'/start'}]` is the same command, slash
  added by the chip.
- **`/list` (owner Telegram):** still shows the visitor's last message
  (60 chars) to the owner — the owner is the intended recipient, so this
  is not a log leak.
- **Render cold start:** the first accounts sync after a deploy may take
  30–60s (Render waking up); the admin page shows the sync status.

## Deploy steps (for the parent agent — nothing deployed here)

1. **GitHub** (repo `Lamon1515/telegram-live-chat`, main): upload
   `server.js`, `public/widget.js`, `public/bot-page-snippet.html`,
   `bots.json`, `README.md` (and `V8-NOTES.md` if keeping notes in the
   repo). Commit message e.g. "v8: per-bot command control, session
   secret, multi-account userbot pool + auto-shift".
2. **Render** (service `telegram-live-chat-ej29`): Manual Deploy of the
   latest commit; wait for "Deploy succeeded | Live". Verify
   `GET /health` returns `ok:true` + `userbots:{connected:1,total:1}`
   (the existing TG_SESSION is still the primary account — no new env
   vars are required for v8 to run; add `TG_SESSION_2`/`TG_SESSION_3`
   later if Lemon adds a second account). Verify `GET /api/bots`
   returns both bots immediately after the deploy (bots.json baseline).
3. **WordPress — MLA Bot page** (`?page_id=1777`): upload the new
   `bot-page-snippet.html` via the TEMP upload helper (as .txt) and
   re-apply with the apply helper (snippet 28), exactly as in v5–v7.
   Bump the header version string to **v8** at this point (it is still
   v7 in the file). Deactivate both helpers afterwards. Empty W3TC.
   Verify the page shows v8 + both bot tabs + the /start chip.
4. **WordPress — MLA Bots admin plugin**: re-upload `mla-bots-admin.php`
   (Code Snippets, "Only run in administration area", Activate — it
   replaces the v7 version). Open wp-admin → MLA Bots and verify: the
   bots list shows (with the new Custom/Blocked columns), the
   "Telegram অ্যাকাউন্ট" section shows the existing account (masked
   phone, connected), and no error appears. The page auto-syncs bots +
   accounts on open.
5. **Re-sync check:** after the deploy, `GET /api/bots` must still list
   both bots and `GET /api/admin/accounts` (via the admin page) must show
   the pool account — if the accounts section is empty, click
   "🔄 অ্যাকাউন্ট Sync" once.
6. **Live test (Lemon's phone is the acceptance check):** open the MLA
   Bot page, pick "gmail", send `/start`, tap a button; also try a
   blocked command after blocking one in the admin panel (expect
   "এই কমান্ডটি বন্ধ আছে।").
