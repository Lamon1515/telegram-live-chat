<?php
/**
 * MLA Bots — Admin Panel (wp-admin only, NEVER a user page)
 *
 * Adds a "MLA Bots" page under the WordPress admin menu where the site owner
 * manages the connected Telegram income bots (username, name, description,
 * how_to_earn). The list is saved in wp_options (mla_connected_bots) and
 * pushed to the Render live-chat server via POST /api/admin/bots/sync so the
 * GramJS userbot bridge can operate those bots from the site.
 *
 * SECURITY: The sync secret (ADMIN_BOTS_SECRET) is embedded here and in the
 * Render env vars only. This snippet is visible ONLY inside wp-admin to
 * administrators — it is never on a user-facing page. Do NOT copy this code
 * into a public page or the theme.
 *
 * Install: Code Snippets → Add New → paste this whole file → "Only run in
 * administration area" → Save & Activate. (Or add to a small plugin.)
 */

if (!defined('ABSPATH')) exit;

// --- Config: keep these in sync with the Render service ---
define('MLA_BOTS_RENDER_URL', 'https://telegram-live-chat-ej29.onrender.com');
define('MLA_BOTS_SYNC_SECRET', '0db415fe555d521b53a147f4f9e8423b201ed29ff447d08c'); // ADMIN_BOTS_SECRET — same value as the Render env var
define('MLA_BOTS_OPTION', 'mla_connected_bots');

function mla_bots_get_list() {
    $bots = get_option(MLA_BOTS_OPTION, array());
    if (!is_array($bots)) $bots = array();
    $clean = array();
    foreach ($bots as $b) {
        if (!is_array($b)) continue;
        $u = isset($b['username']) ? preg_replace('/^@/', '', sanitize_text_field($b['username'])) : '';
        if (!preg_match('/^[A-Za-z0-9_]{5,32}$/', $u)) continue;
        $clean[] = array(
            'username'    => $u,
            'name'        => isset($b['name']) ? sanitize_text_field($b['name']) : $u,
            'description' => isset($b['description']) ? sanitize_textarea_field($b['description']) : '',
            'how_to_earn' => isset($b['how_to_earn']) ? sanitize_textarea_field($b['how_to_earn']) : '',
        );
    }
    return $clean;
}

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
    // Reuse the same cleaning as mla_bots_get_list by saving raw then reading back.
    update_option(MLA_BOTS_OPTION, $bots);
    $clean = mla_bots_get_list();
    update_option(MLA_BOTS_OPTION, $clean);
    wp_send_json_success(array('bots' => $clean, 'count' => count($clean)));
});

function mla_bots_admin_page() {
    if (!current_user_can('manage_options')) { wp_die('Forbidden'); }
    $bots = mla_bots_get_list();
    $bots_json = wp_json_encode($bots);
    $render_url = esc_js(MLA_BOTS_RENDER_URL);
    $secret = esc_js(MLA_BOTS_SYNC_SECRET);
    $nonce = wp_create_nonce('mla_bots_nonce');
    $ajax_url = esc_js(admin_url('admin-ajax.php'));
    ?>
    <div class="wrap">
        <h1>🤖 MLA Bots — Telegram ইনকাম বট</h1>
        <p>এখানে যেসব বট যুক্ত করবেন, সাইটের ভিজিটররা সেগুলো সাইট থেকেই চালাতে পারবে। বট যুক্ত করলেই সার্ভারে (Render) পাঠিয়ে দেওয়া হয় — আলাদা করে কিছু করতে হবে না।</p>
        <p id="mla-bots-status" style="font-weight:bold;"></p>

        <h2>➕ নতুন বট যুক্ত করুন</h2>
        <table class="form-table">
            <tr><th><label for="mla-bot-username">Bot username *</label></th>
                <td><input id="mla-bot-username" type="text" placeholder="@SomeBot" style="width:300px"> <span class="description">@ ছাড়াও লিখতে পারেন</span></td></tr>
            <tr><th><label for="mla-bot-name">নাম</label></th>
                <td><input id="mla-bot-name" type="text" placeholder="যেমন: Earn Bot" style="width:300px"></td></tr>
            <tr><th><label for="mla-bot-desc">বিবরণ</label></th>
                <td><textarea id="mla-bot-desc" rows="2" cols="50" placeholder="এই বট থেকে কিভাবে আয় হয়"></textarea></td></tr>
            <tr><th><label for="mla-bot-earn">কিভাবে আয়</label></th>
                <td><textarea id="mla-bot-earn" rows="2" cols="50" placeholder="যেমন: টাস্ক করুন, রেফার করুন"></textarea></td></tr>
        </table>
        <p><button id="mla-bot-add" class="button button-primary">➕ বট যুক্ত করুন</button></p>

        <h2>📋 যুক্ত বটগুলো (<span id="mla-bot-count"><?php echo count($bots); ?></span>টি)</h2>
        <table class="widefat striped" id="mla-bot-table">
            <thead><tr><th>Username</th><th>নাম</th><th>বিবরণ / কিভাবে আয়</th><th></th></tr></thead>
            <tbody id="mla-bot-list"></tbody>
        </table>
        <p><button id="mla-bot-sync" class="button">🔄 সার্ভারে আবার পাঠান (Sync)</button>
        <span class="description">সার্ভার রিস্টার্ট হলে এই বোতামে একবার ক্লিক করলেই বটগুলো আবার চালু হবে। এই পেজ খুললেই নিজে থেকেও Sync হয়।</span></p>
    </div>
    <script>
    (function () {
        var RENDER_URL = '<?php echo $render_url; ?>';
        var SECRET = '<?php echo $secret; ?>';
        var AJAX_URL = '<?php echo $ajax_url; ?>';
        var NONCE = '<?php echo $nonce; ?>';
        var bots = <?php echo $bots_json; ?> || [];
        var statusEl = document.getElementById('mla-bots-status');
        var listEl = document.getElementById('mla-bot-list');
        var countEl = document.getElementById('mla-bot-count');

        function setStatus(msg, ok) {
            statusEl.textContent = msg;
            statusEl.style.color = ok ? 'green' : 'red';
        }
        function renderList() {
            countEl.textContent = bots.length;
            listEl.innerHTML = '';
            if (!bots.length) {
                listEl.innerHTML = '<tr><td colspan="4">এখনো কোনো বট যুক্ত হয়নি। উপরের ফর্ম থেকে যুক্ত করুন।</td></tr>';
                return;
            }
            bots.forEach(function (b, i) {
                var tr = document.createElement('tr');
                var desc = (b.description || '') + (b.how_to_earn ? ' — কিভাবে আয়: ' + b.how_to_earn : '');
                tr.innerHTML = '<td><b>@' + esc(b.username) + '</b></td><td>' + esc(b.name || b.username) + '</td><td>' + esc(desc) + '</td>';
                var td = document.createElement('td');
                var del = document.createElement('button');
                del.className = 'button';
                del.textContent = '✕ মুছুন';
                del.onclick = function () { removeBot(i); };
                td.appendChild(del);
                tr.appendChild(td);
                listEl.appendChild(tr);
            });
        }
        function esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }
        // Push the current list to the Render server (secret-protected).
        function syncToServer() {
            setStatus('⏳ সার্ভারে পাঠানো হচ্ছে...', true);
            return fetch(RENDER_URL + '/api/admin/bots/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bots: bots, secret: SECRET })
            }).then(function (r) { return r.json(); }).then(function (d) {
                if (d && d.ok) {
                    setStatus('✅ সেভ হয়েছে — সার্ভারে ' + d.count + 'টি বট চালু আছে।', true);
                } else {
                    setStatus('❌ সার্ভারে পাঠানো যায়নি: ' + (d && d.error ? d.error : 'অজানা ত্রুটি'), false);
                }
            }).catch(function (e) {
                setStatus('❌ সার্ভারে পৌঁছানো যায়নি: ' + e.message, false);
            });
        }
        // Save the list to WordPress, then push it to the server.
        function saveAll() {
            setStatus('⏳ সেভ হচ্ছে...', true);
            var form = new FormData();
            form.append('action', 'mla_bots_save');
            form.append('nonce', NONCE);
            form.append('bots', JSON.stringify(bots));
            return fetch(AJAX_URL, { method: 'POST', body: form, credentials: 'same-origin' })
                .then(function (r) { return r.json(); }).then(function (d) {
                    if (d && d.success) {
                        bots = d.data.bots || [];
                        renderList();
                        return syncToServer();
                    }
                    setStatus('❌ সেভ হয়নি: ' + (d && d.data ? d.data : 'অজানা ত্রুটি'), false);
                }).catch(function (e) {
                    setStatus('❌ সেভ হয়নি: ' + e.message, false);
                });
        }
        function removeBot(i) {
            if (!confirm('"' + bots[i].username + '" বটটি মুছে ফেলবেন?')) return;
            bots.splice(i, 1);
            saveAll();
        }
        document.getElementById('mla-bot-add').addEventListener('click', function () {
            var u = document.getElementById('mla-bot-username').value.trim().replace(/^@/, '');
            if (!/^[A-Za-z0-9_]{5,32}$/.test(u)) {
                setStatus('❌ সঠিক Bot username দিন (যেমন @SomeBot)।', false);
                return;
            }
            if (bots.some(function (b) { return b.username.toLowerCase() === u.toLowerCase(); })) {
                setStatus('❌ এই বটটি ইতিমধ্যে যুক্ত আছে।', false);
                return;
            }
            bots.push({
                username: u,
                name: document.getElementById('mla-bot-name').value.trim() || u,
                description: document.getElementById('mla-bot-desc').value.trim(),
                how_to_earn: document.getElementById('mla-bot-earn').value.trim()
            });
            document.getElementById('mla-bot-username').value = '';
            document.getElementById('mla-bot-name').value = '';
            document.getElementById('mla-bot-desc').value = '';
            document.getElementById('mla-bot-earn').value = '';
            saveAll();
        });
        document.getElementById('mla-bot-sync').addEventListener('click', function () { syncToServer(); });
        renderList();
        // Auto-sync on page open (self-heals after a server redeploy/restart).
        if (bots.length) syncToServer();
    })();
    </script>
    <?php
}
