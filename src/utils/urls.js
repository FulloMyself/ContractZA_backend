'use strict';

const config = require('../config/env');

function clientPage(path) {
  return `${config.clientUrl}${config.clientBasePath}/#/${path}`;
}

module.exports = { clientPage };
