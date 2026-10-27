'use strict';

function notFound(req, res) {
  res.status(404).json({ error: 'Route not found.' });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.code === 11000) return res.status(409).json({ error: 'An account or record with those details already exists.' });
  if (error.name === 'ValidationError') return res.status(400).json({ error: 'The submitted data is invalid.' });
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'An unexpected server error occurred.' : error.message });
}

module.exports = { notFound, errorHandler };
