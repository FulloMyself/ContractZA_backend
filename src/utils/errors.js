'use strict';

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { AppError, asyncHandler };
