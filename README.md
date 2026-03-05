# Cloudflare Workers API Gateway + R2 + D1

Sistem API Gateway berbasis **Cloudflare Workers + Hono.js**.
- Konfigurasi gateway disimpan di **R2 bucket `dataapi`**.
- Data user + API key + limit disimpan di **Cloudflare D1**.

## Fitur Utama

- `GET /api/gateway/:key` dengan validasi API key (`?apikey=` atau `x-api-key`).
- Proxy request ke `target_url` dari R2 dan meneruskan query user (kecuali `apikey`).
- Hit pengguna otomatis ditambah (`total_hit`) di D1.
- Proteksi limit bulanan (`limit_per_month`) + status user (`active`/`banned`).
- Halaman publik **`/register`** untuk daftar user dan generate API key otomatis (`ak_xxx`).
- Halaman **`/dashboard`** untuk melihat kuota user, statistik hit, dan daftar API yang tersedia.
- Halaman **`/admin`** luxury UI (dark + glassmorphism + neon):
  - tab Manage Gateways,
  - tab Manage Users (set limit, ban/unban, delete),
  - search/filter, statistik card.

## Skema D1 (`users`)

Kolom:
- `id`
- `nama`
- `email`
- `no_wa`
- `api_key`
- `limit_per_month`
- `total_hit`
- `status` (`active` / `banned`)

> Worker akan menjalankan `CREATE TABLE IF NOT EXISTS` otomatis saat endpoint user/admin dipakai.

## Konfigurasi Wrangler

Update `wrangler.toml`:
- R2 binding: `dataapi`
- D1 binding: `DB`

Ganti `database_id` sesuai D1 Anda.

## Deploy

1. Install dependency
   ```bash
   npm install
   ```
2. Login cloudflare
   ```bash
   npx wrangler login
   ```
3. Pastikan R2 bucket `dataapi` sudah dibuat.
4. Buat D1 database (jika belum):
   ```bash
   npx wrangler d1 create v4api-users
   ```
5. Masukkan `database_id` hasil create ke `wrangler.toml`.
6. Deploy:
   ```bash
   npm run deploy
   ```

## Optional Security Admin

Agar endpoint `/api/admin/*` privat:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Lalu kirim header:
- `x-admin-token: <token>`
  atau
- `Authorization: Bearer <token>`
