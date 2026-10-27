'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');

function createAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.accessSecret, { expiresIn: config.accessTtl });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.accessSecret);
}

module.exports = { createAccessToken, verifyAccessToken };
