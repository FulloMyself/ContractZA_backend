'use strict';

const config = require('../../config/env');
const User = require('../../models/User');
const { clientPage } = require('../../utils/urls');

function getPublicSiteUrl() {
  return `${config.clientUrl}${config.clientBasePath}/`;
}

function brandedEmailHtml(content) {
  const siteUrl = getPublicSiteUrl();
  const logoUrl = `${siteUrl}favicon.svg`;
  const styledContent = String(content || '').replace(/<a\b([^>]*)>/gi, (tag, attributes) => {
    if (/\bstyle\s*=/.test(attributes)) return tag;
    return `<a${attributes} style="color:#17634b;font-weight:700;text-decoration:underline;">`;
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>Contracts ZAR</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f2f5f3;font-family:Arial,Helvetica,sans-serif;color:#24342d;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">A notification from Contracts ZAR.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f2f5f3;">
      <tr>
        <td align="center" style="padding:32px 14px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:18px 24px;background-color:#153a32;border-radius:12px 12px 0 0;">
                <a href="${escapeHtml(siteUrl)}" style="display:inline-block;color:#ffffff;text-decoration:none;">
                  <img src="${escapeHtml(logoUrl)}" width="40" height="40" alt="Contracts ZAR" style="display:inline-block;width:40px;height:40px;margin-right:12px;border:0;border-radius:9px;vertical-align:middle;">
                  <span style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;vertical-align:middle;">Contracts <span style="color:#c9ef74;">ZAR</span></span>
                </a>
              </td>
            </tr>
            <tr>
              <td class="email-content" style="padding:30px 28px;background-color:#ffffff;font-size:15px;line-height:1.65;overflow-wrap:anywhere;">
                ${styledContent}
              </td>
            </tr>
            <tr>
              <td style="padding:21px 24px;background-color:#edf2ee;border-radius:0 0 12px 12px;color:#607067;font-size:12px;line-height:1.65;">
                <strong style="color:#264c3b;font-size:13px;">Contracts ZAR</strong><br>
                Digital tools to prepare, share, sign and retain agreements.<br>
                A product of Established Media and Enterprises.<br>
                <a href="${escapeHtml(siteUrl)}" style="color:#17634b;text-decoration:underline;">Visit Contracts ZAR</a>
                <p style="margin:14px 0 0;">This is an automated notification. Please sign in through the link in this email to review or respond; replies may not be monitored. Complaint communications are not legal advice or a determination of contractual rights.</p>
                <p style="margin:12px 0 0;color:#7a8880;">(c) ${new Date().getFullYear()} Established Media and Enterprises - Contracts ZAR</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function brandedEmailText(content) {
  return `${String(content || '').trim()}\n\nContracts ZAR\nDigital tools to prepare, share, sign and retain agreements.\nA product of Established Media and Enterprises.\nVisit Contracts ZAR: ${getPublicSiteUrl()}\nThis is an automated notification. Please sign in through the link in this email to review or respond; replies may not be monitored. Complaint communications are not legal advice or a determination of contractual rights.\n(c) ${new Date().getFullYear()} Established Media and Enterprises - Contracts ZAR`;
}

async function sendEmail({ to, subject, html, text }) {
  const safeSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const formattedHtml = brandedEmailHtml(html);
  const formattedText = brandedEmailText(text);
  if (!config.emailProvider) {
    if (config.nodeEnv === 'production') throw new Error('EMAIL_PROVIDER must be configured in production');
    console.info(`[development email] to=${to} subject=${safeSubject}\n${formattedText}`);
    return;
  }

  let endpoint;
  let headers;
  let payload;
  if (config.emailProvider === 'resend') {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for Resend');
    endpoint = 'https://api.resend.com/emails';
    headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}` };
    payload = { from: config.emailFrom, to: [to], subject: safeSubject, html: formattedHtml, text: formattedText };
  } else if (config.emailProvider === 'brevo') {
    if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is required for Brevo');
    endpoint = 'https://api.brevo.com/v3/smtp/email';
    headers = { 'api-key': process.env.BREVO_API_KEY };
    payload = {
      sender: { email: config.emailFrom.match(/<([^>]+)>/)?.[1] || config.emailFrom, name: 'Contracts ZAR' },
      to: [{ email: to }],
      subject: safeSubject,
      htmlContent: formattedHtml,
      textContent: formattedText
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

async function sendAccountStatusNotice(user, status) {
  if (user.notifications?.email === false || user.notifications?.contractUpdates === false) return { failedCount: 0 };
  const isSuspended = status === 'suspended';
  const message = isSuspended
    ? 'An administrator has suspended your Contracts ZAR account. You will not be able to sign in while it is suspended. Contact platform support if you believe this was a mistake.'
    : 'An administrator has reactivated your Contracts ZAR account. You can sign in and use the platform again.';
  return deliverNotifications([{
    to: user.email,
    recipientType: 'account-owner',
    subject: `Your Contracts ZAR account was ${status}`,
    html: `<p>${escapeHtml(message)}</p>`,
    text: message
  }], 'account status');
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

async function sendComplaintStatusNotifications(caseRecord) {
  const partyEmails = [...new Set([caseRecord.complainantEmail, caseRecord.respondentEmail])];
  const partyUsers = await User.find({ email: { $in: partyEmails } }).select('email notifications').lean();
  const partyByEmail = new Map(partyUsers.map((user) => [user.email, user]));
  const caseId = String(caseRecord._id);
  const link = clientPage(`complaints/${encodeURIComponent(caseId)}`);
  const title = escapeHtml(caseRecord.contractTitle);
  const subject = escapeHtml(caseRecord.subject);
  const notifications = [];

  for (const [email, recipientType] of [[caseRecord.complainantEmail, 'reporter'], [caseRecord.respondentEmail, 'other-party']]) {
    const preferences = partyByEmail.get(email)?.notifications;
    if (preferences?.email === false || preferences?.contractUpdates === false) continue;
    const status = escapeHtml(caseRecord.status.replace(/_/g, ' '));
    notifications.push({
      to: email,
      recipientType,
      subject: `Complaint case status updated: ${caseRecord.subject}`,
      html: `<p>An administrator updated the status of a complaint case involving you.</p><p><strong>Contract:</strong> ${title}<br><strong>Case:</strong> ${subject}<br><strong>Status:</strong> ${status}<br><strong>Reference:</strong> ${escapeHtml(caseId)}</p><p><a href="${escapeHtml(link)}">Sign in to review the case</a></p><p>Contracts ZAR records the platform workflow and does not determine legal liability.</p>`,
      text: `An administrator updated the status of a complaint case involving you.\nContract: ${caseRecord.contractTitle}\nCase: ${caseRecord.subject}\nStatus: ${caseRecord.status.replace(/_/g, ' ')}\nReference: ${caseId}\nSign in to review the case: ${link}\nContracts ZAR records the platform workflow and does not determine legal liability.`
    });
  }
  return deliverNotifications(notifications, 'complaint status');
}

async function sendCorrectionDecisionNotice(user, request) {
  if (user.notifications?.email === false || user.notifications?.contractUpdates === false) return { failedCount: 0 };
  const status = request.status;
  const message = `Your Contracts ZAR identity correction request was ${status}.`;
  const reviewNote = request.reviewNote ? `<p>Administrator note: ${escapeHtml(request.reviewNote)}</p>` : '';
  return deliverNotifications([{
    to: user.email,
    recipientType: 'account-owner',
    subject: `Your identity correction request was ${status}`,
    html: `<p>${escapeHtml(message)}</p>${reviewNote}`,
    text: `${message}${request.reviewNote ? ` Administrator note: ${request.reviewNote}` : ''}`
  }], 'correction request');
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
  escapeHtml,
  emailHtml,
  sendProfileUpdatedNotice,
  sendAccountStatusNotice,
  sendComplaintCreatedNotifications,
  sendComplaintResponseNotifications,
  sendComplaintStatusNotifications,
  sendCorrectionDecisionNotice,
  sendSignatureConfirmation
};
