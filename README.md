# Lucifer License System

Sistem lisensi berbasis voucher untuk script Lucifer. Setiap lisensi terikat ke username Lucifer + satu jenis script dengan masa aktif dalam hari.

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env
cp .env.example .env
# Edit .env — ganti SESSION_SECRET dengan string acak panjang

# 3. Push database schema
pnpm prisma db push

# 4. Buat admin pertama
pnpm seed:admin

# 5. Jalankan
pnpm dev
```

App berjalan di `http://localhost:3000`

## Routes

| URL | Deskripsi |
|-----|-----------|
| `GET /check` | Cek status lisensi (publik) |
| `GET /redeem` | Form redeem voucher (publik) |
| `GET /admin` | Dashboard admin |
| `POST /api/license/verify` | API untuk loader.lua |

## API Verify

```http
POST /api/license/verify
Content-Type: application/json

{ "user": "username_lucifer", "sc": "DF" }
```

Response valid:
```json
{ "valid": true, "expiresAt": "2026-09-15T00:00:00Z", "daysLeft": 12 }
```

Response tidak valid:
```json
{ "valid": false, "reason": "not_found" }
```

Reason: `not_found` | `expired` | `revoked` | `rate_limited`
