'use strict';

const express = require('express');
const { z } = require('zod');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const { validateSAId } = require('../utils/saId');
const { encryptId, hashId, hashToken, hashRefreshToken, randomToken, maskId } = require('../utils/crypto');
const { createAccessToken } = require('../utils/tokens');
const { asyncHandler, AppError } = require('../utils/errors');
const { writeAudit } = require('../services/audit.service');
const { sendEmail, emailHtml } = require('../services/email');
const { clientPage } = require('../utils/urls');
const config = require('../config/env');

const router = express.Router();
const passwordField = z.string().min(10, 'Password must be at least 10 characters.').max(128);
const emailField = z.string().email().max(254).transform((value) => value.toLowerCase().trim());
const registrationSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailField,
  password: passwordField,
  idNumber: z.string().regex(/^\d{13}$/, 'ID number must be exactly 13 digits.')
});

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production' || config.sameSite === 'none',
    sameSite: config.sameSite,
    domain: config.cookieDomain,
    path: '/api/auth',
    maxAge: config.refreshDays * 24 * 60 * 60 * 1000
  };
}

async function setRefreshCookie(res, user, req, family) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.refreshDays * 24 * 60 * 60 * 1000);
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashRefreshToken(token),
    family,
    expiresAt,
    userAgent: req.get('user-agent') || '',
    ipAddress: req.ip
  });
  res.cookie('refreshToken', token, cookieOptions());
}

router.post('/register', asyncHandler(async (req, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  const data = parsed.data;
  const idResult = validateSAId(data.idNumber);
  if (!idResult.valid) throw new AppError(400, idResult.reason);
  if (await User.exists({ $or: [{ email: data.email }, { idNumberHash: hashId(data.idNumber) }] })) {
    throw new AppError(409, 'An account with those details already exists.');
  }

  const token = randomToken();
  const user = new User({
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    encryptedIdNumber: encryptId(data.idNumber),
    maskedIdNumber: maskId(data.idNumber),
    idNumberHash: hashId(data.idNumber),
    dateOfBirth: idResult.dateOfBirth,
    gender: idResult.gender,
    verificationTokenHash: hashToken(token),
    verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
  await user.setPassword(data.password);
  await user.save();
  const link = clientPage(`verify-email?token=${encodeURIComponent(token)}`);
  await sendEmail({
    to: user.email,
    subject: 'Verify your Contracts ZAR account',
    html: emailHtml(`Hello ${user.firstName}, verify your email to activate your account.`, link),
    text: `Verify your account: ${link}`
  });
  await writeAudit({ actor: user._id, action: 'auth.register', targetType: 'user', targetId: String(user._id), ipAddress: req.ip });
  res.status(201).json({ message: 'Account created. Check your email for a verification link.' });
}));

router.get('/verify-email', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) throw new AppError(400, 'Verification token is required.');
  const user = await User.findOne({ verificationTokenHash: hashToken(token), verificationExpiresAt: { $gt: new Date() } });
  if (!user) throw new AppError(400, 'This verification link is invalid or expired.');
  user.emailVerified = true;
  user.verificationTokenHash = undefined;
  user.verificationExpiresAt = undefined;
  await user.save();
  await writeAudit({ actor: user._id, action: 'auth.email_verified', targetType: 'user', targetId: String(user._id), ipAddress: req.ip });
  res.json({ message: 'Email verified. You can now sign in.' });
}));

router.post('/resend-verification', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const user = await User.findOne({ email, emailVerified: false });
  if (user) {
    const token = randomToken();
    user.verificationTokenHash = hashToken(token);
    user.verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();
    const link = clientPage(`verify-email?token=${encodeURIComponent(token)}`);
    await sendEmail({ to: user.email, subject: 'Verify your Contracts ZAR account', html: emailHtml('Verify your account.', link), text: `Verify your account: ${link}` });
  }
  res.json({ message: 'If that account needs verification, a link has been sent.' });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const user = await User.findOne({ email }).select('+passwordHash');
  const genericError = new AppError(401, 'Email or password is incorrect.');
  if (!user) throw genericError;
  if (user.lockedUntil && user.lockedUntil > new Date()) throw genericError;

  const suppliedPassword = String(req.body.password || '');
  const matches = await user.comparePassword(suppliedPassword.length <= 128 ? suppliedPassword : '');
  if (!matches) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= 5) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    }
    await user.save();
    throw genericError;
  }
  if (!user.emailVerified || user.status !== 'active') throw genericError;
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();
  const family = randomToken();
  await setRefreshCookie(res, user, req, family);
  await writeAudit({ actor: user._id, action: 'auth.login', targetType: 'user', targetId: String(user._id), ipAddress: req.ip });
  await sendEmail({
    to: user.email,
    subject: 'New sign-in to your Contracts ZAR account',
    html: '<p>A new sign-in to your Contracts ZAR account was successful. If this was not you, change your password immediately.</p>',
    text: 'A new sign-in to your Contracts ZAR account was successful. If this was not you, change your password immediately.'
  });
  res.json({ accessToken: createAccessToken(user), user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role } });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const rawToken = req.cookies.refreshToken;
  if (!rawToken) throw new AppError(401, 'Refresh session is missing.');
  const tokenHash = hashRefreshToken(rawToken);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record) throw new AppError(401, 'Refresh session is invalid.');
  if (record.revokedAt) {
    await RefreshToken.updateMany({ family: record.family }, { $set: { revokedAt: new Date() } });
    res.clearCookie('refreshToken', cookieOptions());
    throw new AppError(401, 'Refresh session reuse detected. Please sign in again.');
  }
  if (record.expiresAt <= new Date()) throw new AppError(401, 'Refresh session expired.');
  const user = await User.findById(record.user);
  if (!user || user.status !== 'active' || !user.emailVerified) throw new AppError(401, 'Authentication required.');
  const nextToken = randomToken();
  const nextHash = hashRefreshToken(nextToken);
  const rotatedAt = new Date();
  const rotated = await RefreshToken.updateOne(
    { _id: record._id, revokedAt: null, expiresAt: { $gt: rotatedAt } },
    { $set: { revokedAt: rotatedAt, replacedByHash: nextHash } }
  );
  if (!rotated.modifiedCount) {
    await RefreshToken.updateMany({ family: record.family }, { $set: { revokedAt: rotatedAt } });
    res.clearCookie('refreshToken', cookieOptions());
    throw new AppError(401, 'Refresh session reuse detected. Please sign in again.');
  }
  await RefreshToken.create({
    user: user._id, tokenHash: nextHash, family: record.family,
    expiresAt: new Date(Date.now() + config.refreshDays * 24 * 60 * 60 * 1000),
    userAgent: req.get('user-agent') || '', ipAddress: req.ip
  });
  res.cookie('refreshToken', nextToken, cookieOptions());
  res.json({ accessToken: createAccessToken(user) });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies.refreshToken;
  if (token) await RefreshToken.updateOne({ tokenHash: hashRefreshToken(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
  res.clearCookie('refreshToken', cookieOptions());
  res.json({ message: 'Signed out.' });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email || '').toLowerCase().trim() });
  if (user) {
    const token = randomToken();
    user.resetTokenHash = hashToken(token);
    user.resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    const link = clientPage(`reset-password?token=${encodeURIComponent(token)}`);
    await sendEmail({ to: user.email, subject: 'Reset your Contracts ZAR password', html: emailHtml('Reset your password.', link, '1 hour'), text: `Reset your password: ${link}` });
  }
  res.json({ message: 'If an account exists for that address, a reset link has been sent.' });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const parsed = z.object({ token: z.string().min(1), password: passwordField }).safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  const user = await User.findOne({ resetTokenHash: hashToken(parsed.data.token), resetExpiresAt: { $gt: new Date() } }).select('+passwordHash');
  if (!user) throw new AppError(400, 'This password reset link is invalid or expired.');
  await user.setPassword(parsed.data.password);
  user.resetTokenHash = undefined;
  user.resetExpiresAt = undefined;
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await writeAudit({ actor: user._id, action: 'auth.password_reset', targetType: 'user', targetId: String(user._id), ipAddress: req.ip });
  await sendEmail({
    to: user.email, subject: 'Your Contracts ZAR password was changed',
    html: '<p>Your Contracts ZAR password was changed. If you did not make this change, contact support immediately.</p>',
    text: 'Your Contracts ZAR password was changed. If you did not make this change, contact support immediately.'
  });
  res.json({ message: 'Password updated. Sign in with your new password.' });
}));

module.exports = router;
