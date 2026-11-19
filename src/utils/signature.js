'use strict';

const crypto = require('node:crypto');

function documentHash(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function signatureImage(value) {
  if (typeof value !== 'string' || value.length > 300000) return false;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(value);
  if (!match) return false;
  const image = Buffer.from(match[1], 'base64');
  return image.length >= 24 && image.length <= 200 * 1024
    && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && image.toString('ascii', 12, 16) === 'IHDR';
}

module.exports = { documentHash, signatureImage };
