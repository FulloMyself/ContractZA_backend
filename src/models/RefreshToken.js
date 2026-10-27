'use strict';

const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  family: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: Date,
  replacedByHash: String,
  userAgent: { type: String, maxlength: 300 },
  ipAddress: { type: String, maxlength: 64 }
}, { timestamps: true });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
