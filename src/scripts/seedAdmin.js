'use strict';

const connectDatabase = require('../config/db');
const User = require('../models/User');
const { validateSAId } = require('../utils/saId');
const { encryptId, hashId, maskId } = require('../utils/crypto');

async function seedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME, ADMIN_LAST_NAME, ADMIN_ID_NUMBER } = process.env;
  if (![ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME, ADMIN_LAST_NAME, ADMIN_ID_NUMBER].every(Boolean)) {
    throw new Error('All ADMIN_* variables are required.');
  }
  if (ADMIN_PASSWORD.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  const id = validateSAId(ADMIN_ID_NUMBER);
  if (!id.valid) throw new Error(`ADMIN_ID_NUMBER is invalid: ${id.reason}`);
  await connectDatabase();
  if (await User.exists({ role: 'admin' })) throw new Error('An administrator account already exists; refusing to seed another.');
  const user = new User({
    firstName: ADMIN_FIRST_NAME,
    lastName: ADMIN_LAST_NAME,
    email: ADMIN_EMAIL.toLowerCase(),
    role: 'admin',
    emailVerified: true,
    encryptedIdNumber: encryptId(ADMIN_ID_NUMBER),
    maskedIdNumber: maskId(ADMIN_ID_NUMBER),
    idNumberHash: hashId(ADMIN_ID_NUMBER),
    dateOfBirth: id.dateOfBirth,
    gender: id.gender
  });
  await user.setPassword(ADMIN_PASSWORD);
  await user.save();
  console.log(`Administrator seeded: ${user.email}`);
  await require('mongoose').disconnect();
}

seedAdmin().catch(async (error) => {
  console.error('Administrator seed failed:', error.message);
  await require('mongoose').disconnect();
  process.exitCode = 1;
});
