import PDFDocument from 'pdfkit';
import type { Response } from 'express';

const GOLD = '#A67D4C';
const INK = '#1A1415';
const MUTED = '#7A7072';

// pdfkit's built-in fonts lack the rupee glyph, so amounts use "Rs."
const money = (n: number) => `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d: string) =>
  new Date(d.length === 10 ? `${d}T00:00:00Z` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export function streamInvoicePdf(res: Response, data: { invoice: any; items: any[]; payments: any[]; org: any; branch: any; member: any }) {
  const { invoice, items, payments, org, branch, member } = data;
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 6).fill(GOLD);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(org.name, 48, 40);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  doc.text([branch.name, branch.address, branch.phone, org.gstin ? `GSTIN ${org.gstin}` : null].filter(Boolean).join('  ·  '), 48, 66);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(GOLD).text('TAX INVOICE', 380, 40, { width: 167, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  doc.text(invoice.invoice_number, 380, 56, { width: 167, align: 'right' });
  doc.fillColor(MUTED).text(`Issued ${date(invoice.issue_date)}`, 380, 69, { width: 167, align: 'right' });

  doc.moveTo(48, 100).lineTo(547, 100).strokeColor('#E6DED6').stroke();
  doc.fillColor(MUTED).fontSize(8).text('BILLED TO', 48, 116);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(member.full_name, 48, 128);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([member.member_code, member.phone, member.email].filter(Boolean).join('  ·  '), 48, 144);

  const statusLabel = invoice.status.replace('_', ' ').toUpperCase();
  doc.fillColor(MUTED).fontSize(8).text('STATUS', 380, 116, { width: 167, align: 'right' });
  doc.fillColor(invoice.status === 'paid' ? '#3B7A3B' : '#9A5B12').font('Helvetica-Bold').fontSize(11).text(statusLabel, 380, 128, { width: 167, align: 'right' });

  let y = 186;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', 48, y).text('QTY', 320, y, { width: 30, align: 'right' }).text('PRICE', 355, y, { width: 60, align: 'right' })
    .text('DISC.', 420, y, { width: 50, align: 'right' }).text('AMOUNT', 475, y, { width: 72, align: 'right' });
  y += 16;
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const item of items) {
    const h = doc.heightOfString(item.description, { width: 260 });
    doc.text(item.description, 48, y, { width: 260 });
    doc.text(String(item.quantity), 320, y, { width: 30, align: 'right' });
    doc.text(money(item.unit_price), 355, y, { width: 60, align: 'right' });
    doc.text(item.discount ? money(item.discount) : '—', 420, y, { width: 50, align: 'right' });
    doc.text(money(item.amount), 475, y, { width: 72, align: 'right' });
    y += Math.max(h, 12) + 10;
    doc.moveTo(48, y - 5).lineTo(547, y - 5).strokeColor('#EFE9E3').stroke();
  }

  const row = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(bold ? INK : MUTED);
    doc.text(label, 340, y, { width: 120 });
    doc.fillColor(INK).text(value, 460, y, { width: 87, align: 'right' });
    y += bold ? 20 : 15;
  };
  y += 6;
  row('Subtotal', money(invoice.subtotal));
  if (invoice.discount) row('Discount', `- ${money(invoice.discount)}`);
  if (invoice.tax) row('Tax (GST)', money(invoice.tax));
  row('Total', money(invoice.total), true);
  row('Paid', money(invoice.amount_paid));
  row('Balance due', money(invoice.total - invoice.amount_paid), true);

  if (payments.length) {
    y += 16;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('PAYMENTS RECEIVED', 48, y);
    y += 14;
    doc.font('Helvetica').fontSize(9).fillColor(INK);
    for (const p of payments) {
      const method = p.method === 'bank_transfer' ? 'Bank transfer' : p.method.toUpperCase();
      doc.text(`${date(p.paid_at)}  ·  ${p.receipt_number}  ·  ${method}${p.reference ? ` (${p.reference})` : ''}`, 48, y, { width: 380 });
      doc.text(money(p.amount), 460, y, { width: 87, align: 'right' });
      y += 15;
    }
  }

  doc.fontSize(8).fillColor(MUTED).text('Payments are collected at the gym. This is a computer-generated invoice.', 48, 780, { width: 499, align: 'center' });
  doc.end();
}
