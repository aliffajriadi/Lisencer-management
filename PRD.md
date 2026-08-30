# PRD — Lucifer Script License System

## 1. Latar Belakang & Tujuan

Sistem lisensi untuk mengontrol siapa saja yang boleh menjalankan script Lucifer (misal: Dirtfarm/"DF") yang dijual. Setiap lisensi terikat ke **username Lucifer** tertentu dan **satu jenis script** tertentu, dengan masa aktif dalam hari yang bisa dikonfigurasi. Registrasi awal maupun perpanjangan sama-sama dilakukan lewat **kode voucher** yang di-generate admin — bukan pembayaran otomatis (di luar scope MVP ini).

Sistem ini juga berfungsi sebagai backend untuk fungsi `checkWhitelist()` di loader.lua (lihat catatan integrasi di §4.3).

## 2. Tech Stack

| Layer | Pilihan | Catatan |
|---|---|---|
| Runtime | Node.js | CommonJS (bukan ESM) — konsisten dengan project Discord-Store kamu |
| Web framework | Express | Untuk API + render admin panel & halaman publik |
| ORM | Prisma | `prisma db push` untuk dev & prod (bukan `migrate`) — sesuai pola yang sudah kamu pakai |
| Database | SQLite (`better-sqlite3` via Prisma) | Cukup untuk skala single-server |
| Package manager | pnpm | Konsisten dengan project lain |
| Logging | winston | Audit trail aksi admin (create/revoke/redeem) |
| Templating (admin/public UI) | EJS | Server-rendered, ringan, konsisten dengan pola Discord-Store kamu |
dan gunakan PNPM


## 3. Data Model (Prisma Schema — draft)

```prisma
model ScriptType {
  id        Int       @id @default(autoincrement())
  code      String    @unique   // contoh: "DF"
  name      String              // contoh: "Dirtfarm Auto Farm"
  active    Boolean   @default(true)
  createdAt DateTime  @default(now())

  licenses  License[]
  vouchers  VoucherCode[]
}

model License {
  id           Int         @id @default(autoincrement())
  username     String                // username Lucifer
  scriptTypeId Int
  scriptType   ScriptType  @relation(fields: [scriptTypeId], references: [id])
  expiresAt    DateTime
  revoked      Boolean     @default(false)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  @@unique([username, scriptTypeId])   // 1 username cuma 1 lisensi aktif per jenis script
}

model VoucherCode {
  id             Int         @id @default(autoincrement())
  code           String      @unique     // kode redeem, contoh: "DF-7D-X9K2M4"
  scriptTypeId   Int
  scriptType     ScriptType  @relation(fields: [scriptTypeId], references: [id])
  durationDays   Int                     // berapa hari ditambahkan saat redeem
  batchLabel     String?                 // opsional, penanda batch generate (contoh: "Restock Sep 2026")
  usedByUsername String?
  usedAt         DateTime?
  createdAt      DateTime    @default(now())
  createdByAdminId Int
  createdByAdmin AdminUser   @relation(fields: [createdByAdminId], references: [id])
}

model AdminUser {
  id           Int       @id @default(autoincrement())
  username     String    @unique
  passwordHash String
  createdAt    DateTime  @default(now())

  vouchers     VoucherCode[]
}
```

## 4. Functional Requirements

### 4.1 Halaman Publik (tanpa login)

**`/check` — Cek Status Lisensi**
- Input: username Lucifer
- Output: tabel semua lisensi milik username itu — jenis script, tanggal expired, sisa hari, status (`Aktif` / `Expired` / `Revoked`)
- Kalau username belum pernah terdaftar sama sekali → tampilkan pesan jelas ("belum ada lisensi terdaftar untuk username ini"), bukan error mentah

**`/redeem` — Registrasi Awal / Perpanjang**
- Input: username Lucifer + kode voucher
- Sistem otomatis tau ini "registrasi awal" atau "perpanjangan" berdasarkan ada/tidaknya `License` existing untuk kombinasi (username, scriptType milik voucher tsb) — user tidak perlu pilih mode secara manual
- Setelah berhasil redeem: tampilkan konfirmasi (jenis script, tanggal expired baru)
- 1 kode voucher hanya bisa dipakai **sekali**, siapapun usernamenya

### 4.2 Admin Panel (butuh login)

- **Login** — sederhana, 1 tabel `AdminUser` (password di-hash, misal pakai bcrypt)
- **Dashboard** — ringkasan: total lisensi aktif, lisensi yang akan expired dalam 7 hari ke depan, total voucher ter-generate vs terpakai
- **Kelola Lisensi**
  - List + search/filter (by username, jenis script, status)
  - Edit manual tanggal expired (override, buat kasus khusus/komplain)
  - Revoke / un-revoke lisensi
- **Kelola Voucher**
  - Generate 1 voucher: pilih jenis script + durasi (hari) → kode di-generate otomatis (atau admin bisa isi custom)
  - Generate banyak sekaligus (bulk): jumlah + jenis script + durasi → hasil bisa di-export (copy list / download .txt/.csv)
  - List semua voucher dengan filter (belum dipakai / sudah dipakai / per jenis script), lihat siapa & kapan pakai kalau sudah dipakai
  - Void voucher yang belum dipakai (misal salah generate)
- **Kelola Jenis Script**
  - CRUD `ScriptType` — tambah/nonaktifkan jenis script baru (misal nanti nambah "FISH", "COOK", dst selain "DF")

### 4.3 API untuk Client Lua (`checkWhitelist()`)

```
POST /api/license/verify
Body: { "user": "anjay", "sc": "DF" }

Response (valid):
{ "valid": true, "expiresAt": "2026-09-15T00:00:00Z", "daysLeft": 12 }

Response (tidak valid):
{ "valid": false, "reason": "not_found" | "expired" | "revoked" }
```

- Endpoint ini yang dipanggil dari `checkWhitelist()` di loader.lua (menggantikan versi hardcoded whitelist username yang kita buat sebelumnya)
- **Rate limit** per IP & per username (cegah orang iseng cek endpoint ini bolak-balik dari browser — lihat diskusi kita soal ini sebelumnya)
- Di fase selanjutnya (di luar MVP ini), endpoint ini bisa diperluas jadi titik yang sama dengan sistem cloud-load (kalau valid, sekalian balikin source ter-obfuscate) — dicatat di §8

## 5. Business Rules

1. **Redeem saat belum punya lisensi untuk jenis script itu** → buat `License` baru, `expiresAt = now + durationDays` voucher.
2. **Redeem saat sudah punya lisensi aktif** (belum expired) → **extend dari tanggal expired lama**, bukan dari hari ini: `newExpiresAt = currentExpiresAt + durationDays`. Ini supaya user tidak rugi sisa hari yang belum kepakai.
3. **Redeem saat lisensi lama sudah expired** → hitung dari sekarang: `newExpiresAt = now + durationDays` (karena tidak ada sisa hari untuk dipertahankan).
4. **Voucher yang sudah dipakai** tidak bisa dipakai lagi oleh siapapun — status berubah permanen jadi "used", tercatat `usedByUsername` & `usedAt`.
5. **Lisensi dianggap aktif** kalau `expiresAt > sekarang` DAN `revoked = false`.
6. **Lisensi yang di-revoke** tidak otomatis pulih walau di-extend voucher baru — admin harus un-revoke manual dulu. *(Asumsi — kalau kamu mau redeem otomatis meng-clear status revoked, kasih tau supaya saya sesuaikan.)*
7. Voucher **terikat ke satu `ScriptType`** saat di-generate — tidak bisa dipakai lintas jenis script.

## 6. Audit & Logging

- Setiap aksi admin (create voucher, revoke lisensi, edit expired manual, void voucher) dicatat via winston: siapa admin-nya, aksi apa, terhadap objek apa, kapan.
- Setiap redeem sukses/gagal dari halaman publik juga di-log (bantu investigasi kalau ada laporan "kode saya nggak work").

dam usahakan untuk seringan mungkin dan tahan 1k - 10k request perdetik, karna akan digunakan untuk seluruh lisensi 

## 7. Prinsip Desain UI ("tanpa AI slop")

Karena ini disebut eksplisit — berikut batasan konkret, bukan cuma imbauan umum:

**Dihindari:**
- Gradient ungu-biru generik di hero section
- Card dengan efek glassmorphism/blur berlebihan tanpa alasan fungsional
- Icon generik "rocket"/"lightning bolt" buat mewakili "cepat"/"canggih"
- Font default system stack tanpa keputusan sadar (Inter dipakai di mana-mana tanpa alasan)
- Halaman publik yang terasa seperti landing page marketing SaaS template

**Diarahkan ke:**
- Admin panel: **information-dense**, tabel sungguhan (bukan card besar berisi 1 baris data), fokus ke kecepatan kerja admin (scan status banyak lisensi sekaligus), bukan estetika kosong
- Halaman publik `/check` & `/redeem`: terasa seperti **utility tool** (mirip status page/dashboard uptime), bukan halaman jualan — user ke sini buat cek fakta, bukan dibujuk
- 1 keputusan tipografi & warna yang disengaja dan konsisten di semua halaman (bukan default Bootstrap/Tailwind palette tanpa sentuhan)
- Detail implementasi visual ini akan digarap pakai referensi desain frontend saat masuk fase build, bukan di tahap PRD ini

## 8. Di Luar Scope MVP (dicatat untuk nanti)

- Integrasi payment gateway otomatis (kaitannya ke project payment gateway kamu yang lain) — saat ini voucher tetap di-generate manual oleh admin
- HWID binding per lisensi (beda dari model ini yang baru bind ke username)
- Endpoint ini digabung dengan sistem cloud-load (fetch source ter-obfuscate) yang sudah kita desain sebelumnya
- Notifikasi Discord otomatis saat lisensi mendekati expired
- Role admin bertingkat (saat ini asumsi 1 level admin saja)

## 9. MVP — Harus Ada vs Nice-to-Have

**Harus ada (MVP):**
- [ ] Schema Prisma (ScriptType, License, VoucherCode, AdminUser)
- [ ] API `/api/license/verify` (dipanggil loader.lua)
- [ ] Halaman publik `/check` dan `/redeem`
- [ ] Admin: login, generate voucher (single + bulk), list voucher, list & edit lisensi, revoke
- [ ] Admin: CRUD ScriptType

**Nice-to-have (setelah MVP jalan):**
- [ ] Export voucher ke CSV
- [ ] Dashboard statistik lebih detail (grafik redeem per hari, dst)
- [ ] Rate limiting & abuse detection di endpoint verify
- [ ] Audit log viewer di admin panel (bukan cuma winston file)

