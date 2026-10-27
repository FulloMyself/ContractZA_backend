'use strict';

const mongoose = require('mongoose');

const correctionRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requestedChanges: { type: mongoose.Schema.Types.Mixed, required: true },
  requestedFields: { type: [String], required: true },
  encryptedRequestedIdNumber: { type: String, select: false },
  maskedRequestedIdNumber: String,
  reason: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, maxlength: 1000 }
}, { timestamps: true });

module.exports = mongoose.model('CorrectionRequest', correctionRequestSchema);
