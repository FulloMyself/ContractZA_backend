'use strict';

const express = require('express');
const { z } = require('zod');
const Contract = require('../models/Contract');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../utils/errors');
const { hashToken } = require('../utils/crypto');
const { writeAudit } = require('../services/audit.service');
const { signCounterparty } = require('../services/signature.service');
const { documentHash, signatureImage } = require('../utils/signature');

const router = express.Router();

router.get('/:token', asyncHandler(async (req, res) => {
  const hash = hashToken(req.params.token);
  const contract = await Contract.findOne({ 'parties.signingTokenHash': hash, status: 'pending' });
  const party = contract?.parties.find((item) => item.signingTokenHash === hash);
  if (!contract || !party || party.role !== 'counterparty' || party.signedAt || party.declinedAt || !party.signingExpiresAt || party.signingExpiresAt <= new Date()) {
    throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  }
  if (!contract.bodyHash || contract.bodyHash !== documentHash(contract.body)) {
    throw new AppError(409, 'The contract document no longer matches its signing invitation. Ask the owner to send a new invitation.');
  }
  res.json({ contract: { id: contract.id, title: contract.title, body: contract.body, status: contract.status, signerName: party.name, signerEmail: party.email } });
}));

router.post('/:token', asyncHandler(async (req, res) => {
  if (req.body?.action === 'sign') throw new AppError(401, 'Create an account, verify your invited email address and sign in before signing.');
  const parsed = z.object({
    action: z.literal('decline'),
    name: z.string().trim().min(1).max(160)
  }).safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'A name is required to decline the agreement.');
  const hash = hashToken(req.params.token);
  const contract = await Contract.findOne({ 'parties.signingTokenHash': hash, status: 'pending' });
  const party = contract?.parties.find((item) => item.signingTokenHash === hash);
  if (!contract || !party || party.role !== 'counterparty' || party.signedAt || party.declinedAt || !party.signingExpiresAt || party.signingExpiresAt <= new Date()) {
    throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  }
  const signedAt = new Date();
  const signedContract = await Contract.findOneAndUpdate({
    _id: contract._id,
    status: 'pending',
    parties: { $elemMatch: { signingTokenHash: hash, signedAt: { $exists: false }, declinedAt: { $exists: false }, signingExpiresAt: { $gt: new Date() } } }
  }, {
    $unset: { 'parties.$.signingTokenHash': 1 },
    $set: { 'parties.$.declinedAt': signedAt, status: 'declined' }
  }, { new: true });
  if (!signedContract) throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  await Contract.updateOne({ _id: signedContract._id }, { $unset: { 'parties.$[].signingTokenHash': 1 } });
  await writeAudit({ action: 'contract.declined', targetType: 'contract', targetId: String(signedContract._id), fields: ['status'], ipAddress: req.ip });
  res.json({ message: 'You declined this contract.' });
}));

router.post('/:token/sign', authenticate, requireRole('user'), asyncHandler(async (req, res) => {
  if (!req.user.emailVerified) throw new AppError(403, 'Verify your email address before signing contracts.');
  const parsed = z.object({
    name: z.string().trim().min(1).max(160),
    signature: z.string()
  }).safeParse(req.body);
  if (!parsed.success || !signatureImage(parsed.data.signature)) throw new AppError(400, 'A valid PNG signature and your name are required.');

  const hash = hashToken(req.params.token);
  const contract = await Contract.findOne({ 'parties.signingTokenHash': hash, status: 'pending' });
  const party = contract?.parties.find((item) => item.signingTokenHash === hash);
  if (!contract || !party || party.role !== 'counterparty' || party.signedAt || party.declinedAt || !party.signingExpiresAt || party.signingExpiresAt <= new Date()) {
    throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  }
  if (party.email !== req.user.email) throw new AppError(403, 'Sign in with the email address that received this invitation.');

  const signedContract = await signCounterparty({
    contract,
    request: req,
    name: parsed.data.name,
    signature: parsed.data.signature,
    partyMatch: { signingTokenHash: hash, role: 'counterparty' }
  });
  res.json({ message: 'Contract signed successfully.', contract: { id: signedContract.id, status: signedContract.status } });
}));

module.exports = router;
