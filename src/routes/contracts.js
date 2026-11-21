'use strict';

const express = require('express');
const { z } = require('zod');
const Contract = require('../models/Contract');
const { authenticate, requireRole } = require('../middleware/auth');
const { objectIdParam } = require('../middleware/objectIdParam');
const { asyncHandler, AppError } = require('../utils/errors');
const { randomToken, hashToken } = require('../utils/crypto');
const { writeAudit } = require('../services/audit.service');
const { sendEmail, emailHtml, sendSignatureConfirmation } = require('../services/email');
const { contractPdf } = require('../services/pdf.service');
const { signCounterparty } = require('../services/signature.service');
const { documentHash, signatureImage } = require('../utils/signature');
const { clientPage } = require('../utils/urls');
const config = require('../config/env');
const ComplaintCase = require('../models/ComplaintCase');
const ReadReceipt = require('../models/ReadReceipt');
const { markViewed, countUnread, countAwaitingResponse, ensureTrackingStartedAt } = require('../services/readReceipts');

const router = express.Router();
router.param('id', objectIdParam);
const reminderSettingsInput = z.object({
  signingDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  renewalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  remindersEnabled: z.boolean(),
  reminderDaysBefore: z.array(z.number().int().refine((value) => [1, 3, 7].includes(value))).max(3),
  overdueSigningReminderEnabled: z.boolean()
}).strict();
const contractInput = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(100000),
  template: z.enum([
    'custom', 'service-agreement', 'nda', 'freelance-agreement',
    'independent-contractor', 'employment-agreement', 'residential-lease',
    'commercial-lease', 'sale-of-goods', 'loan-agreement',
    'partnership-agreement', 'shareholders-agreement',
    'data-processing-agreement', 'settlement-agreement'
  ]).optional()
}).strict();
const emailSchema = z.string().email().max(254).transform((value) => value.toLowerCase().trim());

function parseReminderDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function safeContract(contract, owner = false) {
  const result = contract.toObject ? contract.toObject() : contract;
  delete result.__v;
  delete result.owner;
  result.isOwner = owner;
  result.parties = result.parties.map(({ signingTokenHash, ...party }) => owner
    ? party
    : (({ name, email, role, signedAt }) => ({ name, email, role, signedAt }))(party));
  if (!owner) {
    result.signatures = result.signatures.map(({ name, email, signedAt }) => ({ name, email, signedAt }));
  }
  return result;
}

function accessibleContracts(user) {
  return { $or: [{ owner: user._id }, { 'parties.email': user.email }] };
}

function isOwner(contract, user) {
  return contract.owner.equals(user._id);
}

async function expireStaleInvitations(owner) {
  const contracts = await Contract.find({ owner, status: 'pending', 'parties.role': 'counterparty' });
  const now = new Date();
  for (const contract of contracts) {
    const unsigned = contract.parties.filter((party) => party.role === 'counterparty' && !party.signedAt && !party.declinedAt);
    if (unsigned.length && unsigned.every((party) => !party.signingTokenHash || !party.signingExpiresAt || party.signingExpiresAt <= now)) {
      contract.status = 'expired';
      for (const party of unsigned) party.signingTokenHash = undefined;
      await contract.save();
      await writeAudit({ actor: owner, action: 'contract.expired', targetType: 'contract', targetId: String(contract._id), fields: ['status'] });
    }
  }
}

router.use(authenticate, requireRole('user'));

router.get('/stats', asyncHandler(async (req, res) => {
  await expireStaleInvitations(req.user._id);
  const accessFilter = accessibleContracts(req.user);
  const baseline = await ensureTrackingStartedAt(req.user);
  const complaintFilter = { $or: [{ complainantEmail: req.user.email }, { respondentEmail: req.user.email }] };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [counts, recent, pending, unreadContracts, unreadComplaints, awaitingResponseComplaints] = await Promise.all([
    Contract.aggregate([{ $match: accessFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Contract.find(accessFilter).sort({ updatedAt: -1 }).limit(5).select('title status updatedAt owner'),
    Contract.countDocuments({ ...accessFilter, status: 'pending' }),
    countUnread({ Model: Contract, user: req.user, resourceType: 'contract', filter: accessFilter, baseline }),
    countUnread({
      Model: ComplaintCase,
      user: req.user,
      resourceType: 'complaint',
      filter: complaintFilter,
      baseline
    }),
    countAwaitingResponse({ Model: ComplaintCase, user: req.user, role: 'user', filter: complaintFilter })
  ]);
  const [signatureDeadlines, renewalDeadlines] = await Promise.all([
    Contract.find({ $and: [accessFilter, { status: 'pending' }, { signingDeadline: { $gte: today } }] })
      .sort({ signingDeadline: 1 }).limit(5).select('_id title signingDeadline'),
    Contract.find({ $and: [accessFilter, { status: 'signed' }, { renewalDate: { $gte: today } }] })
      .sort({ renewalDate: 1 }).limit(5).select('_id title renewalDate')
  ]);
  const upcomingDeadlines = [
    ...signatureDeadlines.map((contract) => ({
      _id: contract._id, title: contract.title, type: 'signing', date: contract.signingDeadline
    })),
    ...renewalDeadlines.map((contract) => ({
      _id: contract._id, title: contract.title, type: 'renewal', date: contract.renewalDate
    }))
  ].sort((a, b) => a.date - b.date).slice(0, 5);
  res.json({
    stats: Object.fromEntries(counts.map(({ _id, count }) => [_id, count])),
    pendingSignatures: pending,
    unreadContracts,
    unreadComplaints,
    awaitingResponseComplaints,
    upcomingDeadlines,
    recent: recent.map((contract) => ({
      _id: contract._id,
      title: contract.title,
      status: contract.status,
      updatedAt: contract.updatedAt,
      isOwner: isOwner(contract, req.user)
    }))
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  await expireStaleInvitations(req.user._id);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
  const filter = accessibleContracts(req.user);
  if (['draft', 'pending', 'signed', 'declined', 'expired', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.search) filter.title = { $regex: String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [items, total] = await Promise.all([
    Contract.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).select('-body -signatures -parties.signingTokenHash'),
    Contract.countDocuments(filter)
  ]);
  res.json({
    contracts: items.map((contract) => {
      const result = contract.toObject();
      result.isOwner = isOwner(contract, req.user);
      delete result.owner;
      return result;
    }),
    page,
    limit,
    total,
    pages: Math.ceil(total / limit)
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const parsed = contractInput.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  const contract = await Contract.create({
    owner: req.user._id, title: parsed.data.title, body: parsed.data.body,
    template: parsed.data.template || 'custom',
    parties: [{ name: `${req.user.firstName} ${req.user.lastName}`, email: req.user.email, role: 'owner' }]
  });
  await writeAudit({ actor: req.user._id, action: 'contract.created', targetType: 'contract', targetId: String(contract._id), ipAddress: req.ip });
  res.status(201).json({ contract: safeContract(contract, true) });
}));

router.get('/:id/pdf', asyncHandler(async (req, res) => {
  const contract = await Contract.findOne({ _id: req.params.id, ...accessibleContracts(req.user) });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (contract.status !== 'signed') throw new AppError(409, 'The completion certificate is available once all parties have signed.');
  const expectedHash = documentHash(contract.body);
  if (!contract.bodyHash || contract.bodyHash !== expectedHash || contract.signatures.some((signature) => signature.documentHash !== expectedHash)) {
    await writeAudit({ actor: req.user._id, action: 'contract.tamper_detected', targetType: 'contract', targetId: String(contract._id), fields: ['bodyHash'], ipAddress: req.ip });
    throw new AppError(409, 'The contract document no longer matches its signing evidence.');
  }
  const pdf = await contractPdf(contract);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${contract.title.replace(/[^a-z0-9-_ ]/gi, '').slice(0, 80)}.pdf"` });
  res.send(pdf);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const contract = await Contract.findOne({ _id: req.params.id, ...accessibleContracts(req.user) });
  if (!contract) throw new AppError(404, 'Contract not found.');
  await markViewed(req.user, 'contract', contract);
  res.json({ contract: safeContract(contract, isOwner(contract, req.user)) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = contractInput.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (contract.status !== 'draft' || contract.signatures.length) throw new AppError(409, 'Only unsigned draft contracts can be edited.');
  Object.assign(contract, parsed.data);
  await contract.save();
  await markViewed(req.user, 'contract', contract);
  await writeAudit({ actor: req.user._id, action: 'contract.updated', targetType: 'contract', targetId: String(contract._id), fields: Object.keys(parsed.data), ipAddress: req.ip });
  res.json({ contract: safeContract(contract, true) });
}));

router.patch('/:id/reminders', asyncHandler(async (req, res) => {
  const parsed = reminderSettingsInput.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'Provide valid contract reminder settings.');
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  const signingDeadline = parseReminderDate(parsed.data.signingDeadline);
  const renewalDate = parseReminderDate(parsed.data.renewalDate);
  if (signingDeadline === undefined || renewalDate === undefined) throw new AppError(400, 'Enter valid calendar dates for the deadlines.');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if ([signingDeadline, renewalDate].some((date) => date && date < today)) {
    throw new AppError(400, 'Deadlines must be today or a future date.');
  }
  if (signingDeadline && !['draft', 'pending'].includes(contract.status)) {
    throw new AppError(409, 'A signing deadline can only be set for a draft or pending contract.');
  }
  if (renewalDate && contract.status !== 'signed') {
    throw new AppError(409, 'A renewal date can only be set after all parties have signed the contract.');
  }
  if (parsed.data.remindersEnabled && parsed.data.reminderDaysBefore.length === 0) {
    throw new AppError(400, 'Choose at least one reminder time or turn reminders off.');
  }
  if (parsed.data.reminderDaysBefore.some((day, index, days) => days.indexOf(day) !== index)) {
    throw new AppError(400, 'Reminder days must be unique.');
  }
  contract.signingDeadline = signingDeadline || undefined;
  contract.renewalDate = renewalDate || undefined;
  contract.remindersEnabled = parsed.data.remindersEnabled;
  contract.reminderDaysBefore = parsed.data.reminderDaysBefore;
  contract.overdueSigningReminderEnabled = parsed.data.overdueSigningReminderEnabled;
  await contract.save();
  await markViewed(req.user, 'contract', contract);
  await writeAudit({
    actor: req.user._id,
    action: 'contract.reminders_updated',
    targetType: 'contract',
    targetId: String(contract._id),
    fields: ['signingDeadline', 'renewalDate', 'remindersEnabled', 'reminderDaysBefore', 'overdueSigningReminderEnabled'],
    ipAddress: req.ip
  });
  res.json({ contract: safeContract(contract, true), message: 'Deadline and reminder settings saved.' });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (!['draft', 'cancelled'].includes(contract.status)) throw new AppError(409, 'Only draft or cancelled contracts can be deleted.');
  await contract.deleteOne();
  await ReadReceipt.deleteMany({ resourceType: 'contract', resourceId: contract._id });
  await writeAudit({ actor: req.user._id, action: 'contract.deleted', targetType: 'contract', targetId: String(contract._id), ipAddress: req.ip });
  res.json({ message: 'Contract deleted.' });
}));

router.post('/:id/invite', asyncHandler(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(160), email: emailSchema }).safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'A valid counterparty name and email are required.');
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (!['draft', 'pending', 'expired'].includes(contract.status)) throw new AppError(409, 'This contract cannot be sent for signature.');
  if (parsed.data.email === req.user.email) throw new AppError(400, 'Invite a counterparty using a different email address.');
  let party = contract.parties.find((item) => item.email === parsed.data.email);
  if (party && party.signedAt) throw new AppError(409, 'This counterparty has already signed.');
  if (!party) {
    contract.parties.push({ name: parsed.data.name, email: parsed.data.email, role: 'counterparty' });
    party = contract.parties[contract.parties.length - 1];
  }
  party.name = parsed.data.name;
  const token = randomToken();
  party.signingTokenHash = hashToken(token);
  party.signingExpiresAt = new Date(Date.now() + config.signingDays * 24 * 60 * 60 * 1000);
  contract.bodyHash = documentHash(contract.body);
  contract.status = 'pending';
  await contract.save();
  await markViewed(req.user, 'contract', contract);
  const link = clientPage(`sign/${encodeURIComponent(token)}`);
  await sendEmail({
    to: parsed.data.email, subject: `Signature requested: ${contract.title}`,
    html: emailHtml(`${parsed.data.name}, ${req.user.firstName} ${req.user.lastName} invited you to sign "${contract.title}".`, link, `${config.signingDays} days`),
    text: `Review and sign "${contract.title}": ${link}`
  });
  await writeAudit({ actor: req.user._id, action: 'contract.invited', targetType: 'contract', targetId: String(contract._id), fields: ['counterparty'], ipAddress: req.ip });
  res.json({ message: 'Signature invitation sent.', contract: safeContract(contract, true) });
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (!['draft', 'pending', 'expired'].includes(contract.status)) throw new AppError(409, 'This contract cannot be cancelled.');
  contract.status = 'cancelled';
  for (const party of contract.parties) party.signingTokenHash = undefined;
  await contract.save();
  await markViewed(req.user, 'contract', contract);
  await writeAudit({ actor: req.user._id, action: 'contract.cancelled', targetType: 'contract', targetId: String(contract._id), fields: ['status'], ipAddress: req.ip });
  res.json({ message: 'Contract cancelled.' });
}));

router.post('/:id/sign', asyncHandler(async (req, res) => {
  const parsed = z.object({ signature: z.string(), name: z.string().trim().min(1).max(160) }).safeParse(req.body);
  if (!parsed.success || !signatureImage(parsed.data.signature)) throw new AppError(400, 'A valid PNG signature is required.');
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (contract.status !== 'pending') throw new AppError(409, 'Invite a counterparty before signing this contract.');
  const hash = documentHash(contract.body);
  const signedAt = new Date();
  const signature = {
    name: parsed.data.name, email: req.user.email, imageData: parsed.data.signature,
    signedAt, ipAddress: req.ip, userAgent: req.get('user-agent') || '', documentHash: hash
  };
  const signedContract = await Contract.findOneAndUpdate({
    _id: contract._id,
    owner: req.user._id,
    status: 'pending',
    parties: { $elemMatch: { role: 'owner', signedAt: { $exists: false } } }
  }, {
    $set: { bodyHash: hash, 'parties.$[owner].signedAt': signedAt },
    $push: { signatures: signature }
  }, {
    new: true,
    arrayFilters: [{ 'owner.role': 'owner', 'owner.signedAt': { $exists: false } }]
  });
  if (!signedContract) throw new AppError(409, 'You have already signed this contract or it is no longer awaiting signatures.');
  const counterparties = signedContract.parties.filter((item) => item.role === 'counterparty');
  if (counterparties.length > 0 && counterparties.every((item) => item.signedAt)) {
    const completedAt = new Date();
    await Contract.updateOne({ _id: signedContract._id, status: 'pending' }, { $set: { status: 'signed', signedAt: completedAt } });
    signedContract.status = 'signed';
    signedContract.signedAt = completedAt;
    await sendSignatureConfirmation(signedContract);
  }
  const viewedContract = await Contract.findById(signedContract._id).select('_id updatedAt');
  await markViewed(req.user, 'contract', viewedContract);
  await writeAudit({ actor: req.user._id, action: 'contract.owner_signed', targetType: 'contract', targetId: String(contract._id), ipAddress: req.ip });
  res.json({ contract: safeContract(signedContract, true) });
}));

router.post('/:id/sign-as-counterparty', asyncHandler(async (req, res) => {
  if (!req.user.emailVerified) throw new AppError(403, 'Verify your email address before signing contracts.');
  const parsed = z.object({ signature: z.string(), name: z.string().trim().min(1).max(160) }).safeParse(req.body);
  if (!parsed.success || !signatureImage(parsed.data.signature)) throw new AppError(400, 'A valid PNG signature is required.');
  const contract = await Contract.findOne({
    _id: req.params.id,
    status: 'pending',
    parties: { $elemMatch: { email: req.user.email, role: 'counterparty' } }
  });
  const party = contract?.parties.find((item) => item.email === req.user.email && item.role === 'counterparty');
  if (!contract || !party || party.signedAt || party.declinedAt || !party.signingTokenHash || !party.signingExpiresAt || party.signingExpiresAt <= new Date()) {
    throw new AppError(404, 'This contract is not awaiting your signature.');
  }
  const signedContract = await signCounterparty({
    contract,
    request: req,
    name: parsed.data.name,
    signature: parsed.data.signature,
    partyMatch: { email: req.user.email, role: 'counterparty' }
  });
  res.json({ contract: safeContract(signedContract, false) });
}));

module.exports = router;
