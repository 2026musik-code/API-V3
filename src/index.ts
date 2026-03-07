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

// Error Handler
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: message }, 500);
  }
  return c.html(`<pre style="background:#020617;color:#e2e8f0;padding:16px;">${message}</pre>`, 500);
});

const DEFAULT_LIMIT = 100;
let userTableInitialized = false;

// Helpers
const cleanKey = (rawKey: string) => rawKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
const objectName = (key: string) => `${cleanKey(key)}.json`;
const cleanText = (v: string) => v.trim().replace(/[\u0000-\u001f\u007f]/g, '');

const ensureUsersTable = async (db: D1Database) => {
  if (userTableInitialized) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, email TEXT NOT NULL UNIQUE, no_wa TEXT NOT NULL, api_key TEXT NOT NULL UNIQUE, limit_per_month INTEGER NOT NULL DEFAULT 100, total_hit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS gateway_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, gateway_key TEXT NOT NULL UNIQUE, total_hit INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
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
      if (parsed.key && parsed.target_url) {
        all.push({
          key: parsed.key,
          target_url: parsed.target_url,
          created_at: parsed.created_at ?? new Date().toISOString(),
          updated_at: parsed.updated_at ?? new Date().toISOString()
        });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return all.sort((a, b) => a.key.localeCompare(b.key));
};

const createApiKey = () => `ak_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

const parseApiKey = (c: Context<{ Bindings: Bindings }>) => 
  cleanText(c.req.query('apikey') ?? c.req.header('x-api-key') ?? '');

const getUserByApiKey = async (db: D1Database, apiKey: string): Promise<UserRecord | null> => {
  return await db.prepare('SELECT id, nama, email, no_wa, api_key, limit_per_month, total_hit, status FROM users WHERE api_key = ? LIMIT 1').bind(apiKey).first<UserRecord>() ?? null;
};

/* --- ADMIN HTML --- */
const adminHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>API Gateway Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .v3-logo { font-weight: 900; background: linear-gradient(to bottom, #fff 10%, #fbbf24 30%, #ef4444 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .logo-fire { animation: fireFlicker 0.4s ease-in-out infinite alternate; filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.6)); }
    @keyframes fireFlicker { 0% { transform: scale(1); } 100% { transform: scale(1.05); } }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <main id="adminApp" class="hidden relative z-10 max-w-6xl mx-auto p-6 md:p-10">
    <header class="mb-8 flex items-start justify-between gap-4">
      <div class="logo-fire flex items-center gap-3">
        <h1 class="v3-logo text-3xl sm:text-4xl">V3 API ADMIN</h1>
      </div>
      <div class="flex gap-2 flex-wrap justify-end">
        <button id="logoutAdmin" class="px-4 py-3 rounded-xl border border-rose-400/40 text-rose-300">Logout</button>
        <button id="openModal" class="px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 font-semibold">+ Add API</button>
      </div>
    </header>
    <section id="gatewayPanel" class="bg-slate-900/40 border border-cyan-400/40 rounded-2xl overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-slate-900/70 border-b border-cyan-400/30">
          <tr><th class="text-left px-4 py-3">Key</th><th class="text-left px-4 py-3">Target</th><th class="text-right px-4 py-3">Actions</th></tr>
        </thead>
        <tbody id="gatewayBody"></tbody>
      </table>
    </section>
  </main>
  
  <div id="adminLock" class="fixed inset-0 z-[100] bg-slate-950 flex items-center justify-center p-6">
    <div class="w-full max-w-md bg-slate-900 border border-cyan-400/40 rounded-2xl p-6 shadow-2xl">
      <h2 class="text-2xl font-bold mb-4">Admin Login</h2>
      <form id="adminLoginForm" class="space-y-4">
        <input id="adminTokenInput" type="password" required placeholder="ADMIN_TOKEN" class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/10" />
        <button class="w-full px-5 py-3 rounded-xl bg-cyan-500 font-semibold">Unlock</button>
      </form>
    </div>
  </div>

  <div id="gatewayModal" class="hidden fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="w-full max-w-xl bg-slate-900 border border-cyan-400/60 rounded-2xl p-6">
      <h2 id="modalTitle" class="text-2xl font-bold mb-4">API Gateway</h2>
      <form id="gatewayForm" class="space-y-4">
        <input id="keyInput" required class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/10" placeholder="Key Name" />
        <input id="urlInput" type="url" required class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/10" placeholder="Target URL" />
        <div class="flex justify-end gap-3">
          <button type="button" id="closeModal" class="px-4 py-2 border border-white/20 rounded-lg text-white">Cancel</button>
          <button type="submit" class="px-5 py-2 bg-cyan-500 rounded-lg font-bold text-white">Save</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const state = { gateways: [], editingGateway: null };
    const ADMIN_TOKEN_KEY = 'admin_token';
    const adminLock = document.getElementById('adminLock');
    const adminApp = document.getElementById('adminApp');
    const gatewayModal = document.getElementById('gatewayModal');

    const getAdminToken = () => localStorage.getItem(ADMIN_TOKEN_KEY) || '';
    async function adminFetch(url, options = {}) {
      const headers = { ...options.headers, 'Authorization': 'Bearer ' + getAdminToken() };
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) { location.reload(); }
      return res;
    }

    async function loadData() {
      const res = await adminFetch('/api/admin/gateways');
      const data = await res.json();
      state.gateways = data.items || [];
      render();
    }

    function render() {
      const body = document.getElementById('gatewayBody');
      body.innerHTML = state.gateways.map(g => \`
        <tr class="border-t border-white/5">
          <td class="px-4 py-3 text-cyan-300">\${g.key}</td>
          <td class="px-4 py-3 text-slate-400 truncate max-w-xs">\${g.target_url}</td>
          <td class="px-4 py-3 text-right">
            <button onclick="deleteGateway('\${g.key}')" class="text-rose-400">Delete</button>
          </td>
        </tr>
      \`).join('');
    }

    async function deleteGateway(key) {
      if(!confirm('Hapus ' + key + '?')) return;
      await adminFetch('/api/admin/gateways/' + key, { method: 'DELETE' });
      loadData();
    }

    document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      localStorage.setItem(ADMIN_TOKEN_KEY, document.getElementById('adminTokenInput').value);
      try {
        await loadData();
        adminLock.classList.add('hidden');
        adminApp.classList.remove('hidden');
      } catch { alert('Token salah!'); }
    });

    document.getElementById('openModal').addEventListener('click', () => gatewayModal.classList.remove('hidden'));
    document.getElementById('closeModal').addEventListener('click', () => gatewayModal.classList.add('hidden'));
    document.getElementById('gatewayForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = { key: document.getElementById('keyInput').value, target_url: document.getElementById('urlInput').value };
      await adminFetch('/api/admin/gateways', { method: 'POST', body: JSON.stringify(payload) });
      gatewayModal.classList.add('hidden');
      loadData();
    });

    if(getAdminToken()) { loadData().then(() => { adminLock.classList.add('hidden'); adminApp.classList.remove('hidden'); }); }
  </script>
</body>
</html>`;

/* --- USER DASHBOARD HTML --- */
const dashboardHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dashboard V3 API</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#020617] text-slate-100 min-h-screen p-4 md:p-8">
  <div class="max-w-5xl mx-auto">
    <header class="flex justify-between items-center mb-10">
      <h1 class="text-2xl font-black text-cyan-400 tracking-tighter uppercase italic">V3 Gateway</h1>
      <button id="logoutBtn" class="px-4 py-2 border border-rose-500/50 text-rose-400 rounded-xl text-sm font-bold">LOGOUT</button>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      <div class="bg-slate-900 border border-white/5 p-6 rounded-3xl">
        <p class="text-slate-500 text-xs font-bold uppercase mb-1">User Aktif</p>
        <h2 id="nama" class="text-xl font-bold text-white">-</h2>
      </div>
      <div class="bg-slate-900 border border-white/5 p-6 rounded-3xl">
        <p class="text-slate-500 text-xs font-bold uppercase mb-1">Total Hits</p>
        <h2 id="hit" class="text-xl font-bold text-violet-400">-</h2>
      </div>
      <div class="bg-slate-900 border border-white/5 p-6 rounded-3xl">
        <p class="text-slate-500 text-xs font-bold uppercase mb-1">Sisa Kuota</p>
        <h2 id="sisa" class="text-xl font-bold text-emerald-400">-</h2>
      </div>
    </div>

    <div class="bg-slate-900 border border-cyan-400/20 rounded-3xl p-6">
      <h3 class="font-bold mb-4 text-cyan-200">API Gateway List</h3>
      <div id="gatewayList" class="grid gap-3"></div>
    </div>
  </div>

  <div id="playgroundModal" class="hidden pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
    <div class="w-full max-w-2xl bg-slate-900 border border-cyan-400/40 rounded-3xl p-6 shadow-2xl">
      <div class="flex justify-between items-center mb-6">
        <h2 id="pgTitle" class="text-xl font-bold text-cyan-400">Test API</h2>
        <button id="closePG" class="text-slate-400 text-xl font-bold">✕</button>
      </div>
      <div class="space-y-4">
        <div>
          <label id="pgLabel" class="block text-xs font-bold text-slate-500 uppercase mb-2">Parameter</label>
          <input id="pgInput" class="w-full bg-slate-950 border border-white/10 p-4 rounded-2xl text-white outline-none focus:border-cyan-400/50" placeholder="..." />
        </div>
        <button id="runTest" class="w-full bg-cyan-500 py-4 rounded-2xl font-black text-slate-950 uppercase tracking-widest hover:bg-cyan-400 transition">KIRIM REQUEST</button>
        <div class="bg-slate-950 rounded-2xl p-4 border border-white/5">
          <p class="text-[10px] text-slate-500 font-bold mb-2 uppercase">JSON Response</p>
          <pre id="pgJson" class="text-xs text-emerald-400 overflow-auto max-h-48 whitespace-pre-wrap">Belum ada data.</pre>
        </div>
        <div id="pgMedia" class="rounded-2xl overflow-hidden bg-black/40"></div>
      </div>
    </div>
  </div>

  <script>
    const apiKey = localStorage.getItem('apikey') || '';
    if(!apiKey) location.href = '/login';

    const pgModal = document.getElementById('playgroundModal');
    let activeKey = '';

    // FIX MACET: Hapus pointer-events-none saat buka modal
    function setModal(open) {
      if(open) {
        pgModal.classList.remove('hidden', 'pointer-events-none');
        pgModal.classList.add('flex');
      } else {
        pgModal.classList.add('hidden', 'pointer-events-none');
        pgModal.classList.remove('flex');
      }
    }

    async function load() {
      const res = await fetch('/api/user/dashboard?apikey=' + apiKey);
      const data = await res.json();
      if(!res.ok) { alert('Sesi berakhir'); return; }

      document.getElementById('nama').textContent = data.user.nama;
      document.getElementById('hit').textContent = data.user.total_hit;
      document.getElementById('sisa').textContent = data.user.remaining;

      const list = document.getElementById('gatewayList');
      list.innerHTML = data.gateways.map(g => \`
        <div class="flex items-center justify-between p-4 bg-slate-950/50 border border-white/5 rounded-2xl hover:border-cyan-400/30 transition">
          <div class="truncate mr-4">
            <p class="font-bold text-slate-200">/\${g.key}</p>
            <p class="text-[10px] text-slate-500 truncate">\${location.origin}/api/gateway/\${g.key}</p>
          </div>
          <button onclick="openPlayground('\${g.key}')" class="px-4 py-2 bg-white/5 text-xs font-bold rounded-xl border border-white/10 hover:bg-white/10">TEST API</button>
        </div>
      \`).join('');
    }

    function openPlayground(key) {
      activeKey = key;
      document.getElementById('pgTitle').textContent = 'Test: ' + key;
      document.getElementById('pgJson').textContent = 'Siap menerima respon...';
      document.getElementById('pgMedia').innerHTML = '';
      document.getElementById('pgInput').value = '';
      setModal(true);
    }

    document.getElementById('runTest').addEventListener('click', async () => {
      const input = document.getElementById('pgInput').value;
      const btn = document.getElementById('runTest');
      btn.textContent = 'LOADING...';
      btn.disabled = true;

      const url = new URL(location.origin + '/api/gateway/' + activeKey);
      url.searchParams.set('apikey', apiKey);
      
      // Deteksi otomatis param: Link -> url, Teks -> prompt
      if(input.startsWith('http')) url.searchParams.set('url', input);
      else url.searchParams.set('prompt', input);

      try {
        const res = await fetch(url.toString());
        const json = await res.json();
        document.getElementById('pgJson').textContent = JSON.stringify(json, null, 2);
        
        // Preview Sederhana
        const textStr = JSON.stringify(json);
        const match = textStr.match(/https?:\\/\\/[^"']+\\.(jpg|png|mp4|webp)/gi);
        if(match) {
          const link = match[0];
          if(link.endsWith('.mp4')) {
            document.getElementById('pgMedia').innerHTML = \`<video src="\${link}" controls class="w-full"></video>\`;
          } else {
            document.getElementById('pgMedia').innerHTML = \`<img src="\${link}" class="w-full" />\`;
          }
        }
      } catch(e) {
        document.getElementById('pgJson').textContent = 'Error: ' + e.message;
      } finally {
        btn.textContent = 'KIRIM REQUEST';
        btn.disabled = false;
      }
    });

    document.getElementById('closePG').addEventListener('click', () => setModal(false));
    document.getElementById('logoutBtn').addEventListener('click', () => { localStorage.clear(); location.href='/login'; });

    load();
  </script>
</body>
</html>`;

/* --- KODE REGISTER & LOGIN (SEDERHANA) --- */
const registerHtml = `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white flex items-center justify-center min-h-screen p-6"><div class="max-w-md w-full bg-slate-900 p-8 rounded-3xl border border-white/5"><h1 class="text-2xl font-bold mb-6">Daftar API V3</h1><form id="rf" class="space-y-4"><input id="n" placeholder="Nama" class="w-full p-4 bg-slate-950 rounded-xl" required /><input id="e" type="email" placeholder="Email" class="w-full p-4 bg-slate-950 rounded-xl" required /><input id="w" placeholder="WhatsApp (628...)" class="w-full p-4 bg-slate-950 rounded-xl" required /><button class="w-full bg-cyan-500 py-4 rounded-xl font-bold text-black uppercase">Daftar</button></form><p class="mt-4 text-sm text-slate-500">Sudah punya? <a href="/login" class="text-cyan-400">Login</a></p><div id="res" class="hidden mt-6 p-4 bg-slate-950 rounded-xl border border-cyan-400/20 text-xs text-cyan-300 break-all"></div></div><script>document.getElementById('rf').addEventListener('submit',async(e)=>{e.preventDefault();const b=e.target.querySelector('button');b.textContent='...';const res=await fetch('/api/register',{method:'POST',body:JSON.stringify({nama:document.getElementById('n').value,email:document.getElementById('e').value,no_wa:document.getElementById('w').value})});const d=await res.json();b.textContent='Daftar';if(res.ok){document.getElementById('res').classList.remove('hidden');document.getElementById('res').textContent='API KEY ANDA: '+d.user.api_key;setTimeout(()=>location.href='/login',3000);}else alert(d.error);});</script></body></html>`;

const loginHtml = `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white flex items-center justify-center min-h-screen p-6"><div class="max-w-md w-full bg-slate-900 p-8 rounded-3xl border border-white/5"><h1 class="text-2xl font-bold mb-6">Login API</h1><form id="lf" class="space-y-4"><input id="e" placeholder="Email" class="w-full p-4 bg-slate-950 rounded-xl" required /><input id="a" placeholder="API KEY (ak_...)" class="w-full p-4 bg-slate-950 rounded-xl" required /><button class="w-full bg-cyan-500 py-4 rounded-xl font-bold text-black uppercase">Masuk</button></form><p class="mt-4 text-sm text-slate-500">Belum punya? <a href="/register" class="text-cyan-400">Daftar</a></p></div><script>document.getElementById('lf').addEventListener('submit',async(e)=>{e.preventDefault();const res=await fetch('/api/login',{method:'POST',body:JSON.stringify({email:document.getElementById('e').value,api_key:document.getElementById('a').value})});const d=await res.json();if(res.ok){localStorage.setItem('apikey',d.user.api_key);location.href='/dashboard';}else alert(d.error);});</script></body></html>`;

const notFoundPage = (k: string) => `<html><body style="background:#020617;color:#fff;text-align:center;padding:50px;font-family:sans-serif;"><h1>404</h1><p>Gateway <b>${k}</b> tidak ditemukan.</p><a href="/dashboard" style="color:cyan;">Kembali</a></body></html>`;

/* --- ROUTES --- */
app.get('/', (c) => c.redirect('/login'));
app.get('/admin', (c) => c.html(adminHtml));
app.get('/register', (c) => c.html(registerHtml));
app.get('/login', (c) => c.html(loginHtml));
app.get('/dashboard', (c) => c.html(dashboardHtml));

app.post('/api/register', async (c) => {
  await ensureUsersTable(c.env.DB);
  const body = await c.req.json();
  const apiKey = createApiKey();
  try {
    await c.env.DB.prepare('INSERT INTO users (nama, email, no_wa, api_key) VALUES (?, ?, ?, ?)').bind(body.nama, body.email.toLowerCase(), body.no_wa, apiKey).run();
    return c.json({ user: { api_key: apiKey } });
  } catch(e) { return c.json({ error: 'Email sudah terdaftar atau data salah' }, 400); }
});

app.post('/api/login', async (c) => {
  await ensureUsersTable(c.env.DB);
  const body = await c.req.json();
  const user = await c.env.DB.prepare('SELECT api_key, nama FROM users WHERE email = ? AND api_key = ?').bind(body.email.toLowerCase(), body.api_key).first<UserRecord>();
  if(!user) return c.json({ error: 'Login gagal' }, 401);
  return c.json({ user });
});

app.get('/api/user/dashboard', async (c) => {
  await ensureUsersTable(c.env.DB);
  const key = parseApiKey(c);
  const user = await getUserByApiKey(c.env.DB, key);
  if(!user) return c.json({ error: 'Invalid' }, 401);
  const gateways = await listGateways(c.env.dataapi);
  return c.json({ user: { ...user, remaining: user.limit_per_month - user.total_hit }, gateways });
});

app.get('/api/gateway/:key', async (c) => {
  await ensureUsersTable(c.env.DB);
  const key = cleanKey(c.req.param('key'));
  const apiKey = parseApiKey(c);
  const user = await getUserByApiKey(c.env.DB, apiKey);

  if(!user || user.status !== 'active') return c.json({ error: 'API Key Invalid' }, 401);
  if(user.total_hit >= user.limit_per_month) return c.json({ error: 'Limit Habis' }, 429);

  const obj = await c.env.dataapi.get(objectName(key));
  if(!obj) return c.html(notFoundPage(key), 404);

  const gw = (await obj.json()) as GatewayRecord;
  const target = new URL(gw.target_url);
  c.req.query(); // ensure queries are ready
  new URL(c.req.url).searchParams.forEach((v, k) => { if(k !== 'apikey') target.searchParams.set(k, v); });

  // Update Stats
  await c.env.DB.prepare('UPDATE users SET total_hit = total_hit + 1 WHERE id = ?').bind(user.id).run();
  await c.env.DB.prepare('INSERT INTO gateway_hits (gateway_key, total_hit) VALUES (?, 1) ON CONFLICT(gateway_key) DO UPDATE SET total_hit = total_hit + 1').bind(key).run();

  const res = await fetch(target.toString());
  return new Response(res.body, { status: res.status, headers: res.headers });
});

/* --- ADMIN API --- */
app.use('/api/admin/*', async (c, next) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ', '');
  if(auth !== c.env.ADMIN_TOKEN) return c.json({ error: 'Forbidden' }, 401);
  await next();
});

app.get('/api/admin/gateways', async (c) => c.json({ items: await listGateways(c.env.dataapi) }));
app.post('/api/admin/gateways', async (c) => {
  const b = await c.req.json();
  const k = cleanKey(b.key);
  const data = { key: k, target_url: b.target_url, updated_at: new Date().toISOString() };
  await c.env.dataapi.put(objectName(k), JSON.stringify(data));
  return c.json({ success: true });
});
app.delete('/api/admin/gateways/:key', async (c) => {
  await c.env.dataapi.delete(objectName(c.req.param('key')));
  return c.json({ success: true });
});

export default app;
