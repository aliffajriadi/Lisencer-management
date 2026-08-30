'use strict';

const { customAlphabet } = require('nanoid');
const prisma = require('../lib/prisma');
const { auditLog, redeemLog } = require('../lib/logger');
const cache = require('../lib/verifyCache');

// PIN voucher alphabet — same as main
const pinNanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);
function generateVoucherCode(scriptCode, durationDays) {
  return `${scriptCode}-${durationDays}D-${pinNanoid()}`;
}

// Normalize PIN: uppercase dan trim (tetap pertahankan dash karena disimpan dengan dash)
function normPin(pin) {
  return (pin || '').toUpperCase().trim();
}

// ─── GET /manage ─────────────────────────────────────────────────────────────

async function manageGet(req, res) {
  res.render('public/manage', {
    step: 'input',    // 'input' | 'dashboard'
    licenses: null,
    pin: '',
    error: null,
    success: null,
  });
}

// ─── POST /manage (verify PIN, show dashboard) ────────────────────────────────

async function managePost(req, res) {
  const pinRaw = (req.body.pin || '').trim();
  const pinNorm = normPin(pinRaw);

  if (!pinNorm || pinNorm.length < 8) {
    return res.render('public/manage', {
      step: 'input', licenses: null, pin: pinRaw,
      error: 'Masukkan Management PIN yang valid.',
      success: null,
    });
  }

  try {
    // Cari semua lisensi dengan PIN ini (satu PIN bisa terikat ke beberapa SC jika user punya lebih dari 1? 
    // Tidak — PIN per-license record, jadi satu PIN = satu baris license)
    const license = await prisma.license.findFirst({
      where: { managementPin: pinNorm },
      include: {
        scriptType: true,
        usernameChanges: { orderBy: { changedAt: 'desc' }, take: 5 },
      },
    });

    if (!license) {
      return res.render('public/manage', {
        step: 'input', licenses: null, pin: pinRaw,
        error: 'PIN tidak ditemukan. Pastikan kamu memasukkan PIN yang benar.',
        success: null,
      });
    }

    // Cari semua lisensi milik username yang sama (untuk tampilkan semua SC)
    const allLicenses = await prisma.license.findMany({
      where: { username: license.username },
      include: { scriptType: true },
      orderBy: { createdAt: 'asc' },
    });

    // Simpan PIN ke session untuk aksi selanjutnya
    req.session.managePin = pinNorm;
    req.session.manageLicenseId = license.id;
    req.session.manageUsername = license.username;

    return res.render('public/manage', {
      step: 'dashboard',
      licenses: allLicenses,
      primaryLicense: license,
      pin: pinRaw,
      error: null,
      success: null,
      now: new Date(),
    });
  } catch (err) {
    return res.render('public/manage', {
      step: 'input', licenses: null, pin: pinRaw,
      error: 'Terjadi kesalahan server.',
      success: null,
    });
  }
}

// ─── POST /manage/change-username ─────────────────────────────────────────────

async function changeUsername(req, res) {
  // Verifikasi session PIN
  const sessionPin = req.session.managePin;
  const pinRaw = normPin(req.body.pin || '');
  const newUsername = (req.body.newUsername || '').trim().toLowerCase();
  const voucherCode = (req.body.voucherCode || '').trim().toUpperCase();

  if (!sessionPin || sessionPin !== pinRaw) {
    return res.redirect('/manage');
  }

  if (!newUsername || newUsername.length < 2) {
    return _renderDashboard(req, res, 'Username baru tidak valid.', null);
  }

  if (!voucherCode) {
    return _renderDashboard(req, res, 'Masukkan kode voucher ganti nama.', null);
  }

  try {
    // 1. Cari voucher ganti nama (CN-XXXXXX)
    const nameVoucher = await prisma.nameChangeVoucher.findUnique({
      where: { code: voucherCode }
    });

    if (!nameVoucher) {
      return _renderDashboard(req, res, 'Voucher ganti nama tidak ditemukan.', null);
    }
    if (nameVoucher.usedAt || nameVoucher.voided) {
      return _renderDashboard(req, res, 'Voucher ganti nama sudah digunakan atau di-void.', null);
    }

    const license = await prisma.license.findFirst({
      where: { managementPin: sessionPin },
      include: { scriptType: true },
    });

    if (!license) return res.redirect('/manage');
    if (license.username === newUsername) {
      return _renderDashboard(req, res, 'Username baru sama dengan username lama.', null);
    }

    // Cek konflik username
    const conflict = await prisma.license.findUnique({
      where: {
        username_scriptTypeId: {
          username: newUsername,
          scriptTypeId: license.scriptTypeId,
        },
      },
    });

    if (conflict) {
      return _renderDashboard(req, res,
        `Username "${newUsername}" sudah memiliki lisensi aktif untuk script ${license.scriptType.code}.`,
        null
      );
    }

    const oldUsername = license.username;

    // Update username + log ganti nama + redeem voucher ganti nama dalam 1 transaksi
    await prisma.$transaction([
      prisma.license.update({
        where: { id: license.id },
        data: { username: newUsername },
      }),
      prisma.usernameChangeLog.create({
        data: {
          licenseId: license.id,
          oldUsername,
          newUsername,
          changedBy: 'user',
        },
      }),
      prisma.nameChangeVoucher.update({
        where: { id: nameVoucher.id },
        data: {
          usedByUsername: oldUsername,
          usedAt: new Date()
        }
      })
    ]);

    // Invalidasi cache username lama dan baru
    cache.invalidate(oldUsername, license.scriptType.code);
    cache.invalidate(newUsername, license.scriptType.code);

    // Update session
    req.session.manageUsername = newUsername;

    // Ambil ulang data
    const allLicenses = await prisma.license.findMany({
      where: { username: newUsername },
      include: { scriptType: true },
      orderBy: { createdAt: 'asc' },
    });

    return res.render('public/manage', {
      step: 'dashboard',
      licenses: allLicenses,
      primaryLicense: { ...license, username: newUsername },
      pin: req.body.pin,
      error: null,
      success: `Username berhasil diubah dari "${oldUsername}" ke "${newUsername}".`,
      now: new Date(),
    });
  } catch (err) {
    return _renderDashboard(req, res, 'Terjadi kesalahan server.', null);
  }
}

// ─── POST /manage/extend ──────────────────────────────────────────────────────

async function extendLicense(req, res) {
  const sessionPin = req.session.managePin;
  const pinRaw = normPin(req.body.pin || '');
  const voucherCode = (req.body.voucherCode || '').trim().toUpperCase();
  const licenseId = parseInt(req.body.licenseId || '0', 10);

  if (!sessionPin || sessionPin !== pinRaw) {
    return res.redirect('/manage');
  }

  if (!voucherCode) {
    return _renderDashboard(req, res, 'Masukkan kode voucher untuk memperpanjang.', null);
  }

  try {
    // Cari voucher
    const voucher = await prisma.voucherCode.findUnique({
      where: { code: voucherCode },
      include: { scriptType: true },
    });

    if (!voucher) {
      return _renderDashboard(req, res, 'Kode voucher tidak ditemukan.', null);
    }
    if (voucher.usedAt || voucher.voided) {
      return _renderDashboard(req, res, 'Kode voucher sudah dipakai atau dibatalkan.', null);
    }

    // Cari license target
    const license = await prisma.license.findUnique({
      where: { id: licenseId },
      include: { scriptType: true },
    });

    if (!license || license.managementPin !== sessionPin) {
      return _renderDashboard(req, res, 'Lisensi tidak ditemukan atau PIN tidak cocok.', null);
    }

    if (voucher.scriptTypeId !== license.scriptTypeId) {
      return _renderDashboard(req, res,
        `Voucher ini untuk script ${voucher.scriptType.code}, bukan ${license.scriptType.code}.`,
        null
      );
    }

    if (license.revoked) {
      return _renderDashboard(req, res, 'Lisensi ini sedang dibekukan (revoked). Hubungi admin.', null);
    }

    const now = new Date();
    let newExpiresAt;
    if (license.expiresAt > now) {
      newExpiresAt = new Date(license.expiresAt.getTime() + voucher.durationDays * 86400000);
    } else {
      newExpiresAt = new Date(now.getTime() + voucher.durationDays * 86400000);
    }

    await prisma.$transaction([
      prisma.license.update({
        where: { id: license.id },
        data: { expiresAt: newExpiresAt },
      }),
      prisma.voucherCode.update({
        where: { id: voucher.id },
        data: { usedByUsername: license.username, usedAt: now },
      }),
    ]);

    // Invalidasi cache karena expiresAt berubah
    cache.invalidate(license.username, license.scriptType.code);

    redeemLog(license.username, voucherCode, true);

    const allLicenses = await prisma.license.findMany({
      where: { username: license.username },
      include: { scriptType: true },
      orderBy: { createdAt: 'asc' },
    });

    const exDate = newExpiresAt.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
    return res.render('public/manage', {
      step: 'dashboard',
      licenses: allLicenses,
      primaryLicense: license,
      pin: req.body.pin,
      error: null,
      success: `Lisensi ${license.scriptType.code} berhasil diperpanjang +${voucher.durationDays} hari. Berlaku hingga ${exDate}.`,
      now: new Date(),
    });
  } catch (err) {
    return _renderDashboard(req, res, 'Terjadi kesalahan server.', null);
  }
}

// Helper: re-render dashboard dengan error
async function _renderDashboard(req, res, error, success) {
  const sessionPin = req.session.managePin;
  if (!sessionPin) return res.redirect('/manage');
  try {
    const license = await prisma.license.findFirst({
      where: { managementPin: sessionPin },
      include: { scriptType: true },
    });
    if (!license) return res.redirect('/manage');
    const allLicenses = await prisma.license.findMany({
      where: { username: license.username },
      include: { scriptType: true },
    });
    return res.render('public/manage', {
      step: 'dashboard',
      licenses: allLicenses,
      primaryLicense: license,
      pin: req.body.pin || '',
      error,
      success,
      now: new Date(),
    });
  } catch (e) {
    return res.redirect('/manage');
  }
}

module.exports = { manageGet, managePost, changeUsername, extendLicense };
