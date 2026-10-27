'use strict';

const express = require('express');
const { z } = require('zod');
const User = require('../models/User');
const Contract = require('../models/Contract');
const AuditLog = require('../models/AuditLog');
const RefreshToken = require('../models/RefreshToken');
const CorrectionRequest = require('../models/CorrectionRequest');
const { authenticate, requireRole } = require('../middleware/auth');
const { objectIdParam } = require('../middleware/objectIdParam');
const { asyncHandler, AppError } = require('../utils/errors');
const { writeAudit } = require('../services/audit.service');
const { validateSAId } = require('../utils/saId');
const { encryptId, decryptId, hashId, maskId } = require('../utils/crypto');
const { sendEmail } = require('../services/email');

const router = express.Router();
router.param('id', objectIdParam);
router.use(authenticate, requireRole('admin'));

router.get('/stats', asyncHandler(async (req, res) => {
  const [users, contracts, pendingCorrections, recentActivity] = await Promise.all([
    User.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Contract.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    CorrectionRequest.countDocuments({ status: 'pending' }),
    AuditLog.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
  ]);
  res.json({
    users: Object.fromEntries(users.map(({ _id, count }) => [_id, count])),
    contracts: Object.fromEntries(contracts.map(({ _id, count }) => [_id, count])),
    pendingCorrections, recentActivity
  });
}));

router.get('/users', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const filter = {};
  if (['active', 'suspended'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.search) {
    const safeSearch = String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ email: { $regex: safeSearch, $options: 'i' } }, { firstName: { $regex: safeSearch, $options: 'i' } }, { lastName: { $regex: safeSearch, $options: 'i' } }];
  }
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .select('firstName lastName email role status emailVerified createdAt lastLoginAt').lean(),
    User.countDocuments(filter)
  ]);
  res.json({ users, page, limit, total, pages: Math.ceil(total / limit) });
}));

router.patch('/users/:id/status', asyncHandler(async (req, res) => {
  const parsed = z.object({ status: z.enum(['active', 'suspended']) }).safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'Status must be active or suspended.');
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError(404, 'User not found.');
  if (user.role === 'admin' && user.id === req.user.id) throw new AppError(400, 'You cannot change your own account status.');
  user.status = parsed.data.status;
  await user.save();
  if (user.status === 'suspended') await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await writeAudit({ actor: req.user._id, action: `admin.user_${user.status}`, targetType: 'user', targetId: String(user._id), fields: ['status'], ipAddress: req.ip });
  res.json({ message: `User ${user.status}.` });
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError(404, 'User not found.');
  if (user.id === req.user.id || user.role === 'admin') throw new AppError(400, 'Administrator accounts cannot be deleted here.');
  await writeAudit({ actor: req.user._id, action: 'admin.user_deletion_started', targetType: 'user', targetId: String(user._id), fields: ['account', 'contracts'], ipAddress: req.ip });
  await Contract.deleteMany({ owner: user._id });
  await RefreshToken.deleteMany({ user: user._id });
  await CorrectionRequest.deleteMany({ user: user._id });
  await user.deleteOne();
  await writeAudit({ actor: req.user._id, action: 'admin.user_deleted', targetType: 'user', targetId: String(user._id), fields: ['account', 'contracts'], ipAddress: req.ip });
  res.json({ message: 'User and their data deleted.' });
}));

router.get('/correction-requests', asyncHandler(async (req, res) => {
  const requests = await CorrectionRequest.find({ status: req.query.status === 'all' ? { $in: ['pending', 'approved', 'rejected'] } : 'pending' })
    .select('+encryptedRequestedIdNumber')
    .populate('user', 'firstName lastName email').sort({ createdAt: -1 }).limit(100).lean();
  res.json({ requests: requests.map((request) => ({
    ...request,
    requestedChanges: {
      ...request.requestedChanges,
      ...(request.encryptedRequestedIdNumber ? { idNumber: decryptId(request.encryptedRequestedIdNumber) } : {})
    },
    encryptedRequestedIdNumber: undefined
  })) });
}));

router.patch('/correction-requests/:id', asyncHandler(async (req, res) => {
  const parsed = z.object({ decision: z.enum(['approved', 'rejected']), reviewNote: z.string().max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'Decision must be approved or rejected.');
  const request = await CorrectionRequest.findOne({ _id: req.params.id, status: 'pending' }).select('+encryptedRequestedIdNumber');
  if (!request) throw new AppError(404, 'Pending correction request not found.');
  const user = await User.findById(request.user);
  if (!user) throw new AppError(404, 'The requester no longer exists.');
  if (parsed.data.decision === 'approved') {
    const changes = request.requestedChanges;
    if (changes.firstName) user.firstName = changes.firstName.trim();
    if (changes.lastName) user.lastName = changes.lastName.trim();
    if (request.encryptedRequestedIdNumber) {
      const idNumber = decryptId(request.encryptedRequestedIdNumber);
      const validation = validateSAId(idNumber);
      if (!validation.valid) throw new AppError(400, validation.reason);
      if (await User.exists({ idNumberHash: hashId(idNumber), _id: { $ne: user._id } })) {
        throw new AppError(409, 'That ID number is already associated with another account.');
      }
      user.idNumberHash = hashId(idNumber);
      user.encryptedIdNumber = encryptId(idNumber);
      user.maskedIdNumber = maskId(idNumber);
      user.dateOfBirth = validation.dateOfBirth;
      user.gender = validation.gender;
    }
    await user.save();
  }
  request.status = parsed.data.decision;
  request.reviewedBy = req.user._id;
  request.reviewedAt = new Date();
  request.reviewNote = parsed.data.reviewNote || '';
  await request.save();
  await writeAudit({ actor: req.user._id, action: `admin.correction_${request.status}`, targetType: 'correctionRequest', targetId: String(request._id), fields: request.requestedFields, ipAddress: req.ip });
  await sendEmail({
    to: user.email,
    subject: `Your identity correction request was ${request.status}`,
    html: `<p>Your Contracts ZAR identity correction request was ${request.status}.</p>`,
    text: `Your Contracts ZAR identity correction request was ${request.status}.`
  });
  res.json({ message: `Correction request ${request.status}.` });
}));

router.get('/audit-log', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const [entries, total] = await Promise.all([
    AuditLog.find().populate('actor', 'firstName lastName email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments()
  ]);
  res.json({ entries, page, limit, total, pages: Math.ceil(total / limit) });
}));

module.exports = router;
