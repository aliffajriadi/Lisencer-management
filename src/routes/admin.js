'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const c = require('../controllers/adminController');

// Auth
router.get('/login', c.loginGet);
router.post('/login', c.loginPost);
router.post('/logout', requireAdmin, c.logout);

// Dashboard
router.get('/', requireAdmin, c.dashboard);

// Licenses
router.get('/licenses', requireAdmin, c.licensesList);
router.get('/licenses/:id/edit', requireAdmin, c.licenseEditGet);
router.post('/licenses/:id', requireAdmin, c.licenseEditPost);
router.post('/licenses/:id/change-username', requireAdmin, c.adminChangeUsername);

// Username change log
router.get('/username-changes', requireAdmin, c.usernameChangesList);

// Vouchers
router.get('/vouchers', requireAdmin, c.vouchersList);
router.get('/vouchers/generate', requireAdmin, c.vouchersGenerateGet);
router.post('/vouchers/generate', requireAdmin, c.vouchersGeneratePost);
router.get('/vouchers/generate-name-change', requireAdmin, c.vouchersGenerateNameChangeGet);
router.post('/vouchers/generate-name-change', requireAdmin, c.vouchersGenerateNameChangePost);
router.post('/vouchers/:id/void', requireAdmin, c.voucherVoid);
router.get('/vouchers/export', requireAdmin, c.voucherExport);

// Ad Config
router.get('/ad-config', requireAdmin, c.adConfigGet);
router.post('/ad-config', requireAdmin, c.adConfigPost);

// Script Types
router.get('/script-types', requireAdmin, c.scriptTypesList);
router.post('/script-types', requireAdmin, c.scriptTypesCreate);
router.post('/script-types/:id', requireAdmin, c.scriptTypesUpdate);

module.exports = router;
