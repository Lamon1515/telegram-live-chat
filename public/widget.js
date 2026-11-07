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
    var row = el('div', 'mla-chat-row ' + (m.from === 'visitor' ? 'mla-chat-row-visitor' : 'mla-chat-row-owner'));
    row.appendChild(el('div', 'mla-chat-bubble', m.text));
    list.appendChild(row);
    if ((m.from === 'owner' || m.from === 'bot') && !isOpen) { unread++; showBadge(); }
    if (save !== false) {
      history.push(m);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      saveHistory();
    }
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
    fetch(API_URL + '/history?session_id=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && d.messages) d.messages.forEach(addMsg); })
      .catch(function () {});
  }
  function connect() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    var url = WS_URL + '?session_id=' + encodeURIComponent(sessionId);
    try { ws = new WebSocket(url); } catch (e) { retryTimer = setTimeout(connect, retryMs); return; }
    ws.onopen = function () { retryMs = 1000; };
    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 'hello' && d.session_id) setSession(d.session_id);
      if (d.type === 'history' && d.messages) d.messages.forEach(addMsg);
      if (d.type === 'message' && d.message) addMsg(d.message);
      if (d.type === 'error') addSys(d.error || 'Error');
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
      body: JSON.stringify({ session_id: sessionId, text: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          if (d.session_id) setSession(d.session_id);
          fetchHistory();
        } else { addSys('Message could not be sent. Please try again.'); }
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
