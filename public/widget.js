// MLA Live Chat widget — standalone, with localStorage history.
// Load after setting:
//   window.MLA_CHAT_WS_URL  = 'wss://your-server/ws';
//   window.MLA_CHAT_API_URL = 'https://your-server/api';
// If not set, it uses the same host that served this file.
// History (visitor messages + owner replies) is saved in localStorage, so it
// survives page refresh, tab close and server restarts (per browser/device).
(function () {
  'use strict';
  var WS_URL = window.MLA_CHAT_WS_URL || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  var API_URL = window.MLA_CHAT_API_URL || (location.origin + '/api');
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
  var lastSeen = parseInt(localStorage.getItem('mla_chat_lastseen') || '0', 10) || 0;
  var isOpen = false, unread = 0, ws = null, retryMs = 1000, retryTimer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var btn = el('button', 'mla-chat-btn');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Live chat');
  btn.innerHTML = '<span class="mla-chat-btn-icon">💬</span><span class="mla-chat-badge" style="display:none">0</span>';
  var badge = btn.querySelector('.mla-chat-badge');

  var panel = el('div', 'mla-chat-panel');
  panel.style.display = 'none';
  var head = el('div', 'mla-chat-head');
  head.appendChild(el('div', 'mla-chat-title', 'Live Chat'));
  head.appendChild(el('div', 'mla-chat-sub', 'Typically replies within a few minutes'));
  var closeBtn = el('button', 'mla-chat-close', '✕');
  closeBtn.type = 'button';
  head.appendChild(closeBtn);
  var list = el('div', 'mla-chat-list');
  var form = el('form', 'mla-chat-form');
  var input = el('input', 'mla-chat-input');
  input.type = 'text';
  input.placeholder = 'Type your message…';
  input.maxLength = 1000;
  input.autocomplete = 'off';
  var sendBtn = el('button', 'mla-chat-send', '➤');
  sendBtn.type = 'submit';
  sendBtn.setAttribute('aria-label', 'Send');
  form.appendChild(input);
  form.appendChild(sendBtn);
  panel.appendChild(head);
  panel.appendChild(list);
  panel.appendChild(form);
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  function historyKey() { return 'mla_chat_history_' + sessionId; }
  function saveHistory() {
    try { localStorage.setItem(historyKey(), JSON.stringify(history.slice(-HISTORY_MAX))); } catch (e) { /* storage full/blocked */ }
  }
  function loadHistory() {
    history = [];
    try {
      var stored = JSON.parse(localStorage.getItem(historyKey()) || '[]');
      if (Array.isArray(stored)) history = stored.slice(-HISTORY_MAX);
    } catch (e) { history = []; }
    history.forEach(function (m) { addMsg(m, false); });
    unread = history.filter(function (m) { return (m.from === 'owner' || m.from === 'bot') && (m.id || 0) > lastSeen; }).length;
    showBadge();
  }
  function setSession(id) {
    if (id === sessionId && history.length) return; // already on this session
    sessionId = id;
    localStorage.setItem('mla_chat_session', sessionId);
    seen = {};
    list.innerHTML = '';
    loadHistory();
  }

  function scrollBottom() { list.scrollTop = list.scrollHeight; }
  function showBadge() {
    if (unread > 0) { badge.style.display = 'block'; badge.textContent = unread > 9 ? '9+' : String(unread); }
    else { badge.style.display = 'none'; }
  }
  function addMsg(m, save) {
    if (!m) return;
    // Dedupe by id+time, not id alone: after a server restart the per-session
    // id counter resets to 1, so a new message can reuse an id already stored
    // in localStorage — id alone would wrongly drop it as a duplicate.
    var key = m.id + ':' + (m.time || 0);
    if (seen[key]) return;
    seen[key] = 1;
    // Always keep the message in history, but only DISPLAY it when it is a
    // live-chat message (no bot tag) or belongs to the bot currently selected
    // on the MLA Bot page — each bot's chat stays separate.
    if (save !== false) {
      history.push(m);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      saveHistory();
    }
    var selBot = '';
    try { selBot = localStorage.getItem('mla_chat_bot') || ''; } catch (e) {}
    // Compare case-insensitively (the server may tag with either case).
    if (m.bot && selBot && String(m.bot).toLowerCase() !== String(selBot).toLowerCase()) return; // another bot's message — hidden here
    if (m.bot && !selBot) return; // a bot message but no bot selected — hidden here
    var row = el('div', 'mla-chat-row ' + (m.from === 'visitor' ? 'mla-chat-row-visitor' : 'mla-chat-row-owner'));
    var bubble = el('div', 'mla-chat-bubble', m.text);
    row.appendChild(bubble);
    // Inline keyboard: the bot's real options. Rendered as tappable buttons
    // under the bot's message; tapping clicks the button on the real message.
    if (m.buttons && m.from === 'bot') {
      m.buttons.forEach(function (brow, r) {
        var browEl = el('div', 'mla-chat-btn-row');
        brow.forEach(function (btn, c) {
          var chip = el('button', 'mla-chat-opt-btn', btn.text);
          chip.type = 'button';
          chip.addEventListener('click', function () {
            if (btn.url) { window.open(btn.url, '_blank'); return; }
            clickButton(r, c, btn.text, m.tgMsgId);
          });
          browEl.appendChild(chip);
        });
        row.appendChild(browEl);
      });
    }
    list.appendChild(row);
    if ((m.from === 'owner' || m.from === 'bot') && !isOpen) { unread++; showBadge(); }
    scrollBottom();
  }
  function addSys(text) {
    var row = el('div', 'mla-chat-row mla-chat-row-sys');
    row.appendChild(el('div', 'mla-chat-bubble', text));
    list.appendChild(row);
    scrollBottom();
  }
  function fetchHistory() {
    if (!sessionId) return;
    fetch(API_URL + '/history?session_id=' + encodeURIComponent(sessionId) + '&secret=' + encodeURIComponent(sessionSecret))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && d.messages) d.messages.forEach(addMsg); })
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
    // Send via REST, not WebSocket: the WS echo proved unreliable from the
    // site page (messages over a stale/half-open socket never reach the
    // server and no error shows). REST /api/send is proven to work and
    // CORS is enabled, so use it as the primary path. WS stays connected
    // only for receiving owner replies.
    fetch(API_URL + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, secret: sessionSecret, text: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          if (d.session_id) setSession(d.session_id);
          fetchHistory();
        } else if (d && d.error === 'blocked') { addSys('এই কমান্ডটি বন্ধ আছে।'); }
        else { addSys('Message could not be sent. Please try again.'); }
      })
      .catch(function () { addSys('Network error. Please try again.'); });
  }
  function clickButton(row, col, text, tgMsgId) {
    // The bot the visitor picked on the MLA Bot page (shared localStorage).
    var bot = '';
    try { bot = localStorage.getItem('mla_chat_bot') || ''; } catch (e) {}
    if (!bot) { addSys('প্রথমে MLA Bot পেজ থেকে একটি বট বেছে নিন।'); return; }
    addSys('👆 ' + text);
    var body = { session_id: sessionId, secret: sessionSecret, bot: bot, row: row, col: col };
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
      .catch(function () { addSys('Network error. Please try again.'); });
  }
  function toggle(openIt) {
    isOpen = openIt;
    panel.style.display = isOpen ? 'flex' : 'none';
    btn.querySelector('.mla-chat-btn-icon').textContent = isOpen ? '✕' : '💬';
    if (isOpen) {
      unread = 0; showBadge();
      if (history.length) { lastSeen = history[history.length - 1].id || lastSeen; localStorage.setItem('mla_chat_lastseen', String(lastSeen)); }
      scrollBottom(); input.focus();
    }
  }
  btn.addEventListener('click', function () { toggle(!isOpen); });
  closeBtn.addEventListener('click', function () { toggle(false); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });
  if (sessionId) loadHistory();
  connect();
  fetchHistory();
  // Poll history every 10s as a fallback so owner replies still arrive
  // even if the WebSocket drops (WS stays the fast path for replies).
  setInterval(fetchHistory, 10000);
})();
