'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const Contract = require('../models/Contract');
const { asyncHandler, AppError } = require('../utils/errors');
const { hashToken } = require('../utils/crypto');
const { writeAudit } = require('../services/audit.service');
const { sendSignatureConfirmation } = require('../services/email');

const router = express.Router();
function hashBody(body) {
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

router.get('/:token', asyncHandler(async (req, res) => {
  const hash = hashToken(req.params.token);
  const contract = await Contract.findOne({ 'parties.signingTokenHash': hash, status: 'pending' });
  const party = contract?.parties.find((item) => item.signingTokenHash === hash);
  if (!contract || !party || party.signedAt || party.declinedAt || !party.signingExpiresAt || party.signingExpiresAt <= new Date()) {
    throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  }
  if (!contract.bodyHash || contract.bodyHash !== hashBody(contract.body)) {
    throw new AppError(409, 'The contract document no longer matches its signing invitation. Ask the owner to send a new invitation.');
  }
  res.json({ contract: { id: contract.id, title: contract.title, body: contract.body, status: contract.status, signerName: party.name, signerEmail: party.email } });
}));

router.post('/:token', asyncHandler(async (req, res) => {
  const parsed = z.object({
    action: z.enum(['sign', 'decline']),
    name: z.string().trim().min(1).max(160),
    signature: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success || (parsed.data.action === 'sign' && !signatureImage(parsed.data.signature))) {
    throw new AppError(400, 'Provide your name and a valid PNG signature, or decline the agreement.');
  }
  const hash = hashToken(req.params.token);
  const contract = await Contract.findOne({ 'parties.signingTokenHash': hash, status: 'pending' });
  const party = contract?.parties.find((item) => item.signingTokenHash === hash);
  if (!contract || !party || party.signedAt || party.declinedAt || !party.signingExpiresAt || party.signingExpiresAt <= new Date()) {
    throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  }
  const bodyHash = hashBody(contract.body);
  if (parsed.data.action === 'sign' && (!contract.bodyHash || contract.bodyHash !== bodyHash)) {
    throw new AppError(409, 'The contract changed after the invitation was sent. Ask the owner to send a new invitation.');
  }
  const signedAt = new Date();
  const signingUpdate = parsed.data.action === 'decline'
    ? {
      $unset: { 'parties.$.signingTokenHash': 1 },
      $set: { 'parties.$.declinedAt': signedAt, status: 'declined' }
    }
    : {
      $unset: { 'parties.$.signingTokenHash': 1 },
      $set: { 'parties.$.signedAt': signedAt, bodyHash },
      $push: {
        signatures: {
          name: parsed.data.name, email: party.email, imageData: parsed.data.signature,
          signedAt, ipAddress: req.ip, userAgent: req.get('user-agent') || '', documentHash: bodyHash
        }
      }
    };
  const signedContract = await Contract.findOneAndUpdate({
    _id: contract._id,
    status: 'pending',
    parties: { $elemMatch: { signingTokenHash: hash, signedAt: { $exists: false }, declinedAt: { $exists: false }, signingExpiresAt: { $gt: new Date() } } }
  }, signingUpdate, { new: true });
  if (!signedContract) throw new AppError(404, 'This signing link is invalid, expired, or already used.');
  if (parsed.data.action === 'decline') {
    await Contract.updateOne({ _id: signedContract._id }, { $unset: { 'parties.$[].signingTokenHash': 1 } });
    await writeAudit({ action: 'contract.declined', targetType: 'contract', targetId: String(signedContract._id), fields: ['status'], ipAddress: req.ip });
  } else {
    const otherSigners = signedContract.parties.filter((item) => item.role === 'counterparty');
    const ownerSigned = signedContract.parties.find((item) => item.role === 'owner')?.signedAt;
    if (otherSigners.length && otherSigners.every((item) => item.signedAt) && ownerSigned) {
      const completedAt = new Date();
      await Contract.updateOne({ _id: signedContract._id, status: 'pending' }, { $set: { status: 'signed', signedAt: completedAt } });
      signedContract.status = 'signed';
      signedContract.signedAt = completedAt;
      await sendSignatureConfirmation(signedContract);
    }
    await writeAudit({ action: 'contract.counterparty_signed', targetType: 'contract', targetId: String(signedContract._id), fields: ['signature', 'status'], ipAddress: req.ip });
  }
  res.json({ message: parsed.data.action === 'sign' ? 'Contract signed successfully.' : 'You declined this contract.' });
}));

module.exports = router;
