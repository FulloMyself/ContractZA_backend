'use strict';

const AuditLog = require('../models/AuditLog');

async function writeAudit({ actor, action, targetType = '', targetId = '', fields = [], metadata = {}, ipAddress }) {
  return AuditLog.create({ actor: actor || null, action, targetType, targetId, fields, metadata, ipAddress });
}

module.exports = { writeAudit };
