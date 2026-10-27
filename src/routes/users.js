'use strict';

const express = require('express');
const { z } = require('zod');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const CorrectionRequest = require('../models/CorrectionRequest');
const { authenticate, requireRole } = require('../middleware/auth');
const { objectIdParam } = require('../middleware/objectIdParam');
const { asyncHandler, AppError } = require('../utils/errors');
const { writeAudit } = require('../services/audit.service');
const { sendEmail, emailHtml } = require('../services/email');
const { randomToken, hashToken, encryptId, maskId } = require('../utils/crypto');
const { validateSAId } = require('../utils/saId');
const config = require('../config/env');

const router = express.Router();
router.param('id', objectIdParam);
const provinces = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape'];
const addressSchema = z.object({
  street: z.string().max(150).optional(),
  unit: z.string().max(100).optional(),
  suburb: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  province: z.enum(provinces).or(z.literal('')).optional(),
  postalCode: z.string().regex(/^\d{4}$/).or(z.literal('')).optional()
}).strict();
const profileSchema = z.object({
  mobile: z.string().max(20).optional(),
  alternatePhone: z.string().max(20).optional(),
  residentialAddress: addressSchema.optional(),
  postalAddress: addressSchema.optional(),
  postalSameAsResidential: z.boolean().optional(),
  businessName: z.string().max(150).optional(),
  companyRegistrationNumber: z.string().max(30).optional(),
  vatNumber: z.string().max(20).optional(),
  preferredLanguage: z.enum(['en', 'af', 'zu']).optional(),
  timezone: z.string().max(80).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Timezone must be a valid IANA timezone.').optional(),
  notifications: z.object({ email: z.boolean().optional(), contractUpdates: z.boolean().optional() }).strict().optional(),
  email: z.string().email().max(254).optional()
}).strict();

function normalizePhone(phone) {
  if (!phone) return '';
  const value = phone.replace(/[\s()-]/g, '');
  if (/^0[1-8]\d{8}$/.test(value)) return `+27${value.slice(1)}`;
  if (/^27[1-8]\d{8}$/.test(value)) return `+${value}`;
  if (/^\+27[1-8]\d{8}$/.test(value)) return value;
  throw new AppError(400, 'Phone numbers must be valid South African numbers.');
}

function profileResponse(user) {
  return {
    id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email,
    pendingEmail: user.pendingEmail, role: user.role, emailVerified: user.emailVerified,
    idNumber: user.maskedIdNumber,
    dateOfBirth: user.dateOfBirth, gender: user.gender, mobile: user.mobile,
    alternatePhone: user.alternatePhone, residentialAddress: user.residentialAddress,
    postalAddress: user.postalAddress, postalSameAsResidential: user.postalSameAsResidential,
    businessName: user.businessName, companyRegistrationNumber: user.companyRegistrationNumber,
    vatNumber: user.vatNumber, preferredLanguage: user.preferredLanguage,
    timezone: user.timezone, notifications: user.notifications
  };
}

router.get('/confirm-email', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const user = await User.findOne({ pendingEmailTokenHash: hashToken(token), pendingEmailExpiresAt: { $gt: new Date() } });
  if (!user || !user.pendingEmail) throw new AppError(400, 'This email confirmation link is invalid or expired.');
  user.email = user.pendingEmail;
  user.pendingEmail = undefined;
  user.pendingEmailTokenHash = undefined;
  user.pendingEmailExpiresAt = undefined;
  user.emailVerified = true;
  await user.save();
  await writeAudit({ actor: user._id, action: 'profile.email_changed', targetType: 'user', targetId: String(user._id), fields: ['email'], ipAddress: req.ip });
  res.send('<!doctype html><html><body><h1>Email address updated</h1><p>Your email address is now active. You may close this page.</p></body></html>');
}));

router.use(authenticate);

router.get('/me', (req, res) => res.json({ user: profileResponse(req.user) }));

router.patch('/me', asyncHandler(async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  const data = parsed.data;
  const fields = Object.keys(data);
  let emailChange;
  if (data.email && data.email.toLowerCase() !== req.user.email) {
    const pending = data.email.toLowerCase();
    if (await User.exists({ email: pending })) throw new AppError(409, 'That email address is already in use.');
    const token = randomToken();
    req.user.pendingEmail = pending;
    req.user.pendingEmailTokenHash = hashToken(token);
    req.user.pendingEmailExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    emailChange = { pending, old: req.user.email, token };
  }
  for (const [field, value] of Object.entries(data)) {
    if (field === 'email') continue;
    if (field === 'mobile' || field === 'alternatePhone') req.user[field] = normalizePhone(value);
    else req.user[field] = value;
  }
  await req.user.save();
  await writeAudit({ actor: req.user._id, action: 'profile.updated', targetType: 'user', targetId: String(req.user._id), fields, ipAddress: req.ip });
  if (emailChange) {
    const link = `${config.apiUrl}/api/users/confirm-email?token=${encodeURIComponent(emailChange.token)}`;
    await sendEmail({ to: emailChange.pending, subject: 'Confirm your new email address', html: emailHtml('Confirm this address to update your Contracts ZAR account.', link), text: `Confirm your email: ${link}` });
    await sendEmail({ to: emailChange.old, subject: 'Email change requested', html: '<p>A request was made to change the email address on your account.</p>', text: 'A request was made to change the email address on your account.' });
  }
  res.json({ user: profileResponse(req.user), message: emailChange ? 'Profile updated. Confirm the new email address to activate it.' : 'Profile updated.' });
}));

router.patch('/me/password', asyncHandler(async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().max(128), newPassword: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'Provide your current password and a new password of at least 10 characters.');
  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!await user.comparePassword(parsed.data.currentPassword)) throw new AppError(400, 'Current password is incorrect.');
  await user.setPassword(parsed.data.newPassword);
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await writeAudit({ actor: user._id, action: 'profile.password_changed', targetType: 'user', targetId: String(user._id), ipAddress: req.ip });
  await sendEmail({
    to: user.email, subject: 'Your Contracts ZAR password was changed',
    html: '<p>Your Contracts ZAR password was changed. If you did not make this change, contact support immediately.</p>',
    text: 'Your Contracts ZAR password was changed. If you did not make this change, contact support immediately.'
  });
  res.json({ message: 'Password changed. Please sign in again.' });
}));

router.get('/me/sessions', asyncHandler(async (req, res) => {
  const sessions = await RefreshToken.find({ user: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select('createdAt expiresAt userAgent ipAddress').sort({ createdAt: -1 }).lean();
  res.json({ sessions: sessions.map((session) => ({ id: String(session._id), createdAt: session.createdAt, expiresAt: session.expiresAt, userAgent: session.userAgent, ipAddress: session.ipAddress })) });
}));

router.delete('/me/sessions/:id', asyncHandler(async (req, res) => {
  const result = await RefreshToken.updateOne({ _id: req.params.id, user: req.user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!result.modifiedCount) throw new AppError(404, 'Session not found.');
  res.json({ message: 'Session revoked.' });
}));

router.post('/me/correction-requests', requireRole('user', 'admin'), asyncHandler(async (req, res) => {
  const allowed = ['firstName', 'lastName', 'idNumber'];
  const changes = req.body.requestedChanges;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some((field) => !allowed.includes(field))) {
    throw new AppError(400, 'Correction requests may include first name, last name, or ID number only.');
  }
  if (!Object.keys(changes).length) throw new AppError(400, 'Provide at least one requested correction.');
  if (changes.firstName && (typeof changes.firstName !== 'string' || changes.firstName.trim().length > 80)) throw new AppError(400, 'First name must be 80 characters or fewer.');
  if (changes.lastName && (typeof changes.lastName !== 'string' || changes.lastName.trim().length > 80)) throw new AppError(400, 'Last name must be 80 characters or fewer.');
  if (Object.hasOwn(changes, 'firstName') && (typeof changes.firstName !== 'string' || !changes.firstName.trim() || changes.firstName.trim().length > 80)) throw new AppError(400, 'Provide a valid corrected first name.');
  if (Object.hasOwn(changes, 'lastName') && (typeof changes.lastName !== 'string' || !changes.lastName.trim() || changes.lastName.trim().length > 80)) throw new AppError(400, 'Provide a valid corrected surname.');
  if (Object.hasOwn(changes, 'idNumber') && (typeof changes.idNumber !== 'string' || !/^\d{13}$/.test(changes.idNumber))) throw new AppError(400, 'Provide a 13-digit corrected ID number.');
  if (changes.idNumber && !validateSAId(changes.idNumber).valid) throw new AppError(400, 'The requested ID number is invalid.');
  const reason = z.string().trim().min(5).max(1000).safeParse(req.body.reason);
  if (!reason.success) throw new AppError(400, 'A reason of at least 5 characters is required.');
  const requestedChanges = {};
  for (const field of ['firstName', 'lastName']) {
    if (Object.hasOwn(changes, field)) requestedChanges[field] = changes[field].trim();
  }
  const request = await CorrectionRequest.create({
    user: req.user._id,
    requestedChanges,
    requestedFields: Object.keys(changes),
    encryptedRequestedIdNumber: changes.idNumber ? encryptId(changes.idNumber) : undefined,
    maskedRequestedIdNumber: changes.idNumber ? maskId(changes.idNumber) : undefined,
    reason: reason.data
  });
  await writeAudit({ actor: req.user._id, action: 'profile.correction_requested', targetType: 'correctionRequest', targetId: String(request._id), fields: Object.keys(changes), ipAddress: req.ip });
  res.status(201).json({ request: { id: String(request._id), status: request.status } });
}));

module.exports = router;
