'use strict';

const PDFDocument = require('pdfkit');

function contractPdf(contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(20).text(contract.title, { align: 'center' });
    doc.moveDown().fontSize(10).fillColor('#555').text(`Status: ${contract.status}    Created: ${contract.createdAt.toISOString()}`);
    doc.moveDown().fillColor('#111').fontSize(11).text(contract.body, { lineGap: 4 });
    if (contract.signatures.length) {
      doc.addPage().fontSize(18).text('Certificate of completion');
      doc.moveDown().fontSize(10).text(`Document SHA-256: ${contract.bodyHash || 'Not available'}`);
      for (const signature of contract.signatures) {
        doc.moveDown().fontSize(12).text(signature.name);
        doc.fontSize(9).text(`${signature.email} | ${signature.signedAt.toISOString()}`);
        doc.text(`IP: ${signature.ipAddress} | Document hash: ${signature.documentHash}`);
        if (signature.imageData.startsWith('data:image/png;base64,')) {
          const image = Buffer.from(signature.imageData.slice('data:image/png;base64,'.length), 'base64');
          doc.image(image, { fit: [180, 60] });
        }
      }
    }
    doc.end();
  });
}

module.exports = { contractPdf };
