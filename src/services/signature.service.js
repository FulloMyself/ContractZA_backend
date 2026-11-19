'use strict';

const Contract = require('../models/Contract');
const { AppError } = require('../utils/errors');
const { documentHash } = require('../utils/signature');
const { writeAudit } = require('./audit.service');
const { sendSignatureConfirmation } = require('./email');

async function signCounterparty({ contract, request, name, signature, partyMatch }) {
  const bodyHash = documentHash(contract.body);
  if (!contract.bodyHash || contract.bodyHash !== bodyHash) {
    throw new AppError(409, 'The contract changed after the invitation was sent. Ask the owner to send a new invitation.');
  }

  const signedAt = new Date();
  const signedContract = await Contract.findOneAndUpdate({
    _id: contract._id,
    status: 'pending',
    parties: {
      $elemMatch: {
        ...partyMatch,
        signedAt: { $exists: false },
        declinedAt: { $exists: false },
        signingTokenHash: { $exists: true },
        signingExpiresAt: { $gt: signedAt }
      }
    }
  }, {
    $unset: { 'parties.$.signingTokenHash': 1 },
    $set: { 'parties.$.signedAt': signedAt },
    $push: {
      signatures: {
        name,
        email: request.user.email,
        imageData: signature,
        signedAt,
        ipAddress: request.ip,
        userAgent: request.get('user-agent') || '',
        documentHash: bodyHash
      }
    }
  }, { new: true });
  if (!signedContract) throw new AppError(404, 'This signing link is invalid, expired, or already used.');

  const otherSigners = signedContract.parties.filter((party) => party.role === 'counterparty');
  const ownerSigned = signedContract.parties.find((party) => party.role === 'owner')?.signedAt;
  if (otherSigners.length && otherSigners.every((party) => party.signedAt) && ownerSigned) {
    const completedAt = new Date();
    await Contract.updateOne({ _id: signedContract._id, status: 'pending' }, { $set: { status: 'signed', signedAt: completedAt } });
    signedContract.status = 'signed';
    signedContract.signedAt = completedAt;
    await sendSignatureConfirmation(signedContract);
  }

  await writeAudit({
    actor: request.user._id,
    action: 'contract.counterparty_signed',
    targetType: 'contract',
    targetId: String(signedContract._id),
    fields: ['signature', 'status'],
    ipAddress: request.ip
  });
  return signedContract;
}

module.exports = { signCounterparty };
