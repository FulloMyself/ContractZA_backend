'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const Contract = require('../models/Contract');
const { authenticate, requireRole } = require('../middleware/auth');
const { objectIdParam } = require('../middleware/objectIdParam');
const { asyncHandler, AppError } = require('../utils/errors');
const { randomToken, hashToken } = require('../utils/crypto');
const { writeAudit } = require('../services/audit.service');
const { sendEmail, emailHtml, sendSignatureConfirmation } = require('../services/email');
const { contractPdf } = require('../services/pdf.service');
const { clientPage } = require('../utils/urls');
const config = require('../config/env');

const router = express.Router();
router.param('id', objectIdParam);
const contractInput = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(100000),
  template: z.enum(['custom', 'service-agreement', 'nda', 'freelance-agreement']).optional()
}).strict();
const emailSchema = z.string().email().max(254).transform((value) => value.toLowerCase().trim());

function documentHash(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function signatureImage(value) {
  if (typeof value !== 'string' || value.length > 300000) return false;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(value);
  if (!match) return false;
  const image = Buffer.from(match[1], 'base64');
  return image.length >= 24 && image.length <= 200 * 1024
    && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && image.toString('ascii', 12, 16) === 'IHDR';
}

function safeContract(contract, owner = false) {
  const result = contract.toObject ? contract.toObject() : contract;
  delete result.__v;
  result.parties = result.parties.map(({ signingTokenHash, ...party }) => owner
    ? party
    : (({ name, email, role, signedAt }) => ({ name, email, role, signedAt }))(party));
  if (!owner) {
    result.signatures = result.signatures.map(({ name, email, signedAt }) => ({ name, email, signedAt }));
  }
  return result;
}

async function expireStaleInvitations(owner) {
  const contracts = await Contract.find({ owner, status: 'pending', 'parties.role': 'counterparty' });
  const now = new Date();
  for (const contract of contracts) {
    const unsigned = contract.parties.filter((party) => party.role === 'counterparty' && !party.signedAt && !party.declinedAt);
    if (unsigned.length && unsigned.every((party) => !party.signingExpiresAt || party.signingExpiresAt <= now)) {
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
  const [counts, recent, pending] = await Promise.all([
    Contract.aggregate([{ $match: { owner: req.user._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Contract.find({ owner: req.user._id }).sort({ updatedAt: -1 }).limit(5).select('title status updatedAt').lean(),
    Contract.countDocuments({ owner: req.user._id, status: 'pending' })
  ]);
  res.json({ stats: Object.fromEntries(counts.map(({ _id, count }) => [_id, count])), pendingSignatures: pending, recent });
}));

router.get('/', asyncHandler(async (req, res) => {
  await expireStaleInvitations(req.user._id);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
  const filter = { owner: req.user._id };
  if (['draft', 'pending', 'signed', 'declined', 'expired', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.search) filter.title = { $regex: String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [items, total] = await Promise.all([
    Contract.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).select('-body -signatures -parties.signingTokenHash'),
    Contract.countDocuments(filter)
  ]);
  res.json({ contracts: items, page, limit, total, pages: Math.ceil(total / limit) });
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
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
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
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  res.json({ contract: safeContract(contract, true) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = contractInput.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (contract.status !== 'draft' || contract.signatures.length) throw new AppError(409, 'Only unsigned draft contracts can be edited.');
  Object.assign(contract, parsed.data);
  await contract.save();
  await writeAudit({ actor: req.user._id, action: 'contract.updated', targetType: 'contract', targetId: String(contract._id), fields: Object.keys(parsed.data), ipAddress: req.ip });
  res.json({ contract: safeContract(contract, true) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const contract = await Contract.findOne({ _id: req.params.id, owner: req.user._id });
  if (!contract) throw new AppError(404, 'Contract not found.');
  if (!['draft', 'cancelled'].includes(contract.status)) throw new AppError(409, 'Only draft or cancelled contracts can be deleted.');
  await contract.deleteOne();
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
    party = { name: parsed.data.name, email: parsed.data.email, role: 'counterparty' };
    contract.parties.push(party);
  }
  party.name = parsed.data.name;
  const token = randomToken();
  party.signingTokenHash = hashToken(token);
  party.signingExpiresAt = new Date(Date.now() + config.signingDays * 24 * 60 * 60 * 1000);
  contract.bodyHash = documentHash(contract.body);
  contract.status = 'pending';
  await contract.save();
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
  await writeAudit({ actor: req.user._id, action: 'contract.owner_signed', targetType: 'contract', targetId: String(contract._id), ipAddress: req.ip });
  res.json({ contract: safeContract(signedContract, true) });
}));

module.exports = router;
