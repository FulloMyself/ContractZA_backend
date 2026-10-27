'use strict';

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  action: { type: String, required: true, index: true },
  targetType: { type: String, default: '' },
  targetId: { type: String, default: '' },
  fields: { type: [String], default: [] },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  ipAddress: { type: String, maxlength: 64 }
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);
