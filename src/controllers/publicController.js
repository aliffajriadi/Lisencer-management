'use strict';

const { customAlphabet } = require('nanoid');
const prisma = require('../lib/prisma');
const { redeemLog } = require('../lib/logger');
const cache = require('../lib/verifyCache');

// PIN alphabet — no 0/O/I/1
const pinNanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 10);

/** Generate PIN dan format sebagai XXXX-XXXX-XX */
function generatePin() {
  const raw = pinNanoid();
  return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,10)}`;
}

/** Format PIN dari DB (tersimpan tanpa dash) ke tampilan */
function formatPin(pin) {
  if (!pin) return null;
  const raw = pin.replace(/-/g, '');
  return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,10)}`;
}

// ─── /check ──────────────────────────────────────────────────────────────────

async function checkGet(req, res) {
  res.render('public/check', { query: null, licenses: null, username: '', error: null });
}

async function checkPost(req, res) {
  const username = (req.body.username || '').trim();
  if (!username) {
    return res.render('public/check', {
      query: username, licenses: null, username,
      error: 'Masukkan username Lucifer kamu.',
    });
  }

  try {
    const licenses = await prisma.license.findMany({
      where: { username: username.toLowerCase() },
      include: { scriptType: true },
      orderBy: { createdAt: 'desc' },
    });
    res.render('public/check', { query: username, licenses, username, error: null });
  } catch (err) {
    res.render('public/check', { query: username, licenses: null, username, error: 'Terjadi kesalahan server.' });
  }
}

// ─── /redeem ─────────────────────────────────────────────────────────────────

async function redeemGet(req, res) {
  res.render('public/redeem', { success: null, error: null, username: '', code: '' });
}

async function redeemPost(req, res) {
  const username = (req.body.username || '').trim();
  const code = (req.body.code || '').trim().toUpperCase();

  if (!username || !code) {
    return res.render('public/redeem', {
      success: null, error: 'Username dan kode voucher harus diisi.', username, code,
    });
  }

  try {
    // 1. Cari voucher
    const voucher = await prisma.voucherCode.findUnique({
      where: { code },
      include: { scriptType: true },
    });

    if (!voucher) {
      redeemLog(username, code, false, 'voucher_not_found');
      return res.render('public/redeem', {
        success: null, error: 'Kode voucher tidak ditemukan.', username, code,
      });
    }

    if (voucher.usedAt || voucher.usedByUsername) {
      redeemLog(username, code, false, 'voucher_already_used');
      return res.render('public/redeem', {
        success: null, error: 'Kode voucher ini sudah pernah dipakai.', username, code,
      });
    }

    if (voucher.voided) {
      redeemLog(username, code, false, 'voucher_voided');
      return res.render('public/redeem', {
        success: null, error: 'Kode voucher ini sudah dibatalkan oleh admin.', username, code,
      });
    }

    if (!voucher.scriptType.active) {
      redeemLog(username, code, false, 'script_type_inactive');
      return res.render('public/redeem', {
        success: null, error: 'Jenis script pada voucher ini sudah tidak aktif.', username, code,
      });
    }

    // 2. Cek lisensi existing
    const usernameNorm = username.toLowerCase();
    const existingLicense = await prisma.license.findUnique({
      where: {
        username_scriptTypeId: {
          username: usernameNorm,
          scriptTypeId: voucher.scriptTypeId,
        },
      },
    });

    // Business rule §5.6: jika revoked, tidak otomatis pulih
    if (existingLicense && existingLicense.revoked) {
      redeemLog(username, code, false, 'license_revoked');
      return res.render('public/redeem', {
        success: null,
        error: 'Lisensi kamu untuk script ini sedang dibekukan (revoked). Hubungi admin untuk mengaktifkan kembali sebelum redeem.',
        username, code,
      });
    }

    // 3. Hitung expiresAt baru
    const now = new Date();
    let newExpiresAt;

    if (!existingLicense) {
      newExpiresAt = new Date(now.getTime() + voucher.durationDays * 86400000);
    } else if (existingLicense.expiresAt > now) {
      newExpiresAt = new Date(existingLicense.expiresAt.getTime() + voucher.durationDays * 86400000);
    } else {
      newExpiresAt = new Date(now.getTime() + voucher.durationDays * 86400000);
    }

    // 4. Generate PIN hanya jika registrasi pertama (belum ada PIN)
    const isNew = !existingLicense;
    const newPin = isNew ? generatePin() : null;

    // 5. Upsert license + tandai voucher (transaksi)
    const [updatedLicense] = await prisma.$transaction([
      prisma.license.upsert({
        where: { username_scriptTypeId: { username: usernameNorm, scriptTypeId: voucher.scriptTypeId } },
        create: {
          username: usernameNorm,
          scriptTypeId: voucher.scriptTypeId,
          expiresAt: newExpiresAt,
          managementPin: newPin,
        },
        update: {
          expiresAt: newExpiresAt,
          // PIN tidak pernah di-overwrite saat extend
        },
      }),
      prisma.voucherCode.update({
        where: { id: voucher.id },
        data: { usedByUsername: usernameNorm, usedAt: now },
      }),
    ]);

    redeemLog(username, code, true);
    // Invalidasi cache — expiresAt berubah atau lisensi baru dibuat
    cache.invalidate(usernameNorm, voucher.scriptType.code);

    return res.render('public/redeem', {
      success: {
        scriptType: voucher.scriptType.name,
        scriptCode: voucher.scriptType.code,
        expiresAt: newExpiresAt,
        durationDays: voucher.durationDays,
        isNew,
        managementPin: isNew ? newPin : null,
      },
      error: null,
      username,
      code: '',
    });
  } catch (err) {
    redeemLog(username, code, false, 'server_error');
    return res.render('public/redeem', {
      success: null,
      error: 'Terjadi kesalahan server. Coba lagi dalam beberapa saat.',
      username, code,
    });
  }
}

module.exports = { checkGet, checkPost, redeemGet, redeemPost };
