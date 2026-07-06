// api/webhooks/paypal.ts
// PayPal server-to-server webhook for Vercel / serverless deployments.
// Mirrors the proven Node route in server.ts (POST /api/paypal/webhook).
//
// Verifies PAYPAL-TRANSMISSION-SIG (CRC32 of the raw body, RSA-SHA256 signed
// with PayPal's cert) and FAILS CLOSED in live mode when it cannot verify.
// The webhook id comes from Admin Panel -> Payment Settings first, then env.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { loadDbPaymentSettings, dbc, sbx, persistPaidOrder, env } from '../payment';

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const transmissionId = String(req.headers['paypal-transmission-id'] || '');
  const timestamp = String(req.headers['paypal-transmission-time'] || '');
  const certUrl = String(req.headers['paypal-cert-url'] || '');
  const receivedSig = String(req.headers['paypal-transmission-sig'] || '');
  const raw = await readRawBody(req);
  const rawBody = raw.toString('utf8');
  try { await loadDbPaymentSettings(); } catch { /* non-fatal: fall back to env */ }
  const webhookId = (dbc('paypalWebhookId') || env('PAYPAL_WEBHOOK_ID')).trim();
  const sandbox = sbx(undefined, 'paypalSandboxMode', 'PAYPAL_SANDBOX');

  if (webhookId && receivedSig && certUrl && transmissionId) {
    try {
      const bodyCrc = crc32(Buffer.from(rawBody));
      const message = transmissionId + '|' + timestamp + '|' + webhookId + '|' + bodyCrc;
      const certRes = await fetch(certUrl);
      const cert = await certRes.text();
      const verify = crypto.createVerify('SHA256');
      verify.update(message);
      const valid = verify.verify(cert, Buffer.from(receivedSig, 'base64'));
      if (!valid) { res.status(400).json({ error: 'Invalid PayPal webhook signature' }); return; }
    } catch (sigErr: any) {
      // Fail closed in live mode; allow through in sandbox for easier testing.
      if (!sandbox) { res.status(400).json({ error: 'PayPal webhook signature could not be verified' }); return; }
    }
  } else if (!sandbox) {
    res.status(400).json({ error: 'PayPal webhook verification not configured (set PayPal Webhook ID)' });
    return;
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
  const eventType = String(event.event_type || '');
  const resource = event.resource || {};
  // persistPaidOrder is idempotent (claimPaymentOnce dedupes gateway retries).
  try {
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureId = resource.id;
      const paidAmt = resource.amount && resource.amount.value;
      const custRef = resource.custom_id || resource.invoice_id || '';
      await persistPaidOrder('', String(custRef || ''), {
        amount: Number(paidAmt) || undefined,
        method: 'PayPal',
        txnId: String(captureId || ''),
      });
    }
    // CHECKOUT.ORDER.APPROVED is intentionally NOT persisted: funds are only
    // captured (and persisted) on PAYMENT.CAPTURE.COMPLETED / capture-order.
  } catch (e: any) {
    console.error('[PayPal Webhook] persist failed:', e && e.message ? e.message : e);
  }
  res.status(200).json({ received: true });
}
