'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { logger } = require('./lib/logger');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

const app = express();

// Trust proxy if behind nginx/caddy
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: process.cwd(),
  }),
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// Request logger (minimal, avoid logging sensitive data)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/license/verify')) {
    logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  }
  next();
});

// Middleware untuk mengambil konfigurasi iklan global
app.use(async (req, res, next) => {
  try {
    const prisma = require('./lib/prisma');
    const adConfig = await prisma.systemSetting.findUnique({ where: { key: 'ad_config' } });
    res.locals.globalAd = adConfig ? JSON.parse(adConfig.value) : null;
  } catch (err) {
    res.locals.globalAd = null;
  }
  next();
});

// Helper available in all EJS templates
app.locals.formatDate = (date) => {
  if (!date) return '-';
  return new Date(date).toLocaleDateString('id-ID', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
};
app.locals.formatDatetime = (date) => {
  if (!date) return '-';
  return new Date(date).toLocaleString('id-ID', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};
app.locals.daysLeft = (expiresAt) => {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt) - new Date()) / 86400000));
};
app.locals.licenseStatus = (license) => {
  if (license.revoked) return 'revoked';
  if (new Date(license.expiresAt) <= new Date()) return 'expired';
  return 'active';
};

// Routes
app.use('/', publicRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('public/check', {
    query: null, licenses: null, username: '',
    error: 'Halaman tidak ditemukan.',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
