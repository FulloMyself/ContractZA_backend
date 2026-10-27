'use strict';

const mongoose = require('mongoose');

const signatureSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, lowercase: true },
  imageData: { type: String, required: true },
  signedAt: { type: Date, required: true },
  ipAddress: { type: String, required: true },
  userAgent: { type: String, required: true },
  documentHash: { type: String, required: true }
}, { _id: false });

const contractSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  body: { type: String, required: true, maxlength: 100000 },
  template: { type: String, enum: ['custom', 'service-agreement', 'nda', 'freelance-agreement'], default: 'custom' },
  status: { type: String, enum: ['draft', 'pending', 'signed', 'declined', 'expired', 'cancelled'], default: 'draft', index: true },
  parties: [{
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    role: { type: String, enum: ['owner', 'counterparty'], default: 'counterparty' },
    signingTokenHash: String,
    signingExpiresAt: Date,
    signedAt: Date,
    declinedAt: Date
  }],
  signatures: { type: [signatureSchema], default: [] },
  bodyHash: String,
  signedAt: Date
}, { timestamps: true });

contractSchema.index({ owner: 1, updatedAt: -1 });
module.exports = mongoose.model('Contract', contractSchema);
