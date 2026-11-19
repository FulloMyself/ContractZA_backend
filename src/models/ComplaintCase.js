'use strict';

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  authorName: { type: String, required: true, maxlength: 160 },
  authorEmail: { type: String, required: true, lowercase: true, maxlength: 254 },
  authorRole: { type: String, enum: ['user', 'admin'], required: true },
  body: { type: String, required: true, maxlength: 5000 },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const complaintCaseSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  contractTitle: { type: String, required: true, maxlength: 160 },
  contractStatusAtReport: { type: String, required: true },
  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  complainantName: { type: String, required: true, maxlength: 160 },
  complainantEmail: { type: String, required: true, lowercase: true, maxlength: 254 },
  respondentName: { type: String, required: true, maxlength: 160 },
  respondentEmail: { type: String, required: true, lowercase: true, maxlength: 254 },
  category: {
    type: String,
    enum: ['payment', 'performance', 'scope', 'communication', 'confidentiality', 'other'],
    required: true
  },
  subject: { type: String, required: true, trim: true, maxlength: 160 },
  status: {
    type: String,
    enum: ['submitted', 'awaiting_response', 'under_review', 'referred', 'closed'],
    default: 'submitted',
  },
  messages: {
    type: [messageSchema],
    default: [],
    validate: {
      validator: (messages) => messages.length <= 100,
      message: 'A complaint case cannot contain more than 100 messages.'
    }
  },
  statusUpdatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

complaintCaseSchema.index({ status: 1, updatedAt: -1 });
complaintCaseSchema.index({ complainantEmail: 1, updatedAt: -1 });
complaintCaseSchema.index({ respondentEmail: 1, updatedAt: -1 });
complaintCaseSchema.index(
  { contract: 1, openedBy: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['submitted', 'awaiting_response', 'under_review', 'referred'] } }
  }
);

module.exports = mongoose.model('ComplaintCase', complaintCaseSchema);
