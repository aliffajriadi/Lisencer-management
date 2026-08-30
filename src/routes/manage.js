'use strict';

const express = require('express');
const router = express.Router();
const { manageGet, managePost, changeUsername, extendLicense } = require('../controllers/manageController');

router.get('/', manageGet);
router.post('/', managePost);
router.post('/change-username', changeUsername);
router.post('/extend', extendLicense);

module.exports = router;
