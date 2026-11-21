'use strict';

const Contract = require('../models/Contract');
const ReminderDelivery = require('../models/ReminderDelivery');
const User = require('../models/User');
const { clientPage } = require('../utils/urls');
const { sendEmail, escapeHtml } = require('./email');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const MAX_ATTEMPT_DELAY_MS = 6 * 60 * 60 * 1000;

function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function daysBetweenUtcDates(from, to) {
  const fromKey = dateKey(from);
  const toKey = dateKey(to);
  return (Date.parse(`${toKey}T00:00:00.000Z`) - Date.parse(`${fromKey}T00:00:00.000Z`)) / DAY_MS;
}

function getDueReminderJobs(contract, now = new Date()) {
  if (contract.remindersEnabled === false) return [];
  const jobs = [];
  const reminderDaysBefore = Array.isArray(contract.reminderDaysBefore) ? contract.reminderDaysBefore : [7, 3, 1];
  const owner = contract.parties.find((party) => party.role === 'owner');
  const dateReminder = (reminderType, targetDate, offsetDays, recipients) => {
    if (!targetDate) return;
    const daysUntil = daysBetweenUtcDates(now, targetDate);
    if (daysUntil !== offsetDays) return;
    const targetKey = dateKey(targetDate);
    for (const recipient of recipients) {
      jobs.push({
        contractId: String(contract._id),
        reminderType,
        targetDate,
        offsetDays,
        recipientEmail: recipient.email.toLowerCase(),
        recipientType: recipient.recipientType,
        reminderKey: `${contract._id}:${reminderType}:${targetKey}:${offsetDays}:${recipient.email.toLowerCase()}`
      });
    }
  };

  if (contract.status === 'pending' && contract.signingDeadline) {
    const signers = new Map();
    if (owner?.email) signers.set(owner.email.toLowerCase(), { email: owner.email, recipientType: 'owner' });
    for (const party of contract.parties) {
      if (party.role === 'counterparty' && !party.signedAt && !party.declinedAt
        && party.signingTokenHash && party.signingExpiresAt && new Date(party.signingExpiresAt) > now) {
        signers.set(party.email.toLowerCase(), { email: party.email, recipientType: 'signer' });
      }
    }
    if ([...signers.values()].some((recipient) => recipient.recipientType === 'signer')) {
      for (const daysBefore of reminderDaysBefore) {
        dateReminder('signing', contract.signingDeadline, daysBefore, [...signers.values()]);
      }
      if (contract.overdueSigningReminderEnabled !== false && daysBetweenUtcDates(now, contract.signingDeadline) === -1) {
        for (const recipient of signers.values()) {
          jobs.push({
            contractId: String(contract._id),
            reminderType: 'signing_overdue',
            targetDate: contract.signingDeadline,
            offsetDays: -1,
            recipientEmail: recipient.email.toLowerCase(),
            recipientType: recipient.recipientType,
            reminderKey: `${contract._id}:signing_overdue:${dateKey(contract.signingDeadline)}:-1:${recipient.email.toLowerCase()}`
          });
        }
      }
    }
  }

  if (contract.status === 'signed' && contract.renewalDate) {
    const renewalRecipients = new Map();
    if (owner?.email) renewalRecipients.set(owner.email.toLowerCase(), { email: owner.email, recipientType: 'owner' });
    for (const party of contract.parties) {
      if (party.email) renewalRecipients.set(party.email.toLowerCase(), { email: party.email, recipientType: 'party' });
    }
    for (const daysBefore of reminderDaysBefore) {
      dateReminder('renewal', contract.renewalDate, daysBefore, [...renewalRecipients.values()]);
    }
  }

  return jobs;
}

function reminderMessage(contract, job) {
  const dueDate = new Date(job.targetDate).toLocaleDateString('en-ZA', { timeZone: 'UTC', dateStyle: 'long' });
  const contractLink = clientPage(`contracts/${encodeURIComponent(String(contract._id))}`);
  const title = String(contract.title);
  const reminderText = job.reminderType === 'renewal'
    ? `The agreement "${title}" is due for renewal on ${dueDate} (in ${job.offsetDays} day${job.offsetDays === 1 ? '' : 's'}).`
    : job.reminderType === 'signing_overdue'
      ? `The agreement "${title}" passed its signing deadline on ${dueDate} and is still awaiting signatures.`
      : `The agreement "${title}" is due for signatures on ${dueDate} (in ${job.offsetDays} day${job.offsetDays === 1 ? '' : 's'}).`;
  const subject = job.reminderType === 'renewal'
    ? `Renewal reminder: ${title}`
    : job.reminderType === 'signing_overdue'
      ? `Signing deadline passed: ${title}`
      : `Signing deadline approaching: ${title}`;
  const action = job.reminderType === 'renewal' ? 'Review the agreement' : 'Review and sign the agreement';
  return {
    to: job.recipientEmail,
    subject,
    html: `<p>${escapeHtml(reminderText)}</p><p><a href="${escapeHtml(contractLink)}">${escapeHtml(action)}</a></p><p>Sign in using the email address associated with this agreement. Reminder emails do not include the contract text.</p>`,
    text: `${reminderText}\n${action}: ${contractLink}\nSign in using the email address associated with this agreement. Reminder emails do not include the contract text.`
  };
}

async function claimReminder(job, now) {
  try {
    return await ReminderDelivery.findOneAndUpdate({
      reminderKey: job.reminderKey,
      $or: [
        { status: 'failed', nextAttemptAt: { $lte: now } },
        { status: 'sending', lockedAt: { $lte: new Date(now.getTime() - LOCK_MS) } }
      ]
    }, {
      $set: {
        contract: job.contractId,
        reminderType: job.reminderType,
        recipientEmail: job.recipientEmail,
        scheduledFor: job.targetDate,
        status: 'sending',
        lockedAt: now,
        nextAttemptAt: null,
        lastError: ''
      },
      $setOnInsert: { reminderKey: job.reminderKey },
      $inc: { attempts: 1 }
    }, { upsert: true, new: true, setDefaultsOnInsert: false });
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }
}

async function deliverReminder(contract, job, now) {
  const claim = await claimReminder(job, now);
  if (!claim) return;
  try {
    await sendEmail(reminderMessage(contract, job));
    await ReminderDelivery.updateOne({ _id: claim._id, status: 'sending' }, {
      $set: { status: 'sent', sentAt: new Date(), nextAttemptAt: null, lastError: '' },
      $unset: { lockedAt: 1 }
    });
  } catch (error) {
    const delay = Math.min(60_000 * (2 ** Math.min(claim.attempts - 1, 8)), MAX_ATTEMPT_DELAY_MS);
    await ReminderDelivery.updateOne({ _id: claim._id, status: 'sending' }, {
      $set: {
        status: 'failed',
        nextAttemptAt: new Date(Date.now() + delay),
        lastError: String(error.message || error).slice(0, 500)
      },
      $unset: { lockedAt: 1 }
    });
    console.error('Failed to send contract reminder email', {
      contractId: job.contractId,
      reminderType: job.reminderType,
      recipientType: job.recipientType,
      error
    });
  }
}

async function processReminderBatch(contracts, now) {
  const jobsByContract = contracts.map((contract) => ({ contract, jobs: getDueReminderJobs(contract, now) }))
    .filter((entry) => entry.jobs.length);
  const emailSet = new Set(jobsByContract.flatMap((entry) => entry.jobs.map((job) => job.recipientEmail)));
  if (!emailSet.size) return;
  const users = await User.find({ email: { $in: [...emailSet] } }).select('email notifications').lean();
  const preferences = new Map(users.map((user) => [user.email.toLowerCase(), user.notifications]));
  for (const { contract, jobs } of jobsByContract) {
    for (const job of jobs) {
      const userPreferences = preferences.get(job.recipientEmail);
      if (userPreferences?.email === false || userPreferences?.contractUpdates === false) continue;
      await deliverReminder(contract, job, now);
    }
  }
}

async function processDueReminders(now = new Date()) {
  const today = new Date(`${dateKey(now)}T00:00:00.000Z`);
  const overdueStart = new Date(today.getTime() - DAY_MS);
  const latestReminderDate = new Date(today.getTime() + 7 * DAY_MS);
  const filter = {
    remindersEnabled: { $ne: false },
    $or: [
      { status: 'pending', signingDeadline: { $gte: overdueStart, $lte: latestReminderDate } },
      { status: 'signed', renewalDate: { $gte: today, $lte: latestReminderDate } }
    ]
  };
  const cursor = Contract.find(filter).select('_id title status parties signingDeadline renewalDate remindersEnabled reminderDaysBefore overdueSigningReminderEnabled')
    .lean().cursor({ batchSize: 100 });
  let batch = [];
  for await (const contract of cursor) {
    batch.push(contract);
    if (batch.length === 100) {
      await processReminderBatch(batch, now);
      batch = [];
    }
  }
  if (batch.length) await processReminderBatch(batch, now);
}

function startSigningReminderWorker() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processDueReminders();
    } catch (error) {
      console.error('Contract reminder worker failed', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 60_000);
  run();
  return () => clearInterval(timer);
}

module.exports = { getDueReminderJobs, processDueReminders, startSigningReminderWorker };
