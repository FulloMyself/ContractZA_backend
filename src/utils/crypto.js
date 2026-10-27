'use strict';

const crypto = require('node:crypto');
const config = require('../config/env');

function encryptId(id) {
  if (!config.encryptionKey) throw new Error('ID_ENCRYPTION_KEY is required to store identity numbers');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(id, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('hex')).join(':');
}

function decryptId(value) {
  if (!config.encryptionKey) throw new Error('ID_ENCRYPTION_KEY is required to decrypt identity numbers');
  const [ivHex, tagHex, encryptedHex, ...extra] = String(value).split(':');
  if (extra.length || !/^[a-f0-9]{24}$/i.test(ivHex) || !/^[a-f0-9]{32}$/i.test(tagHex) || !/^(?:[a-f0-9]{2})+$/i.test(encryptedHex)) {
    throw new Error('Encrypted identity number has an invalid format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

function hashId(id) {
  if (!config.idHashPepper) throw new Error('ID_HASH_PEPPER is required to index identity numbers');
  return crypto.createHmac('sha256', config.idHashPepper).update(id).digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashRefreshToken(token) {
  return crypto.createHmac('sha256', config.refreshSecret).update(token).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function maskId(id) {
  return `${id.slice(0, 6)} •••• ${id.slice(10, 12)} •`;
}

module.exports = { encryptId, decryptId, hashId, hashToken, hashRefreshToken, randomToken, maskId };
