'use strict';

const express = require('express');
const { z } = require('zod');
const Contract = require('../models/Contract');
const ComplaintCase = require('../models/ComplaintCase');
const { markViewed } = require('../services/readReceipts');
const { authenticate, requireRole } = require('../middleware/auth');
const { objectIdParam } = require('../middleware/objectIdParam');
const { asyncHandler, AppError } = require('../utils/errors');
const { writeAudit } = require('../services/audit.service');
const { sendComplaintCreatedNotifications } = require('../services/email');

const router = express.Router();
router.param('id', objectIdParam);
router.use(authenticate, requireRole('user'));

const categories = ['payment', 'performance', 'scope', 'communication', 'confidentiality', 'other'];
const messageInput = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
const complaintInput = z.object({
  contractId: z.string().regex(/^[a-f0-9]{24}$/i),
  respondentEmail: z.string().email().max(254).transform((email) => email.toLowerCase().trim()),
  category: z.enum(categories),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(20).max(5000)
}).strict();

function isParticipant(caseRecord, user) {
  return caseRecord.complainantEmail === user.email || caseRecord.respondentEmail === user.email;
}

function addMessage(caseRecord, user, body) {
  caseRecord.messages.push({
    author: user._id,
    authorName: `${user.firstName} ${user.lastName}`,
    authorEmail: user.email,
    authorRole: user.role,
    body
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const filter = {
    $or: [{ complainantEmail: req.user.email }, { respondentEmail: req.user.email }]
  };
  const [cases, total] = await Promise.all([
    ComplaintCase.find(filter).select('-messages').sort({ updatedAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    ComplaintCase.countDocuments(filter)
  ]);
  res.json({ cases, page, limit, total, pages: Math.ceil(total / limit) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const parsed = complaintInput.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'Provide a contract, another party, a category, a short subject and a description of at least 20 characters.');

  const contract = await Contract.findOne({
    _id: parsed.data.contractId,
    $or: [{ owner: req.user._id }, { 'parties.email': req.user.email }]
  });
  if (!contract) throw new AppError(404, 'Contract not found.');
  const complainant = contract.parties.find((party) => party.email === req.user.email);
  const respondent = contract.parties.find((party) => party.email === parsed.data.respondentEmail);
  if (!complainant || !respondent || respondent.email === complainant.email) {
    throw new AppError(400, 'Select another party listed on this contract.');
  }
  const activeCase = await ComplaintCase.exists({
    contract: contract._id,
    openedBy: req.user._id,
    status: { $in: ['submitted', 'awaiting_response', 'under_review', 'referred'] }
  });
  if (activeCase) throw new AppError(409, 'You already have an open complaint for this contract.');

  const caseRecord = new ComplaintCase({
    contract: contract._id,
    contractTitle: contract.title,
    contractStatusAtReport: contract.status,
    openedBy: req.user._id,
    complainantName: complainant.name,
    complainantEmail: complainant.email,
    respondentName: respondent.name,
    respondentEmail: respondent.email,
    category: parsed.data.category,
    subject: parsed.data.subject,
    status: 'submitted'
  });
  addMessage(caseRecord, req.user, parsed.data.description);
  try {
    await caseRecord.save();
  } catch (error) {
    if (error.code === 11000) throw new AppError(409, 'You already have an open complaint for this contract.');
    throw error;
  }
  await writeAudit({
    actor: req.user._id,
    action: 'complaint.submitted',
    targetType: 'complaintCase',
    targetId: String(caseRecord._id),
    fields: ['contract', 'category', 'status'],
    metadata: { contractId: String(contract._id) },
    ipAddress: req.ip
  });
  await markViewed(req.user, 'complaint', caseRecord);
  const notificationResult = await sendComplaintCreatedNotifications(caseRecord);
  res.status(201).json({
    case: caseRecord,
    ...(notificationResult.failedCount > 0 && { notificationWarning: 'The case was created, but some email notifications could not be sent.' })
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const caseRecord = await ComplaintCase.findById(req.params.id);
  if (!caseRecord || !isParticipant(caseRecord, req.user)) throw new AppError(404, 'Complaint case not found.');
  await markViewed(req.user, 'complaint', caseRecord);
  res.json({ case: caseRecord });
}));

router.post('/:id/messages', asyncHandler(async (req, res) => {
  const parsed = messageInput.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'A response of up to 5,000 characters is required.');
  const caseRecord = await ComplaintCase.findById(req.params.id);
  if (!caseRecord || !isParticipant(caseRecord, req.user)) throw new AppError(404, 'Complaint case not found.');
  if (caseRecord.status === 'closed') throw new AppError(409, 'This case is closed and no longer accepts responses.');
  if (caseRecord.messages.length >= 100) throw new AppError(409, 'This case has reached its response limit.');
  addMessage(caseRecord, req.user, parsed.data.body);
  await caseRecord.save();
  await markViewed(req.user, 'complaint', caseRecord);
  await writeAudit({
    actor: req.user._id,
    action: 'complaint.response_added',
    targetType: 'complaintCase',
    targetId: String(caseRecord._id),
    fields: ['response'],
    ipAddress: req.ip
  });
  res.json({ case: caseRecord });
}));

module.exports = router;
