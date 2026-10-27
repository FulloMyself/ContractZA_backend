'use strict';

const User = require('../models/User');
const { verifyAccessToken } = require('../utils/tokens');
const { asyncHandler, AppError } = require('../utils/errors');

const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw new AppError(401, 'Authentication required.');
  let claims;
  try {
    claims = verifyAccessToken(header.slice(7));
  } catch {
    throw new AppError(401, 'Session expired. Please sign in again.');
  }
  const user = await User.findById(claims.sub);
  if (!user || user.status !== 'active') throw new AppError(401, 'Authentication required.');
  req.user = user;
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new AppError(403, 'You do not have permission to do that.'));
    next();
  };
}

module.exports = { authenticate, requireRole };
