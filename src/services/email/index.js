'use strict';

const config = require('../../config/env');
const User = require('../../models/User');

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

module.exports = { sendEmail, emailHtml, sendSignatureConfirmation };
