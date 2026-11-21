'use strict';

const PDFDocument = require('pdfkit');

const COLORS = {
  forest: '#153a32',
  forestDark: '#0e2d27',
  lime: '#c9ef74',
  ink: '#172a25',
  muted: '#66766e',
  line: '#dce5df',
  pale: '#f3f6f3',
  white: '#ffffff'
};
const PAGE_MARGIN = 52;
const CONTENT_BOTTOM = 770;

function formattedDate(value, options = { dateStyle: 'long' }) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('en-ZA', { ...options, timeZone: 'Africa/Johannesburg' }).format(date)
    : 'Not recorded';
}

function drawHeader(doc) {
  const width = doc.page.width;
  const contentY = doc.y;
  doc.save();
  doc.rect(0, 0, width, 76).fill(COLORS.forestDark);
  doc.roundedRect(PAGE_MARGIN, 19, 38, 38, 9).fill(COLORS.lime);
  doc.fillColor(COLORS.forestDark).font('Helvetica-Bold').fontSize(21)
    .text('C', PAGE_MARGIN, 26, { width: 38, align: 'center', lineBreak: false });
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(16)
    .text('Contracts', PAGE_MARGIN + 50, 25, { continued: true, lineBreak: false });
  doc.fillColor(COLORS.lime).font('Helvetica-Bold').fontSize(16)
    .text(' ZAR', { lineBreak: false });
  doc.fillColor('#d2dfd7').font('Helvetica').fontSize(8)
    .text('AGREEMENT & SIGNING RECORD', PAGE_MARGIN + 50, 47, { characterSpacing: 1.1 });
  doc.rect(0, 76, width, 3).fill(COLORS.lime);
  doc.restore();
  doc.y = contentY;
}

function drawFooter(doc, pageNumber, pageCount) {
  const y = doc.page.height - 42;
  doc.save();
  doc.moveTo(PAGE_MARGIN, y).lineTo(doc.page.width - PAGE_MARGIN, y).lineWidth(0.7).strokeColor(COLORS.line).stroke();
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
    .text('Contracts ZAR  |  A product of Established Media and Enterprises', PAGE_MARGIN, y + 10, {
      width: 390, lineBreak: false
    });
  doc.text(`Page ${pageNumber} of ${pageCount}`, doc.page.width - PAGE_MARGIN - 105, y + 10, {
    width: 105, align: 'right', lineBreak: false
  });
  doc.restore();
}

function ensureSpace(doc, height) {
  if (doc.y + height > CONTENT_BOTTOM) doc.addPage();
}

function drawSectionHeading(doc, heading) {
  ensureSpace(doc, 38);
  doc.moveDown(0.8);
  const y = doc.y;
  doc.roundedRect(PAGE_MARGIN, y + 1, 3, 15, 1.5).fill(COLORS.forest);
  doc.fillColor(COLORS.forest).font('Helvetica-Bold').fontSize(12)
    .text(heading, PAGE_MARGIN + 12, y, { lineBreak: false });
  doc.y = y + 25;
}

function drawPartyDetails(doc, contract) {
  drawSectionHeading(doc, 'PARTIES');
  for (const [index, party] of contract.parties.entries()) {
    ensureSpace(doc, 58);
    const top = doc.y;
    const width = doc.page.width - (PAGE_MARGIN * 2);
    doc.roundedRect(PAGE_MARGIN, top, width, 48, 5).fill(COLORS.pale);
    doc.fillColor(COLORS.forest).font('Helvetica-Bold').fontSize(10)
      .text(party.name || `Party ${index + 1}`, PAGE_MARGIN + 12, top + 8, {
        width: width - 150, lineBreak: false
      });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(party.email || 'Email not recorded', PAGE_MARGIN + 12, top + 25, {
        width: width - 150, lineBreak: false
      });
    const signed = party.signedAt ? `Signed ${formattedDate(party.signedAt)}` : 'Signature not recorded';
    doc.fillColor(party.signedAt ? COLORS.forest : COLORS.muted).font('Helvetica-Bold').fontSize(8)
      .text(String(party.role || 'party').toUpperCase(), doc.page.width - PAGE_MARGIN - 130, top + 8, {
        width: 118, align: 'right', lineBreak: false
      });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(signed, doc.page.width - PAGE_MARGIN - 130, top + 25, {
        width: 118, align: 'right', lineBreak: false
      });
    doc.y = top + 57;
  }
}

function drawSignatureBlocks(doc, contract) {
  drawSectionHeading(doc, 'SIGNATURES');
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
    .text('The following signatures were recorded for this agreement.', { lineGap: 2 });
  doc.moveDown(0.6);

  for (const [index, party] of contract.parties.entries()) {
    const signature = contract.signatures.find((record) => record.email?.toLowerCase() === party.email?.toLowerCase());
    const blockHeight = 104;
    ensureSpace(doc, blockHeight + 10);
    const top = doc.y;
    const left = PAGE_MARGIN;
    const width = doc.page.width - (PAGE_MARGIN * 2);
    doc.roundedRect(left, top, width, blockHeight, 6).lineWidth(0.8).strokeColor(COLORS.line).stroke();
    doc.fillColor(COLORS.forest).font('Helvetica-Bold').fontSize(9)
      .text(signature?.name || party.name || `Party ${index + 1}`, left + 12, top + 10, {
        width: width - 150, lineBreak: false
      });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(`${party.role || 'Party'}  |  ${signature?.email || party.email || 'Email not recorded'}`, left + 12, top + 25, {
        width: width - 24, lineBreak: false
      });
    doc.moveTo(left + 12, top + 40).lineTo(left + width - 12, top + 40)
      .lineWidth(0.5).strokeColor(COLORS.line).stroke();

    if (signature?.imageData?.startsWith('data:image/png;base64,')) {
      const image = Buffer.from(signature.imageData.slice('data:image/png;base64,'.length), 'base64');
      doc.image(image, left + 12, top + 47, { fit: [155, 38] });
    } else {
      doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(8)
        .text('Signature image unavailable', left + 12, top + 57, { lineBreak: false });
    }

    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(`Signed: ${formattedDate(signature?.signedAt || party.signedAt, { dateStyle: 'medium', timeStyle: 'short' })}`, left + width - 190, top + 54, {
        width: 178, align: 'right', lineBreak: false
      });
    doc.y = top + blockHeight + 10;
  }
}

function drawCompletionCertificate(doc, contract) {
  doc.addPage();
  doc.fillColor(COLORS.forest).font('Helvetica-Bold').fontSize(19)
    .text('Certificate of completion', PAGE_MARGIN, doc.y, { lineGap: 4 });
  doc.moveDown(0.5);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
    .text('This certificate records the signing evidence stored by Contracts ZAR for the agreement identified below.', {
      width: doc.page.width - PAGE_MARGIN * 2, lineGap: 3
    });

  drawSectionHeading(doc, 'AGREEMENT RECORD');
  const details = [
    ['Agreement reference', String(contract._id || 'Not available')],
    ['Agreement', contract.title],
    ['Status', String(contract.status || 'unknown').toUpperCase()],
    ['Created', formattedDate(contract.createdAt, { dateStyle: 'medium', timeStyle: 'short' })],
    ['Completed', formattedDate(contract.signedAt, { dateStyle: 'medium', timeStyle: 'short' })],
    ['Contract text SHA-256', contract.bodyHash || 'Not available']
  ];
  for (const [label, value] of details) {
    ensureSpace(doc, 26);
    const y = doc.y;
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8)
      .text(label, PAGE_MARGIN, y, { width: 135, lineBreak: false });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8)
      .text(String(value), PAGE_MARGIN + 140, y, {
        width: doc.page.width - PAGE_MARGIN * 2 - 140, lineGap: 2
      });
    doc.moveDown(0.35);
  }

  drawSectionHeading(doc, 'SIGNING EVIDENCE');
  for (const [index, signature] of contract.signatures.entries()) {
    ensureSpace(doc, 112);
    const top = doc.y;
    const width = doc.page.width - PAGE_MARGIN * 2;
    doc.roundedRect(PAGE_MARGIN, top, width, 101, 5).fill(COLORS.pale);
    doc.fillColor(COLORS.forest).font('Helvetica-Bold').fontSize(9)
      .text(signature.name || `Signer ${index + 1}`, PAGE_MARGIN + 10, top + 8, { lineBreak: false });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(signature.email || 'Email not recorded', PAGE_MARGIN + 10, top + 23, { lineBreak: false });
    doc.text(`Signed: ${formattedDate(signature.signedAt, { dateStyle: 'medium', timeStyle: 'short' })}`, PAGE_MARGIN + 10, top + 37, { lineBreak: false });
    doc.text(`IP address: ${signature.ipAddress || 'Not recorded'}`, PAGE_MARGIN + 10, top + 50, { lineBreak: false });
    doc.fillColor(COLORS.forest).font('Helvetica-Bold').fontSize(7)
      .text('SIGNED DOCUMENT SHA-256', PAGE_MARGIN + 10, top + 63, { lineBreak: false });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7)
      .text(signature.documentHash || 'Not available', PAGE_MARGIN + 145, top + 63, {
        width: width - 155, lineBreak: false
      });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
      .text(`User agent: ${String(signature.userAgent || 'Not recorded').slice(0, 120)}`, PAGE_MARGIN + 10, top + 78, {
        width: width - 20, lineBreak: false
      });
    doc.y = top + 111;
  }

  ensureSpace(doc, 36);
  doc.moveDown(0.5);
  doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(8)
    .text('The SHA-256 values above identify the contract text recorded at signing. This certificate summarizes platform records and is not legal advice or an independent verification of signer identity.', {
      width: doc.page.width - PAGE_MARGIN * 2, lineGap: 3
    });
}

function contractPdf(contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 100, bottom: 62, left: PAGE_MARGIN, right: PAGE_MARGIN },
      bufferPages: true,
      info: {
        Title: contract.title,
        Author: 'Contracts ZAR',
        Subject: 'Executed contract and signing record',
        Creator: 'Contracts ZAR'
      }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('pageAdded', () => drawHeader(doc));
    drawHeader(doc);

    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(22)
      .text(contract.title, { width: doc.page.width - PAGE_MARGIN * 2, lineGap: 3 });
    doc.moveDown(0.4);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text(`Executed agreement  |  Created ${formattedDate(contract.createdAt, { dateStyle: 'medium' })}  |  Completed ${formattedDate(contract.signedAt, { dateStyle: 'medium' })}`, {
        width: doc.page.width - PAGE_MARGIN * 2, lineGap: 2
      });

    drawPartyDetails(doc, contract);
    drawSectionHeading(doc, 'CONTRACT TERMS');
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(10)
      .text(contract.body, {
        width: doc.page.width - PAGE_MARGIN * 2,
        lineGap: 3,
        paragraphGap: 5,
        continued: false
      });

    drawSignatureBlocks(doc, contract);
    drawCompletionCertificate(doc, contract);

    const pages = doc.bufferedPageRange();
    const lastPage = pages.start + pages.count - 1;
    for (let index = pages.start; index <= lastPage; index += 1) {
      doc.switchToPage(index);
      drawFooter(doc, index - pages.start + 1, pages.count);
    }
    doc.switchToPage(lastPage);
    doc.end();
  });
}

module.exports = { contractPdf };
