'use strict';

const { AppError } = require('../utils/errors');

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new AppError(400, result.error.issues.map((issue) => issue.message).join(' ')));
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
