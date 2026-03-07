import { Context, Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  dataapi: R2Bucket;
  DB: D1Database;
  ADMIN_TOKEN?: string;
};

type GatewayRecord = {
  key: string;
  target_url: string;
  created_at: string;
  updated_at: string;
};

type PopularGateway = {
  gateway_key: string;
  total_hit: number;
};

type UserRecord = {
  id: number;
  nama: string;
  email: string;
  no_wa: string;
  api_key: string;
  limit_per_month: number;
  total_hit: number;
  status: 'active' | 'banned';
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/*', cors());
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: message || 'Internal Server Error' }, 500);
  }

  return c.html(
    `<pre style="white-space:pre-wrap;background:#020617;color:#e2e8f0;padding:16px;border-radius:12px;">${message}</pre>`,
    500
  );
});

const DEFAULT_LIMIT = 100;
let userTableInitialized = false;

const cleanKey = (rawKey: string) => rawKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
const objectName = (key: string) => `${cleanKey(key)}.json`;
const cleanText = (v: string) => v.trim().replace(/[\u0000-\u001f\u007f]/g, '');

const ensureUsersTable = async (db: D1Database) => {
  if (userTableInitialized) return;

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, email TEXT NOT NULL UNIQUE, no_wa TEXT NOT NULL, api_key TEXT NOT NULL UNIQUE, limit_per_month INTEGER NOT NULL DEFAULT 100, total_hit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key)').run();
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS gateway_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, gateway_key TEXT NOT NULL UNIQUE, total_hit INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_gateway_hits_total_hit ON gateway_hits(total_hit DESC)').run();

  userTableInitialized = true;
};

const listGateways = async (bucket: R2Bucket): Promise<GatewayRecord[]> => {
  const all: GatewayRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ cursor });
    for (const item of page.objects) {
      if (!item.key.endsWith('.json')) continue;
      const obj = await bucket.get(item.key);
      if (!obj) continue;

      const parsed = (await obj.json()) as Partial<GatewayRecord>;
      if (!parsed.key || !parsed.target_url) continue;

      all.push({
        key: parsed.key,
        target_url: parsed.target_url,
        created_at: parsed.created_at ?? new Date().toISOString(),
        updated_at: parsed.updated_at ?? new Date().toISOString()
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return all.sort((a, b) => a.key.localeCompare(b.key));
};

const createApiKey = (): string => {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `ak_${random}`;
};

const parseApiKey = (c: Context<{ Bindings: Bindings }>): string => {
  const queryKey = cleanText(c.req.query('apikey') ?? '');
  const headerKey = cleanText(c.req.header('x-api-key') ?? '');
  return queryKey || headerKey;
};

const getUserByApiKey = async (db: D1Database, apiKey: string): Promise<UserRecord | null> => {
  const data = await db
    .prepare('SELECT id, nama, email, no_wa, api_key, limit_per_month, total_hit, status FROM users WHERE api_key = ? LIMIT 1')
    .bind(apiKey)
    .first<UserRecord>();

  return data ?? null;
};

const adminHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>API Gateway Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .v3-logo {
      font-weight: 900;
      background: linear-gradient(to bottom, #fff 10%, #fbbf24 30%, #f59e0b 60%, #ef4444 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: inline-block;
    }

    .logo-fire {
      animation: fireFlicker 0.4s ease-in-out infinite alternate;
      transform-origin: center bottom;
      filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.6));
    }

    @keyframes fireFlicker {
      0% { transform: scaleY(1) scaleX(1) skewX(0deg); filter: brightness(1) drop-shadow(0 0 8px rgba(255, 100, 0, 0.8)); }
      25% { transform: scaleY(1.1) scaleX(0.9) skewX(3deg); filter: brightness(1.2) drop-shadow(0 0 15px rgba(255, 200, 0, 0.9)); }
      100% { transform: scaleY(0.98) scaleX(1.02) skewX(-1deg); filter: brightness(1.1) drop-shadow(0 0 10px rgba(255, 150, 0, 0.8)); }
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_right,#22d3ee22,transparent_40%),radial-gradient(circle_at_bottom_left,#a855f722,transparent_45%)] pointer-events-none"></div>
  <main id="adminApp" class="hidden relative z-10 max-w-6xl mx-auto p-6 md:p-10">
    <header class="mb-8 flex items-start justify-between gap-3 sm:gap-4">
      <div class="logo-fire flex items-center gap-3 min-w-0">
        <svg viewBox="0 0 24 24" class="w-8 h-8 sm:w-10 sm:h-10 shrink-0" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M13.5 2.8c.2 2.3-.6 3.9-2.2 5.7-1 1.1-1.7 2.2-1.7 3.8 0 1.8 1.3 3.2 3.2 3.2 2.5 0 4-2 4-4.6 0-2-1-3.8-3.3-8.1Z" fill="#fb923c"/>
          <path d="M9.4 13.5c-1.3 1.1-2.2 2.5-2.2 4.3 0 2.6 2 4.4 4.8 4.4 3.7 0 6-2.8 6-6.5 0-2.2-.9-4.2-2.6-6.1.2 3.2-1.2 5.3-3.6 5.3-1 0-1.8-.5-2.4-1.4Z" fill="#ef4444"/>
          <path d="M12.2 16.7c-1.1 1-1.6 1.8-1.6 2.8 0 1.3 1 2.2 2.4 2.2 1.8 0 3.1-1.3 3.1-3.1 0-1-.4-2-1.2-2.9-.2 1-.9 1.8-2 1.8-.3 0-.5-.1-.7-.2Z" fill="#fde68a"/>
        </svg>
        <h1 class="v3-logo text-3xl sm:text-4xl leading-tight">V3 API</h1>
      </div>
      <div class="flex gap-2 flex-wrap justify-end">
        <a href="/register" class="px-4 py-3 rounded-xl border border-cyan-400/40 text-cyan-300">Register User</a>
        <button id="logoutAdmin" class="px-4 py-3 rounded-xl border border-rose-400/40 text-rose-300">Logout Admin</button>
        <button id="openModal" class="px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 font-semibold">+ Add API</button>
      </div>
    </header>

    <section class="grid md:grid-cols-3 gap-4 mb-8">
      <article class="bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl p-5">
        <p class="text-slate-300 text-sm">Total API Aktif</p>
        <p id="totalApi" class="text-4xl font-extrabold text-cyan-300 mt-2">0</p>
      </article>
      <article class="bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl p-5">
        <p class="text-slate-300 text-sm">Total User</p>
        <p id="totalUser" class="text-4xl font-extrabold text-violet-300 mt-2">0</p>
      </article>
      <article class="bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl p-5">
        <p class="text-slate-300 text-sm">User Active</p>
        <p id="activeUser" class="text-4xl font-extrabold text-emerald-300 mt-2">0</p>
      </article>
    </section>

    <section class="bg-slate-900/35 backdrop-blur-xl border-2 border-cyan-400/70 rounded-2xl p-5 mb-6">
      <h2 class="text-lg font-bold text-cyan-200 mb-4">🔥 Top Gateway Traffic</h2>
      <div id="topTrafficList" class="space-y-3">
        <p class="text-slate-400 text-sm">Belum ada data traffic.</p>
      </div>
    </section>

    <section class="mb-4 flex gap-2">
      <button data-tab="gateways" class="tabBtn px-4 py-2 rounded-xl bg-cyan-500/20 border border-cyan-400/40">Manage Gateways</button>
      <button data-tab="users" class="tabBtn px-4 py-2 rounded-xl border border-white/20">Manage Users</button>
    </section>

    <section class="bg-slate-900/40 backdrop-blur-xl border-2 border-cyan-400/70 rounded-2xl p-4 mb-4">
      <input id="searchInput" class="w-full bg-slate-900/70 border border-cyan-400/30 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-cyan-400" placeholder="Cari gateway key atau email user" />
    </section>

    <section id="gatewayPanel" class="bg-slate-900/35 backdrop-blur-xl border-2 border-amber-300/60 rounded-2xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-900/70 text-slate-200 border-b-2 border-cyan-400/70">
            <tr>
              <th class="text-left px-4 py-3">Key</th>
              <th class="text-left px-4 py-3">Target URL</th>
              <th class="text-left px-4 py-3">Updated</th>
              <th class="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody id="gatewayBody"></tbody>
        </table>
      </div>
    </section>

    <section id="userPanel" class="hidden bg-slate-900/35 backdrop-blur-xl border-2 border-amber-300/60 rounded-2xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-900/70 text-slate-200 border-b-2 border-cyan-400/70">
            <tr>
              <th class="text-left px-4 py-3">Nama</th>
              <th class="text-left px-4 py-3">Email</th>
              <th class="text-left px-4 py-3">No WA</th>
              <th class="text-left px-4 py-3">Hit/Limit</th>
              <th class="text-left px-4 py-3">Status</th>
              <th class="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody id="userBody"></tbody>
        </table>
      </div>
    </section>
  </main>

  <div id="adminLock" class="fixed inset-0 z-20 bg-slate-950/90 backdrop-blur flex items-center justify-center p-6">
    <div class="w-full max-w-md bg-slate-900/90 border border-cyan-400/40 rounded-2xl p-6">
      <h2 class="text-2xl font-bold mb-2">Login Admin</h2>
      <p class="text-slate-300 text-sm mb-4">Masukkan ADMIN_TOKEN untuk membuka dashboard admin.</p>
      <form id="adminLoginForm" class="space-y-3">
        <input id="adminTokenInput" type="password" required placeholder="ADMIN_TOKEN" class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/10" />
        <button class="w-full px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 font-semibold">Masuk Admin</button>
      </form>
    </div>
  </div>

  <div id="gatewayModal" class="hidden fixed inset-0 bg-slate-950/70 backdrop-blur-sm items-center justify-center p-4">
    <div class="w-full max-w-xl bg-slate-900/90 border border-cyan-400/40 rounded-2xl p-6">
      <h2 id="modalTitle" class="text-2xl font-bold mb-4">Add API Gateway</h2>
      <form id="gatewayForm" class="space-y-4">
        <input id="keyInput" required class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/10" placeholder="Key Name" />
        <input id="urlInput" type="url" required class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/10" placeholder="Target API URL" />
        <div class="flex justify-end gap-3">
          <button type="button" id="closeModal" class="px-4 py-2 rounded-lg border border-white/20">Cancel</button>
          <button type="submit" class="px-5 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-violet-600">Save</button>
        </div>
      </form>
    </div>
  </div>

<script>
const state = { gateways: [], users: [], popular: [], tab: 'gateways', editingGateway: null };
const gatewayBody = document.getElementById('gatewayBody');
const userBody = document.getElementById('userBody');
const searchInput = document.getElementById('searchInput');
const gatewayPanel = document.getElementById('gatewayPanel');
const userPanel = document.getElementById('userPanel');
const gatewayModal = document.getElementById('gatewayModal');
const keyInput = document.getElementById('keyInput');
const urlInput = document.getElementById('urlInput');
const topTrafficList = document.getElementById('topTrafficList');
const adminApp = document.getElementById('adminApp');
const adminLock = document.getElementById('adminLock');
const adminLoginForm = document.getElementById('adminLoginForm');
const adminTokenInput = document.getElementById('adminTokenInput');
const ADMIN_TOKEN_KEY = 'admin_token';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

const getAdminToken = () => localStorage.getItem(ADMIN_TOKEN_KEY) || '';
const authHeaders = (base = {}) => {
  const token = getAdminToken();
  return token ? { ...base, Authorization: 'Bearer ' + token } : base;
};

async function adminFetch(url, options = {}) {
  const headers = authHeaders(options.headers || {});
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    adminApp.classList.add('hidden');
    adminLock.classList.remove('hidden');
    throw new Error('Unauthorized admin token');
  }
  return res;
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabBtn').forEach((btn) => {
    const active = btn.getAttribute('data-tab') === tab;
    btn.className = 'tabBtn px-4 py-2 rounded-xl border ' + (active ? 'bg-cyan-500/20 border-cyan-400/40' : 'border-white/20');
  });
  gatewayPanel.classList.toggle('hidden', tab !== 'gateways');
  userPanel.classList.toggle('hidden', tab !== 'users');
  render();
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const gatewayFiltered = state.gateways.filter((item) => item.key.toLowerCase().includes(q));
  const userFiltered = state.users.filter((u) => (u.nama + ' ' + u.email + ' ' + u.no_wa).toLowerCase().includes(q));

  gatewayBody.innerHTML = gatewayFiltered.map((item) =>
    '<tr class="border-t border-cyan-400/30 hover:bg-cyan-500/5 transition-colors">' +
    '<td class="px-4 py-3 text-cyan-300 font-semibold">' + esc(item.key) + '</td>' +
    '<td class="px-4 py-3">' + esc(item.target_url) + '</td>' +
    '<td class="px-4 py-3 text-slate-400">' + new Date(item.updated_at).toLocaleString('id-ID') + '</td>' +
    '<td class="px-4 py-3"><div class="flex justify-end gap-2">' +
      '<button data-copy="' + esc(item.key) + '" class="px-3 py-1 rounded-lg border border-cyan-400/40 text-cyan-300">Copy Link</button>' +
      '<button data-edit="' + esc(item.key) + '" class="px-3 py-1 rounded-lg border border-violet-400/40 text-violet-300">Edit</button>' +
      '<button data-delete="' + esc(item.key) + '" class="px-3 py-1 rounded-lg border border-rose-400/40 text-rose-300">Delete</button>' +
    '</div></td></tr>'
  ).join('') || '<tr><td colspan="4" class="px-4 py-10 text-center text-slate-400">Tidak ada gateway.</td></tr>';

  userBody.innerHTML = userFiltered.map((user) =>
    '<tr class="border-t border-cyan-400/30 hover:bg-cyan-500/5 transition-colors">' +
    '<td class="px-4 py-3">' + esc(user.nama) + '</td>' +
    '<td class="px-4 py-3">' + esc(user.email) + '</td>' +
    '<td class="px-4 py-3">' + esc(user.no_wa) + '</td>' +
    '<td class="px-4 py-3">' + user.total_hit + '/' + user.limit_per_month + '</td>' +
    '<td class="px-4 py-3 ' + (user.status === 'active' ? 'text-emerald-300' : 'text-rose-300') + '">' + esc(user.status) + '</td>' +
    '<td class="px-4 py-3"><div class="flex justify-end gap-2">' +
      '<button data-limit="' + user.id + '" class="px-3 py-1 rounded-lg border border-cyan-400/40 text-cyan-300">Set Limit</button>' +
      '<button data-toggle="' + user.id + '" class="px-3 py-1 rounded-lg border border-amber-400/40 text-amber-300">Ban/Unban</button>' +
      '<button data-remove="' + user.id + '" class="px-3 py-1 rounded-lg border border-rose-400/40 text-rose-300">Delete</button>' +
    '</div></td></tr>'
  ).join('') || '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400">Tidak ada user.</td></tr>';

  const maxHit = state.popular.length ? Math.max(...state.popular.map((p) => p.total_hit), 1) : 1;
  topTrafficList.innerHTML = state.popular.map((item) => {
    const pct = Math.max(6, Math.round((item.total_hit / maxHit) * 100));
    return '<div class="rounded-xl border border-cyan-400/35 bg-slate-900/50 p-3">' +
      '<div class="flex justify-between text-sm mb-2">' +
        '<span class="text-cyan-200 font-semibold break-all">' + esc(item.gateway_key) + '</span>' +
        '<span class="text-amber-200 font-semibold">' + item.total_hit + ' hit</span>' +
      '</div>' +
      '<div class="h-2 rounded-full bg-slate-800 overflow-hidden">' +
        '<div class="h-full bg-cyan-400" style="width:' + pct + '%"></div>' +
      '</div>' +
    '</div>';
  }).join('') || '<p class="text-slate-400 text-sm">Belum ada data traffic.</p>';

  document.getElementById('totalApi').textContent = state.gateways.length;
  document.getElementById('totalUser').textContent = state.users.length;
  document.getElementById('activeUser').textContent = state.users.filter((u) => u.status === 'active').length;
}

async function loadData() {
  const [gRes, uRes, pRes] = await Promise.all([adminFetch('/api/admin/gateways'), adminFetch('/api/admin/users'), adminFetch('/api/admin/stats/popular')]);
  const gData = await gRes.json();
  const uData = await uRes.json();
  const pData = await pRes.json();
  state.gateways = gData.items || [];
  state.users = uData.items || [];
  state.popular = pData.items || [];
  render();
}

searchInput.addEventListener('input', render);
document.querySelectorAll('.tabBtn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab'))));

document.getElementById('openModal').addEventListener('click', () => {
  state.editingGateway = null;
  keyInput.disabled = false;
  keyInput.value = '';
  urlInput.value = '';
  document.getElementById('modalTitle').textContent = 'Add API Gateway';
  gatewayModal.classList.remove('hidden');
  gatewayModal.classList.add('flex');
});

document.getElementById('closeModal').addEventListener('click', () => {
  gatewayModal.classList.add('hidden');
  gatewayModal.classList.remove('flex');
});

document.getElementById('gatewayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const endpoint = state.editingGateway ? '/api/admin/gateways/' + state.editingGateway : '/api/admin/gateways';
  const method = state.editingGateway ? 'PUT' : 'POST';
  const payload = state.editingGateway ? { target_url: urlInput.value } : { key: keyInput.value, target_url: urlInput.value };
  const res = await adminFetch(endpoint, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    alert('Gagal simpan gateway');
    return;
  }
  gatewayModal.classList.add('hidden');
  gatewayModal.classList.remove('flex');
  await loadData();
});

gatewayBody.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  const copy = target.getAttribute('data-copy');
  const edit = target.getAttribute('data-edit');
  const del = target.getAttribute('data-delete');

  if (copy) {
    const link = location.origin + '/api/gateway/' + copy;
    await navigator.clipboard.writeText(link);
    alert('Copied: ' + link);
    return;
  }

  if (edit) {
    const selected = state.gateways.find((g) => g.key === edit);
    if (!selected) return;
    state.editingGateway = selected.key;
    keyInput.value = selected.key;
    keyInput.disabled = true;
    urlInput.value = selected.target_url;
    document.getElementById('modalTitle').textContent = 'Edit API Gateway';
    gatewayModal.classList.remove('hidden');
    gatewayModal.classList.add('flex');
    return;
  }

  if (del) {
    if (!confirm('Delete gateway ' + del + '?')) return;
    await adminFetch('/api/admin/gateways/' + del, { method: 'DELETE' });
    await loadData();
  }
});

userBody.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  const idLimit = target.getAttribute('data-limit');
  const idToggle = target.getAttribute('data-toggle');
  const idRemove = target.getAttribute('data-remove');

  if (idLimit) {
    const next = prompt('Set limit per month:', '100');
    if (!next) return;
    const limit = Number(next);
    if (!Number.isFinite(limit) || limit < 0) {
      alert('Limit tidak valid');
      return;
    }
    await adminFetch('/api/admin/users/' + idLimit, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit_per_month: limit }) });
    await loadData();
    return;
  }

  if (idToggle) {
    await adminFetch('/api/admin/users/' + idToggle + '/toggle-status', { method: 'POST' });
    await loadData();
    return;
  }

  if (idRemove) {
    if (!confirm('Delete user #' + idRemove + '?')) return;
    await adminFetch('/api/admin/users/' + idRemove, { method: 'DELETE' });
    await loadData();
  }
});

document.getElementById('logoutAdmin').addEventListener('click', () => {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  adminApp.classList.add('hidden');
  adminLock.classList.remove('hidden');
});

adminLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = adminTokenInput.value.trim();
  if (!token) return;
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
  try {
    await loadData();
    adminLock.classList.add('hidden');
    adminApp.classList.remove('hidden');
    switchTab('gateways');
  } catch (err) {
    alert('Token admin salah atau kosong.');
  }
});

(async () => {
  const savedToken = getAdminToken();
  if (!savedToken) {
    adminLock.classList.remove('hidden');
    return;
  }
  try {
    await loadData();
    adminLock.classList.add('hidden');
    adminApp.classList.remove('hidden');
    switchTab('gateways');
  } catch (err) {
    adminLock.classList.remove('hidden');
  }
})();
</script>
</body>
</html>`;

const registerHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Register API User</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100 p-6">
  <div class="max-w-2xl mx-auto mt-8 bg-white/10 border border-cyan-400/20 backdrop-blur-2xl rounded-3xl p-8">
    <p class="tracking-[0.28em] text-cyan-300 uppercase text-xs mb-2">V4API</p>
    <h1 class="text-3xl font-bold mb-3">Daftar User API Gateway</h1>
    <p class="text-slate-300 mb-6">Isi data kamu. Sistem akan otomatis generate API key unik.</p>
    <form id="registerForm" class="space-y-4">
      <input id="nama" required placeholder="Nama" class="w-full px-4 py-3 rounded-xl bg-slate-950/80 border border-white/20" />
      <input id="email" type="email" required placeholder="Email" class="w-full px-4 py-3 rounded-xl bg-slate-950/80 border border-white/20" />
      <input id="no_wa" required placeholder="No WA (contoh: 6281234567890)" class="w-full px-4 py-3 rounded-xl bg-slate-950/80 border border-white/20" />
      <button class="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 font-semibold">Daftar Sekarang</button>
    </form>
    <a href="/login" class="inline-block mt-4 text-cyan-300 hover:text-cyan-200 underline">Sudah punya akun? Login di sini</a>

    <div id="result" class="hidden mt-6 p-5 rounded-xl border border-emerald-400/30 bg-emerald-500/10">
      <p class="text-emerald-300 font-semibold mb-2">Pendaftaran berhasil ✅</p>
      <p class="text-sm text-slate-300">API Key Anda:</p>
      <code id="apikey" class="block mt-2 px-3 py-2 rounded bg-slate-900 text-cyan-300"></code>
      <p class="text-sm text-slate-300 mt-3">Gunakan endpoint:</p>
      <code id="usage" class="block mt-2 px-3 py-2 rounded bg-slate-900 text-violet-300 break-all"></code>
      <a id="dashboardLink" class="inline-block mt-4 px-4 py-2 rounded-lg border border-cyan-400/40 text-cyan-300">Buka User Dashboard</a>
    </div>
  </div>

<script>
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitButton = e.target.querySelector('button');
  const originalText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Loading...';

  const payload = {
    nama: document.getElementById('nama').value,
    email: document.getElementById('email').value,
    no_wa: document.getElementById('no_wa').value
  };

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Gagal daftar');
      return;
    }

    const key = data.user.api_key;
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('apikey').textContent = key;
    document.getElementById('usage').textContent = location.origin + '/api/gateway/:key?apikey=' + key;
    const dash = '/dashboard?apikey=' + encodeURIComponent(key);
    document.getElementById('dashboardLink').href = dash;
  } catch (err) {
    alert('Network Error: ' + (err && err.message ? err.message : String(err)));
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalText;
  }
});
</script>
</body>
</html>`;

const loginHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login User</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100 p-6">
  <div class="max-w-xl mx-auto mt-12 bg-white/10 border border-cyan-400/20 backdrop-blur-2xl rounded-3xl p-8">
    <p class="tracking-[0.28em] text-cyan-300 uppercase text-xs mb-2">V4API</p>
    <h1 class="text-3xl font-bold mb-3">Login User API</h1>
    <p class="text-slate-300 mb-6">Masukkan email dan API key kamu untuk masuk ke dashboard.</p>
    <form id="loginForm" class="space-y-4">
      <input id="email" type="email" required placeholder="Email" class="w-full px-4 py-3 rounded-xl bg-slate-950/80 border border-white/20" />
      <input id="api_key" required placeholder="API Key (ak_xxxxx)" class="w-full px-4 py-3 rounded-xl bg-slate-950/80 border border-white/20" />
      <button class="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 font-semibold">Login</button>
    </form>
    <a href="/register" class="inline-block mt-4 text-cyan-300 hover:text-cyan-200 underline">Belum punya akun? Daftar di sini</a>
  </div>

<script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitButton = e.target.querySelector('button');
  const originalText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Loading...';

  const payload = {
    email: document.getElementById('email').value,
    api_key: document.getElementById('api_key').value
  };

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Login gagal');
      return;
    }

    localStorage.setItem('apikey', data.user.api_key);
    location.href = '/dashboard';
  } catch (err) {
    alert('Network Error: ' + (err && err.message ? err.message : String(err)));
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalText;
  }
});
</script>
</body>
</html>`;

const dashboardHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .v3-logo {
      font-weight: 900;
      background: linear-gradient(to bottom, #fff 10%, #fbbf24 30%, #f59e0b 60%, #ef4444 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: inline-block;
    }

    .logo-fire {
      animation: fireFlicker 0.4s ease-in-out infinite alternate;
      transform-origin: center bottom;
      filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.6));
    }

    .sidebar-overlay {
      transition: opacity 0.25s ease;
    }

    .sidebar-panel {
      transition: transform 0.3s ease;
    }

    @keyframes fireFlicker {
      0% { transform: scaleY(1) scaleX(1) skewX(0deg); filter: brightness(1) drop-shadow(0 0 8px rgba(255, 100, 0, 0.8)); }
      25% { transform: scaleY(1.1) scaleX(0.9) skewX(3deg); filter: brightness(1.2) drop-shadow(0 0 15px rgba(255, 200, 0, 0.9)); }
      100% { transform: scaleY(0.98) scaleX(1.02) skewX(-1deg); filter: brightness(1.1) drop-shadow(0 0 10px rgba(255, 150, 0, 0.8)); }
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 sm:p-6">
  <div class="max-w-6xl mx-auto relative">
    <header class="mb-6 flex items-start justify-between gap-3 sm:gap-4">
      <div class="flex items-center gap-3 min-w-0">
        <button id="menuBtn" aria-label="Buka menu" class="shrink-0 p-2.5 rounded-xl border border-cyan-400/50 bg-slate-900/40 hover:border-cyan-300 transition">
          <span id="menuIcon" class="block transition-transform duration-300">
            <svg viewBox="0 0 24 24" class="w-6 h-6 text-cyan-200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </span>
        </button>
        <div class="logo-fire flex items-center gap-3 min-w-0">
          <svg viewBox="0 0 24 24" class="w-8 h-8 sm:w-10 sm:h-10 shrink-0" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M13.5 2.8c.2 2.3-.6 3.9-2.2 5.7-1 1.1-1.7 2.2-1.7 3.8 0 1.8 1.3 3.2 3.2 3.2 2.5 0 4-2 4-4.6 0-2-1-3.8-3.3-8.1Z" fill="#fb923c"/>
            <path d="M9.4 13.5c-1.3 1.1-2.2 2.5-2.2 4.3 0 2.6 2 4.4 4.8 4.4 3.7 0 6-2.8 6-6.5 0-2.2-.9-4.2-2.6-6.1.2 3.2-1.2 5.3-3.6 5.3-1 0-1.8-.5-2.4-1.4Z" fill="#ef4444"/>
            <path d="M12.2 16.7c-1.1 1-1.6 1.8-1.6 2.8 0 1.3 1 2.2 2.4 2.2 1.8 0 3.1-1.3 3.1-3.1 0-1-.4-2-1.2-2.9-.2 1-.9 1.8-2 1.8-.3 0-.5-.1-.7-.2Z" fill="#fde68a"/>
          </svg>
          <h1 class="v3-logo text-3xl sm:text-4xl leading-tight">V3 API</h1>
        </div>
      </div>
      <button id="logoutBtn" class="shrink-0 px-3 py-2 sm:px-4 rounded-xl border border-rose-400/40 text-rose-300">Logout</button>
    </header>

    <section class="grid md:grid-cols-3 gap-4 mb-6">
      <article class="bg-white/10 border border-white/10 rounded-2xl p-4 backdrop-blur-xl">
        <p class="text-slate-300 text-sm">Nama</p>
        <p id="nama" class="text-xl font-bold text-cyan-300">-</p>
      </article>
      <article class="bg-white/10 border border-white/10 rounded-2xl p-4 backdrop-blur-xl">
        <p class="text-slate-300 text-sm">Kuota Tersisa</p>
        <p id="sisa" class="text-xl font-bold text-emerald-300">-</p>
      </article>
      <article class="bg-white/10 border border-white/10 rounded-2xl p-4 backdrop-blur-xl">
        <p class="text-slate-300 text-sm">Total Hit</p>
        <p id="hit" class="text-xl font-bold text-violet-300">-</p>
      </article>
    </section>

    <section class="mb-3 border-2 border-cyan-400/70 bg-slate-900/40 backdrop-blur-xl rounded-2xl p-4 flex items-center justify-between">
      <h2 class="text-sm sm:text-base font-semibold text-cyan-200 tracking-wide">API Gateway List</h2>
      <span class="text-xs sm:text-sm text-amber-300">Kotak Data API</span>
    </section>

    <section id="gatewayList" class="space-y-3"></section>
  </div>

  <div id="menuOverlay" class="sidebar-overlay fixed inset-0 bg-black/50 backdrop-blur-[1px] opacity-0 pointer-events-none z-30"></div>
  <aside id="sidebar" class="sidebar-panel fixed left-0 top-0 h-full w-[85%] max-w-sm bg-slate-900/85 border-r border-cyan-400/40 backdrop-blur-2xl p-5 z-40 -translate-x-full">
    <div class="flex items-center justify-between mb-6">
      <div class="logo-fire flex items-center gap-2">
        <svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M13.5 2.8c.2 2.3-.6 3.9-2.2 5.7-1 1.1-1.7 2.2-1.7 3.8 0 1.8 1.3 3.2 3.2 3.2 2.5 0 4-2 4-4.6 0-2-1-3.8-3.3-8.1Z" fill="#fb923c"/>
          <path d="M9.4 13.5c-1.3 1.1-2.2 2.5-2.2 4.3 0 2.6 2 4.4 4.8 4.4 3.7 0 6-2.8 6-6.5 0-2.2-.9-4.2-2.6-6.1.2 3.2-1.2 5.3-3.6 5.3-1 0-1.8-.5-2.4-1.4Z" fill="#ef4444"/>
        </svg>
        <span class="v3-logo text-xl">V3 API</span>
      </div>
      <button id="closeMenuBtn" class="px-3 py-1.5 rounded-lg border border-white/20 text-slate-200">✕</button>
    </div>

    <nav class="space-y-3">
      <a href="#" id="btnMenuAkun" class="flex items-center gap-3 px-4 py-3 rounded-xl border border-cyan-400/40 bg-slate-900/50 hover:border-cyan-300 transition">
        <span>👤</span><span>Akun Saya</span>
      </a>
      <a href="#" id="btnDocs" onclick="openDocs(); return false;" class="flex items-center gap-3 px-4 py-3 rounded-xl border border-cyan-400/40 bg-slate-900/50 hover:border-cyan-300 transition">
        <span>📘</span><span>Dokumentasi</span>
      </a>
      <a href="#" id="btnPro" onclick="openPro(); return false;" class="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-300/70 bg-gradient-to-r from-amber-500/20 to-violet-500/20 hover:border-amber-200 transition text-amber-200 font-semibold">
        <span>👑</span><span>Upgrade Pro</span>
      </a>
    </nav>
  </aside>

  <div id="accountModal" class="hidden fixed inset-0 z-50 items-center justify-center bg-black/55 backdrop-blur-md p-4">
    <div class="w-full max-w-md rounded-2xl border border-cyan-400/40 bg-slate-900/85 backdrop-blur-xl p-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-xl font-bold text-white">Akun Saya</h3>
        <button id="closeAccountBtn" class="px-3 py-1 rounded-lg border border-white/20 text-white">✕</button>
      </div>
      <div class="space-y-3 text-sm">
        <p class="text-white"><span class="text-cyan-300 font-semibold">Nama:</span> <span id="accNama">-</span></p>
        <p class="text-white"><span class="text-cyan-300 font-semibold">Email:</span> <span id="accEmail">-</span></p>
        <p class="text-white"><span class="text-cyan-300 font-semibold">No WA:</span> <span id="accWa">-</span></p>
        <p class="text-white break-all"><span class="text-cyan-300 font-semibold">API Key:</span> <span id="accKey">-</span></p>
      </div>
      <button id="closeAccountFooterBtn" class="mt-5 w-full px-4 py-2 rounded-xl border border-cyan-400/40 text-white hover:border-cyan-300 transition">TUTUP</button>
    </div>
  </div>

  <div id="docsModal" class="hidden fixed inset-0 z-50 items-center justify-center bg-black/55 backdrop-blur-md p-4">
    <div class="w-full max-w-xl rounded-2xl border border-cyan-400/40 bg-slate-900/85 backdrop-blur-xl p-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-xl font-bold text-white">Dokumentasi</h3>
        <button id="closeDocsBtn" class="px-3 py-1 rounded-lg border border-white/20 text-white">✕</button>
      </div>
      <p class="text-slate-200 mb-3">Gunakan parameter prompt untuk bertanya ke AI.</p>
      <pre class="rounded-xl bg-slate-950 border border-slate-700 p-4 text-cyan-300 text-sm overflow-x-auto"><code>GET /api/gateway/aimuslim?apikey=YOUR_KEY&prompt=Halo</code></pre>
      <button id="closeDocsFooterBtn" class="mt-5 w-full px-4 py-2 rounded-xl border border-cyan-400/40 text-white hover:border-cyan-300 transition">Tutup</button>
    </div>
  </div>

  <div id="proModal" class="hidden fixed inset-0 z-50 items-center justify-center bg-black/55 backdrop-blur-md p-4">
    <div class="w-full max-w-xl rounded-2xl border border-amber-300/50 bg-slate-900/90 backdrop-blur-xl p-5">
      <div class="flex items-center justify-between mb-4">
        <div class="w-full mr-3 rounded-xl border border-amber-300 shadow-[0_0_18px_rgba(251,191,36,0.45)] px-4 py-3 text-center">
          <h3 class="text-xl font-bold text-amber-200 tracking-wide">VERSI PRO</h3>
        </div>
        <button id="closeProBtn" class="px-3 py-1 rounded-lg border border-white/20 text-white">✕</button>
      </div>

      <div class="rounded-xl border border-cyan-400/40 bg-slate-900/70 p-4 text-sm text-slate-100 space-y-2 mb-4">
        <p>✅ Limit Tanpa Batas (Unlimited Hits)</p>
        <p>✅ Akses ke Semua Versi API Premium</p>
        <p>✅ Respon API Lebih Cepat & Prioritas</p>
        <p>✅ Support Update Fitur Terbaru</p>
      </div>

      <div class="rounded-xl border border-transparent bg-[linear-gradient(#0f172a,#0f172a),linear-gradient(120deg,#a855f7,#3b82f6)] bg-origin-border bg-clip-padding p-4">
        <p class="text-slate-200 text-sm mb-3">Hubungi kami untuk upgrade sekarang:</p>
        <div class="grid sm:grid-cols-2 gap-3">
          <a href="https://wa.me/6287733745059" target="_blank" rel="noopener noreferrer" class="flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-emerald-400/50 text-emerald-300 hover:border-emerald-300">
            <span>🟢</span><span>WhatsApp</span>
          </a>
          <a href="https://t.me/otomotif_digital" target="_blank" rel="noopener noreferrer" class="flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-sky-400/50 text-sky-300 hover:border-sky-300">
            <span>✈️</span><span>Telegram</span>
          </a>
        </div>
      </div>
    </div>
  </div>

<script>
const apiKey = localStorage.getItem('apikey') || '';
if (!apiKey) {
  alert('Session login tidak ditemukan. Silakan login dulu.');
  location.href = '/login';
}

const sidebar = document.getElementById('sidebar');
const menuOverlay = document.getElementById('menuOverlay');
const menuIcon = document.getElementById('menuIcon');
const accountModal = document.getElementById('accountModal');
const docsModal = document.getElementById('docsModal');
const proModal = document.getElementById('proModal');

function openAccount() {
  closeSidebar();
  accountModal.classList.remove('hidden');
  accountModal.classList.add('flex');
}

function closeAccount() {
  accountModal.classList.add('hidden');
  accountModal.classList.remove('flex');
}

function openDocs() {
  closeSidebar();
  docsModal.classList.remove('hidden');
  docsModal.classList.add('flex');
}

function closeDocs() {
  docsModal.classList.add('hidden');
  docsModal.classList.remove('flex');
}

function openPro() {
  closeSidebar();
  proModal.classList.remove('hidden');
  proModal.classList.add('flex');
}

function closePro() {
  proModal.classList.add('hidden');
  proModal.classList.remove('flex');
}

function openSidebar() {
  sidebar.classList.remove('-translate-x-full');
  menuOverlay.classList.remove('opacity-0', 'pointer-events-none');
  menuIcon.classList.add('rotate-90');
}

function closeSidebar() {
  sidebar.classList.add('-translate-x-full');
  menuOverlay.classList.add('opacity-0', 'pointer-events-none');
  menuIcon.classList.remove('rotate-90');
}

document.getElementById('menuBtn').addEventListener('click', openSidebar);
document.getElementById('closeMenuBtn').addEventListener('click', closeSidebar);
menuOverlay.addEventListener('click', closeSidebar);
document.getElementById('btnMenuAkun').addEventListener('click', (e) => { e.preventDefault(); openAccount(); });
document.getElementById('closeAccountBtn').addEventListener('click', closeAccount);
document.getElementById('closeAccountFooterBtn').addEventListener('click', closeAccount);
accountModal.addEventListener('click', (e) => { if (e.target === accountModal) closeAccount(); });
document.getElementById('closeDocsBtn').addEventListener('click', closeDocs);
document.getElementById('closeDocsFooterBtn').addEventListener('click', closeDocs);
document.getElementById('closeProBtn').addEventListener('click', closePro);
docsModal.addEventListener('click', (e) => { if (e.target === docsModal) closeDocs(); });
proModal.addEventListener('click', (e) => { if (e.target === proModal) closePro(); });

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('apikey');
  location.href = '/login';
});

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const body = document.getElementById('gatewayList');

async function load() {
  const res = await fetch('/api/user/dashboard?apikey=' + encodeURIComponent(apiKey));
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Gagal memuat dashboard');
    return;
  }

  document.getElementById('nama').textContent = data.user.nama;
  document.getElementById('sisa').textContent = String(data.user.remaining);
  document.getElementById('hit').textContent = String(data.user.total_hit);

  document.getElementById('accNama').textContent = data.user.nama || '-';
  document.getElementById('accEmail').textContent = data.user.email || '-';
  document.getElementById('accWa').textContent = data.user.no_wa || '-';
  document.getElementById('accKey').textContent = apiKey || '-';

  body.innerHTML = data.gateways.map((g) => {
    const example = location.origin + '/api/gateway/' + g.key + '?apikey=' + apiKey;
    return '<article class="group border border-cyan-400/45 hover:border-amber-300/80 transition rounded-2xl bg-slate-900/40 p-4">' +
      '<div class="space-y-2 text-sm">' +
        '<p><span class="text-cyan-300 font-semibold">Gateway Key:</span> <span class="text-slate-200 break-all">' + esc(g.key) + '</span></p>' +
        '<p><span class="text-amber-300 font-semibold">Target URL:</span> <span class="text-slate-300 break-all">' + esc(example) + '</span></p>' +
      '</div>' +
      '<button data-copy="' + esc(example) + '" class="mt-3 w-full px-3 py-2 rounded-xl border border-cyan-400/50 hover:border-amber-300/90 text-cyan-200 hover:text-amber-200 transition">Copy API Link</button>' +
    '</article>';
  }).join('') || '<article class="border border-cyan-400/40 rounded-2xl bg-slate-900/30 p-6 text-center text-slate-400">Belum ada API tersedia.</article>';
}

body.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const copy = target.getAttribute('data-copy');
  if (!copy) return;
  await navigator.clipboard.writeText(copy);
  alert('URL copied!');
});

load();
</script>
</body>
</html>`;

const notFoundPage = (key: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="https://cdn.tailwindcss.com"></script><title>Gateway Not Found</title></head>
<body class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
  <div class="max-w-xl w-full bg-white/10 backdrop-blur-2xl border border-cyan-400/30 rounded-3xl p-8 shadow-2xl">
    <p class="text-cyan-300 uppercase tracking-[0.3em] text-xs mb-3">Error 404</p>
    <h1 class="text-3xl md:text-4xl font-bold text-white mb-3">Gateway key tidak ditemukan</h1>
    <p class="text-slate-300 mb-6">Key <span class="text-violet-300 font-semibold">${key}</span> tidak tersedia pada bucket <strong>dataapi</strong>.</p>
    <a href="/dashboard" class="inline-block px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 font-semibold">Buka User Dashboard</a>
  </div>
</body></html>`;

app.get('/', (c) => c.redirect('/register'));
app.get('/admin', (c) => c.html(adminHtml));
app.get('/register', async (c) => {
  await ensureUsersTable(c.env.DB);
  return c.html(registerHtml);
});
app.get('/login', async (c) => {
  await ensureUsersTable(c.env.DB);
  return c.html(loginHtml);
});
app.get('/dashboard', (c) => c.html(dashboardHtml));

app.post('/api/register', async (c) => {
  await ensureUsersTable(c.env.DB);
  const body = await c.req.json<{ nama?: string; email?: string; no_wa?: string }>();

  const nama = cleanText(body.nama ?? '');
  const email = cleanText((body.email ?? '').toLowerCase());
  const noWa = cleanText(body.no_wa ?? '');

  if (!nama || !email || !noWa) {
    return c.json({ error: 'nama, email, no_wa wajib diisi' }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'format email tidak valid' }, 400);
  }

  if (!/^[0-9]{9,16}$/.test(noWa)) {
    return c.json({ error: 'format no_wa tidak valid' }, 400);
  }

  let apiKey = createApiKey();
  let inserted = false;

  for (let i = 0; i < 4 && !inserted; i++) {
    try {
      await c.env.DB.prepare('INSERT INTO users (nama, email, no_wa, api_key, limit_per_month, total_hit, status) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .bind(nama, email, noWa, apiKey, DEFAULT_LIMIT, 'active')
        .run();
      inserted = true;
    } catch (error) {
      const msg = String(error);
      if (msg.includes('UNIQUE constraint failed: users.email')) {
        return c.json({ error: 'Email sudah terdaftar' }, 409);
      }
      apiKey = createApiKey();
      if (i === 3) return c.json({ error: 'Gagal membuat akun' }, 500);
    }
  }

  const user = await getUserByApiKey(c.env.DB, apiKey);
  return c.json({ success: true, user });
});

app.post('/api/login', async (c) => {
  await ensureUsersTable(c.env.DB);
  const body = await c.req.json<{ email?: string; api_key?: string }>();

  const email = cleanText((body.email ?? '').toLowerCase());
  const apiKey = cleanText(body.api_key ?? '');

  if (!email || !apiKey) return c.json({ error: 'email dan api_key wajib diisi' }, 400);

  const user = await c.env.DB
    .prepare('SELECT id, nama, email, no_wa, api_key, limit_per_month, total_hit, status FROM users WHERE email = ? AND api_key = ? LIMIT 1')
    .bind(email, apiKey)
    .first<UserRecord>();

  if (!user) return c.json({ error: 'Email atau API key tidak valid' }, 401);
  if (user.status !== 'active') return c.json({ error: 'akun diblokir' }, 403);

  return c.json({ success: true, user: { api_key: user.api_key, nama: user.nama, email: user.email } });
});

app.get('/api/user/dashboard', async (c) => {
  await ensureUsersTable(c.env.DB);
  const apiKey = parseApiKey(c);
  if (!apiKey) return c.json({ error: 'apikey wajib diisi' }, 401);

  const user = await getUserByApiKey(c.env.DB, apiKey);
  if (!user) return c.json({ error: 'apikey tidak valid' }, 401);
  if (user.status !== 'active') return c.json({ error: 'akun diblokir' }, 403);

  const gateways = await listGateways(c.env.dataapi);
  return c.json({
    user: {
      nama: user.nama,
      email: user.email,
      no_wa: user.no_wa,
      limit_per_month: user.limit_per_month,
      total_hit: user.total_hit,
      remaining: Math.max(0, user.limit_per_month - user.total_hit)
    },
    gateways
  });
});

app.get('/api/gateway/:key', async (c) => {
  await ensureUsersTable(c.env.DB);
  const key = cleanKey(c.req.param('key'));
  if (!key) return c.json({ error: 'Invalid key format' }, 400);

  const apiKey = parseApiKey(c);
  if (!apiKey) return c.json({ error: 'Missing API key. Gunakan ?apikey= atau x-api-key header.' }, 401);

  const user = await getUserByApiKey(c.env.DB, apiKey);
  if (!user) return c.json({ error: 'API key tidak valid' }, 401);
  if (user.status !== 'active') return c.json({ error: 'Akun user dibanned' }, 403);
  if (user.total_hit >= user.limit_per_month) {
    return c.json({ error: 'Limit bulanan habis', limit_per_month: user.limit_per_month, total_hit: user.total_hit }, 429);
  }

  const item = await c.env.dataapi.get(objectName(key));
  if (!item) return c.html(notFoundPage(key), 404);

  const gateway = (await item.json()) as GatewayRecord;
  let target: URL;
  try {
    target = new URL(gateway.target_url);
  } catch {
    return c.json({ error: 'Stored target_url is invalid' }, 500);
  }

  const sourceUrl = new URL(c.req.url);
  sourceUrl.searchParams.forEach((value, name) => {
    if (name.toLowerCase() === 'apikey') return;
    target.searchParams.append(name, value);
  });

  await c.env.DB.prepare('UPDATE users SET total_hit = total_hit + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();
  await c.env.DB
    .prepare('INSERT INTO gateway_hits (gateway_key, total_hit, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP) ON CONFLICT(gateway_key) DO UPDATE SET total_hit = total_hit + 1, updated_at = CURRENT_TIMESTAMP')
    .bind(key)
    .run();

  const proxyResponse = await fetch(target.toString(), {
    method: 'GET',
    headers: {
      accept: c.req.header('accept') ?? '*/*',
      'user-agent': c.req.header('user-agent') ?? 'cloudflare-worker-gateway'
    }
  });

  return new Response(proxyResponse.body, {
    status: proxyResponse.status,
    headers: proxyResponse.headers
  });
});

app.use('/api/admin/*', async (c, next) => {
  if (!c.env.ADMIN_TOKEN) return next();

  const token = c.req.header('x-admin-token') ?? c.req.header('authorization')?.replace('Bearer ', '');
  if (token !== c.env.ADMIN_TOKEN) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

app.get('/api/admin/gateways', async (c) => c.json({ items: await listGateways(c.env.dataapi) }));

app.get('/api/admin/stats/popular', async (c) => {
  await ensureUsersTable(c.env.DB);
  const rows = await c.env.DB
    .prepare('SELECT gateway_key, total_hit FROM gateway_hits ORDER BY total_hit DESC, gateway_key ASC LIMIT 5')
    .all<PopularGateway>();

  return c.json({ items: rows.results ?? [] });
});

app.post('/api/admin/gateways', async (c) => {
  const body = await c.req.json<{ key?: string; target_url?: string }>();
  const key = cleanKey(body.key ?? '');
  const targetUrl = cleanText(body.target_url ?? '');

  if (!key || !targetUrl) return c.json({ error: 'key and target_url are required' }, 400);

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return c.json({ error: 'target_url must be a valid URL' }, 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return c.json({ error: 'Only http/https URLs are allowed' }, 400);

  const now = new Date().toISOString();
  const existing = await c.env.dataapi.get(objectName(key));
  const existingData = existing ? ((await existing.json()) as Partial<GatewayRecord>) : null;

  const record: GatewayRecord = {
    key,
    target_url: targetUrl,
    created_at: existingData?.created_at ?? now,
    updated_at: now
  };

  await c.env.dataapi.put(objectName(key), JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return c.json({ success: true, item: record });
});

app.put('/api/admin/gateways/:key', async (c) => {
  const key = cleanKey(c.req.param('key'));
  const body = await c.req.json<{ target_url?: string }>();
  const targetUrl = cleanText(body.target_url ?? '');
  if (!key || !targetUrl) return c.json({ error: 'key and target_url are required' }, 400);

  const existing = await c.env.dataapi.get(objectName(key));
  if (!existing) return c.json({ error: 'Gateway key not found' }, 404);

  const oldRecord = (await existing.json()) as GatewayRecord;
  const record: GatewayRecord = { key, target_url: targetUrl, created_at: oldRecord.created_at, updated_at: new Date().toISOString() };

  await c.env.dataapi.put(objectName(key), JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return c.json({ success: true, item: record });
});

app.delete('/api/admin/gateways/:key', async (c) => {
  const key = cleanKey(c.req.param('key'));
  if (!key) return c.json({ error: 'Invalid key' }, 400);
  await c.env.dataapi.delete(objectName(key));
  return c.json({ success: true });
});

app.get('/api/admin/users', async (c) => {
  await ensureUsersTable(c.env.DB);
  const rows = await c.env.DB.prepare('SELECT id, nama, email, no_wa, api_key, limit_per_month, total_hit, status FROM users ORDER BY id DESC').all<UserRecord>();
  return c.json({ items: rows.results ?? [] });
});

app.patch('/api/admin/users/:id', async (c) => {
  await ensureUsersTable(c.env.DB);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ limit_per_month?: number; status?: 'active' | 'banned' }>();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof body.limit_per_month === 'number' && Number.isFinite(body.limit_per_month) && body.limit_per_month >= 0) {
    updates.push('limit_per_month = ?');
    values.push(Math.floor(body.limit_per_month));
  }

  if (body.status === 'active' || body.status === 'banned') {
    updates.push('status = ?');
    values.push(body.status);
  }

  if (!updates.length) return c.json({ error: 'No valid fields to update' }, 400);
  values.push(id);

  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...values).run();
  return c.json({ success: true });
});

app.post('/api/admin/users/:id/toggle-status', async (c) => {
  await ensureUsersTable(c.env.DB);
  const id = Number(c.req.param('id'));
  const user = await c.env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(id).first<{ status: 'active' | 'banned' }>();
  if (!user) return c.json({ error: 'User not found' }, 404);
  const nextStatus = user.status === 'active' ? 'banned' : 'active';
  await c.env.DB.prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(nextStatus, id).run();
  return c.json({ success: true, status: nextStatus });
});

app.delete('/api/admin/users/:id', async (c) => {
  await ensureUsersTable(c.env.DB);
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

app.notFound((c) => c.html(notFoundPage('unknown'), 404));

export default app;
