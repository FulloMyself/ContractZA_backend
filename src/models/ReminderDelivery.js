'use strict';

const mongoose = require('mongoose');

const reminderDeliverySchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  reminderKey: { type: String, required: true },
  reminderType: { type: String, enum: ['signing', 'signing_overdue', 'renewal'], required: true },
  recipientEmail: { type: String, required: true, lowercase: true },
  scheduledFor: { type: Date, required: true },
  status: { type: String, enum: ['sending', 'sent', 'failed'], required: true },
  attempts: { type: Number, default: 0 },
  lockedAt: Date,
  nextAttemptAt: Date,
  sentAt: Date,
  lastError: { type: String, maxlength: 500 }
}, { timestamps: true });

reminderDeliverySchema.index({ reminderKey: 1 }, { unique: true });
reminderDeliverySchema.index({ status: 1, nextAttemptAt: 1, lockedAt: 1 });

module.exports = mongoose.model('ReminderDelivery', reminderDeliverySchema);
