// api/webhook.ts
// UNIFIED server-to-server webhook for Vercel / serverless deployments.
//
// Handles Stripe, PayPal and Razorpay webhooks in ONE serverless function so we
// stay under Vercel's Hobby-plan limit of 12 functions. Routing is by the
// `gateway` query param, injected by the rewrites in vercel.json:
//   /api/stripe/webhook    -> /api/webhook?gateway=stripe
//   /api/paypal/webhook    -> /api/webhook?gateway=paypal
//   /api/razorpay/webhook  -> /api/webhook?gateway=razorpay
//
// Why a dedicated function (and not an action inside api/payment.ts)?
// api/payment.ts parses the JSON body, which destroys the exact raw bytes that
// Stripe/Razorpay HMAC signatures (and PayPal's CRC32) are computed over. This
// function disables body parsing so signatures can be verified.
//
// Credentials: signing secrets/ids are read from Admin Panel -> Payment Settings
// first (via the shared loader), then from env. No double entry required.
// Verification FAILS CLOSED in live mode; persistPaidOrder is idempotent.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { loadDbPaymentSettings, dbc, sbx, persistPaidOrder, env } from './payment';

export const config = { api: { bodyParser: false } };

function norm(v: string | string[] | undefined): string {
  return String(Array.isArray(v) ? v[0] : (v || '')).toLowerCase().trim();
}

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

// ── Stripe ────────────────────────────────────────────────────────────────
async function handleStripe(req: VercelRequest, res: VercelResponse, raw: Buffer): Promise<void> {
  const sig = String(req.headers['stripe-signature'] || '');
  const secret = (dbc('stripeWebhookSecret') || env('STRIPE_WEBHOOK_SECRET')).trim();
  if (!sig) { res.status(400).json({ error: 'Missing stripe-signature header' }); return; }
  if (!secret) {
    // Not configured yet -> acknowledge so Stripe stops retrying, but do nothing.
    res.status(200).json({ received: true, warning: 'Webhook secret not configured' });
    return;
  }
  let event: any;
  try {
    const parts = sig.split(',').reduce((acc: Record<string, string[]>, part) => {
      const [k, v] = part.split('=');
      if (!acc[k]) acc[k] = [];
      acc[k].push(v);
      return acc;
    }, {});
    const timestamp = parts['t'] && parts['t'][0];
    const v1Sigs = parts['v1'] || [];
    if (!timestamp || v1Sigs.length === 0) throw new Error('Invalid stripe-signature format');
    // Replay-attack guard: reject events older than 5 minutes.
    const age = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (age > 300) throw new Error('Stripe webhook timestamp too old (replay attack?)');
    const rawBody = raw.toString('utf8');
    const signedPayload = timestamp + '.' + rawBody;
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    const isValid = v1Sigs.some((v: string) =>
      v.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(v, 'hex'), Buffer.from(expected, 'hex'))
    );
    if (!isValid) throw new Error('Stripe signature verification failed');
    event = JSON.parse(rawBody);
  } catch (err: any) {
    res.status(400).json({ error: err && err.message ? err.message : 'Signature error' });
    return;
  }
  const type = String(event.type || '');
  const obj = (event.data && event.data.object) || {};
  try {
    if (type === 'checkout.session.completed') {
      const orderId = (obj.metadata && obj.metadata.orderId) || obj.client_reference_id || '';
      const amount = (obj.amount_total || 0) / 100;
      await persistPaidOrder(String((obj.metadata && obj.metadata.backend) || ''), String(orderId), {
        amount,
        customer: { email: String((obj.customer_details && obj.customer_details.email) || '') },
        method: 'Stripe',
        txnId: String(obj.payment_intent || obj.id || ''),
      });
    } else if (type === 'payment_intent.succeeded') {
      const amount = (obj.amount || 0) / 100;
      await persistPaidOrder(String((obj.metadata && obj.metadata.backend) || ''), String((obj.metadata && obj.metadata.orderId) || ''), {
        amount,
        method: 'Stripe',
        txnId: String(obj.id || ''),
      });
    }
  } catch (e: any) {
    console.error('[Stripe Webhook] persist failed:', e && e.message ? e.message : e);
  }
  res.status(200).json({ received: true });
}

// ── PayPal ────────────────────────────────────────────────────────────────
async function handlePaypal(req: VercelRequest, res: VercelResponse, raw: Buffer): Promise<void> {
  const transmissionId = String(req.headers['paypal-transmission-id'] || '');
  const timestamp = String(req.headers['paypal-transmission-time'] || '');
  const certUrl = String(req.headers['paypal-cert-url'] || '');
  const receivedSig = String(req.headers['paypal-transmission-sig'] || '');
  const rawBody = raw.toString('utf8');
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

// ── Razorpay ──────────────────────────────────────────────────────────────
async function handleRazorpay(req: VercelRequest, res: VercelResponse, raw: Buffer): Promise<void> {
  const rcvdSig = String(req.headers['x-razorpay-signature'] || '');
  const rawBody = raw.toString('utf8');
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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const gateway = norm(req.query.gateway);
  // Read the raw body ONCE (bodyParser is disabled) before any verification.
  const raw = await readRawBody(req);
  try { await loadDbPaymentSettings(); } catch { /* non-fatal: fall back to env */ }

  switch (gateway) {
    case 'stripe':   return handleStripe(req, res, raw);
    case 'paypal':   return handlePaypal(req, res, raw);
    case 'razorpay': return handleRazorpay(req, res, raw);
    default:
      res.status(400).json({ error: `Unknown or missing webhook gateway: '${gateway}'` });
      return;
  }
}
