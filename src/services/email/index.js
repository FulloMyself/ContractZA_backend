'use strict';

const config = require('../../config/env');
const User = require('../../models/User');
const { clientPage } = require('../../utils/urls');

async function sendEmail({ to, subject, html, text }) {
  const safeSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (!config.emailProvider) {
    if (config.nodeEnv === 'production') throw new Error('EMAIL_PROVIDER must be configured in production');
    console.info(`[development email] to=${to} subject=${safeSubject}\n${text}`);
    return;
  }

  let endpoint;
  let headers;
  let payload;
  if (config.emailProvider === 'resend') {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for Resend');
    endpoint = 'https://api.resend.com/emails';
    headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}` };
    payload = { from: config.emailFrom, to: [to], subject: safeSubject, html, text };
  } else if (config.emailProvider === 'brevo') {
    if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is required for Brevo');
    endpoint = 'https://api.brevo.com/v3/smtp/email';
    headers = { 'api-key': process.env.BREVO_API_KEY };
    payload = {
      sender: { email: config.emailFrom.match(/<([^>]+)>/)?.[1] || config.emailFrom, name: 'Contracts ZAR' },
      to: [{ email: to }],
      subject: safeSubject,
      htmlContent: html,
      textContent: text
    };
  } else {
    throw new Error(`Unsupported EMAIL_PROVIDER: ${config.emailProvider}`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Email provider returned ${response.status}: ${detail}`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function emailHtml(message, link, expiration = '24 hours') {
  return `<p>${escapeHtml(message)}</p><p><a href="${escapeHtml(link)}">Continue to Contracts ZAR</a></p><p>This link expires in ${escapeHtml(expiration)}. If you did not request this, ignore this email.</p>`;
}

async function deliverNotifications(notifications, event) {
  const results = await Promise.allSettled(notifications.map(({ to, subject, html, text }) => sendEmail({ to, subject, html, text })));
  let failedCount = 0;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failedCount += 1;
      console.error(`Failed to send ${event} email`, {
        recipientType: notifications[index].recipientType,
        error: result.reason
      });
    }
  });
  return { failedCount };
}

async function sendProfileUpdatedNotice(user) {
  if (user.notifications?.email === false) return { failedCount: 0 };
  const link = clientPage('profile');
  return deliverNotifications([{
    to: user.email,
    recipientType: 'account-owner',
    subject: 'Your Contracts ZAR Profile Settings were updated',
    html: `<p>Your Contracts ZAR Profile Settings were updated.</p><p><a href="${escapeHtml(link)}">Review your Profile Settings</a></p><p>If you did not make this change, sign in and contact support.</p>`,
    text: `Your Contracts ZAR Profile Settings were updated. Review them here: ${link}. If you did not make this change, sign in and contact support.`
  }], 'profile update');
}

async function sendComplaintCreatedNotifications(caseRecord) {
  const partyEmails = [...new Set([caseRecord.complainantEmail, caseRecord.respondentEmail])];
  const [partyUsers, admins] = await Promise.all([
    User.find({ email: { $in: partyEmails } }).select('email notifications').lean(),
    User.find({ role: 'admin', status: 'active', emailVerified: true }).select('email notifications').lean()
  ]);
  const partyByEmail = new Map(partyUsers.map((user) => [user.email, user]));
  const notifications = new Map();
  const caseId = String(caseRecord._id);
  const title = escapeHtml(caseRecord.contractTitle);
  const subject = escapeHtml(caseRecord.subject);
  for (const [email, label] of [[caseRecord.complainantEmail, 'reporter'], [caseRecord.respondentEmail, 'other-party']]) {
    const preferences = partyByEmail.get(email)?.notifications;
    if (preferences?.email === false || preferences?.contractUpdates === false) continue;
    const link = clientPage(`complaints/${encodeURIComponent(caseId)}`);
    const isReporter = label === 'reporter';
    notifications.set(email, {
      to: email,
      recipientType: label,
      subject: isReporter ? `Your contract dispute was submitted: ${caseRecord.subject}` : `A contract dispute was opened: ${caseRecord.subject}`,
      html: `<p>${isReporter ? 'Your contract dispute report has been submitted.' : 'A contract dispute report has been opened involving you as a party.'}</p><p><strong>Contract:</strong> ${title}<br><strong>Case:</strong> ${subject}<br><strong>Reference:</strong> ${escapeHtml(caseId)}</p><p><a href="${escapeHtml(link)}">View the case and respond</a></p><p>Contracts ZAR helps parties communicate and does not determine legal liability. If you do not have an account, sign up using this email address to access the case.</p>`,
      text: `${isReporter ? 'Your contract dispute report has been submitted.' : 'A contract dispute report has been opened involving you as a party.'}\nContract: ${caseRecord.contractTitle}\nCase: ${caseRecord.subject}\nReference: ${caseId}\nView the case and respond: ${link}\nContracts ZAR helps parties communicate and does not determine legal liability. If you do not have an account, sign up using this email address to access the case.`
    });
  }
  for (const admin of admins) {
    if (admin.notifications?.email === false || admin.notifications?.contractUpdates === false) continue;
    const link = clientPage(`admin/complaints/${encodeURIComponent(caseId)}`);
    notifications.set(admin.email, {
      to: admin.email,
      recipientType: 'admin',
      subject: `New contract dispute submitted: ${caseRecord.subject}`,
      html: `<p>A new contract dispute has been submitted for platform review.</p><p><strong>Contract:</strong> ${title}<br><strong>Case:</strong> ${subject}<br><strong>Reference:</strong> ${escapeHtml(caseId)}</p><p><a href="${escapeHtml(link)}">Review the case</a></p><p>Administrators support communication and do not determine legal liability. Contract documents are not available in the admin case view.</p>`,
      text: `A new contract dispute has been submitted for platform review.\nContract: ${caseRecord.contractTitle}\nCase: ${caseRecord.subject}\nReference: ${caseId}\nReview the case: ${link}\nAdministrators support communication and do not determine legal liability. Contract documents are not available in the admin case view.`
    });
  }
  return deliverNotifications([...notifications.values()], 'complaint');
}

async function sendComplaintResponseNotifications(caseRecord, response) {
  const partyEmails = [...new Set([caseRecord.complainantEmail, caseRecord.respondentEmail])];
  const [partyUsers, admins] = await Promise.all([
    User.find({ email: { $in: partyEmails } }).select('email notifications').lean(),
    User.find({ role: 'admin', status: 'active', emailVerified: true }).select('email notifications').lean()
  ]);
  const partyByEmail = new Map(partyUsers.map((user) => [user.email, user]));
  const notifications = new Map();
  const caseId = String(caseRecord._id);
  const title = escapeHtml(caseRecord.contractTitle);
  const subject = escapeHtml(caseRecord.subject);
  const author = escapeHtml(response.authorName);

  for (const [email, recipientType] of [[caseRecord.complainantEmail, 'reporter'], [caseRecord.respondentEmail, 'other-party']]) {
    const preferences = partyByEmail.get(email)?.notifications;
    if (preferences?.email === false || preferences?.contractUpdates === false) continue;
    const link = clientPage(`complaints/${encodeURIComponent(caseId)}`);
    notifications.set(email, {
      to: email,
      recipientType,
      subject: `New response in contract dispute: ${caseRecord.subject}`,
      html: `<p>${author} added a response to a contract dispute involving you.</p><p><strong>Contract:</strong> ${title}<br><strong>Case:</strong> ${subject}<br><strong>Reference:</strong> ${escapeHtml(caseId)}</p><p><a href="${escapeHtml(link)}">Sign in to view the case and respond</a></p><p>The response is not included in this email. Contracts ZAR records communications and does not determine legal liability.</p>`,
      text: `${response.authorName} added a response to a contract dispute involving you.\nContract: ${caseRecord.contractTitle}\nCase: ${caseRecord.subject}\nReference: ${caseId}\nSign in to view the case and respond: ${link}\nThe response is not included in this email. Contracts ZAR records communications and does not determine legal liability.`
    });
  }

  for (const admin of admins) {
    if (admin.notifications?.email === false || admin.notifications?.contractUpdates === false) continue;
    const link = clientPage(`admin/complaints/${encodeURIComponent(caseId)}`);
    notifications.set(admin.email, {
      to: admin.email,
      recipientType: 'admin',
      subject: `Complaint response updated: ${caseRecord.subject}`,
      html: `<p>${author} added a response to a contract dispute case.</p><p><strong>Contract:</strong> ${title}<br><strong>Case:</strong> ${subject}<br><strong>Reference:</strong> ${escapeHtml(caseId)}</p><p><a href="${escapeHtml(link)}">Review the case</a></p><p>The response is not included in this email. Administrators support communication and do not determine legal liability or access contract documents.</p>`,
      text: `${response.authorName} added a response to a contract dispute case.\nContract: ${caseRecord.contractTitle}\nCase: ${caseRecord.subject}\nReference: ${caseId}\nReview the case: ${link}\nThe response is not included in this email. Administrators support communication and do not determine legal liability or access contract documents.`
    });
  }
  return deliverNotifications([...notifications.values()], 'complaint response');
}

async function sendSignatureConfirmation(contract) {
  const uniqueEmails = [...new Set(contract.parties.map((party) => party.email))];
  const title = escapeHtml(contract.title);
  const text = `All parties have signed "${contract.title}". The agreement is complete.`;
  const recipients = await Promise.all(uniqueEmails.map(async (email) => {
    const user = await User.findOne({ email }).select('notifications').lean();
    return !user || (user.notifications?.email !== false && user.notifications?.contractUpdates !== false) ? email : null;
  }));
  await Promise.all(recipients.filter(Boolean).map((to) => sendEmail({
    to,
    subject: `Agreement complete: ${contract.title}`,
    html: `<p>All parties have signed <strong>${title}</strong>. The agreement is complete.</p>`,
    text
  })));
}

module.exports = {
  sendEmail,
  emailHtml,
  sendProfileUpdatedNotice,
  sendComplaintCreatedNotifications,
  sendComplaintResponseNotifications,
  sendSignatureConfirmation
};
