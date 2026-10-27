'use strict';

const { AppError } = require('../utils/errors');

function objectIdParam(req, res, next, value) {
  if (!/^[a-f0-9]{24}$/i.test(value)) return next(new AppError(400, 'Invalid record identifier.'));
  return next();
}

module.exports = { objectIdParam };
