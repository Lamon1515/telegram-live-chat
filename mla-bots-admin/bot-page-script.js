
(function () {
  'use strict';
  var WS_URL = 'wss://telegram-live-chat-ej29.onrender.com/ws';
  var API_URL = 'https://telegram-live-chat-ej29.onrender.com/api';
  var HISTORY_MAX = 200;
  var sessionId = localStorage.getItem('mla_chat_session') || '';
  // v8: per-session secret — a random 32-hex-char token generated once and
  // stored next to the session id. It is sent with every request for this
  // session; the server binds it on first contact and rejects (403) any
  // later request that does not present it. This stops another browser/tab
  // (or a leaked session id) from reading or sending as this visitor.
  // The secret is never shown in the UI and never logged.
  var sessionSecret = (function () {
    var s = '';
    try { s = localStorage.getItem('mla_chat_secret') || ''; } catch (e) {}
    if (!/^[0-9a-f]{32}$/.test(s)) {
      var bytes = new Uint8Array(16);
      try {
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
        else throw new Error('no crypto');
      } catch (e) {
        for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      s = '';
      for (var k = 0; k < 16; k++) s += ('0' + bytes[k].toString(16)).slice(-2);
      try { localStorage.setItem('mla_chat_secret', s); } catch (e2) {}
    }
    return s;
  })();
  var seen = {};
  var history = [];
  var ws = null, retryMs = 1000, retryTimer = null;
  var bots = [];
  var selectedBot = localStorage.getItem('mla_chat_bot') || '';
  var list = document.getElementById('mla-bot-list');
  var form = document.getElementById('mla-bot-form');
  var input = document.getElementById('mla-bot-input');
  var picker = document.getElementById('mla-bot-picker');
  var cmdsEl = document.getElementById('mla-bot-commands');
  var titleEl = document.getElementById('mla-bot-title');
  var subEl = document.getElementById('mla-bot-sub');
  var avatarEl = document.getElementById('mla-bot-avatar');
  var backBtn = document.getElementById('mla-bot-back');
  // v9.0 (Telegram): the back chevron shows/hides the bot list (chat list),
  // like going back to the chat list in the Telegram app. Tapping it again
  // brings the list back. It never deletes anything. (v9.4: kept as
  // toggle-only — the site header + bottom menu stay visible, so Home is
  // one tap away on the bottom menu; no navigation from this button.)
  if (backBtn) backBtn.addEventListener('click', function () {
    picker.style.display = (picker.style.display === 'none') ? '' : 'none';
  });
  // v9.5 (stability): fit the chat EXACTLY between the site's fixed top
  // header (#mla-topbar) and fixed bottom menu (#bottomNav), so the page
  // never scrolls and neither the header nor the menu ever moves/shakes.
  // v9.4 measured only the header+menu heights — but it did NOT account
  // for the container's offset from the viewport top: the page-title area
  // pushes the chat ~330px down, so the container extended ~330px past the
  // viewport bottom and the composer was cut off. v9.5 measures the
  // container's top offset (getBoundingClientRect().top) and subtracts
  // that too: height = viewport height - topGap - bottomNavH. The header
  // height is no longer needed (topGap already includes everything above
  // the container). Re-measured on resize/orientationchange and shortly
  // after load (the bottom menu can render late). ALL widths — desktop
  // too. Desktop keeps the centred 560px card look; only the height is
  // fitted. Missing chrome falls back to 0 for that side.
  function fitChat() {
    var page = document.getElementById('mla-bot-page');
    if (!page) return;
    var botH = 0;
    var botEl = document.getElementById('bottomNav');
    if (botEl) botH = botEl.offsetHeight || 0;
    var topGap = 0;
    try { topGap = page.getBoundingClientRect().top || 0; } catch (e) { topGap = 0; }
    if (topGap < 0) topGap = 0;
    var h = window.innerHeight - topGap - botH;
    if (h < 200) h = 200;
    // vh fallback first (older browsers ignore the px line after it);
    // the px value is the 100dvh equivalent (innerHeight tracks the
    // dynamic viewport, like dvh does).
    page.style.height = 'calc(100vh - ' + (topGap + botH) + 'px)';
    page.style.height = h + 'px';
  }
  // v9.4: hide the floating "Spin Now" wheel button on this page — it is a
  // fixed floating button that would overlap the full-screen chat. It has
  // no stable id/class, so find it by its visible text and hide the nearest
  // fixed-position ancestor (that also removes its "Remove" ×, part of the
  // same widget). Runs at init and again after a delay (it can load late).
  function hideSpinButton() {
    try {
      var els = document.querySelectorAll('body *');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.children.length === 0 && /spin\s*now/i.test(el.textContent || '')) {
          var node = el;
          for (var d = 0; d < 4 && node; d++) {
            var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
            if (cs && cs.position === 'fixed') { node.style.display = 'none'; return; }
            node = node.parentElement;
          }
          el.style.display = 'none';
          return;
        }
      }
    } catch (e) {}
  }
  // v9.5: hide the redundant page title ("MLA Bot" <h1>) on this page —
  // the chat already has its own "MLA Bot" header, and the title area
  // leaves a ~330px white gap that pushes the composer below the fold.
  // This is NOT the site header/menu (those stay visible — the user's
  // words: "হেডার মেনু লুকাবে কেন?"). Finds the page's <h1> (there is
  // only one, its text is "MLA Bot") and hides it, plus the nearest block
  // parent that contains only the title (so the wrapper's padding/margin
  // gap goes away too). Runs at init, on load, and at 500ms/1500ms (same
  // as hideSpinButton) in case the title renders late.
  function hidePageTitle() {
    try {
      var hs = document.querySelectorAll('h1');
      for (var i = 0; i < hs.length; i++) {
        var h = hs[i];
        if (!/mla\s*bot/i.test(h.textContent || '')) continue;
        h.style.display = 'none';
        var node = h.parentElement;
        for (var d = 0; d < 3 && node; d++) {
          var txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
          var htxt = (h.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && txt === htxt) { node.style.display = 'none'; break; }
          node = node.parentElement;
        }
        return;
      }
    } catch (e) {}
  }
  // v9.0 (Telegram): chat-list avatar colours, cycled per bot (Telegram
  // gives each chat its own avatar colour). v9.4: richer gradients
  // (Telegram-blue family) + a soft ring/shadow on the avatar itself.
  var AVATAR_COLORS = ['linear-gradient(135deg,#4db2e8,#1a8fc4)', 'linear-gradient(135deg,#66bb6a,#2e7d32)', 'linear-gradient(135deg,#ab47bc,#6a1b9a)', 'linear-gradient(135deg,#ffa726,#ef6c00)', 'linear-gradient(135deg,#26c6da,#00838f)', 'linear-gradient(135deg,#ec407a,#ad1457)', 'linear-gradient(135deg,#ef5350,#c62828)', 'linear-gradient(135deg,#7e57c2,#4527a0)'];
  function avatarInitial(b) {
    var ch = String((b && (b.name || b.username)) || '').charAt(0).toUpperCase();
    return ch || '🤖';
  }
  // v9.0 (Telegram): HH:MM timestamp for a bubble (m.time is epoch ms).
  function fmtTime(ms) {
    var d = new Date(ms);
    var h = d.getHours(), mi = d.getMinutes();
    return (h < 10 ? '0' + h : '' + h) + ':' + (mi < 10 ? '0' + mi : '' + mi);
  }
  function historyKey() { return 'mla_chat_history_' + sessionId; }
  function saveHistory() {
    try { localStorage.setItem(historyKey(), JSON.stringify(history.slice(-HISTORY_MAX))); } catch (e) {}
  }
  // v9.4 (stability): smooth-scroll to the bottom only for NEW messages,
  // and only when the visitor is already near the bottom — so a new
  // message never yanks the view while they scroll up to read older
  // messages. History renders (renderHistory/setSession) jump instantly
  // via scrollBottom(false).
  function scrollBottom(smooth) {
    if (smooth) {
      var nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 140;
      if (!nearBottom) return;
      if (list.scrollTo) {
        try { list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); return; }
        catch (e) {}
      }
    }
    list.scrollTop = list.scrollHeight;
  }
  // Per-bot separate chats: only messages tagged with the selected bot are
  // shown. Each bot keeps its own conversation — switching bots shows that
  // bot's messages only (the others stay stored, not deleted).
  function msgVisible(m) {
    if (!m) return false;
    if (!selectedBot) return true; // no bot picked yet — show everything
    // Compare case-insensitively (the server may tag with either case).
    return String(m.bot || '').toLowerCase() === String(selectedBot).toLowerCase();
  }
  // Re-render the chat list for the currently selected bot (used when the
  // visitor switches bots — the other bot's messages stay in history).
  function renderHistory() {
    seen = {};
    list.innerHTML = '';
    history.forEach(function (m) { addMsg(m, false); });
    scrollBottom();
  }
  function addMsg(m, save) {
    if (!m) return;
    // Dedupe by id+time, not id alone: after a server restart the per-session
    // id counter resets to 1, so a new message can reuse an id already stored
    // in localStorage — id alone would wrongly drop it as a duplicate.
    var key = m.id + ':' + (m.time || 0);
    if (seen[key]) return;
    seen[key] = 1;
    // Always keep the message in history (per-bot), but only DISPLAY it when
    // it belongs to the currently selected bot.
    if (save !== false) {
      history.push(m);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      saveHistory();
    }
    if (!msgVisible(m)) return;
    // Bot answers (from:'bot') and owner replies (from:'owner') show on the
    // left; the visitor's own messages show on the right.
    var isLeft = (m.from === 'owner' || m.from === 'bot');
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:6px;' + (isLeft ? 'align-items:flex-start;' : 'align-items:flex-end;');
    // v9.4: only NEW messages get the entrance animation (fade + tiny rise);
    // history re-renders (save === false) stay still — no whole-list flash.
    if (save !== false) row.className = 'mla-msg-in';
    // v9.0 (Telegram bubble): received = white, sent = light Telegram blue
    // (#d6e9f8); rounded 12px with a small tail on the sender side; soft
    // shadow; dark text. The timestamp sits bottom-right inside the bubble
    // (tiny grey); sent messages get blue ✓✓ ticks after the time.
    // v9.4 (premium): 14px radius, richer sent blue (#cde9f8), layered
    // soft shadow, near-black #111 text, bubbles capped at 75% width and
    // long words wrap anywhere so nothing can push the layout sideways.
    // v9.4 (theme): ALL colours are CSS variables (defined in the plugin's wp_head
    // <style id="mla-bot-page-css">) so the bubbles follow the site's dark/light toggle live —
    // no hardcoded theme colours here.
    var b = document.createElement('div');
    b.style.cssText = 'max-width:75%;padding:8px 12px;border-radius:14px;font-size:15px;line-height:1.45;word-break:break-word;overflow-wrap:anywhere;box-shadow:0 1px 2px var(--mla-sh-a),0 4px 12px var(--mla-sh-b);' +
      (isLeft ? 'background:var(--mla-bubble-in);color:var(--mla-text);border-bottom-left-radius:4px;' : 'background:var(--mla-bubble-out);color:var(--mla-text);border-bottom-right-radius:4px;');
    var t = document.createElement('span');
    t.textContent = m.text;
    t.style.cssText = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;';
    b.appendChild(t);
    var timeStr = m.time ? fmtTime(m.time) : '';
    if (timeStr || !isLeft) {
      var meta = document.createElement('span');
      meta.style.cssText = 'float:right;font-size:10px;color:var(--mla-meta);margin:4px 0 0 8px;white-space:nowrap;';
      meta.textContent = timeStr;
      if (!isLeft) {
        var ticks = document.createElement('span');
        ticks.textContent = ' ✓✓';
        ticks.style.color = '#0088cc';
        meta.appendChild(ticks);
      }
      b.appendChild(meta);
    }
    // Inline keyboard: the bot's real options (e.g. "Register", "Balance").
    // Telegram-style: attached under the message text, full-width stacked
    // buttons (light blue-grey, Telegram-blue text). Tapping sends the
    // callback to the bot via /api/click — the bot's real answer comes
    // back as a new message.
    if (m.buttons && m.from === 'bot') renderButtons(b, m.buttons, m.tgMsgId);
    row.appendChild(b);
    list.appendChild(row);
    scrollBottom(save !== false);
  }
  // Render a bot message's inline keyboard, Telegram-style: full-width
  // stacked buttons attached under the message text (light blue-grey
  // background #e8f1f8, Telegram-blue text, rounded corners); a row of
  // buttons stays side-by-side in one row (equal widths).
  // v9.4 (theme): colours are CSS variables — dark mode uses Telegram dark
  // (#2b5278 background, #64b5ef text) and follows the toggle live.
  function renderButtons(bubbleEl, buttons, tgMsgId) {
    var div = document.createElement('div');
    div.style.cssText = 'height:1px;background:var(--mla-border);margin:8px -12px 4px;';
    bubbleEl.appendChild(div);
    buttons.forEach(function (brow, r) {
      var browEl = document.createElement('div');
      browEl.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
      brow.forEach(function (btn, c) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = btn.text;
        // v9.4: .mla-ibtn gives the press feedback (scale + darken) from the
        // snippet's <style> block; the inline shadow keeps it soft even if
        // that block is ever missing.
        chip.className = 'mla-ibtn';
        chip.style.cssText = 'flex:1;padding:9px 8px;border-radius:8px;font-size:14px;font-family:inherit;cursor:pointer;border:none;background:var(--mla-ibtn-bg);color:var(--mla-ibtn-text);text-align:center;box-shadow:0 1px 2px var(--mla-sh-b);';
        chip.addEventListener('click', function () {
          if (btn.url) { window.open(btn.url, '_blank'); return; }
          clickButton(r, c, btn.text, tgMsgId);
        });
        browEl.appendChild(chip);
      });
      bubbleEl.appendChild(browEl);
    });
  }
  // The visitor tapped one of the bot's inline buttons. Send the tap to the
  // server, which clicks it on the real Telegram message (callback to the bot).
  // tgMsgId identifies the exact Telegram message, so the tap works even on
  // an older message or after a server restart.
  function clickButton(row, col, text, tgMsgId) {
    if (!selectedBot) return;
    addSys('👆 ' + text);
    var body = { session_id: sessionId, secret: sessionSecret, bot: selectedBot, row: row, col: col };
    if (tgMsgId) body.tgMsgId = tgMsgId;
    fetch(API_URL + '/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.url) { window.open(d.url, '_blank'); return; }
        if (d && d.ok) fetchHistory();
        else if (d && d.error === 'blocked') addSys('এই কমান্ডটি বন্ধ আছে।');
        else addSys('বাটন কাজ করেনি। আবার চেষ্টা করুন।');
      })
      .catch(function () { addSys('নেটওয়ার্ক সমস্যা। আবার চেষ্টা করুন।'); });
  }
  // v9.0 (Telegram): system lines are centered grey pills, like Telegram's
  // date/service messages — small, rounded, grey text on a light pill.
  // v9.4 (theme): colours are CSS variables (dark: #17212b pill, #7f91a4 text).
  function addSys(text) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:center;margin:4px 0;';
    var b = document.createElement('div');
    b.textContent = text;
    b.style.cssText = 'font-size:12px;color:var(--mla-sys-text);background:var(--mla-sys-bg);padding:5px 12px;border-radius:12px;text-align:center;';
    row.appendChild(b);
    list.appendChild(row);
    scrollBottom(true);
  }
  function loadHistory() {
    history = [];
    try {
      var stored = JSON.parse(localStorage.getItem(historyKey()) || '[]');
      if (Array.isArray(stored)) history = stored.slice(-HISTORY_MAX);
    } catch (e) { history = []; }
    history.forEach(function (m) { addMsg(m, false); });
  }
  function setSession(id) {
    if (id === sessionId && history.length) return;
    sessionId = id;
    localStorage.setItem('mla_chat_session', sessionId);
    seen = {};
    list.innerHTML = '';
    loadHistory();
  }
  function fetchHistory() {
    if (!sessionId) return;
    fetch(API_URL + '/history?session_id=' + encodeURIComponent(sessionId) + '&secret=' + encodeURIComponent(sessionSecret))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && d.messages) d.messages.forEach(addMsg); })
      .catch(function () {});
  }
  // ---- Bot selector: fetch the connected bots and let the visitor pick one.
  // The picked bot is remembered (localStorage) and sent with every message
  // as the `bot` field, so the server routes to THAT bot — no typing the
  // bot's @username needed.
  // v9.0 (Telegram): the picker is Telegram's chat list — each bot is a row
  // with a circular avatar (initial letter on its own colour), the bot name
  // in bold, a preview line (its description), and a ✓ on the selected row.
  function renderPicker() {
    picker.innerHTML = '';
    if (!bots.length) {
      var none = document.createElement('div');
      none.textContent = 'কোনো বট যুক্ত করা হয়নি — অ্যাডমিন প্যানেল থেকে বট যুক্ত করুন।';
      none.style.cssText = 'font-size:13px;color:var(--mla-text2);padding:12px;';
      picker.appendChild(none);
      return;
    }
    bots.forEach(function (b, i) {
      var row = document.createElement('button');
      row.type = 'button';
      var active = (selectedBot === b.username);
      row.style.cssText = 'display:flex;align-items:center;gap:12px;width:100%;padding:10px 12px;background:' + (active ? 'var(--mla-picker-active)' : 'var(--mla-bg)') + ';border:none;border-bottom:1px solid var(--mla-border-soft);cursor:pointer;text-align:left;font-family:inherit;';
      var av = document.createElement('div');
      av.textContent = avatarInitial(b);
      av.style.cssText = 'width:48px;height:48px;flex:0 0 48px;border-radius:50%;background:' + AVATAR_COLORS[i % AVATAR_COLORS.length] + ';color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.18);';
      var tx = document.createElement('div');
      tx.style.cssText = 'flex:1;min-width:0;';
      var nm = document.createElement('div');
      nm.textContent = b.name || b.username;
      nm.style.cssText = 'font-weight:700;font-size:15px;color:var(--mla-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      var pv = document.createElement('div');
      pv.textContent = b.description || b.how_to_earn || 'ট্যাপ করে চ্যাট শুরু করুন';
      pv.style.cssText = 'font-size:13px;color:var(--mla-text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      tx.appendChild(nm);
      tx.appendChild(pv);
      row.appendChild(av);
      row.appendChild(tx);
      if (active) {
        var ck = document.createElement('div');
        ck.textContent = '✓';
        ck.style.cssText = 'color:#0088cc;font-size:18px;font-weight:700;flex:0 0 auto;';
        row.appendChild(ck);
      }
      row.addEventListener('click', function () { selectBot(b.username); });
      picker.appendChild(row);
    });
  }
  function selectBot(username) {
    selectedBot = username;
    try { localStorage.setItem('mla_chat_bot', username); } catch (e) {}
    var b = bots.find(function (x) { return x.username === username; });
    if (b) {
      titleEl.textContent = b.name || b.username;
      avatarEl.textContent = avatarInitial(b);
      subEl.textContent = '@' + b.username + ' • online • v9.5';
      subEl.style.color = '#0088cc';
      addSys('এখন ' + (b.name || b.username) + ' (@' + b.username + ') এর সাথে চ্যাট করছেন। /start পাঠান।');
    }
    renderPicker();
    renderHistory(); // show THIS bot's own messages (per-bot separate chats)
    fetchCommands(username);
  }
  // ---- Bot commands: the selected bot's REAL command list, auto-shown as
  // tappable chips under the picker (like Telegram's command menu). Tapping
  // a command sends it to the bot. Falls back to /start when the bot has no
  // registered commands OR the fetch fails — so a command chip is ALWAYS
  // visible from the start. (v8: the list already merges the bot's real
  // commands with the admin's custom commands, minus blocked ones. When
  // /start itself is blocked, no fallback chip is shown — tapping a blocked
  // command would only show "এই কমান্ডটি বন্ধ আছে।".)
  // (v8.1: each entry carries `text` — the EXACT text to send. Slash
  // commands send '/name'; plain-text customs (e.g. "ব্যালেন্স") send the
  // text as-is, and the chip shows the label instead of a '/' command.)
  // v9.0 (Telegram): command chips are soft grey pills (#f0f2f5, dark text),
  // like Telegram's bot-command menu.
  function renderCommandChips(cmds, blocked) {
    cmdsEl.innerHTML = '';
    var blockedList = blocked || [];
    var startBlocked = blockedList.some(function (b) { return String(b).toLowerCase() === '/start'; });
    if (!cmds.length && !startBlocked) cmds = [{ command: 'start', description: '' }];
    cmds.forEach(function (c) {
      var sendText = c.text || ('/' + c.command);
      var chip = document.createElement('button');
      chip.type = 'button';
      if (sendText.charAt(0) === '/') {
        chip.textContent = '/' + c.command + (c.description ? ' — ' + c.description : '');
        chip.title = c.description || ('/' + c.command);
      } else {
        chip.textContent = c.description || sendText;
        chip.title = sendText;
      }
      chip.style.cssText = 'flex:0 0 auto;padding:6px 12px;border-radius:16px;font-size:13px;font-family:inherit;cursor:pointer;border:none;background:var(--mla-chip-bg);color:var(--mla-chip-text);box-shadow:0 1px 3px var(--mla-sh-a);';
      // v9.4: .mla-chip gives the gentle press (scale + darken) from the
      // snippet's <style> block.
      chip.className = 'mla-chip';
      chip.addEventListener('click', function () { send(sendText); });
      cmdsEl.appendChild(chip);
    });
  }
  function fetchCommands(username) {
    cmdsEl.innerHTML = '';
    if (!username) { renderCommandChips([]); return; }
    fetch(API_URL + '/bots/' + encodeURIComponent(username) + '/commands')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var cmds = (d && d.ok && Array.isArray(d.commands)) ? d.commands : [];
        var blocked = (d && Array.isArray(d.blocked)) ? d.blocked : [];
        renderCommandChips(cmds, blocked);
      })
      .catch(function () { renderCommandChips([]); }); // fetch failed — still show /start
  }
  function fetchBots() {
    fetch(API_URL + '/bots')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && Array.isArray(d.bots)) {
          bots = d.bots;
          // Auto-select: the remembered bot, else the first bot.
          if (!bots.find(function (x) { return x.username === selectedBot; })) {
            selectedBot = bots.length ? bots[0].username : '';
            try { localStorage.setItem('mla_chat_bot', selectedBot); } catch (e) {}
          }
          if (selectedBot) {
            var b = bots.find(function (x) { return x.username === selectedBot; });
            if (b) {
              titleEl.textContent = b.name || b.username;
              avatarEl.textContent = avatarInitial(b);
              subEl.textContent = '@' + b.username + ' • online • v9.5';
              subEl.style.color = '#0088cc';
            }
            fetchCommands(selectedBot);
          }
          renderPicker();
        }
      })
      .catch(function () {});
  }
  function connect() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    var url = WS_URL + '?session_id=' + encodeURIComponent(sessionId) + '&secret=' + encodeURIComponent(sessionSecret);
    try { ws = new WebSocket(url); } catch (e) { retryTimer = setTimeout(connect, retryMs); return; }
    ws.onopen = function () { retryMs = 1000; };
    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 'hello' && d.session_id) setSession(d.session_id);
      if (d.type === 'history' && d.messages) d.messages.forEach(addMsg);
      if (d.type === 'message' && d.message) addMsg(d.message);
      if (d.type === 'error') addSys(d.error === 'blocked' ? 'এই কমান্ডটি বন্ধ আছে।' : (d.error || 'Error'));
    };
    ws.onclose = function () {
      ws = null;
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function send(text) {
    // Send via REST, not WebSocket: the WS echo proved unreliable from this
    // page (messages sent over a stale/half-open socket never reach the
    // server and no error shows). REST /api/send is proven to work
    // (tg_ok:true) and CORS is enabled on the server, so use it as the
    // primary path. WS stays connected only for receiving replies.
    // Include the selected bot so the server routes to THAT bot.
    var body = { session_id: sessionId, secret: sessionSecret, text: text };
    if (selectedBot) body.bot = selectedBot;
    fetch(API_URL + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          if (d.session_id) setSession(d.session_id);
          fetchHistory();
        } else if (d && d.error === 'blocked') { addSys('এই কমান্ডটি বন্ধ আছে।'); }
        else { addSys('মেসেজ পাঠানো যায়নি। আবার চেষ্টা করুন।'); }
      })
      .catch(function () { addSys('নেটওয়ার্ক সমস্যা। আবার চেষ্টা করুন।'); });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });
  // v9.5: fit the chat between the fixed header + bottom menu, hide the
  // floating Spin Now button, and hide the redundant page title. Re-fit
  // on resize/orientationchange and again shortly after load (the bottom
  // menu and the title can render late, after this script).
  fitChat();
  hideSpinButton();
  hidePageTitle();
  window.addEventListener('resize', fitChat);
  window.addEventListener('orientationchange', fitChat);
  window.addEventListener('load', function () { fitChat(); hideSpinButton(); hidePageTitle(); });
  setTimeout(function () { fitChat(); hideSpinButton(); hidePageTitle(); }, 500);
  setTimeout(function () { fitChat(); hideSpinButton(); hidePageTitle(); }, 1500);
  if (sessionId) loadHistory();
  fetchBots();
  connect();
  fetchHistory();
  // Poll history every 10s as a fallback so bot replies still arrive
  // even if the WebSocket drops (WS stays the fast path for replies).
  setInterval(fetchHistory, 10000);
  // LIVE commands: re-fetch the selected bot's command list every 60s so a
  // change on the bot's side shows up here too (old commands disappear,
  // new ones appear — like Telegram's command menu).
  setInterval(function () { if (selectedBot) fetchCommands(selectedBot); }, 60000);
})();
