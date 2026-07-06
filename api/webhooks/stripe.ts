// api/webhooks/stripe.ts
// Stripe server-to-server webhook for Vercel / serverless deployments.
// Mirrors the proven Node route in server.ts (POST /api/stripe/webhook).
//
// Why a dedicated function (and not an action inside api/payment.ts)?
// On Vercel the shared api/payment.ts function parses the JSON body, which
// destroys the exact raw bytes that Stripe's HMAC signature is computed over.
// This function disables body parsing so the signature can be verified.
//
// Credentials: the signing secret is read from Admin Panel -> Payment Settings
// first (via the shared loader), then from env. No double entry required.
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
  const sig = String(req.headers['stripe-signature'] || '');
  const raw = await readRawBody(req);
  try { await loadDbPaymentSettings(); } catch { /* non-fatal: fall back to env */ }
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
  // persistPaidOrder is idempotent (claimPaymentOnce dedupes gateway retries).
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
