<?php
/**
 * Plugin Name: MLA Bots — Admin Panel
 * Description: WordPress admin panel (wp-admin only) to manage the connected Telegram income bots and the Telegram user accounts that power the userbot bridge. Saves to wp_options and syncs to the Render live-chat server. Never a user page.
 * Version: 1.1.11
 * Author: MLA
 *
 * MLA Bots — Admin Panel (wp-admin only, NEVER a user page)
 *
 * Adds a "MLA Bots" page under the WordPress admin menu where the site owner
 * manages (a) the connected Telegram income bots (username, name,
 * description, how_to_earn, plus v8 per-bot command control) and (b) the
 * Telegram user accounts that power the userbot bridge (multi-account pool).
 *
 * BOTS: the list is saved in wp_options (mla_connected_bots) and pushed to
 * the Render live-chat server via POST /api/admin/bots/sync so the GramJS
 * userbot bridge can operate those bots from the site.
 *
 * ACCOUNTS: the session strings are saved in wp_options
 * (mla_telegram_sessions) and pushed to the Render server via POST
 * /api/admin/accounts/sync (server-side, from PHP — the session strings
 * NEVER appear in the page HTML, the browser, or any log). The server keeps
 * them in userbot-sessions.json; a deploy wipes that file, and opening this
 * page re-syncs the pool automatically. A new account is added by phone +
 * OTP (the OTP goes to that phone); the returned session string is saved
 * into wp_options straight away.
 *
 * FRONT-END (v9.8): this plugin also enqueues the MLA Bot page's chat
 * JavaScript (bot-page-script.js) in the footer, only on page 1777. The
 * page block holds HTML + CSS only — an inline <script> there never runs
 * because the theme loads page content client-side. See the
 * wp_enqueue_scripts hook below.
 *
 * SECURITY: The sync secret (ADMIN_BOTS_SECRET) is embedded here and in the
 * Render env vars only. This snippet is visible ONLY inside wp-admin to
 * administrators — it is never on a user-facing page. Do NOT copy this code
 * into a public page or the theme. Session strings are secrets: they are
 * never rendered, never logged, and only ever sent to Render (via the
 * server-side sync) or to wp-admin (to be stored).
 *
 * Install: Code Snippets → Add New → paste this whole file → "Only run in
 * administration area" → Save & Activate. (Or add to a small plugin.)
 */

if (!defined('ABSPATH')) exit;

// --- Config: keep these in sync with the Render service ---
define('MLA_BOTS_RENDER_URL', 'https://telegram-live-chat-ej29.onrender.com');
define('MLA_BOTS_SYNC_SECRET', '0db415fe555d521b53a147f4f9e8423b201ed29ff447d08c'); // ADMIN_BOTS_SECRET — same value as the Render env var
define('MLA_BOTS_OPTION', 'mla_connected_bots');
define('MLA_BOTS_SESSIONS_OPTION', 'mla_telegram_sessions');
define('MLA_BOTS_LAST_SYNC_OPTION', 'mla_bots_last_sync'); // Unix timestamp of the last successful bots sync to Render

// --- v8: clean one bot entry (username, name, description, how_to_earn,
// custom_commands, blocked_commands). Custom commands: [{label, command}],
// label <= 30 chars, max 20. v8.1: the command is the exact text to send —
// a slash command ('/...', <= 32 chars) or plain text (<= 64 chars).
// Blocked entries: slash ('/withdraw', <= 32 chars) or plain text
// (<= 64 chars), max 20.
function mla_bots_clean_one($b) {
    if (!is_array($b)) return null;
    $u = isset($b['username']) ? preg_replace('/^@/', '', sanitize_text_field($b['username'])) : '';
    if (!preg_match('/^[A-Za-z0-9_]{5,32}$/', $u)) return null;
    $custom = array();
    if (isset($b['custom_commands']) && is_array($b['custom_commands'])) {
        foreach (array_slice($b['custom_commands'], 0, 20) as $c) {
            if (!is_array($c)) continue;
            $label = isset($c['label']) ? sanitize_text_field($c['label']) : '';
            $cmd = isset($c['command']) ? sanitize_text_field($c['command']) : '';
            if ($label === '' || $cmd === '') continue;
            if (strpos($cmd, '/') === 0) {
                if (!preg_match('/^\/[A-Za-z0-9_]{1,31}$/', $cmd) || strlen($cmd) > 32) continue;
            } elseif (mb_strlen($cmd) > 64) continue;
            $label = mb_substr($label, 0, 30);
            $dup = false;
            foreach ($custom as $o) { if (strtolower($o['command']) === strtolower($cmd)) { $dup = true; break; } }
            if ($dup) continue;
            $custom[] = array('label' => $label, 'command' => $cmd);
        }
    }
    $blocked = array();
    if (isset($b['blocked_commands']) && is_array($b['blocked_commands'])) {
        foreach (array_slice($b['blocked_commands'], 0, 20) as $c) {
            $cmd = strtolower(sanitize_text_field($c));
            if ($cmd === '') continue;
            if (strpos($cmd, '/') === 0) {
                if (!preg_match('/^\/[a-z0-9_]{1,31}$/', $cmd) || strlen($cmd) > 32) continue;
            } elseif (mb_strlen($cmd) > 64) continue;
            if (!in_array($cmd, $blocked, true)) $blocked[] = $cmd;
        }
    }
    return array(
        'username'        => $u,
        'name'            => isset($b['name']) ? sanitize_text_field($b['name']) : $u,
        'description'     => isset($b['description']) ? sanitize_textarea_field($b['description']) : '',
        'how_to_earn'     => isset($b['how_to_earn']) ? sanitize_textarea_field($b['how_to_earn']) : '',
        'custom_commands' => $custom,
        'blocked_commands'=> $blocked,
    );
}

function mla_bots_get_list() {
    $bots = get_option(MLA_BOTS_OPTION, array());
    if (!is_array($bots)) $bots = array();
    $clean = array();
    foreach ($bots as $b) {
        $c = mla_bots_clean_one($b);
        if ($c) $clean[] = $c;
    }
    return $clean;
}

// The stored Telegram userbot sessions (opaque strings). Returned only to
// server-side code — NEVER printed into the page.
function mla_bots_get_sessions() {
    $s = get_option(MLA_BOTS_SESSIONS_OPTION, array());
    if (!is_array($s)) return array();
    $out = array();
    foreach ($s as $v) {
        if (is_string($v) && trim($v) !== '' && !in_array(trim($v), $out, true)) $out[] = trim($v);
    }
    return $out;
}

// Push the stored sessions to the Render server (server-side, via
// wp_remote_post) so the userbot pool is restored after a deploy. The
// session strings never touch the browser. Returns
// array('ok'=>bool, 'count'=>int, 'accounts'=>array, 'error'=>string).
function mla_accounts_sync_to_server() {
    $sessions = mla_bots_get_sessions();
    $res = wp_remote_post(MLA_BOTS_RENDER_URL . '/api/admin/accounts/sync', array(
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => wp_json_encode(array('sessions' => $sessions, 'secret' => MLA_BOTS_SYNC_SECRET)),
        'timeout' => 45,
    ));
    if (is_wp_error($res)) return array('ok' => false, 'error' => $res->get_error_message());
    $body = json_decode(wp_remote_retrieve_body($res), true);
    if (!is_array($body) || empty($body['ok'])) {
        return array('ok' => false, 'error' => isset($body['error']) ? $body['error'] : 'sync failed');
    }
    return array('ok' => true, 'count' => isset($body['count']) ? (int) $body['count'] : 0, 'accounts' => isset($body['accounts']) ? $body['accounts'] : array());
}

// Push the stored bot list to the Render server (server-side, via
// wp_remote_post) so the bot config (including custom/blocked commands)
// survives a Render restart/deploy. Returns
// array('ok'=>bool, 'count'=>int, 'error'=>string).
function mla_bots_sync_to_server() {
    $bots = mla_bots_get_list();
    $res = wp_remote_post(MLA_BOTS_RENDER_URL . '/api/admin/bots/sync', array(
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => wp_json_encode(array('bots' => $bots, 'secret' => MLA_BOTS_SYNC_SECRET)),
        'timeout' => 45,
    ));
    if (is_wp_error($res)) return array('ok' => false, 'error' => $res->get_error_message());
    $body = json_decode(wp_remote_retrieve_body($res), true);
    if (!is_array($body) || empty($body['ok'])) {
        return array('ok' => false, 'error' => isset($body['error']) ? $body['error'] : 'sync failed');
    }
    return array('ok' => true, 'count' => isset($body['count']) ? (int) $body['count'] : 0);
}

// --- v8.2: hourly sync (wp-cron) — the bot list is pushed to Render every
// hour so a server restart/deploy cannot lose the saved custom/blocked
// commands. Silent on failure (Render may be briefly unreachable); the next
// hour retries. The admin page auto-sync on open covers the immediate case.
register_activation_hook(__FILE__, function () {
    if (!wp_next_scheduled('mla_bots_hourly_sync')) wp_schedule_event(time(), 'hourly', 'mla_bots_hourly_sync');
});
register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook('mla_bots_hourly_sync');
});
add_action('mla_bots_hourly_sync', function () {
    $r = mla_bots_sync_to_server();
    if (!empty($r['ok'])) update_option(MLA_BOTS_LAST_SYNC_OPTION, time());
    // On failure: stay silent — the next hourly run retries.
});

// --- v9.5: front-end chat script for the MLA Bot page (?page_id=1777) ---
// The page holds its HTML in a Custom HTML block (CSS now comes from this plugin's wp_head, v9.4), but the theme loads
// page content client-side (PJAX-style), which leaves an inline <script>
// inside that block inert — the v9.0 Telegram design showed, yet the bot
// picker never populated and the form submitted as a plain form. The chat
// JavaScript therefore lives in its own file (bot-page-script.js, next to
// this plugin file) and is enqueued here in the FOOTER, only on the MLA Bot
// page, so WordPress outputs it as a real <script src> that the browser
// always executes. is_page(1777) covers the page whether it is reached by
// permalink or by ?page_id=1777 (and even if it were the front page). No
// dependencies — the script is self-contained (it must NOT depend on
// jQuery). Version '9.8' cache-busts after updates. If the JS file is
// missing, nothing is enqueued (no fatal).
// --- v9.5: MLA Bot page CSS via wp_head (page 1777 only) ---
// The previous build put ALL of this CSS in a <style> block inside the Custom HTML block
// snippet. WordPress/Elementor strips (or never applies) <style> inside
// post content, so NONE of it reached the live page: the CSS variables
// were undefined (every var(--...) invalid -> transparent backgrounds,
// text inheriting the site's white dark-mode colour -> invisible in dark
// mode) and the overflow/pin rules never applied (page scrolled, composer
// below the fold on desktop). The fix: the CSS lives here, in the plugin,
// output as a real <style id="mla-bot-page-css"> in <head>, only on
// the MLA Bot page. Values are verbatim from the previous snippet (only
// the comment labels changed). Priority 5 so it lands early.
// Dark is html:not([data-theme="light"]) — the site REMOVES data-theme
// for dark; there is no dark value anywhere.
add_action('wp_head', function () {
    if (!is_page(1777)) return;
    echo '<style id="mla-bot-page-css">' . "\n";
    echo <<<'MLA_BOT_PAGE_CSS'

/* ---- v9.5 theme variables ---- */
/* Light (Telegram light palette). :root carries the light values so the
   chat is never unstyled; html[data-theme="light"] states it explicitly. */
:root, html[data-theme="light"]{
  --mla-bg:#fff; --mla-list-bg:#e9edf1;
  --mla-bubble-in:#fff; --mla-bubble-out:#cde9f8;
  --mla-text:#111827; --mla-text2:#6b7280; --mla-meta:#9aa8b5;
  --mla-border:#e5e7eb; --mla-border-soft:#f0f2f5;
  --mla-chip-bg:#f0f2f5; --mla-chip-text:#111827; --mla-chip-active:#e3ebf1;
  --mla-ibtn-bg:#e8f1f8; --mla-ibtn-text:#0088cc; --mla-ibtn-active:#d9e9f6;
  --mla-sys-bg:#eef2f5; --mla-sys-text:#5b6b7a;
  --mla-input-bg:#fff; --mla-input-text:#111827;
  --mla-picker-active:#e8f1f8;
  --mla-hdr-bg:rgba(255,255,255,.88); --mla-hdr-fallback:#fff;
  --mla-sh-a:rgba(16,24,40,.10); --mla-sh-b:rgba(16,24,40,.06);
}
/* Dark (Telegram dark palette). The site REMOVES data-theme for dark —
   there is no dark value, so dark is html:not([data-theme="light"]). */
html:not([data-theme="light"]){
  --mla-bg:#17212b; --mla-list-bg:#0e1621;
  --mla-bubble-in:#182533; --mla-bubble-out:#2b5278;
  --mla-text:#e8eef4; --mla-text2:#7f91a4; --mla-meta:#7f91a4;
  --mla-border:#1c2733; --mla-border-soft:#1c2733;
  --mla-chip-bg:#17212b; --mla-chip-text:#e8eef4; --mla-chip-active:#1f2c3a;
  --mla-ibtn-bg:#2b5278; --mla-ibtn-text:#64b5ef; --mla-ibtn-active:#35608f;
  --mla-sys-bg:#17212b; --mla-sys-text:#7f91a4;
  --mla-input-bg:#17212b; --mla-input-text:#e8eef4;
  --mla-picker-active:#1f2c3a;
  --mla-hdr-bg:rgba(23,33,43,.88); --mla-hdr-fallback:#17212b;
  --mla-sh-a:rgba(0,0,0,.35); --mla-sh-b:rgba(0,0,0,.25);
}
/* ---- v9.5: this page never scrolls — the chat list scrolls internally.
   Scoped to this page only, so the fixed header + bottom menu never move. */
body.page-id-1777{overflow:hidden;}
/* ---- v9.5: keep the site chrome VISIBLE but pinned stable on this page.
   The bottom menu has a `bottom` transition that slides it (the shake);
   pin it at bottom:0 and kill the transition. Same for the top header. */
body.page-id-1777 #bottomNav{bottom:0!important;transition:none!important;}
body.page-id-1777 #mla-topbar{transition:none!important;}
/* Header: frosted translucent (solid fallback) + soft shadow. */
#mla-bot-page .mla-hdr{background:var(--mla-hdr-fallback);background:var(--mla-hdr-bg);-webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);box-shadow:0 1px 12px var(--mla-sh-a);position:relative;z-index:5;}
/* Header avatar: richer Telegram-blue gradient + soft ring. */
#mla-bot-page .mla-hdr-av{background-color:#1e96c8;background:linear-gradient(135deg,#4db2e8,#1a8fc4 55%,#0f7fb8);box-shadow:0 0 0 2px rgba(255,255,255,.9),0 2px 8px rgba(0,136,204,.35);}
/* Picker / commands: never squeeze the chat list; picker scrolls internally. */
#mla-bot-picker{flex:0 0 auto;max-height:38vh;overflow-y:auto;overscroll-behavior:contain;}
#mla-bot-commands{flex:0 0 auto;overscroll-behavior-x:contain;scrollbar-width:none;}
#mla-bot-commands::-webkit-scrollbar{display:none;}
/* Composer: stays in normal flow at the bottom of the flex column. */
#mla-bot-form{flex:0 0 auto;}
/* Send button: soft glow + press animation. */
#mla-bot-page .mla-send{transition:transform .12s ease,box-shadow .12s ease;}
#mla-bot-page .mla-send:active{transform:scale(.92);box-shadow:0 1px 4px rgba(0,136,204,.3);}
/* Command chips (JS-created): gentle press. */
#mla-bot-page .mla-chip{transition:transform .12s ease,background .12s ease;}
#mla-bot-page .mla-chip:active{transform:scale(.96);background:var(--mla-chip-active);}
/* Inline-keyboard buttons (JS-created): press feedback. */
#mla-bot-page .mla-ibtn{transition:transform .12s ease,background .12s ease;}
#mla-bot-page .mla-ibtn:active{transform:scale(.98);background:var(--mla-ibtn-active);}
/* Input placeholder follows the theme. */
#mla-bot-page #mla-bot-input::placeholder{color:var(--mla-text2);}
/* New-message entrance: fade + tiny rise, ~150ms, only for live arrivals
   (JS adds .mla-msg-in to new rows; history re-renders do not get it). */
@keyframes mlaMsgIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
#mla-bot-page .mla-msg-in{animation:mlaMsgIn .16s ease-out;}
@media (prefers-reduced-motion:reduce){#mla-bot-page .mla-msg-in{animation:none;}}
/* ---- Mobile (≤640px): the chat fills the space between the fixed site
   header and the fixed bottom menu. Height is set exactly by JS
   (viewport height - container top offset - bottomNavH); the CSS 100dvh
   here is only the fallback before JS runs. NOTE: no !important on
   height — the JS inline height must win over this rule. ---- */
@media (max-width:640px){
  #mla-bot-page{max-width:100%!important;margin:0!important;height:100vh;height:100dvh;}
  #mla-bot-list{height:auto!important;flex:1 1 auto!important;min-height:0!important;}
}
MLA_BOT_PAGE_CSS;
    echo '</style>' . "\n";
}, 5);

add_action('wp_enqueue_scripts', function () {
    if (!is_page(1777)) return;
    $js_path = plugin_dir_path(__FILE__) . 'bot-page-script.js';
    if (!file_exists($js_path)) return;
    wp_enqueue_script(
        'mla-bot-page-script',
        plugin_dir_url(__FILE__) . 'bot-page-script.js',
        array(),
        '9.8',
        true
    );
});

// --- Admin menu page ---
add_action('admin_menu', function () {
    add_menu_page(
        'MLA Bots',
        'MLA Bots',
        'manage_options',
        'mla-bots',
        'mla_bots_admin_page',
        'dashicons-share-alt',
        30
    );
});

// --- AJAX: save the whole bot list to wp_options (admin only) ---
add_action('wp_ajax_mla_bots_save', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('forbidden', 403);
    check_ajax_referer('mla_bots_nonce', 'nonce');
    $raw = isset($_POST['bots']) ? wp_unslash($_POST['bots']) : '[]';
    $bots = json_decode($raw, true);
    if (!is_array($bots)) wp_send_json_error('bad bots', 400);
    update_option(MLA_BOTS_OPTION, $bots);
    $clean = mla_bots_get_list();
    update_option(MLA_BOTS_OPTION, $clean);
    wp_send_json_success(array('bots' => $clean, 'count' => count($clean)));
});

// --- AJAX: hand out a fresh nonce (admin only). v8.2: the save retries
// once with a fresh nonce when the page has been open so long that the
// original nonce expired (WordPress nonces last ~12h — an iPhone tab left
// open easily outlives one). This action deliberately does NOT check the
// old nonce (that is the point — it is stale); the capability check is the
// real gate, and a nonce by itself changes no state.
add_action('wp_ajax_mla_bots_fresh_nonce', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('forbidden', 403);
    wp_send_json_success(array('nonce' => wp_create_nonce('mla_bots_nonce')));
});

// --- AJAX: record that a manual sync to Render just succeeded (admin
// only). The browser calls this after a successful syncToServer so the
// "last sync" line on the page stays truthful.
add_action('wp_ajax_mla_bots_mark_synced', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('forbidden', 403);
    check_ajax_referer('mla_bots_nonce', 'nonce');
    $ts = time();
    update_option(MLA_BOTS_LAST_SYNC_OPTION, $ts);
    wp_send_json_success(array('last_sync' => $ts, 'last_sync_text' => date_i18n('Y-m-d H:i', $ts)));
});

// --- AJAX: save ONE new userbot session string into wp_options (admin only).
// Called by the browser right after a successful OTP verify. The session
// string is accepted here and stored — it is never echoed back.
add_action('wp_ajax_mla_bots_save_session', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('forbidden', 403);
    check_ajax_referer('mla_bots_nonce', 'nonce');
    $session = isset($_POST['session']) ? sanitize_text_field(wp_unslash($_POST['session'])) : '';
    if ($session === '') wp_send_json_error('bad session', 400);
    $sessions = mla_bots_get_sessions();
    if (!in_array($session, $sessions, true)) {
        $sessions[] = $session;
        update_option(MLA_BOTS_SESSIONS_OPTION, $sessions);
    }
    wp_send_json_success(array('count' => count($sessions)));
});

// --- AJAX: server-side accounts sync (admin only). Reads the sessions from
// wp_options in PHP and pushes them to Render. The browser never sees them.
add_action('wp_ajax_mla_accounts_sync', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('forbidden', 403);
    check_ajax_referer('mla_bots_nonce', 'nonce');
    $r = mla_accounts_sync_to_server();
    if (!empty($r['ok'])) wp_send_json_success(array('count' => $r['count'], 'accounts' => $r['accounts']));
    wp_send_json_error(isset($r['error']) ? $r['error'] : 'sync failed', 500);
});

// --- AJAX: remove one stored session by its fingerprint (admin only).
// The fingerprint is the first 12 hex chars of SHA-256(session). The
// browser sends only the fingerprint — never the session string.
add_action('wp_ajax_mla_accounts_remove', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('forbidden', 403);
    check_ajax_referer('mla_bots_nonce', 'nonce');
    $fp = isset($_POST['fingerprint']) ? sanitize_text_field(wp_unslash($_POST['fingerprint'])) : '';
    if (!preg_match('/^[0-9a-f]{12}$/', $fp)) wp_send_json_error('bad fingerprint', 400);
    $sessions = mla_bots_get_sessions();
    $kept = array();
    foreach ($sessions as $s) {
        if (substr(hash('sha256', $s), 0, 12) === $fp) continue; // drop this one
        $kept[] = $s;
    }
    update_option(MLA_BOTS_SESSIONS_OPTION, array_values($kept));
    wp_send_json_success(array('count' => count($kept)));
});

function mla_bots_admin_page() {
    if (!current_user_can('manage_options')) { wp_die('Forbidden'); }
    // v8.2: make sure the hourly sync is scheduled even if the plugin was
    // updated by file-replace without the activation hook firing.
    if (!wp_next_scheduled('mla_bots_hourly_sync')) wp_schedule_event(time(), 'hourly', 'mla_bots_hourly_sync');
    $bots = mla_bots_get_list();
    $bots_json = wp_json_encode($bots);
    $has_sessions = count(mla_bots_get_sessions()) > 0 ? '1' : '0';
    $render_url = esc_js(MLA_BOTS_RENDER_URL);
    $secret = esc_js(MLA_BOTS_SYNC_SECRET);
    $nonce = wp_create_nonce('mla_bots_nonce');
    $ajax_url = esc_js(admin_url('admin-ajax.php'));
    $last_sync = (int) get_option(MLA_BOTS_LAST_SYNC_OPTION, 0);
    $last_sync_text = $last_sync ? date_i18n('Y-m-d H:i', $last_sync) : 'এখনো হয়নি';
    ?>
    <div class="wrap">
        <h1>🤖 MLA Bots — Telegram ইনকাম বট</h1>
        <p>এখানে যেসব বট যুক্ত করবেন, সাইটের ভিজিটররা সেগুলো সাইট থেকেই চালাতে পারবে। বট যুক্ত করলেই সার্ভারে (Render) পাঠিয়ে দেওয়া হয় — আলাদা করে কিছু করতে হবে না।</p>
        <p id="mla-bots-status" style="font-weight:bold;"></p>
        <p id="mla-bots-last-sync" style="color:#666;">শেষ সিঙ্ক: <?php echo esc_html($last_sync_text); ?> <span class="description">(প্রতি ঘণ্টায় নিজে থেকেও সিঙ্ক হয় — সার্ভার রিস্টার্ট হলেও কমান্ড হারাবে না।)</span></p>

        <h2>➕ নতুন বট যুক্ত করুন</h2>
        <p id="mla-bot-edit-banner" style="display:none;background:#fff8e1;border-left:4px solid #dba617;padding:10px 12px;font-weight:bold;"></p>
        <table class="form-table">
            <tr><th><label for="mla-bot-username">Bot username *</label></th>
                <td><input id="mla-bot-username" type="text" placeholder="@SomeBot" style="width:300px"> <span class="description">@ ছাড়াও লিখতে পারেন</span></td></tr>
            <tr><th><label for="mla-bot-name">নাম</label></th>
                <td><input id="mla-bot-name" type="text" placeholder="যেমন: Earn Bot" style="width:300px"></td></tr>
            <tr><th><label for="mla-bot-desc">বিবরণ</label></th>
                <td><textarea id="mla-bot-desc" rows="2" cols="50" placeholder="এই বট থেকে কিভাবে আয় হয়"></textarea></td></tr>
            <tr><th><label for="mla-bot-earn">কিভাবে আয়</label></th>
                <td><textarea id="mla-bot-earn" rows="2" cols="50" placeholder="যেমন: টাস্ক করুন, রেফার করুন"></textarea></td></tr>
            <tr><th><label for="mla-bot-custom">কাস্টম কমান্ড (v8.3)</label></th>
                <td><textarea id="mla-bot-custom" rows="3" cols="50" placeholder="যেমন: ব্যালেন্স|/balance — প্রতি লাইনে একটি"></textarea>
                <br><span class="description">এই ঘরটি খালি থাকে — নিজে লিখতে হবে। প্রতি লাইনে একটি: লেবেল|কমান্ড। স্ল্যাশ (/) দিয়ে শুরু হলে কমান্ড, নইলে সাধারণ লেখা — '|' ছাড়া শুধু লেখা লিখলেও চলবে (যেমন শুধু "ব্যালেন্স" লিখলে চিপে ট্যাপ করলে ঠিক ওই লেখাটাই যাবে)। সর্বোচ্চ ২০টি। ভুল ফরম্যাটের লাইন (যেমন স্পেস থাকা কমান্ড) সেভ হবে না — সেভের পর কোন লাইন বাদ পড়েছে জানিয়ে দেওয়া হবে।</span></td></tr>
            <tr><th><label for="mla-bot-blocked">বন্ধ কমান্ড (v8.3)</label></th>
                <td><input id="mla-bot-blocked" type="text" placeholder="যেমন: /withdraw, /admin" style="width:300px">
                <br><span class="description">এই ঘরটি খালি থাকে — নিজে লিখতে হবে। কমা বা নতুন লাইন দিয়ে আলাদা করুন। স্ল্যাশ কমান্ড (/withdraw) বা সাধারণ লেখা — যেটা লিখবেন সেটাই ব্লক হবে; ভিজিটর পাঠালে "এই কমান্ডটি বন্ধ আছে।" দেখাবে। সর্বোচ্চ ২০টি। ভুল ফরম্যাটের লাইন সেভ হবে না — সেভের পর জানিয়ে দেওয়া হবে।</span></td></tr>
        </table>
        <p><button id="mla-bot-add" class="button button-primary">➕ বট যুক্ত করুন</button>
        <button id="mla-bot-cancel-edit" class="button" style="display:none">✕ সম্পাদনা বাতিল</button>
        <br><span class="description">আগে থেকে যুক্ত বট বদলাতে তার পাশের ✏️ সম্পাদনা চাপুন — নতুন করে যুক্ত করলে হবে না।</span></p>

        <h2>📋 যুক্ত বটগুলো (<span id="mla-bot-count"><?php echo count($bots); ?></span>টি)</h2>
        <table class="widefat striped" id="mla-bot-table">
            <thead><tr><th>Username</th><th>নাম</th><th>বিবরণ / কিভাবে আয়</th><th>কাস্টম / বন্ধ কমান্ড</th><th></th></tr></thead>
            <tbody id="mla-bot-list"></tbody>
        </table>
        <p><button id="mla-bot-sync" class="button">🔄 সার্ভারে আবার পাঠান (Sync)</button>
        <span class="description">সার্ভার রিস্টার্ট হলে এই বোতামে একবার ক্লিক করলেই বটগুলো আবার চালু হবে। এই পেজ খুললেই নিজে থেকেও Sync হয়।</span></p>

        <hr>
        <h2>📱 Telegram অ্যাকাউন্ট (Userbot Pool — v8)</h2>
        <p>সাইট থেকে ইনকাম বট চালাতে যেসব Telegram অ্যাকাউন্ট ব্যবহার হবে। একটি অ্যাকাউন্ট বিজি/বন্ধ থাকলে অন্যটি নিজে থেকে কাজ নিয়ে নেবে (auto-shift)। নতুন অ্যাকাউন্ট যুক্ত করতে ফোন নম্বর দিয়ে OTP পাঠান, তারপর OTP দিন।</p>
        <p id="mla-acc-status" style="font-weight:bold;"></p>
        <table class="form-table">
            <tr><th><label for="mla-acc-phone">ফোন নম্বর *</label></th>
                <td><input id="mla-acc-phone" type="text" placeholder="+8801XXXXXXXXX" style="width:300px">
                <button id="mla-acc-send-otp" class="button button-primary">📩 OTP পাঠান</button></td></tr>
            <tr id="mla-acc-otp-row" style="display:none"><th><label for="mla-acc-otp">OTP কোড *</label></th>
                <td><input id="mla-acc-otp" type="text" placeholder="Telegram-এ আসা ৫ সংখ্যার কোড" style="width:300px">
                <button id="mla-acc-verify" class="button button-primary">✅ Verify করুন</button>
                <span class="description">OTP ১০ মিনিটের মধ্যে দিতে হবে। ভুল কোড দিলে আবার নতুন OTP নিতে হবে।</span></td></tr>
        </table>
        <h3>🔗 যুক্ত অ্যাকাউন্টগুলো (<span id="mla-acc-count">0</span>টি)</h3>
        <table class="widefat striped" id="mla-acc-table">
            <thead><tr><th>অ্যাকাউন্ট</th><th>ফোন (মাস্কড)</th><th>স্ট্যাটাস</th><th>চলমান মেসেজ</th><th></th></tr></thead>
            <tbody id="mla-acc-list"></tbody>
        </table>
        <p><button id="mla-acc-sync" class="button">🔄 অ্যাকাউন্ট Sync (সার্ভারে আবার পাঠান)</button>
        <span class="description">সার্ভার রিস্টার্ট/ডেপ্লয় হলে এই পেজ খুললেই অ্যাকাউন্টগুলো নিজে থেকে আবার চালু হয়।</span></p>
    </div>
    <script>
    (function () {
        var RENDER_URL = '<?php echo $render_url; ?>';
        var SECRET = '<?php echo $secret; ?>';
        var AJAX_URL = '<?php echo $ajax_url; ?>';
        var NONCE = '<?php echo $nonce; ?>';
        var HAS_SESSIONS = '<?php echo $has_sessions; ?>' === '1';
        var bots = <?php echo $bots_json; ?> || [];
        var editingIndex = -1; // >=0 হলে Add বোতামটি ওই বটটি আপডেট করবে
        var statusEl = document.getElementById('mla-bots-status');
        var lastSyncEl = document.getElementById('mla-bots-last-sync');
        var editBannerEl = document.getElementById('mla-bot-edit-banner');
        var addBtn = document.getElementById('mla-bot-add');
        var syncBtn = document.getElementById('mla-bot-sync');
        var listEl = document.getElementById('mla-bot-list');
        var countEl = document.getElementById('mla-bot-count');

        function setStatus(msg, ok) {
            statusEl.textContent = msg;
            statusEl.style.color = ok ? 'green' : 'red';
            // v8.2: errors must be unmissable — scroll the status into view.
            if (!ok && msg && statusEl.scrollIntoView) statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        // v8.2: disable the Save + Sync buttons while a save is in progress
        // (prevents double-clicks / double-saves on a slow phone connection).
        function setSaveBusy(busy) {
            addBtn.disabled = busy;
            syncBtn.disabled = busy;
            addBtn.textContent = busy ? '⏳ সেভ হচ্ছে...' : (editingIndex >= 0 ? '💾 সংরক্ষণ করুন' : '➕ বট যুক্ত করুন');
        }
        // v8.3: lines the user typed that could NOT be saved (wrong format)
        // are collected by parseCustom/parseBlocked and named AFTER the save
        // finishes — the save itself is never blocked; the valid lines are
        // saved and the dropped lines are shown, so the user never has to
        // discover on the user page that a line silently vanished.
        var pendingSkipped = [];
        function skippedWarningText() {
            if (!pendingSkipped.length) return '';
            var parts = pendingSkipped.map(function (s) { return "'" + s.line + "' (" + s.reason + ")"; });
            return '⚠️ এই লাইনগুলো সেভ হয়নি: ' + parts.join(', ') + ' — / দিয়ে শুরু হলে শুধু অক্ষর/সংখ্যা/_ চলবে, স্পেস চলবে না।';
        }
        // The final status after a save: appends the skipped-lines warning
        // (if any) and forces ok=false so setStatus scrolls it into view —
        // unmissable. Consumes pendingSkipped (shown once only).
        function finalStatus(msg, ok) {
            var w = skippedWarningText();
            pendingSkipped = [];
            if (w) setStatus(msg + ' ' + w, false);
            else setStatus(msg, ok);
        }
        // v8.2: fetch a fresh nonce (admin-only action; it does not need the
        // old nonce — that is the point). Returns true when NONCE was updated.
        function refreshNonce() {
            var form = new FormData();
            form.append('action', 'mla_bots_fresh_nonce');
            return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d && d.success && d.data && d.data.nonce) { NONCE = d.data.nonce; return true; }
                    return false;
                })
                .catch(function () { return false; });
        }
        // Did this save response fail because the nonce expired? WordPress
        // check_ajax_referer dies with HTTP 403 and body "-1".
        function isNonceFailure(res) {
            if (res.status === 403) return true;
            if (res.raw && String(res.raw).trim() === '-1') return true;
            if (res.data && !res.data.success && res.data.data) {
                var m = String(res.data.data).toLowerCase();
                if (m.indexOf('nonce') !== -1 || m.indexOf('-1') !== -1) return true;
            }
            return false;
        }
        // v8.2: record a successful manual sync so the "শেষ সিঙ্ক" line stays
        // truthful. Silent if it fails — the sync itself already happened.
        function markSynced() {
            var form = new FormData();
            form.append('action', 'mla_bots_mark_synced');
            form.append('nonce', NONCE);
            return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d && d.success && d.data && d.data.last_sync_text) {
                        lastSyncEl.innerHTML = 'শেষ সিঙ্ক: ' + d.data.last_sync_text + ' <span class="description">(প্রতি ঘণ্টায় নিজে থেকেও সিঙ্ক হয় — সার্ভার রিস্টার্ট হলেও কমান্ড হারাবে না।)</span>';
                    }
                })
                .catch(function () { /* ignore — cosmetic only */ });
        }
        // Compare helpers for the verify step: only the command texts matter
        // (labels are display-only, so a label truncation cannot cause a
        // false mismatch). Sorted + lowercased, so order/case do not matter.
        function normCustomCmds(list) {
            return (list || []).map(function (c) { return String((c && c.command) || '').toLowerCase(); }).sort();
        }
        function normBlocked(list) {
            return (list || []).map(function (c) { return String(c || '').toLowerCase(); }).sort();
        }
        function esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }
        // "লেবেল|কমান্ড" প্রতি লাইন -> {list, skipped}. v8.1: a line with
        // NO '|' is plain text — the whole line is both label and command
        // (e.g. just "ব্যালেন্স" sends exactly that text). Slash commands
        // must match /[A-Za-z0-9_]{1,31} (<=32 chars); plain text <=64 chars.
        // v8.3: lines that fail the format are NOT silently dropped any
        // more — they are returned in `skipped` with a Bengali reason, so
        // the save flow can name them to the user afterwards.
        function parseCustom(text) {
            var out = [];
            var skipped = [];
            String(text || '').split('\n').forEach(function (line) {
                var raw = line.trim();
                if (!raw) return;
                var label, command;
                var parts = raw.split('|');
                if (parts.length >= 2) {
                    label = parts[0].trim().slice(0, 30);
                    command = parts.slice(1).join('|').trim();
                } else {
                    label = raw.slice(0, 30);
                    command = raw;
                }
                if (!label || !command) { skipped.push({ line: raw, reason: 'খালি লাইন' }); return; }
                if (command.charAt(0) === '/') {
                    if (command.indexOf(' ') !== -1) { skipped.push({ line: raw, reason: 'স্পেস আছে' }); return; }
                    if (!/^\/[A-Za-z0-9_]{1,31}$/.test(command) || command.length > 32) { skipped.push({ line: raw, reason: 'ভুল ফরম্যাট' }); return; }
                } else if (command.length > 64) { skipped.push({ line: raw, reason: '৬৪ অক্ষরের বেশি' }); return; }
                if (out.some(function (o) { return o.command.toLowerCase() === command.toLowerCase(); })) { skipped.push({ line: raw, reason: 'একই কমান্ড দুইবার' }); return; }
                out.push({ label: label, command: command });
            });
            if (out.length > 20) {
                out.slice(20).forEach(function (o) { skipped.push({ line: o.command, reason: '২০টির বেশি (সর্বোচ্চ ২০টি)' }); });
                out = out.slice(0, 20);
            }
            return { list: out, skipped: skipped };
        }
        // "/withdraw, /admin" -> {list, skipped}. v8.1: split on
        // commas AND newlines; plain text (no leading '/') is also allowed
        // (non-empty, <=64 chars) and blocks that exact message text.
        // v8.3: invalid entries are reported in `skipped` (see parseCustom).
        function parseBlocked(text) {
            var out = [];
            var skipped = [];
            String(text || '').split(/[,\n]/).forEach(function (c) {
                var cmd = c.trim().toLowerCase();
                if (!cmd) return;
                if (cmd.charAt(0) === '/') {
                    if (cmd.indexOf(' ') !== -1) { skipped.push({ line: c.trim(), reason: 'স্পেস আছে' }); return; }
                    if (!/^\/[a-z0-9_]{1,31}$/.test(cmd) || cmd.length > 32) { skipped.push({ line: c.trim(), reason: 'ভুল ফরম্যাট' }); return; }
                } else if (cmd.length > 64) { skipped.push({ line: c.trim(), reason: '৬৪ অক্ষরের বেশি' }); return; }
                if (out.indexOf(cmd) !== -1) { skipped.push({ line: c.trim(), reason: 'একই কমান্ড দুইবার' }); return; }
                out.push(cmd);
            });
            if (out.length > 20) {
                out.slice(20).forEach(function (o) { skipped.push({ line: o, reason: '২০টির বেশি (সর্বোচ্চ ২০টি)' }); });
                out = out.slice(0, 20);
            }
            return { list: out, skipped: skipped };
        }
        function formatCustom(list) {
            return (list || []).map(function (c) {
                var label = c.label || '', cmd = c.command || '';
                return (label === cmd) ? cmd : (label + '|' + cmd);
            }).join('\n');
        }
        function formatBlocked(list) {
            return (list || []).join(', ');
        }
        function renderList() {
            countEl.textContent = bots.length;
            listEl.innerHTML = '';
            if (!bots.length) {
                listEl.innerHTML = '<tr><td colspan="5">এখনো কোনো বট যুক্ত হয়নি। উপরের ফর্ম থেকে যুক্ত করুন।</td></tr>';
                return;
            }
            bots.forEach(function (b, i) {
                var tr = document.createElement('tr');
                var desc = (b.description || '') + (b.how_to_earn ? ' — কিভাবে আয়: ' + b.how_to_earn : '');
                var customTxt = (b.custom_commands || []).map(function (c) { return (c.label || '') + ' (' + (c.command || '') + ')'; }).join(', ');
                var blockedTxt = (b.blocked_commands || []).join(', ');
                var cmds = '';
                if (customTxt) cmds += 'কাস্টম: ' + customTxt + '<br>';
                if (blockedTxt) cmds += 'বন্ধ: ' + blockedTxt;
                if (!cmds) cmds = '—';
                tr.innerHTML = '<td><b>@' + esc(b.username) + '</b></td><td>' + esc(b.name || b.username) + '</td><td>' + esc(desc) + '</td><td>' + esc(cmds).replace(/&lt;br&gt;/g, '<br>') + '</td>';
                var td = document.createElement('td');
                var edit = document.createElement('button');
                edit.className = 'button';
                edit.textContent = '✏️ সম্পাদনা';
                edit.style.marginRight = '6px';
                edit.onclick = function () { startEdit(i); };
                var del = document.createElement('button');
                del.className = 'button';
                del.textContent = '✕ মুছুন';
                del.onclick = function () { removeBot(i); };
                td.appendChild(edit);
                td.appendChild(del);
                tr.appendChild(td);
                listEl.appendChild(tr);
            });
        }
        // v8.3: fetch with a hard timeout — a hanging request (Render
        // waking from sleep, a slow phone network) can NEVER stall the save
        // flow forever. Promise.race is used (not AbortController) so it
        // works on every mobile browser; the timed-out request is simply
        // ignored once the timeout rejects.
        function fetchWithTimeout(url, options, ms) {
            var timeoutMs = ms || 15000;
            var timer = null;
            var timeoutPromise = new Promise(function (resolve, reject) {
                timer = setTimeout(function () { reject(new Error('timeout')); }, timeoutMs);
            });
            return Promise.race([fetch(url, options), timeoutPromise]).then(function (r) {
                clearTimeout(timer);
                return r;
            }, function (e) {
                clearTimeout(timer);
                throw e;
            });
        }
        // Push the current list to the Render server (secret-protected).
        // Returns a promise of true/false (whether the server accepted it).
        // v8.3: this ALWAYS leaves a clear result status now — success shows
        // "✅ সার্ভারে পাঠানো হয়েছে", failure/timeout shows a red error.
        // (Bug: it used to set "⏳ sending..." and never replace it, so the
        // user stared at "sending..." forever even after a successful sync.)
        // The save flow's verify step may still overwrite the status with
        // the verified result afterwards — that is the final word.
        function syncToServer() {
            setStatus('⏳ সার্ভারে পাঠানো হচ্ছে...', true);
            return fetchWithTimeout(RENDER_URL + '/api/admin/bots/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bots: bots, secret: SECRET })
            }, 15000).then(function (r) { return r.json(); }).then(function (d) {
                if (d && d.ok) {
                    markSynced();
                    setStatus('✅ সার্ভারে পাঠানো হয়েছে — ' + bots.length + 'টি বট চালু আছে।', true);
                    return true;
                }
                setStatus('❌ সার্ভারে পাঠানো যায়নি — নেটওয়ার্ক/সার্ভার সমস্যা, আবার চেষ্টা করুন।', false);
                return false;
            }).catch(function () {
                setStatus('❌ সার্ভারে পাঠানো যায়নি — নেটওয়ার্ক/সার্ভার সমস্যা, আবার চেষ্টা করুন।', false);
                return false;
            });
        }
        // v8.2: verify against the server that the saved bot's commands
        // really arrived — compare the actual arrays, not just the bot count.
        // `entry` is the cleaned bot entry from the WordPress save response.
        // v8.3: 15s timeout (a hanging GET used to stall the save flow at
        // "sending..." with no final message at all); a timeout lands in
        // the 'unknown' branch, which still shows a clear result.
        function verifySaved(entry) {
            return fetchWithTimeout(RENDER_URL + '/api/bots', {}, 15000)
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    var list = (d && d.ok && Array.isArray(d.bots)) ? d.bots : null;
                    if (!list) return 'unknown';
                    var found = null;
                    list.forEach(function (b) {
                        if (String(b.username || '').toLowerCase() === String(entry.username).toLowerCase()) found = b;
                    });
                    if (!found) return 'missing';
                    var cc = JSON.stringify(normCustomCmds(found.custom_commands || []));
                    var ec = JSON.stringify(normCustomCmds(entry.custom_commands || []));
                    var bb = JSON.stringify(normBlocked(found.blocked_commands || []));
                    var eb = JSON.stringify(normBlocked(entry.blocked_commands || []));
                    return (cc === ec && bb === eb) ? 'ok' : 'mismatch';
                })
                .catch(function () { return 'unknown'; })
                .then(function (state) {
                    if (state === 'ok') {
                        var nc = (entry.custom_commands || []).length;
                        var nb = (entry.blocked_commands || []).length;
                        finalStatus('✅ সেভ হয়েছে — সার্ভারে যাচাই হয়েছে (কাস্টম ' + nc + 'টি, বন্ধ ' + nb + 'টি)।', true);
                    } else if (state === 'mismatch' || state === 'missing') {
                        finalStatus('⚠️ ওয়ার্ডপ্রেসে সেভ হয়েছে কিন্তু সার্ভারে পাওয়া যায়নি — নিচের Sync বোতাম চাপুন।', false);
                    } else {
                        finalStatus('⚠️ সেভ হয়েছে, কিন্তু সার্ভার যাচাই করা যায়নি — নিচের Sync বোতাম চাপুন।', false);
                    }
                });
        }
        // v8.2: CORE SAVE — post `list` to wp_options (with ONE automatic
        // retry on a fresh nonce when the first attempt fails as a nonce/403
        // error), then sync to Render and verify the commands really arrived.
        // `bots` is NOT mutated until the WordPress save succeeds, so a
        // failed save leaves the form values AND the edit state intact and a
        // retry cannot create a duplicate. On success, `bots` becomes the
        // server-cleaned list from WordPress, the list re-renders, and
        // onSuccess() runs (the caller clears the form there).
        // `verifyUsername` is the bot whose commands the verify step checks.
        function saveBotList(list, verifyUsername, onSuccess) {
            setSaveBusy(true);
            setStatus('⏳ সেভ হচ্ছে...', true);
            return doSave(0);
            function doSave(attempt) {
                var form = new FormData();
                form.append('action', 'mla_bots_save');
                form.append('nonce', NONCE);
                form.append('bots', JSON.stringify(list));
                return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                    .then(function (r) {
                        var status = r.status;
                        return r.text().then(function (t) {
                            var d = null;
                            try { d = JSON.parse(t); } catch (e) { d = null; }
                            return { status: status, data: d, raw: t };
                        });
                    })
                    .then(function (res) {
                        if (res.data && res.data.success) {
                            bots = (res.data.data && res.data.data.bots) || [];
                            renderList();
                            if (onSuccess) onSuccess();
                            // Sync, then verify the saved bot's commands
                            // (the cleaned entry from the WordPress response).
                            // The button stays busy until the whole flow
                            // (sync + verify) finishes, so a second click
                            // cannot start a duplicate save mid-flight.
                            var saved = null;
                            var wantU = String(verifyUsername || '').toLowerCase();
                            bots.forEach(function (b) {
                                if (String(b.username || '').toLowerCase() === wantU) saved = b;
                            });
                            if (!saved) saved = { username: verifyUsername || '', custom_commands: [], blocked_commands: [] };
                            return syncToServer().then(function (ok) {
                                if (!ok) {
                                    finalStatus('⚠️ ওয়ার্ডপ্রেসে সেভ হয়েছে কিন্তু সার্ভারে পাঠানো যায়নি — নিচের Sync বোতাম চাপুন।', false);
                                    return;
                                }
                                // No bot to verify (e.g. a deletion — the bot
                                // is supposed to be gone): plain success.
                                if (!verifyUsername) {
                                    finalStatus('✅ সেভ হয়েছে — সার্ভারে ' + bots.length + 'টি বট চালু আছে।', true);
                                    return;
                                }
                                return verifySaved(saved);
                            }).then(function () { setSaveBusy(false); })
                            .catch(function () { setSaveBusy(false); });
                        }
                        // Nonce/403 failure → retry ONCE with a fresh nonce.
                        if (attempt === 0 && isNonceFailure(res)) {
                            return refreshNonce().then(function (ok) {
                                if (ok) return doSave(1);
                                return saveFailed('❌ সেভ হয়নি: নিরাপত্তা কোড নবায়ন করা যায়নি। পেজটি রিফ্রেশ করে আবার চেষ্টা করুন।');
                            });
                        }
                        return saveFailed('❌ সেভ হয়নি: ' + saveErrorText(res));
                    })
                    .catch(function (e) {
                        // Network error → retry once with a fresh nonce too.
                        if (attempt === 0) {
                            return refreshNonce().then(function (ok) {
                                if (ok) return doSave(1);
                                return saveFailed('❌ সেভ হয়নি: নেটওয়ার্ক সমস্যা (' + e.message + ')।');
                            });
                        }
                        return saveFailed('❌ সেভ হয়নি: নেটওয়ার্ক সমস্যা (' + e.message + ')।');
                    });
            }
            function saveFailed(msg) {
                setSaveBusy(false);
                pendingSkipped = []; // nothing was saved — no skipped warning to show
                // KEEP all form values — do not clear the form. The user can
                // just press Save again.
                setStatus(msg + ' আপনার লেখা ঘরেই আছে — আবার "সংরক্ষণ করুন" চাপুন।', false);
            }
            function saveErrorText(res) {
                if (res.data && !res.data.success && res.data.data) return String(res.data.data);
                if (res.status) return 'সার্ভার ত্রুটি (' + res.status + ')';
                return 'অজানা ত্রুটি';
            }
        }
        // v8.2: build the list WITHOUT mutating `bots` first — only a
        // successful save commits the removal, so a failed save cannot
        // silently drop a bot from the page.
        function removeBot(i) {
            if (!confirm('"' + bots[i].username + '" বটটি মুছে ফেলবেন?')) return;
            var toSend = bots.slice();
            toSend.splice(i, 1);
            saveBotList(toSend, null, function () {
                if (editingIndex === i) cancelEdit();
                else if (editingIndex > i) editingIndex--;
            });
        }
        function clearBotForm() {
            document.getElementById('mla-bot-username').value = '';
            document.getElementById('mla-bot-name').value = '';
            document.getElementById('mla-bot-desc').value = '';
            document.getElementById('mla-bot-earn').value = '';
            document.getElementById('mla-bot-custom').value = '';
            document.getElementById('mla-bot-blocked').value = '';
        }
        // Fill the add form with a bot's data so the admin can edit it.
        // v8.2: show an unmissable banner so it is obvious this is an EDIT.
        function startEdit(i) {
            var b = bots[i];
            if (!b) return;
            editingIndex = i;
            document.getElementById('mla-bot-username').value = b.username;
            document.getElementById('mla-bot-name').value = b.name || '';
            document.getElementById('mla-bot-desc').value = b.description || '';
            document.getElementById('mla-bot-earn').value = b.how_to_earn || '';
            document.getElementById('mla-bot-custom').value = formatCustom(b.custom_commands);
            document.getElementById('mla-bot-blocked').value = formatBlocked(b.blocked_commands);
            addBtn.textContent = '💾 সংরক্ষণ করুন';
            document.getElementById('mla-bot-cancel-edit').style.display = '';
            editBannerEl.textContent = '✏️ @' + b.username + ' সম্পাদনা করছেন — বদলে "সংরক্ষণ করুন" চাপুন।';
            editBannerEl.style.display = '';
            setStatus('✏️ "' + b.username + '" সম্পাদনা করছেন — বদলে "সংরক্ষণ করুন" চাপুন।', true);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        function cancelEdit() {
            editingIndex = -1;
            clearBotForm();
            addBtn.textContent = '➕ বট যুক্ত করুন';
            document.getElementById('mla-bot-cancel-edit').style.display = 'none';
            editBannerEl.style.display = 'none';
            setStatus('', true);
        }
        document.getElementById('mla-bot-add').addEventListener('click', function () {
            var u = document.getElementById('mla-bot-username').value.trim().replace(/^@/, '');
            if (!/^[A-Za-z0-9_]{5,32}$/.test(u)) {
                setStatus('❌ সঠিক Bot username দিন (যেমন @SomeBot)।', false);
                return;
            }
            if (editingIndex < 0 && bots.some(function (b) { return b.username.toLowerCase() === u.toLowerCase(); })) {
                setStatus('❌ এই বটটি ইতিমধ্যে যুক্ত আছে — বদলাতে নিচের তালিকায় তার পাশের ✏️ সম্পাদনা চাপুন।', false);
                return;
            }
            // v8.3: parse returns {list, skipped} — remember the lines that
            // could not be saved so the final status can name them AFTER the
            // save (the save itself is never blocked; valid lines are saved).
            var customRes = parseCustom(document.getElementById('mla-bot-custom').value);
            var blockedRes = parseBlocked(document.getElementById('mla-bot-blocked').value);
            pendingSkipped = customRes.skipped.concat(blockedRes.skipped);
            var entry = {
                username: u,
                name: document.getElementById('mla-bot-name').value.trim() || u,
                description: document.getElementById('mla-bot-desc').value.trim(),
                how_to_earn: document.getElementById('mla-bot-earn').value.trim(),
                custom_commands: customRes.list,
                blocked_commands: blockedRes.list
            };
            // v8.2: build the list to send WITHOUT mutating `bots` and
            // WITHOUT clearing the form yet. Only a successful save clears
            // the form / exits edit mode — a failed save keeps every value
            // so the user can just press Save again.
            var toSend = bots.slice();
            var wasEditing = editingIndex >= 0;
            if (wasEditing) toSend[editingIndex] = entry;
            else toSend.push(entry);
            saveBotList(toSend, u, function () {
                if (wasEditing) cancelEdit();
                else clearBotForm();
            });
        });
        document.getElementById('mla-bot-cancel-edit').addEventListener('click', cancelEdit);
        document.getElementById('mla-bot-sync').addEventListener('click', function () { syncToServer(); });
        renderList();
        // Auto-sync on page open (self-heals after a server redeploy/restart).
        if (bots.length) syncToServer();

        // ---------- Telegram Accounts (v8) ----------
        var accStatusEl = document.getElementById('mla-acc-status');
        var accListEl = document.getElementById('mla-acc-list');
        var accCountEl = document.getElementById('mla-acc-count');
        var accPhoneEl = document.getElementById('mla-acc-phone');
        var accOtpRow = document.getElementById('mla-acc-otp-row');
        var accOtpEl = document.getElementById('mla-acc-otp');
        var pendingPhone = '';
        function setAccStatus(msg, ok) {
            accStatusEl.textContent = msg;
            accStatusEl.style.color = ok ? 'green' : 'red';
        }
        // Fetch the pool accounts from the server (masked phones only — no
        // session strings ever come to the browser).
        function fetchAccounts() {
            return fetch(RENDER_URL + '/api/admin/accounts?secret=' + encodeURIComponent(SECRET))
                .then(function (r) { return r.json(); }).then(function (d) {
                    var list = (d && d.ok && Array.isArray(d.accounts)) ? d.accounts : [];
                    accCountEl.textContent = list.length;
                    accListEl.innerHTML = '';
                    if (!list.length) {
                        accListEl.innerHTML = '<tr><td colspan="5">এখনো কোনো অ্যাকাউন্ট যুক্ত হয়নি। উপরের ফর্ম থেকে ফোন নম্বর দিয়ে যুক্ত করুন।</td></tr>';
                        return;
                    }
                    list.forEach(function (a) {
                        var tr = document.createElement('tr');
                        var st = a.status === 'connected' ? '🟢 চালু' : (a.status === 'cooling' ? '🟡 ঠান্ডা হচ্ছে' : '🔴 বন্ধ');
                        tr.innerHTML = '<td><b>' + esc(a.id) + '</b></td><td>' + esc(a.phone || '—') + '</td><td>' + st + '</td><td>' + (a.activeSends || 0) + '</td>';
                        var td = document.createElement('td');
                        var del = document.createElement('button');
                        del.className = 'button';
                        del.textContent = '✕ মুছুন';
                        del.onclick = function () { removeAccount(a.id, a.fingerprint); };
                        td.appendChild(del);
                        tr.appendChild(td);
                        accListEl.appendChild(tr);
                    });
                }).catch(function (e) {
                    accListEl.innerHTML = '<tr><td colspan="5">অ্যাকাউন্ট লিস্ট আনা যায়নি: ' + esc(e.message) + '</td></tr>';
                });
        }
        // Server-side accounts sync (PHP reads the sessions from wp_options
        // and pushes them to Render — the browser never sees them).
        function syncAccounts(showOk) {
            setAccStatus('⏳ অ্যাকাউন্ট Sync হচ্ছে...', true);
            var form = new FormData();
            form.append('action', 'mla_accounts_sync');
            form.append('nonce', NONCE);
            return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                .then(function (r) { return r.json(); }).then(function (d) {
                    if (d && d.success) {
                        if (showOk) setAccStatus('✅ অ্যাকাউন্ট Sync হয়েছে — সার্ভারে ' + (d.data.count || 0) + 'টি অ্যাকাউন্ট চালু আছে।', true);
                        return fetchAccounts();
                    }
                    setAccStatus('❌ অ্যাকাউন্ট Sync হয়নি: ' + (d && d.data ? d.data : 'অজানা ত্রুটি'), false);
                }).catch(function (e) {
                    setAccStatus('❌ অ্যাকাউন্ট Sync হয়নি: ' + e.message, false);
                });
        }
        // Step 1: send the OTP to the phone.
        document.getElementById('mla-acc-send-otp').addEventListener('click', function () {
            var phone = accPhoneEl.value.trim();
            if (!/^\+?[0-9]{7,15}$/.test(phone)) {
                setAccStatus('❌ সঠিক ফোন নম্বর দিন (যেমন +8801XXXXXXXXX)।', false);
                return;
            }
            setAccStatus('⏳ OTP পাঠানো হচ্ছে...', true);
            fetch(RENDER_URL + '/api/admin/tg-login-start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone, secret: SECRET })
            }).then(function (r) { return r.json(); }).then(function (d) {
                if (d && d.ok) {
                    pendingPhone = phone;
                    accOtpRow.style.display = '';
                    accOtpEl.value = '';
                    accOtpEl.focus();
                    setAccStatus('✅ OTP পাঠানো হয়েছে — Telegram-এ আসা কোডটি দিন।', true);
                } else {
                    setAccStatus('❌ OTP পাঠানো যায়নি: ' + (d && d.error ? d.error : 'অজানা ত্রুটি'), false);
                }
            }).catch(function (e) {
                setAccStatus('❌ সার্ভারে পৌঁছানো যায়নি: ' + e.message, false);
            });
        });
        // Step 2: verify the OTP. The session string comes back here — it is
        // saved straight into wp_options and NEVER shown or logged.
        document.getElementById('mla-acc-verify').addEventListener('click', function () {
            var code = accOtpEl.value.trim();
            if (!pendingPhone || !code) {
                setAccStatus('❌ প্রথমে OTP পাঠান, তারপর কোডটি দিন।', false);
                return;
            }
            setAccStatus('⏳ যাচাই করা হচ্ছে...', true);
            fetch(RENDER_URL + '/api/admin/tg-login-verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: pendingPhone, code: code, secret: SECRET })
            }).then(function (r) { return r.json(); }).then(function (d) {
                if (d && d.ok && d.session) {
                    // Save the session into wp_options (never display it).
                    var form = new FormData();
                    form.append('action', 'mla_bots_save_session');
                    form.append('nonce', NONCE);
                    form.append('session', d.session);
                    return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                        .then(function (r2) { return r2.json(); }).then(function (d2) {
                            if (d2 && d2.success) {
                                accOtpRow.style.display = 'none';
                                accOtpEl.value = '';
                                pendingPhone = '';
                                setAccStatus('✅ অ্যাকাউন্ট যুক্ত হয়েছে — সার্ভারে চালু আছে।', true);
                                return syncAccounts(false).then(fetchAccounts);
                            }
                            setAccStatus('❌ সেভ হয়নি: ' + (d2 && d2.data ? d2.data : 'অজানা ত্রুটি'), false);
                        });
                }
                var err = (d && d.error) ? d.error : 'অজানা ত্রুটি';
                setAccStatus('❌ যাচাই হয়নি: ' + err + ' — নতুন OTP নিন।', false);
                pendingPhone = '';
                accOtpRow.style.display = 'none';
            }).catch(function (e) {
                setAccStatus('❌ সার্ভারে পৌঁছানো যায়নি: ' + e.message, false);
            });
        });
        function removeAccount(id, fingerprint) {
            if (!confirm('"' + id + '" অ্যাকাউন্টটি মুছে ফেলবেন? সাইট থেকে ওই অ্যাকাউন্ট আর বট চালাতে পারবে না।')) return;
            setAccStatus('⏳ মুছে ফেলা হচ্ছে...', true);
            fetch(RENDER_URL + '/api/admin/accounts/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, secret: SECRET })
            }).then(function (r) { return r.json(); }).then(function (d) {
                if (d && d.ok) {
                    // Also drop the matching session from wp_options (by
                    // fingerprint — the session string itself never leaves
                    // the server).
                    var form = new FormData();
                    form.append('action', 'mla_accounts_remove');
                    form.append('nonce', NONCE);
                    form.append('fingerprint', fingerprint || '');
                    return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                        .then(function () { setAccStatus('✅ অ্যাকাউন্ট মুছে ফেলা হয়েছে।', true); return fetchAccounts(); });
                }
                setAccStatus('❌ মুছে ফেলা যায়নি: ' + (d && d.error ? d.error : 'অজানা ত্রুটি'), false);
            }).catch(function (e) {
                setAccStatus('❌ সার্ভারে পৌঁছানো যায়নি: ' + e.message, false);
            });
        }
        document.getElementById('mla-acc-sync').addEventListener('click', function () { syncAccounts(true); });
        // On page open: restore the pool from wp_options (server-side), then
        // show the live account list.
        fetchAccounts();
        if (HAS_SESSIONS) syncAccounts(false);
    })();
    </script>
    <?php
}
