'use strict';

require('dotenv').config();
const nodeEnv = process.env.NODE_ENV || 'development';

function required(name) {
  const value = process.env[name];
  if (!value && nodeEnv === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function key(name) {
  const value = process.env[name];
  if (!value && nodeEnv === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value && !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 32-byte hexadecimal key`);
  }
  return value;
}

const accessSecret = required('JWT_ACCESS_SECRET') || 'development-access-secret-change-me';
const refreshSecret = required('JWT_REFRESH_SECRET') || 'development-refresh-secret-change-me';
const idHashPepper = required('ID_HASH_PEPPER');
const clientUrl = required('CLIENT_URL') || 'http://localhost:5173';
const apiUrl = required('API_URL') || 'http://localhost:5000';
const clientBasePath = (process.env.CLIENT_BASE_PATH || '').replace(/\/+$/, '');
const refreshDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7);
const signingDays = Number(process.env.SIGNING_TOKEN_TTL_DAYS || 7);
const emailProvider = process.env.EMAIL_PROVIDER || '';
const emailFrom = required('EMAIL_FROM') || 'Contracts ZAR <no-reply@example.com>';
const sameSite = process.env.COOKIE_SAMESITE || 'lax';
if (!Number.isInteger(refreshDays) || refreshDays < 1 || !Number.isInteger(signingDays) || signingDays < 1) {
  throw new Error('Refresh and signing token lifetimes must be positive whole days');
}
if (idHashPepper && !/^[a-f0-9]{64}$/i.test(idHashPepper)) {
  throw new Error('ID_HASH_PEPPER must be a 32-byte hexadecimal key');
}
if (clientBasePath && (!/^\/[a-z0-9/_-]+$/i.test(clientBasePath) || clientBasePath.includes('..'))) {
  throw new Error('CLIENT_BASE_PATH must be a safe URL path such as /contracts-zar or empty');
}
if (nodeEnv === 'production') {
  if (accessSecret.length < 64 || refreshSecret.length < 64 || accessSecret === refreshSecret) {
    throw new Error('Production JWT secrets must be distinct and at least 64 characters long');
  }
  for (const [name, value] of [['CLIENT_URL', clientUrl], ['API_URL', apiUrl]]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${name} must be an HTTPS origin without a path`);
    }
  }
  if (!['resend', 'brevo'].includes(emailProvider)) {
    throw new Error('EMAIL_PROVIDER must be resend or brevo in production');
  }
  if (emailProvider === 'resend' && !required('RESEND_API_KEY')) throw new Error('RESEND_API_KEY is required for Resend');
  if (emailProvider === 'brevo' && !required('BREVO_API_KEY')) throw new Error('BREVO_API_KEY is required for Brevo');
}
if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict, or none');

module.exports = {
  nodeEnv,
  port: Number(process.env.PORT || 5000),
  clientUrl,
  clientBasePath,
  apiUrl,
  mongoUri: required('MONGODB_URI') || 'mongodb://127.0.0.1:27017/contracts-zar',
  accessSecret,
  refreshSecret,
  accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshDays,
  signingDays,
  encryptionKey: key('ID_ENCRYPTION_KEY'),
  idHashPepper,
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  sameSite,
  emailProvider,
  emailFrom
};
