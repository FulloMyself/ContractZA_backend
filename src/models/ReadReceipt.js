'use strict';

const mongoose = require('mongoose');

const readReceiptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  resourceType: { type: String, enum: ['contract', 'complaint'], required: true },
  resourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  seenUpdatedAt: { type: Date, required: true }
}, { timestamps: true });

readReceiptSchema.index({ user: 1, resourceType: 1, resourceId: 1 }, { unique: true });

module.exports = mongoose.model('ReadReceipt', readReceiptSchema);
