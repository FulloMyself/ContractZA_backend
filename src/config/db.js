'use strict';

const mongoose = require('mongoose');
const config = require('./env');

async function connectDatabase() {
  await mongoose.connect(config.mongoUri);
  console.log('Connected to MongoDB');
}

module.exports = connectDatabase;
