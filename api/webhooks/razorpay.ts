// api/webhooks/razorpay.ts
// Razorpay server-to-server webhook for Vercel / serverless deployments.
// Mirrors the proven Node route in server.ts (POST /api/razorpay/webhook).
//
// Verifies X-Razorpay-Signature (HMAC-SHA256 over the raw body) and FAILS
// CLOSED for live keys (rzp_live_...) when no secret is configured. The secret
// comes from env first, then Admin Panel -> Payment Settings.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { loadDbPaymentSettings, dbc, persistPaidOrder, env } from '../payment';

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const rcvdSig = String(req.headers['x-razorpay-signature'] || '');
  const raw = await readRawBody(req);
  const rawBody = raw.toString('utf8');
  try { await loadDbPaymentSettings(); } catch { /* non-fatal: fall back to env */ }
  const secret = (env('RAZORPAY_WEBHOOK_SECRET') || dbc('razorpayKeySecret') || env('RAZORPAY_KEY_SECRET')).trim();
  const keyId = String(dbc('razorpayKeyId') || env('RAZORPAY_KEY_ID'));

  if (!secret) {
    // Fail closed for live keys; allow through in test mode so setup is easy.
    if (keyId.startsWith('rzp_live_')) {
      res.status(400).json({ error: 'Razorpay webhook secret not configured' });
      return;
    }
  } else if (!rcvdSig) {
    res.status(400).json({ error: 'Missing signature' });
    return;
  } else {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(rcvdSig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    if (!valid) { res.status(400).json({ error: 'Invalid Razorpay webhook signature' }); return; }
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
  const entity = (event.payload && event.payload.payment && event.payload.payment.entity)
    || (event.payload && event.payload.order && event.payload.order.entity)
    || {};
  const paymentId = entity.id || '';
  const eventAcc = String(event.event || '');
  // persistPaidOrder is idempotent (claimPaymentOnce dedupes gateway retries).
  try {
    if (eventAcc === 'payment.captured') {
      const amount = (Number(entity.amount || 0) / 100).toFixed(2);
      const orderId = (entity.notes && entity.notes.orderId) || entity.order_id || entity.description || '';
      await persistPaidOrder(String((entity.notes && entity.notes.backend) || ''), String(orderId || ''), {
        amount: Number(amount) || undefined,
        method: 'Razorpay',
        txnId: String(paymentId || ''),
      });
    }
  } catch (e: any) {
    console.error('[Razorpay Webhook] persist failed:', e && e.message ? e.message : e);
  }
  res.status(200).json({ received: true });
}
