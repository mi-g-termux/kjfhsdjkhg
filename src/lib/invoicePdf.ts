/**
 * Invoice PDF builder.
 *
 * Generates a clean, printable PDF receipt entirely on the client using jsPDF
 * and returns it as a base64 string suitable for emailing as an attachment.
 *
 * Why client-side?
 *   The Vercel serverless email function is a thin SMTP forwarder. Keeping
 *   PDF generation on the client avoids adding heavy native dependencies
 *   (chromium / wkhtmltopdf) to the serverless bundle and keeps cold-starts
 *   fast. The PDF binary is base64-encoded and posted alongside the email
 *   payload — the server simply attaches it via nodemailer.
 */

import { jsPDF } from 'jspdf';
import type { Order, SiteSettings } from '../types';

const LEGACY_BRAND_RE = /quirky[\s-]?fruity/i;

interface BuildInvoiceOptions {
  order: Order;
  siteSettings: SiteSettings;
  /** Absolute origin (e.g. https://fruitopia.app) used in the QR tracker URL. */
  origin?: string;
}

/**
 * Currency formatter that respects admin's symbol + position.
 *
 * jsPDF's built-in fonts (Helvetica/Times/Courier) only support the
 * WinAnsi (Latin-1) glyph set. Symbols outside that range — like the
 * Bangladeshi Taka sign "৳" (U+09F3), Indian Rupee "₹", or Naira "₦" —
 * render as empty boxes / tofu in the PDF. For those, fall back to the
 * 3-letter ISO currency code (e.g. "BDT 152.09") so the receipt is
 * always readable.
 */
function isLatin1Safe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

function makeFormatter(siteSettings: SiteSettings) {
  const rawSym = siteSettings.currencySymbol || '$';
  const code = (siteSettings.currency || '').toString().trim().toUpperCase();
  const safeSym = isLatin1Safe(rawSym) ? rawSym : (code || 'USD');
  // When we had to drop a fancy symbol for a 3-letter code, add a space
  // so it reads like "BDT 1,234.56" instead of "BDT1,234.56".
  const usedCode = safeSym === code;
  const pos = (siteSettings.currencyPosition || 'before') as 'before' | 'after';
  return (n: number) => {
    const amt = (Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2);
    const sep = usedCode ? ' ' : '';
    return pos === 'after' ? `${amt}${sep}${safeSym}` : `${safeSym}${sep}${amt}`;
  };
}

/** Trim and sanitize storefront name; fall back to a neutral label. */
function getStoreName(siteSettings: SiteSettings): string {
  return (siteSettings.websiteName || 'Store').trim();
}

/**
 * Build a single-page invoice PDF and return it as a base64 string
 * (no data: URI prefix — nodemailer attachments want raw base64).
 */
export function buildInvoicePdfBase64(options: BuildInvoiceOptions): string {
  const { order, siteSettings } = options;
  const storeName = getStoreName(siteSettings);
  const fmt = makeFormatter(siteSettings);

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // Header
  doc.setFillColor(16, 185, 129); // emerald-500
  doc.rect(0, 0, pageW, 6, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(16, 185, 129);
  doc.text(storeName.toUpperCase(), margin, (y += 30));

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 130);
  doc.text('SALES RECEIPT', margin, (y += 14));

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.text(`Invoice #${order.orderNumber}`, pageW - margin, y - 14, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 130);
  doc.text(
    new Date(order.createdAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    pageW - margin,
    y,
    { align: 'right' },
  );

  // Divider
  y += 18;
  doc.setDrawColor(226, 232, 240);
  doc.line(margin, y, pageW - margin, y);
  y += 18;

  // Customer / Address blocks
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 130);
  doc.text('CUSTOMER', margin, y);
  doc.text('SHIP TO', pageW / 2, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text(order.customerName, margin, y + 14);
  doc.text(order.phone, margin, y + 28);
  doc.text(order.email, margin, y + 42);

  const addrLines = doc.splitTextToSize(`${order.address}, ${order.city}`, pageW / 2 - margin - 10);
  doc.text(addrLines, pageW / 2, y + 14);

  y += 70;

  // Items table header
  doc.setFillColor(16, 185, 129);
  doc.rect(margin, y, pageW - margin * 2, 22, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text('ITEM', margin + 10, y + 15);
  doc.text('QTY', pageW - margin - 140, y + 15, { align: 'center' });
  doc.text('AMOUNT', pageW - margin - 10, y + 15, { align: 'right' });
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  for (const item of order.items) {
    if (y > 720) {
      doc.addPage();
      y = margin;
    }
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 41, 59);
    doc.text(item.name, margin + 10, y + 16);
    doc.text(String(item.quantity), pageW - margin - 140, y + 16, { align: 'center' });
    doc.text(fmt(item.price * item.quantity), pageW - margin - 10, y + 16, { align: 'right' });
    y += 22;
    // Variant detail row (e.g. "Size: 500ml") rendered directly under the name
    // so customers / admins / delivery staff can see exactly which variant was
    // ordered. Falls back to building a label from selectedVariants if the
    // explicit variantLabel was not captured at checkout time.
    const variantText =
      item.variantLabel ||
      (item.selectedVariants
        ? Object.entries(item.selectedVariants)
            .map(([g, v]) => `${g}: ${v}`)
            .join(' / ')
        : '');
    if (variantText) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(variantText, margin + 18, y + 12);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      y += 16;
    }
    doc.setDrawColor(241, 245, 249);
    doc.line(margin, y, pageW - margin, y);
  }

  // Totals
  y += 14;
  const totalsX = pageW - margin - 200;

  const writeRow = (label: string, value: string, opts?: { bold?: boolean; color?: [number, number, number] }) => {
    doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    doc.setFontSize(opts?.bold ? 12 : 10);
    if (opts?.color) doc.setTextColor(...opts.color);
    else doc.setTextColor(100, 116, 139);
    doc.text(label, totalsX, y);
    if (opts?.bold) doc.setTextColor(16, 185, 129);
    else doc.setTextColor(30, 41, 59);
    doc.text(value, pageW - margin - 10, y, { align: 'right' });
    y += 18;
  };

  writeRow('Subtotal', fmt(order.subtotal));
  if (order.discount > 0) {
    writeRow(
      `Discount${order.couponApplied ? ` (${order.couponApplied})` : ''}`,
      `-${fmt(order.discount)}`,
      { color: [220, 38, 38] },
    );
  }
  writeRow('Delivery & Handling', fmt(order.deliveryFee));

  // Grand total divider
  doc.setDrawColor(16, 185, 129);
  doc.setLineWidth(1);
  doc.line(totalsX, y - 4, pageW - margin - 10, y - 4);
  y += 6;
  writeRow('GRAND TOTAL', fmt(order.total), { bold: true });
  doc.setLineWidth(0.2);

  // ── PAYMENT SUMMARY ─────────────────────────────────────────────────────────
  // Always show the payment METHOD, a clear PAID / PARTIALLY PAID / UNPAID
  // status, and Amount Paid vs Amount Due, so anyone reading the invoice knows
  // instantly whether (and how) the order was paid. Handles fully-prepaid
  // orders, partial-COD (advance paid online), and plain cash-on-delivery.
  {
    const grand = Number(order.total) || 0;
    const hasPartial =
      order.paidAmount !== undefined && order.outstandingAmount !== undefined;
    const isFullyPaid = order.paymentStatus === 'Paid';
    const paid = hasPartial
      ? Number(order.paidAmount) || 0
      : isFullyPaid
        ? grand
        : 0;
    const due = hasPartial
      ? Number(order.outstandingAmount) || 0
      : Math.max(0, grand - paid);

    const statusLabel =
      due <= 0 && paid > 0
        ? 'PAID'
        : paid > 0
          ? 'PARTIALLY PAID'
          : 'UNPAID (Cash on Delivery)';
    const statusColor: [number, number, number] =
      due <= 0 && paid > 0 ? [16, 185, 129] : paid > 0 ? [217, 119, 6] : [220, 38, 38];

    y += 10;
    doc.setDrawColor(16, 185, 129);
    doc.setLineWidth(0.8);
    doc.line(totalsX, y, pageW - margin - 10, y);
    y += 16;
    doc.setLineWidth(0.2);

    // Payment method
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('Payment Method', totalsX, y);
    doc.setTextColor(30, 41, 59);
    const methodLines = doc.splitTextToSize(order.paymentMethod || '-', 150);
    doc.text(methodLines[0] || '-', pageW - margin - 10, y, { align: 'right' });
    y += 18;

    // Payment status
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text('Payment Status', totalsX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
    doc.text(statusLabel, pageW - margin - 10, y, { align: 'right' });
    y += 18;

    // Amount paid (green)
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(16, 185, 129);
    doc.text('Amount Paid', totalsX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(16, 185, 129);
    doc.text(fmt(paid), pageW - margin - 10, y, { align: 'right' });
    y += 18;

    // Amount due (red when > 0, otherwise neutral/green)
    const dueR = due > 0 ? 220 : 16;
    const dueG = due > 0 ? 38 : 185;
    const dueB = due > 0 ? 38 : 129;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(dueR, dueG, dueB);
    doc.text(due > 0 ? 'Amount Due on Delivery' : 'Amount Due', totalsX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(dueR, dueG, dueB);
    doc.text(fmt(due), pageW - margin - 10, y, { align: 'right' });
    y += 18;
    doc.setLineWidth(0.2);
  }

  // Footer
  const rawTrademark = siteSettings.trademarkText || '';
  const trademark =
    !rawTrademark.trim() || LEGACY_BRAND_RE.test(rawTrademark)
      ? `© ${new Date().getFullYear()} ${storeName}. All rights reserved.`
      : rawTrademark;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 130);
  doc.text(`Thank you for your order at ${storeName}!`, pageW / 2, 780, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 160);
  doc.text(trademark, pageW / 2, 795, { align: 'center' });

  // jsPDF returns a data URI; strip the prefix so callers get raw base64.
  const dataUri = doc.output('datauristring');
  return dataUri.substring(dataUri.indexOf(',') + 1);
}
