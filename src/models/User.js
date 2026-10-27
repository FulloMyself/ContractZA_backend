'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const addressSchema = new mongoose.Schema({
  street: { type: String, maxlength: 150, default: '' },
  unit: { type: String, maxlength: 100, default: '' },
  suburb: { type: String, maxlength: 100, default: '' },
  city: { type: String, maxlength: 100, default: '' },
  province: { type: String, default: '' },
  postalCode: { type: String, match: /^\d{4}$/, default: '' }
}, { _id: false });

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true, maxlength: 80 },
  lastName: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  pendingEmail: { type: String, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user', immutable: true },
  emailVerified: { type: Boolean, default: false },
  verificationTokenHash: String,
  verificationExpiresAt: Date,
  resetTokenHash: String,
  resetExpiresAt: Date,
  pendingEmailTokenHash: String,
  pendingEmailExpiresAt: Date,
  encryptedIdNumber: { type: String, required: true, select: false },
  maskedIdNumber: { type: String, required: true },
  idNumberHash: { type: String, required: true, unique: true, select: false },
  dateOfBirth: { type: Date, required: true },
  gender: { type: String, enum: ['male', 'female'] },
  mobile: { type: String, default: '' },
  alternatePhone: { type: String, default: '' },
  residentialAddress: { type: addressSchema, default: () => ({}) },
  postalAddress: { type: addressSchema, default: () => ({}) },
  postalSameAsResidential: { type: Boolean, default: true },
  businessName: { type: String, maxlength: 150, default: '' },
  companyRegistrationNumber: { type: String, maxlength: 30, default: '' },
  vatNumber: { type: String, maxlength: 20, default: '' },
  preferredLanguage: { type: String, enum: ['en', 'af', 'zu'], default: 'en' },
  timezone: { type: String, default: 'Africa/Johannesburg' },
  notifications: {
    email: { type: Boolean, default: true },
    contractUpdates: { type: Boolean, default: true }
  },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date
}, { timestamps: true });

userSchema.methods.setPassword = async function setPassword(password) {
  this.passwordHash = await bcrypt.hash(password, 12);
};
userSchema.methods.comparePassword = function comparePassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};

module.exports = mongoose.model('User', userSchema);
