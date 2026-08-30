'use strict';

const bcrypt = require('bcrypt');
const { customAlphabet } = require('nanoid');
const { stringify } = require('csv-stringify/sync');
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');
const { auditLog, logger } = require('../lib/logger');
const cache = require('../lib/verifyCache');

// Voucher code alphabet — no 0/O/I/1 to avoid confusion
const nanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

function generateVoucherCode(scriptCode, durationDays) {
  return `${scriptCode}-${durationDays}D-${nanoid()}`;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function loginGet(req, res) {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin/login', { error: null });
}

async function loginPost(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('admin/login', { error: 'Username dan password harus diisi.' });
  }

  try {
    const admin = await prisma.adminUser.findUnique({ where: { username: username.trim() } });
    if (!admin) {
      return res.render('admin/login', { error: 'Username atau password salah.' });
    }

    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) {
      return res.render('admin/login', { error: 'Username atau password salah.' });
    }

    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;

    const returnTo = req.session.returnTo || '/admin';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    logger.error('login error', { error: err.message });
    res.render('admin/login', { error: 'Terjadi kesalahan server.' });
  }
}

async function logout(req, res) {
  req.session.destroy(() => res.redirect('/admin/login'));
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

async function dashboard(req, res) {
  try {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 86400000);

    const [totalActive, expiringSoon, totalVouchers, usedVouchers] = await Promise.all([
      prisma.license.count({ where: { revoked: false, expiresAt: { gt: now } } }),
      prisma.license.count({ where: { revoked: false, expiresAt: { gt: now, lte: in7Days } } }),
      prisma.voucherCode.count({ where: { voided: false } }),
      prisma.voucherCode.count({ where: { usedAt: { not: null } } }),
    ]);

    const recentLicenses = await prisma.license.findMany({
      take: 10,
      orderBy: { updatedAt: 'desc' },
      include: { scriptType: true },
    });

    res.render('admin/dashboard', {
      admin: req.session.adminUsername,
      stats: { totalActive, expiringSoon, totalVouchers, usedVouchers },
      recentLicenses,
      now,
    });
  } catch (err) {
    logger.error('dashboard error', { error: err.message });
    res.status(500).send('Server error');
  }
}

// ─── LICENSES ────────────────────────────────────────────────────────────────

async function licensesList(req, res) {
  try {
    const { search = '', script = '', status = '', page = '1' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = 30;
    const skip = (pageNum - 1) * perPage;

    const now = new Date();
    const where = {};

    if (search) {
      where.username = { contains: search.toLowerCase() };
    }

    if (script) {
      where.scriptType = { code: script.toUpperCase() };
    }

    if (status === 'active') {
      where.revoked = false;
      where.expiresAt = { gt: now };
    } else if (status === 'expired') {
      where.revoked = false;
      where.expiresAt = { lte: now };
    } else if (status === 'revoked') {
      where.revoked = true;
    }

    const [licenses, total] = await Promise.all([
      prisma.license.findMany({
        where,
        include: { scriptType: true },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: perPage,
      }),
      prisma.license.count({ where }),
    ]);

    const scriptTypes = await prisma.scriptType.findMany({ orderBy: { code: 'asc' } });

    res.render('admin/licenses/index', {
      admin: req.session.adminUsername,
      licenses,
      scriptTypes,
      filters: { search, script, status },
      pagination: { page: pageNum, perPage, total, totalPages: Math.ceil(total / perPage) },
      now,
    });
  } catch (err) {
    logger.error('licenses list error', { error: err.message });
    res.status(500).send('Server error');
  }
}

async function licenseEditGet(req, res) {
  try {
    const license = await prisma.license.findUnique({
      where: { id: parseInt(req.params.id, 10) },
      include: { scriptType: true },
    });
    if (!license) return res.status(404).send('Lisensi tidak ditemukan.');
    res.render('admin/licenses/edit', { admin: req.session.adminUsername, license, error: null, success: null });
  } catch (err) {
    res.status(500).send('Server error');
  }
}

async function licenseEditPost(req, res) {
  const id = parseInt(req.params.id, 10);
  const { action, expiresAt } = req.body;

  try {
    const license = await prisma.license.findUnique({ where: { id }, include: { scriptType: true } });
    if (!license) return res.status(404).send('Lisensi tidak ditemukan.');

    if (action === 'revoke') {
      await prisma.license.update({ where: { id }, data: { revoked: true } });
      auditLog(req.session.adminUsername, 'revoke_license', { licenseId: id, username: license.username });
      cache.invalidate(license.username, license.scriptType.code);
      return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license: { ...license, revoked: true }, error: null, success: 'Lisensi berhasil di-revoke.' });
    }

    if (action === 'unrevoke') {
      await prisma.license.update({ where: { id }, data: { revoked: false } });
      auditLog(req.session.adminUsername, 'unrevoke_license', { licenseId: id, username: license.username });
      cache.invalidate(license.username, license.scriptType.code);
      return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license: { ...license, revoked: false }, error: null, success: 'Lisensi berhasil diaktifkan kembali.' });
    }

    if (action === 'update_expires') {
      if (!expiresAt) {
        return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license, error: 'Tanggal expired tidak boleh kosong.', success: null });
      }
      const newDate = new Date(expiresAt);
      if (isNaN(newDate.getTime())) {
        return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license, error: 'Format tanggal tidak valid.', success: null });
      }
      await prisma.license.update({ where: { id }, data: { expiresAt: newDate } });
      auditLog(req.session.adminUsername, 'edit_license_expires', { licenseId: id, username: license.username, newExpiresAt: newDate });
      cache.invalidate(license.username, license.scriptType.code);
      const updated = await prisma.license.findUnique({ where: { id }, include: { scriptType: true } });
      return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license: updated, error: null, success: 'Tanggal expired berhasil diperbarui.' });
    }

    res.redirect('/admin/licenses');
  } catch (err) {
    logger.error('license edit error', { error: err.message });
    res.status(500).send('Server error');
  }
}

// ─── VOUCHERS ────────────────────────────────────────────────────────────────

async function vouchersList(req, res) {
  try {
    const { script = '', status = '', page = '1' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = 30;
    const skip = (pageNum - 1) * perPage;

    const where = {};
    if (script) where.scriptType = { code: script.toUpperCase() };
    if (status === 'unused') { where.usedAt = null; where.voided = false; }
    else if (status === 'used') { where.usedAt = { not: null }; }
    else if (status === 'voided') { where.voided = true; }

    const [vouchers, total] = await Promise.all([
      prisma.voucherCode.findMany({
        where,
        include: { scriptType: true, createdByAdmin: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
      }),
      prisma.voucherCode.count({ where }),
    ]);

    const scriptTypes = await prisma.scriptType.findMany({ where: { active: true }, orderBy: { code: 'asc' } });

    res.render('admin/vouchers/index', {
      admin: req.session.adminUsername,
      vouchers,
      scriptTypes,
      filters: { script, status },
      pagination: { page: pageNum, perPage, total, totalPages: Math.ceil(total / perPage) },
    });
  } catch (err) {
    logger.error('vouchers list error', { error: err.message });
    res.status(500).send('Server error');
  }
}

async function vouchersGenerateGet(req, res) {
  try {
    const scriptTypes = await prisma.scriptType.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
    res.render('admin/vouchers/generate', { admin: req.session.adminUsername, scriptTypes, result: null, error: null });
  } catch (err) {
    res.status(500).send('Server error');
  }
}

async function vouchersGeneratePost(req, res) {
  try {
    const { scriptTypeId, durationDays, quantity, batchLabel, customCode } = req.body;
    const scriptTypes = await prisma.scriptType.findMany({ where: { active: true }, orderBy: { code: 'asc' } });

    const stId = parseInt(scriptTypeId, 10);
    const days = parseInt(durationDays, 10);
    const qty = Math.min(Math.max(1, parseInt(quantity || '1', 10)), 500);

    if (!stId || !days || days < 1) {
      return res.render('admin/vouchers/generate', { admin: req.session.adminUsername, scriptTypes, result: null, error: 'Pilih jenis script dan durasi yang valid.' });
    }

    const scriptType = await prisma.scriptType.findUnique({ where: { id: stId } });
    if (!scriptType) {
      return res.render('admin/vouchers/generate', { admin: req.session.adminUsername, scriptTypes, result: null, error: 'Jenis script tidak ditemukan.' });
    }

    const codes = [];
    const isSingle = qty === 1 && customCode && customCode.trim();

    if (isSingle) {
      const code = customCode.trim().toUpperCase();
      codes.push(code);
    } else {
      for (let i = 0; i < qty; i++) {
        codes.push(generateVoucherCode(scriptType.code, days));
      }
    }

    // Insert all vouchers
    await prisma.voucherCode.createMany({
      data: codes.map(code => ({
        code,
        scriptTypeId: stId,
        durationDays: days,
        batchLabel: batchLabel ? batchLabel.trim() : null,
        createdByAdminId: req.session.adminId,
      })),
    });

    auditLog(req.session.adminUsername, 'generate_vouchers', {
      count: codes.length, scriptType: scriptType.code, durationDays: days, batchLabel,
    });

    // Save to temp file for export
    const exportDir = path.join(process.cwd(), 'logs', 'exports');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    const timestamp = Date.now();
    const txtFile = path.join(exportDir, `vouchers-${timestamp}.txt`);
    const csvFile = path.join(exportDir, `vouchers-${timestamp}.csv`);

    fs.writeFileSync(txtFile, codes.join('\n'));
    const csvContent = stringify([['code', 'scriptType', 'durationDays', 'batchLabel'], ...codes.map(c => [c, scriptType.code, days, batchLabel || ''])]);
    fs.writeFileSync(csvFile, csvContent);

    res.render('admin/vouchers/generate', {
      admin: req.session.adminUsername,
      scriptTypes,
      result: { codes, scriptType: scriptType.name, days, txtFile: `exports/vouchers-${timestamp}.txt`, csvFile: `exports/vouchers-${timestamp}.csv` },
      error: null,
    });
  } catch (err) {
    logger.error('generate voucher error', { error: err.message });
    const scriptTypes = await prisma.scriptType.findMany({ where: { active: true } });
    res.render('admin/vouchers/generate', { admin: req.session.adminUsername, scriptTypes, result: null, error: 'Terjadi kesalahan. Cek apakah kode custom sudah ada.' });
  }
}

async function voucherVoid(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const voucher = await prisma.voucherCode.findUnique({ where: { id } });
    if (!voucher) return res.status(404).json({ error: 'Voucher tidak ditemukan.' });
    if (voucher.usedAt) return res.status(400).json({ error: 'Voucher sudah dipakai, tidak bisa di-void.' });

    await prisma.voucherCode.update({ where: { id }, data: { voided: true } });
    auditLog(req.session.adminUsername, 'void_voucher', { voucherId: id, code: voucher.code });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
}

async function voucherExport(req, res) {
  const { file } = req.query;
  if (!file || file.includes('..') || file.includes('/')) {
    return res.status(400).send('Invalid file');
  }
  const filePath = path.join(process.cwd(), 'logs', 'exports', file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
}

// ─── SCRIPT TYPES ─────────────────────────────────────────────────────────────

async function scriptTypesList(req, res) {
  try {
    const scriptTypes = await prisma.scriptType.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { licenses: true, vouchers: true } } },
    });
    res.render('admin/script-types/index', { admin: req.session.adminUsername, scriptTypes, error: null, success: null });
  } catch (err) {
    res.status(500).send('Server error');
  }
}

async function scriptTypesCreate(req, res) {
  const { code, name } = req.body;
  try {
    if (!code || !name) {
      const scriptTypes = await prisma.scriptType.findMany({ include: { _count: { select: { licenses: true, vouchers: true } } } });
      return res.render('admin/script-types/index', { admin: req.session.adminUsername, scriptTypes, error: 'Kode dan nama harus diisi.', success: null });
    }
    await prisma.scriptType.create({ data: { code: code.trim().toUpperCase(), name: name.trim() } });
    auditLog(req.session.adminUsername, 'create_script_type', { code, name });
    res.redirect('/admin/script-types?success=1');
  } catch (err) {
    const scriptTypes = await prisma.scriptType.findMany({ include: { _count: { select: { licenses: true, vouchers: true } } } });
    res.render('admin/script-types/index', { admin: req.session.adminUsername, scriptTypes, error: 'Kode sudah ada atau terjadi kesalahan.', success: null });
  }
}

async function scriptTypesUpdate(req, res) {
  const id = parseInt(req.params.id, 10);
  const { name, active } = req.body;
  try {
    await prisma.scriptType.update({
      where: { id },
      data: { name: name ? name.trim() : undefined, active: active === '1' },
    });
    auditLog(req.session.adminUsername, 'update_script_type', { id, name, active });
    res.redirect('/admin/script-types?success=1');
  } catch (err) {
    res.status(500).send('Server error');
  }
}

// ─── USERNAME CHANGE LOG ─────────────────────────────────────────────────────

async function usernameChangesList(req, res) {
  try {
    const { search = '', page = '1' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = 30;
    const skip = (pageNum - 1) * perPage;

    const where = search
      ? { OR: [{ oldUsername: { contains: search.toLowerCase() } }, { newUsername: { contains: search.toLowerCase() } }] }
      : {};

    const [logs, total] = await Promise.all([
      prisma.usernameChangeLog.findMany({
        where,
        include: { license: { include: { scriptType: true } } },
        orderBy: { changedAt: 'desc' },
        skip,
        take: perPage,
      }),
      prisma.usernameChangeLog.count({ where }),
    ]);

    res.render('admin/username-changes', {
      admin: req.session.adminUsername,
      logs,
      filters: { search },
      pagination: { page: pageNum, perPage, total, totalPages: Math.ceil(total / perPage) || 1 },
    });
  } catch (err) {
    logger.error('username changes list error', { error: err.message });
    res.status(500).send('Server error');
  }
}

async function adminChangeUsername(req, res) {
  const id = parseInt(req.params.id, 10);
  const { newUsername } = req.body;

  if (!newUsername || newUsername.trim().length < 2) {
    // Re-render edit page with error
    const license = await prisma.license.findUnique({ where: { id }, include: { scriptType: true } });
    return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license, error: 'Username baru tidak valid.', success: null });
  }

  try {
    const license = await prisma.license.findUnique({ where: { id }, include: { scriptType: true } });
    if (!license) return res.status(404).send('Lisensi tidak ditemukan.');

    const newUsernameNorm = newUsername.trim().toLowerCase();
    if (license.username === newUsernameNorm) {
      return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license, error: 'Username baru sama dengan yang lama.', success: null });
    }

    const conflict = await prisma.license.findUnique({
      where: { username_scriptTypeId: { username: newUsernameNorm, scriptTypeId: license.scriptTypeId } },
    });
    if (conflict) {
      return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license, error: `Username "${newUsernameNorm}" sudah punya lisensi untuk script ${license.scriptType.code}.`, success: null });
    }

    const oldUsername = license.username;
    await prisma.$transaction([
      prisma.license.update({ where: { id }, data: { username: newUsernameNorm } }),
      prisma.usernameChangeLog.create({
        data: {
          licenseId: id,
          oldUsername,
          newUsername: newUsernameNorm,
          changedBy: `admin:${req.session.adminUsername}`,
        },
      }),
    ]);

    // Invalidasi cache untuk username lama dan baru
    cache.invalidate(oldUsername, license.scriptType.code);
    cache.invalidate(newUsernameNorm, license.scriptType.code);
    auditLog(req.session.adminUsername, 'admin_change_username', { licenseId: id, oldUsername, newUsername: newUsernameNorm });

    const updated = await prisma.license.findUnique({ where: { id }, include: { scriptType: true } });
    return res.render('admin/licenses/edit', { admin: req.session.adminUsername, license: updated, error: null, success: `Username berhasil diubah dari "${oldUsername}" ke "${newUsernameNorm}".` });
  } catch (err) {
    logger.error('admin change username error', { error: err.message });
    res.status(500).send('Server error');
  }
}

// ─── NAME CHANGE VOUCHERS ────────────────────────────────────────────────────

async function vouchersGenerateNameChangeGet(req, res) {
  res.render('admin/vouchers/name-change-generate', { admin: req.session.adminUsername, result: null, error: null });
}

async function vouchersGenerateNameChangePost(req, res) {
  try {
    const qty = Math.min(Math.max(1, parseInt(req.body.quantity || '1', 10)), 100);
    const codes = [];

    // Generate voucher ganti nama dengan format: CN-XXXXXX
    const codeGen = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);
    for (let i = 0; i < qty; i++) {
      codes.push(`CN-${codeGen()}`);
    }

    await prisma.nameChangeVoucher.createMany({
      data: codes.map(code => ({
        code,
        createdByAdminId: req.session.adminId,
      })),
    });

    auditLog(req.session.adminUsername, 'generate_name_change_vouchers', { count: codes.length });

    // Tulis ke temp file
    const exportDir = path.join(process.cwd(), 'logs', 'exports');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    const timestamp = Date.now();
    const txtFile = path.join(exportDir, `name-change-vouchers-${timestamp}.txt`);
    fs.writeFileSync(txtFile, codes.join('\n'));

    res.render('admin/vouchers/name-change-generate', {
      admin: req.session.adminUsername,
      result: { codes, txtFile: `exports/name-change-vouchers-${timestamp}.txt` },
      error: null,
    });
  } catch (err) {
    logger.error('generate name change voucher error', { error: err.message });
    res.render('admin/vouchers/name-change-generate', { admin: req.session.adminUsername, result: null, error: 'Terjadi kesalahan server.' });
  }
}

// ─── AD CONFIG ───────────────────────────────────────────────────────────────

async function adConfigGet(req, res) {
  try {
    const adConfig = await prisma.systemSetting.findUnique({ where: { key: 'ad_config' } });
    const config = adConfig ? JSON.parse(adConfig.value) : { enabled: false, title: '', content: '', linkText: '', linkUrl: '' };
    res.render('admin/ad-config', { admin: req.session.adminUsername, config, error: null, success: null });
  } catch (err) {
    res.status(500).send('Server error');
  }
}

async function adConfigPost(req, res) {
  const { enabled, title, content, linkText, linkUrl } = req.body;
  const configObj = {
    enabled: enabled === '1',
    title: (title || '').trim(),
    content: (content || '').trim(),
    linkText: (linkText || '').trim(),
    linkUrl: (linkUrl || '').trim(),
  };

  try {
    await prisma.systemSetting.upsert({
      where: { key: 'ad_config' },
      update: { value: JSON.stringify(configObj) },
      create: { key: 'ad_config', value: JSON.stringify(configObj) },
    });

    auditLog(req.session.adminUsername, 'update_ad_config', configObj);
    res.render('admin/ad-config', { admin: req.session.adminUsername, config: configObj, error: null, success: 'Pengaturan iklan berhasil diperbarui.' });
  } catch (err) {
    logger.error('update ad config error', { error: err.message });
    res.render('admin/ad-config', { admin: req.session.adminUsername, config: configObj, error: 'Gagal memperbarui pengaturan.', success: null });
  }
}

module.exports = {
  loginGet, loginPost, logout,
  dashboard,
  licensesList, licenseEditGet, licenseEditPost,
  adminChangeUsername,
  usernameChangesList,
  vouchersList, vouchersGenerateGet, vouchersGeneratePost, voucherVoid, voucherExport,
  vouchersGenerateNameChangeGet, vouchersGenerateNameChangePost,
  adConfigGet, adConfigPost,
  scriptTypesList, scriptTypesCreate, scriptTypesUpdate,
};
