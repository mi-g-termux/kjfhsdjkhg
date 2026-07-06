// api/payment.ts  ── v7 SELF-CONTAINED (zero lib/ imports)
// Works on Vercel, Netlify Functions, Render, cPanel, VPS — everywhere.
// No relative imports outside api/. All gateway code is inlined here.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────
function origin(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  return `${proto}://${req.headers.host}`;
}
function ok(res: VercelResponse, body: unknown) { return res.status(200).json(body); }
function fail(res: VercelResponse, status: number, msg: string, extra?: object) {
  return res.status(status).json({ success: false, error: msg, ...extra });
}
function norm(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v || '';
  return String(s).trim().toLowerCase();
}
export function env(k: string): string { return String(process.env[k] || '').trim(); }

// ── Supabase admin (server-side order persistence for verified webhooks) ─────
// Prefers the SERVICE ROLE key (bypasses RLS); falls back to the anon key.
function sbAdmin(): { url: string; key: string } | null {
  const url = (env('SUPABASE_URL') || env('VITE_SUPABASE_URL')).replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE') ||
              env('SUPABASE_ANON_KEY') || env('VITE_SUPABASE_ANON_KEY') ||
              env('SUPABASE_PUBLISHABLE_KEY') || env('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!env('SUPABASE_SERVICE_ROLE_KEY') && !env('SUPABASE_SERVICE_ROLE')) {
    console.error('[IPN] ⚠️ SUPABASE_SERVICE_ROLE_KEY missing — server payment writes use a non-service-role key and will be REJECTED once RLS is tightened. Set SUPABASE_SERVICE_ROLE_KEY in your host env.');
  }
  if (!url || !key) return null;
  return { url, key };
}

// ── Admin-panel credentials loader (no double entry) ─────────────────────────
// Server-to-server webhooks/IPNs have NO client request body, so they can't
// receive the gateway credentials the way interactive checkout does. Instead of
// forcing the store owner to ALSO paste every gateway secret into Vercel/host
// env vars, we read the credentials the admin already saved in Admin Panel →
// Payment Settings (persisted in the Supabase `settings` table under the
// `paymentSettings` key). This is the ONE thing that still needs env vars:
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, so the server can reach the DB at
// all. Everything else flows from the admin panel automatically.
// Cached for the lifetime of the (warm) serverless invocation.
let _psCache: Record<string, any> | null | undefined;
export async function loadDbPaymentSettings(): Promise<Record<string, any> | null> {
  if (_psCache !== undefined) return _psCache;
  // 1) Supabase settings table (settings.value = the PaymentSettings object)
  const cfg = sbAdmin();
  if (cfg) {
    try {
      const r = await fetch(
        `${cfg.url}/rest/v1/settings?key=eq.paymentSettings&select=value`,
        { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      );
      const rows: any = await r.json().catch(() => []);
      let val = Array.isArray(rows) && rows.length > 0 ? rows[0]?.value : null;
      // `value` may be stored as a JSON object (jsonb) or a JSON string.
      if (typeof val === 'string') { try { val = JSON.parse(val); } catch { /* keep string */ } }
      if (val && typeof val === 'object') { _psCache = val; return _psCache; }
    } catch (e: any) {
      console.warn('[payment] loadDbPaymentSettings (supabase) failed:', e?.message || e);
    }
  }
  // 2) Firestore settings/paymentSettings (Firebase-backend deployments)
  try {
    const db = await firebaseAdminDb();
    if (db) {
      const snap = await db.collection('settings').doc('paymentSettings').get();
      if (snap.exists) {
        const d = snap.data();
        const val = (d && typeof d.value === 'object' && d.value) ? d.value : d;
        if (val && typeof val === 'object') { _psCache = val; return _psCache; }
      }
    }
  } catch (e: any) {
    console.warn('[payment] loadDbPaymentSettings (firebase) failed:', e?.message || e);
  }
  _psCache = null;
  return _psCache;
}
// Sync accessor over the cached admin-panel settings. The main handler calls
// loadDbPaymentSettings() once before dispatching, so this is populated for every
// gateway handler. Precedence at each call site: body → dbc(DB) → env.
export function dbc(field: string): string {
  const v = _psCache && (_psCache as any)[field];
  return v == null ? '' : String(v).trim();
}
// Resolve a sandbox flag with body → DB → env precedence (defaults to true = safe sandbox).
export function sbx(bodyVal: unknown, dbField: string, envKey: string): boolean {
  if (bodyVal !== undefined) return bodyVal !== false;
  const dbVal = _psCache ? (_psCache as any)[dbField] : undefined;
  if (dbVal !== undefined && dbVal !== null) return dbVal !== false;
  return env(envKey) !== 'false';
}

// Mark an order Paid + Confirmed in Supabase from a VERIFIED server-to-server
// webhook. The gateway orderId is used as the row id, so the client (on return)
// and this webhook write to the SAME row -> no duplicate orders. If the customer
// never returned (closed the tab), a minimal recovery order is inserted so the
// payment is never lost. No-ops safely when Supabase env vars are absent.
// Native charge currency per gateway. Used to correctly LABEL a recovery order
// (customer-never-returned webhook fallback) when the store's display currency
// wasn't threaded through the webhook URL. e.g. a bKash charge is in BDT, so a
// recovery order whose total is the raw BDT amount must be labeled BDT, never $.
function nativeCcy(method?: string): string | undefined {
  switch ((method || '').toLowerCase()) {
    case 'sslcommerz': case 'bkash': case 'nagad': case 'rocket': return 'BDT';
    case 'razorpay': case 'paytm': case 'upi': return 'INR';
    case 'jazzcash': case 'easypaisa': return 'PKR';
    case 'payfast': return 'ZAR';
    default: return undefined; // Stripe / PayPal / COD / Bank charge in the store currency
  }
}

async function markOrderPaidInDb(orderId: string, extra: { amount?: number; storeTotal?: number; storeCurrency?: string; paidCurrency?: string; customer?: { name?: string; email?: string; phone?: string }; method?: string; txnId?: string } = {}): Promise<void> {
  const cfg = sbAdmin();
  if (!cfg || !orderId) { console.warn('[IPN] Supabase not configured — cannot persist order', orderId); return; }
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' };
  try {
    const getRes = await fetch(`${cfg.url}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,data`, { headers });
    const rows: any = await getRes.json().catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      const existing = (rows[0] && rows[0].data) || {};
      const merged = {
        ...existing,
        paymentStatus: existing.paymentStatus === 'Delivery Fee Paid' ? 'Delivery Fee Paid' : 'Paid',
        orderStatus: 'Confirmed',
        transactionId: existing.transactionId || extra.txnId || '',
      };
      const up = await fetch(`${cfg.url}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ data: merged }),
      });
      console.log('[IPN] Order marked Paid/Confirmed:', orderId, up.status);
      // Customer returned and saved the real order — drop the pending stash.
      await deletePendingOrderItemsSupabase(orderId);
    } else {
      // Bug-2 edge case: the shopper paid but never returned. Rebuild the
      // recovery order from the SLIM items stashed at create-payment time so it
      // keeps its real line items instead of items: [].
      const pending = await loadPendingOrderItemsSupabase(orderId);
      const recoveredItems = Array.isArray(pending?.items) ? pending!.items! : [];
      const recPaidCcy = extra.paidCurrency || nativeCcy(extra.method);
      const recStoreCcy = extra.storeCurrency || pending?.storeCurrency
        || ((extra.storeTotal === undefined && pending?.storeTotal === undefined) ? recPaidCcy : undefined);
      const recovery = {
        orderNumber: orderId, gatewayOrderId: orderId,
        customerName: extra.customer?.name || pending?.customer?.name || '',
        email: (extra.customer?.email || pending?.customer?.email || '').toLowerCase(),
        phone: extra.customer?.phone || pending?.customer?.phone || '',
        ...(pending?.customer?.address ? { address: pending.customer.address } : {}),
        ...(pending?.customer?.city ? { city: pending.customer.city } : {}),
        ...(pending?.customer?.postalCode ? { postalCode: pending.customer.postalCode } : {}),
        items: recoveredItems,
        ...(pending?.subtotal !== undefined ? { subtotal: pending.subtotal } : {}),
        ...(pending?.deliveryFee !== undefined ? { deliveryFee: pending.deliveryFee } : {}),
        // total is in the STORE currency (threaded via ipn_url or the pending
        // record). Fall back to the native charge only when neither was supplied.
        total: extra.storeTotal ?? pending?.storeTotal ?? extra.amount ?? 0,
        ...(recStoreCcy ? { currency: recStoreCcy } : {}),
        // What the gateway actually charged, in its native currency (e.g. BDT).
        paidAmount: extra.amount ?? 0,
        ...(recPaidCcy ? { paidCurrency: recPaidCcy } : {}),
        paymentMethod: extra.method || 'Online', transactionId: extra.txnId || '',
        paymentStatus: 'Paid', orderStatus: 'Confirmed', createdAt: new Date().toISOString(),
        _recoveredFromIpn: true,
        ...(recoveredItems.length > 0 ? { _recoveredItems: recoveredItems.length } : {}),
      };
      const ins = await fetch(`${cfg.url}/rest/v1/orders`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ id: orderId, data: recovery }),
      });
      console.log('[IPN] Recovery order inserted (customer did not return):', orderId, ins.status, `items=${recoveredItems.length}`);
      await deletePendingOrderItemsSupabase(orderId);
    }
  } catch (e: any) {
    console.error('[IPN] Failed to persist paid order:', e?.message || e);
  }
}

// ── Firebase Admin (server-side Firestore writes for verified webhooks) ──────
// Lazy-loaded so the common (Supabase/other) path stays light. Requires a
// service account via env: FIREBASE_SERVICE_ACCOUNT (full JSON) OR
// FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
async function firebaseAdminDb(): Promise<any | null> {
  try {
    const saJson = env('FIREBASE_SERVICE_ACCOUNT') || env('FIREBASE_SERVICE_ACCOUNT_JSON');
    let sa: any = null;
    if (saJson) { try { sa = JSON.parse(saJson); } catch { /* not JSON */ } }
    const projectId   = (sa && (sa.project_id  || sa.projectId))   || env('FIREBASE_PROJECT_ID') || env('VITE_FIREBASE_PROJECT_ID');
    const clientEmail = (sa && (sa.client_email || sa.clientEmail)) || env('FIREBASE_CLIENT_EMAIL');
    let   privateKey  = (sa && (sa.private_key  || sa.privateKey))  || env('FIREBASE_PRIVATE_KEY');
    if (!projectId || !clientEmail || !privateKey) return null;
    privateKey = String(privateKey).replace(/\\n/g, '\n');
    const admin = (await import('firebase-admin')).default as any;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
    }
    return admin.firestore();
  } catch (e: any) {
    console.error('[IPN] Firebase admin init failed:', e?.message || e);
    return null;
  }
}

// Mark an order Paid + Confirmed in Firestore. Same shared-id strategy as
// Supabase: the doc id IS the gateway orderId, so client + webhook hit the same
// document (no duplicates). Inserts a recovery doc if the customer never returned.
async function markOrderPaidFirebase(orderId: string, extra: { amount?: number; storeTotal?: number; storeCurrency?: string; paidCurrency?: string; customer?: { name?: string; email?: string; phone?: string }; method?: string; txnId?: string } = {}): Promise<void> {
  const db = await firebaseAdminDb();
  if (!db || !orderId) { console.warn('[IPN] Firebase not configured — cannot persist order', orderId); return; }
  try {
    const ref  = db.collection('orders').doc(orderId);
    const snap = await ref.get();
    if (snap.exists) {
      const existing = snap.data() || {};
      await ref.set({
        paymentStatus: existing.paymentStatus === 'Delivery Fee Paid' ? 'Delivery Fee Paid' : 'Paid',
        orderStatus: 'Confirmed',
        transactionId: existing.transactionId || extra.txnId || '',
      }, { merge: true });
      console.log('[IPN] (Firebase) Order marked Paid/Confirmed:', orderId);
      await deletePendingOrderItemsFirebase(orderId);
    } else {
      // Bug-2 edge case: rebuild the recovery order from the SLIM items stashed
      // at create-payment time (see Supabase branch) so it keeps its line items.
      const pending = await loadPendingOrderItemsFirebase(orderId);
      const recoveredItems = Array.isArray(pending?.items) ? pending!.items! : [];
      const recPaidCcy = extra.paidCurrency || nativeCcy(extra.method);
      const recStoreCcy = extra.storeCurrency || pending?.storeCurrency
        || ((extra.storeTotal === undefined && pending?.storeTotal === undefined) ? recPaidCcy : undefined);
      await ref.set({
        id: orderId, orderNumber: orderId, gatewayOrderId: orderId,
        customerName: extra.customer?.name || pending?.customer?.name || '',
        email: (extra.customer?.email || pending?.customer?.email || '').toLowerCase(),
        phone: extra.customer?.phone || pending?.customer?.phone || '',
        ...(pending?.customer?.address ? { address: pending.customer.address } : {}),
        ...(pending?.customer?.city ? { city: pending.customer.city } : {}),
        ...(pending?.customer?.postalCode ? { postalCode: pending.customer.postalCode } : {}),
        items: recoveredItems,
        ...(pending?.subtotal !== undefined ? { subtotal: pending.subtotal } : {}),
        ...(pending?.deliveryFee !== undefined ? { deliveryFee: pending.deliveryFee } : {}),
        total: extra.storeTotal ?? pending?.storeTotal ?? extra.amount ?? 0,
        ...(recStoreCcy ? { currency: recStoreCcy } : {}),
        paidAmount: extra.amount ?? 0,
        ...(recPaidCcy ? { paidCurrency: recPaidCcy } : {}),
        paymentMethod: extra.method || 'Online', transactionId: extra.txnId || '',
        paymentStatus: 'Paid', orderStatus: 'Confirmed', createdAt: new Date().toISOString(),
        _recoveredFromIpn: true,
        ...(recoveredItems.length > 0 ? { _recoveredItems: recoveredItems.length } : {}),
      });
      console.log('[IPN] (Firebase) Recovery order inserted (customer did not return):', orderId, `items=${recoveredItems.length}`);
      await deletePendingOrderItemsFirebase(orderId);
    }
  } catch (e: any) {
    console.error('[IPN] Firebase persist failed:', e?.message || e);
  }
}

// Backend-agnostic dispatcher — honors the admin's chosen engine (passed from
// the client through create-payment into the webhook URL). Falls back to
// whichever server credentials are configured when the hint is absent.
// Idempotency guard for the stateless Vercel runtime. Uses the shared
// processed_payments store so a gateway that retries its IPN/webhook cannot
// fulfill the same payment twice (parity with server.ts markPaymentProcessed).
// Returns true if this key is NEW (safe to process), false if already handled.
// Fails OPEN only on infra errors so a genuine first-time payment is never lost.
async function claimPaymentOnce(key: string, method?: string, orderId?: string, amount?: number): Promise<boolean> {
  if (!key) return true;
  const cfg = sbAdmin();
  if (cfg) {
    try {
      const r = await fetch(`${cfg.url}/rest/v1/processed_payments`, {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ payment_id: key, gateway: method || 'unknown', order_id: orderId || null, amount: amount ?? null }),
      });
      if (r.status === 409) return false; // primary-key conflict => already processed
      return true;
    } catch { return true; }
  }
  const db = await firebaseAdminDb();
  if (db) {
    try {
      const ref = db.collection('processed_payments').doc(key);
      return await db.runTransaction(async (tx: any) => {
        const s = await tx.get(ref);
        if (s.exists) return false;
        tx.set(ref, { gateway: method || 'unknown', orderId: orderId || null, amount: amount ?? null, processedAt: new Date().toISOString() });
        return true;
      });
    } catch { return true; }
  }
  return true;
}

export async function persistPaidOrder(backend: string, orderId: string, extra: { amount?: number; storeTotal?: number; storeCurrency?: string; paidCurrency?: string; customer?: { name?: string; email?: string; phone?: string }; method?: string; txnId?: string } = {}): Promise<void> {
  const b = String(backend || '').toLowerCase();
  // Idempotency: block duplicate gateway retries before any fulfillment write.
  const _idemKey = `${(extra.method || 'gw')}:${extra.txnId || orderId}`;
  if (!(await claimPaymentOnce(_idemKey, extra.method, orderId, extra.amount))) {
    console.warn('[IPN] Duplicate payment blocked (already processed):', _idemKey);
    return;
  }
  if (b === 'firebase') return markOrderPaidFirebase(orderId, extra);
  if (b === 'supabase') return markOrderPaidInDb(orderId, extra);
  if (b === 'local') { console.warn('[IPN] Active engine is "local" (browser-only) — server cannot persist order', orderId); return; }
  // No/unknown hint: use whichever backend is configured server-side.
  if (sbAdmin())              return markOrderPaidInDb(orderId, extra);
  if (await firebaseAdminDb()) return markOrderPaidFirebase(orderId, extra);
  console.warn('[IPN] No backend configured to persist order', orderId);
}

// ── Pending order-items holding store (Bug-2 edge case) ──────────────────────
// A redirect gateway's create-payment request does NOT carry the cart to the
// gateway, so a server-to-server IPN that fires when the shopper never returns
// could previously only build a recovery order with items: []. We now stash a
// SLIM copy of the line items (NEVER base64 images), keyed by the gateway
// orderId, at create-payment time; the IPN recovery branch reads them back so
// recovery orders keep their real line items.
//
// Degrades gracefully: if the pending_orders table/collection is absent (an
// install that has not re-run the Install Wizard SQL) or only the anon key is
// available server-side, every call below no-ops and recovery falls back to the
// previous items: [] behaviour — no regression.
type SlimOrderItem = { productId?: string; name?: string; quantity?: number; price?: number; image?: string; variantLabel?: string };
type PendingOrderRecord = {
  items?: SlimOrderItem[];
  customer?: { name?: string; email?: string; phone?: string; address?: string; city?: string; postalCode?: string };
  storeTotal?: number; storeCurrency?: string; subtotal?: number; deliveryFee?: number;
};
// Never let a base64 data: URL into the holding store — keep it slim.
function pendingNoDataUrl(u?: unknown): string | undefined {
  return typeof u === 'string' && !u.startsWith('data:') ? u : undefined;
}
function toSlimOrderItems(items: unknown): SlimOrderItem[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 200).map((it: any) => ({
    productId: it?.productId != null ? String(it.productId) : undefined,
    name: it?.name != null ? String(it.name) : undefined,
    quantity: Number(it?.quantity) || 0,
    price: Number(it?.price) || 0,
    image: pendingNoDataUrl(it?.image),
    variantLabel: it?.variantLabel != null ? String(it.variantLabel) : undefined,
  }));
}
async function savePendingOrderItemsSupabase(orderId: string, data: PendingOrderRecord): Promise<void> {
  const cfg = sbAdmin();
  if (!cfg || !orderId) return;
  try {
    await fetch(`${cfg.url}/rest/v1/pending_orders`, {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: orderId, data }),
    });
  } catch (e: any) { console.warn('[create-payment] pending items save skipped (Supabase):', e?.message || e); }
}
async function loadPendingOrderItemsSupabase(orderId: string): Promise<PendingOrderRecord | null> {
  const cfg = sbAdmin();
  if (!cfg || !orderId) return null;
  try {
    const r = await fetch(`${cfg.url}/rest/v1/pending_orders?id=eq.${encodeURIComponent(orderId)}&select=data`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    const rows: any = await r.json().catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) return (rows[0] && rows[0].data) || null;
  } catch { /* table may not exist yet — degrade gracefully */ }
  return null;
}
async function deletePendingOrderItemsSupabase(orderId: string): Promise<void> {
  const cfg = sbAdmin();
  if (!cfg || !orderId) return;
  try {
    await fetch(`${cfg.url}/rest/v1/pending_orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'return=minimal' },
    });
  } catch { /* ignore cleanup failure */ }
}
async function savePendingOrderItemsFirebase(orderId: string, data: PendingOrderRecord): Promise<void> {
  const db = await firebaseAdminDb();
  if (!db || !orderId) return;
  try { await db.collection('pending_orders').doc(orderId).set({ ...data, createdAt: new Date().toISOString() }, { merge: true }); }
  catch (e: any) { console.warn('[create-payment] pending items save skipped (Firebase):', e?.message || e); }
}
async function loadPendingOrderItemsFirebase(orderId: string): Promise<PendingOrderRecord | null> {
  const db = await firebaseAdminDb();
  if (!db || !orderId) return null;
  try { const s = await db.collection('pending_orders').doc(orderId).get(); return s.exists ? (s.data() as PendingOrderRecord) : null; }
  catch { return null; }
}
async function deletePendingOrderItemsFirebase(orderId: string): Promise<void> {
  const db = await firebaseAdminDb();
  if (!db || !orderId) return;
  try { await db.collection('pending_orders').doc(orderId).delete(); } catch { /* ignore cleanup failure */ }
}
// Backend-agnostic save — honors the admin's chosen engine (hint from the
// client's create-payment call), matching persistPaidOrder's dispatch.
async function savePendingOrderItems(backend: string, orderId: string, data: PendingOrderRecord): Promise<void> {
  const b = String(backend || '').toLowerCase();
  if (b === 'firebase') return savePendingOrderItemsFirebase(orderId, data);
  if (b === 'supabase') return savePendingOrderItemsSupabase(orderId, data);
  if (b === 'local') return; // browser-only engine — nothing server-side to persist to
  if (sbAdmin()) return savePendingOrderItemsSupabase(orderId, data);
  if (await firebaseAdminDb()) return savePendingOrderItemsFirebase(orderId, data);
}

// ── bKash ─────────────────────────────────────────────────────────────────────
function bkashBase(sandbox: boolean) {
  return sandbox
    ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout'
    : 'https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized/checkout';
}
async function bkashToken(appKey: string, appSecret: string, username: string, password: string, sandbox: boolean): Promise<string> {
  const r = await fetch(`${bkashBase(sandbox)}/token/grant`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', username, password },
    body: JSON.stringify({ app_key: appKey, app_secret: appSecret }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!d.id_token) throw new Error(d.statusMessage || `bKash token failed (${r.status})`);
  return d.id_token as string;
}
async function bkashCreatePayment(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const amount = body.amount;
  const orderId = body.orderId || `ORD-${Date.now().toString(36).toUpperCase()}`;
  const callbackURL = body.callbackURL || body.callbackUrl;
  if (!amount || !callbackURL) return fail(res, 400, 'amount and callbackURL required');
  const appKey   = body.appKey    || dbc('bKashAppKey') || env('BKASH_APP_KEY');
  const appSecret = body.appSecret || dbc('bKashAppSecret') || env('BKASH_APP_SECRET');
  const username  = body.username  || dbc('bKashUsername') || env('BKASH_USERNAME');
  const password  = body.password  || dbc('bKashPassword') || env('BKASH_PASSWORD');
  const sandbox   = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('BKASH_SANDBOX') !== 'false');
  if (!appKey || !appSecret || !username || !password)
    return fail(res, 400, 'Missing bKash credentials');
  try {
    const token = await bkashToken(appKey, appSecret, username, password, sandbox);
    const r = await fetch(`${bkashBase(sandbox)}/create`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token, 'X-APP-Key': appKey },
      body: JSON.stringify({
        mode: '0011', payerReference: orderId, callbackURL,
        amount: Number(amount).toFixed(2), currency: 'BDT', intent: 'sale', merchantInvoiceNumber: orderId,
      }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!d.bkashURL) return fail(res, 502, d.statusMessage || 'bKash create failed');
    // Bug-2 edge case (all gateways): stash SLIM line items keyed by orderId so a
    // later recovery (execute safety-net / webhook) rebuilds the order WITH its
    // real items instead of items: []. Degrades gracefully if pending_orders is absent.
    await savePendingOrderItems(String(body.backend || ''), String(orderId), {
      items: toSlimOrderItems(body.items),
      customer: body.customer,
      storeTotal: Number(body.orderTotal) || undefined,
      storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
      subtotal: Number(body.subtotal) || undefined,
      deliveryFee: Number(body.deliveryFee) || undefined,
    });
    return ok(res, { success: true, bkashURL: d.bkashURL, paymentID: d.paymentID });
  } catch (e: any) { return fail(res, 500, e.message); }
}
async function bkashExecutePayment(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const paymentID = body.paymentID || body.paymentId || (req.query.paymentID as string);
  if (!paymentID) return fail(res, 400, 'paymentID required');
  const appKey   = body.appKey   || dbc('bKashAppKey') || env('BKASH_APP_KEY');
  const appSecret = body.appSecret || dbc('bKashAppSecret') || env('BKASH_APP_SECRET');
  const username  = body.username  || dbc('bKashUsername') || env('BKASH_USERNAME');
  const password  = body.password  || dbc('bKashPassword') || env('BKASH_PASSWORD');
  const sandbox   = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('BKASH_SANDBOX') !== 'false');
  if (!appKey) return fail(res, 400, 'Missing bKash credentials');
  try {
    const token = await bkashToken(appKey, appSecret, username, password, sandbox);
    const r = await fetch(`${bkashBase(sandbox)}/execute`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token, 'X-APP-Key': appKey },
      body: JSON.stringify({ paymentID }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (d.transactionStatus !== 'Completed')
      return fail(res, 502, d.statusMessage || 'bKash execute failed', { transactionStatus: d.transactionStatus });
    // Path-B safety net: persist server-side the instant bKash confirms, so the
    // order survives even if the client dies before placing it. Honors the
    // admin's backend (client passes orderId + backend); no-ops safely otherwise.
    await persistPaidOrder(String(body.backend || ''), String(body.orderId || ''), {
      amount: Number(d.amount) || undefined, method: 'bKash', txnId: d.trxID,
    });
    return ok(res, { success: true, paymentID: d.paymentID, transactionId: d.trxID, amount: d.amount });
  } catch (e: any) { return fail(res, 500, e.message); }
}

// ── Nagad ─────────────────────────────────────────────────────────────────────
const NAGAD_PUB_KEY =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAty2hOpfNUS4NLFNwhJsy\n' +
  'JCfsLisFqcU8RcZGtUE/9SqLNCBR5GoxFAyx0RBfDOyOXyVlAj4nBjBKLi63rGzG\n' +
  'a04L+y4SLZjzukWZSrkXa3kcMtH2QQ1JcSf1hEt+gNW1u/m+ZHrXnXjg1JG9wKjN\n' +
  '/0HHTtA9rIa9XwIDAQAB\n' +
  '-----END PUBLIC KEY-----';
function nagadEncrypt(data: string, pubKey: string): string {
  return crypto.publicEncrypt({ key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(data)).toString('base64');
}
function nagadSign(data: string, privKey: string): string {
  const s = crypto.createSign('SHA256'); s.update(data); s.end(); return s.sign(privKey, 'base64');
}
function asPem(key: string, label: 'PUBLIC' | 'PRIVATE'): string {
  if (key.includes('-----BEGIN')) return key.replace(/\\n/g, '\n');
  return `-----BEGIN ${label} KEY-----\n${key}\n-----END ${label} KEY-----`;
}
async function nagadCreatePayment(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId } = body;
  // FIX-04: Nagad POSTs to merchantCallbackURL - must be backend, not frontend URL
  const callbackUrl = body.callbackUrl || `${origin(req)}/api/nagad/callback?orderId=${encodeURIComponent(String(orderId))}`;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const merchantId   = body.merchantId    || dbc('nagadMerchantId') || env('NAGAD_MERCHANT_ID');
  const privateKeyRaw = body.privateKey   || dbc('nagadMerchantPrivateKey') || env('NAGAD_PRIVATE_KEY');
  const isSandbox     = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('NAGAD_SANDBOX') !== 'false');
  if (!merchantId || !privateKeyRaw) return fail(res, 400, 'Missing NAGAD_MERCHANT_ID or NAGAD_PRIVATE_KEY');
  const base = isSandbox
    ? 'https://sandbox.mynagad.com:10080/remote-payment-gateway-1.0/api/dfs'
    : 'https://api.mynagad.com/api/dfs';
  const privKey = asPem(privateKeyRaw, 'PRIVATE');
  const pubKey  = body.publicKey ? asPem(body.publicKey, 'PUBLIC') : (dbc('nagadPublicKey') ? asPem(dbc('nagadPublicKey'), 'PUBLIC') : NAGAD_PUB_KEY);
  try {
    const datetime = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const challenge = crypto.randomBytes(20).toString('hex');
    const sensitive = { merchantId, datetime, orderId, challenge };
    const enc = nagadEncrypt(JSON.stringify(sensitive), pubKey);
    const sig = nagadSign(JSON.stringify(sensitive), privKey);
    const initR = await fetch(`${base}/check-out/initialize/${merchantId}/${orderId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-KM-IP-V4': (req.headers['x-forwarded-for'] as string) || '127.0.0.1',
        'X-KM-Client-Type': 'PC_WEB', 'X-KM-Api-Version': 'v-0.2.0',
      },
      body: JSON.stringify({ dateTime: datetime, sensitiveData: enc, signature: sig }),
    });
    const initJ: any = await initR.json().catch(() => ({}));
    if (!initJ?.sensitiveData) return fail(res, 502, initJ?.reason || 'Nagad init failed');
    const cSens = { merchantId, orderId, amount: String(amount), currencyCode: '050', challenge };
    const cEnc  = nagadEncrypt(JSON.stringify(cSens), pubKey);
    const cSig  = nagadSign(JSON.stringify(cSens), privKey);
    const confR = await fetch(`${base}/check-out/complete/${initJ.paymentReferenceId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensitiveData: cEnc, signature: cSig, merchantCallbackURL: callbackUrl }),
    });
    const confJ: any = await confR.json().catch(() => ({}));
    if (!confJ?.callBackUrl) return fail(res, 502, confJ?.reason || 'Nagad confirm failed');
    // Bug-2 edge case: stash SLIM items keyed by orderId for recovery parity.
    await savePendingOrderItems(String(body.backend || ''), String(orderId), {
      items: toSlimOrderItems(body.items),
      customer: body.customer,
      storeTotal: Number(body.orderTotal) || undefined,
      storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
      subtotal: Number(body.subtotal) || undefined,
      deliveryFee: Number(body.deliveryFee) || undefined,
    });
    return ok(res, { success: true, callBackUrl: confJ.callBackUrl, orderId });
  } catch (e: any) { return fail(res, 500, e.message); }
}
async function nagadVerifyPayment(req: VercelRequest, res: VercelResponse) {
  const refId = (req.query.payment_ref_id as string) || req.body?.paymentRefId || req.body?.payment_ref_id;
  if (!refId) return fail(res, 400, 'paymentRefId required');
  const isSandbox = sbx(undefined, 'nagadSandboxMode', 'NAGAD_SANDBOX');
  const base = isSandbox
    ? 'https://sandbox.mynagad.com:10080/remote-payment-gateway-1.0/api/dfs'
    : 'https://api.mynagad.com/api/dfs';
  const r = await fetch(`${base}/verify/payment/${refId}`).catch(() => null);
  if (!r) return fail(res, 502, 'Nagad verify unreachable');
  const j: any = await r.json().catch(() => ({}));
  const nagadOk = j?.status === 'Success' || j?.statusCode === '000';
  if (nagadOk) await persistPaidOrder(String(req.body?.backend || req.query.backend || ''), String(req.body?.orderId || req.query.orderId || ''), {
    amount: Number(j?.amount) || undefined, method: 'Nagad', txnId: refId,
  });
  return ok(res, { success: nagadOk, raw: j });
}
// FIX (Nagad 404): after payment, Nagad redirects the browser to
// merchantCallbackURL (/api/nagad/callback) with order_id/payment_ref_id/status.
// This action was previously unregistered, so the router returned
// {"error":"Unknown action: callback"} (404). We 302-redirect back to the SPA;
// the frontend then calls /api/nagad/verify-payment to confirm the transaction.
function nagadCallback(req: VercelRequest, res: VercelResponse) {
  res.setHeader('X-Robots-Tag', 'noindex');
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const q = req.query;
  const orderId      = String(q.order_id || q.orderId || body.order_id || '');
  const paymentRefId = String(q.payment_ref_id || body.payment_ref_id || '');
  const status       = String(q.status || body.status || '').toLowerCase();
  const redirectUrl = new URL('/', origin(req));
  if (!paymentRefId || !['success', 'completed'].includes(status)) {
    redirectUrl.searchParams.set('nagad', 'failed');
    if (orderId) redirectUrl.searchParams.set('order', orderId);
    return res.redirect(302, redirectUrl.toString());
  }
  // Frontend (CartModal) reads params.get('nagad') and params.get('ref')
  redirectUrl.searchParams.set('nagad', 'success');
  if (orderId) redirectUrl.searchParams.set('order', orderId);
  redirectUrl.searchParams.set('ref', paymentRefId);
  return res.redirect(302, redirectUrl.toString());
}

// ── SSLCommerz ─────────────────────────────────────────────────��──────────────
const _sslPending = new Set<string>();
async function sslcommerzCreatePayment(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId, customer = {}, productName = 'Order' } = body;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const oid = String(orderId);
  const backend = String(body.backend || '').toLowerCase();
  if (_sslPending.has(oid)) return fail(res, 429, 'Already processing this order');
  _sslPending.add(oid);
  try {
    const storeId   = body.storeId   || body.sslCommerzStoreId   || dbc('sslCommerzStoreId') || env('SSLCZ_STORE_ID');
    const storePass = body.storePass || body.sslCommerzStorePassword || dbc('sslCommerzStorePassword') || env('SSLCZ_STORE_PASSWORD');
    const sandbox   = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('SSLCZ_SANDBOX') !== 'false');
    if (!storeId || !storePass) return fail(res, 400, 'Missing SSLCommerz store credentials (SSLCZ_STORE_ID / SSLCZ_STORE_PASSWORD)');
    const base = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
    const o = origin(req);
    // FIX (reg_id): SSLCommerz rejects a reused tran_id with "Invalid request (reg_id)!".
    // Use a UNIQUE tran_id per attempt; the real order id stays in value_a
    // (and in the success/fail/cancel URLs), which the callback & IPN read.
    const tranId = `${oid}-${Date.now().toString(36)}`;
    const form = new URLSearchParams({
      store_id: storeId, store_passwd: storePass,
      total_amount: Number(amount).toFixed(2), currency: 'BDT', tran_id: tranId,
      // FIX-02: success/fail/cancel -> /callback (validates); ipn -> /ipn (server webhook)
      success_url: `${o}/api/sslcommerz/callback?status=success&orderId=${encodeURIComponent(oid)}&sslcz_sandbox=${sandbox ? '1' : '0'}`,
      fail_url:    `${o}/api/sslcommerz/callback?status=failed&orderId=${encodeURIComponent(oid)}&sslcz_sandbox=${sandbox ? '1' : '0'}`,
      cancel_url:  `${o}/api/sslcommerz/callback?status=cancelled&orderId=${encodeURIComponent(oid)}&sslcz_sandbox=${sandbox ? '1' : '0'}`,
      ipn_url:     `${o}/api/sslcommerz/ipn?sslcz_sandbox=${sandbox ? '1' : '0'}&backend=${encodeURIComponent(backend)}&order_total=${encodeURIComponent(String(body.orderTotal ?? ''))}&order_ccy=${encodeURIComponent(String(body.orderCurrency ?? ''))}`,
      cus_name:    String(customer.name    || 'Customer'),
      cus_email:   String(customer.email   || 'noreply@example.com'),
      cus_phone:   String(customer.phone   || '01700000000'),
      cus_add1:    String(customer.address || 'N/A'),
      cus_city:    String(customer.city    || 'Dhaka'),
      cus_country: String(customer.country || 'Bangladesh'),
      shipping_method: 'NO', product_name: String(productName).slice(0, 100),
      product_category: 'general', product_profile: 'general',
      num_of_item: '1', value_a: oid,
      // value_b/c/d carry customer info so the IPN webhook can rebuild a minimal
      // order if the customer closes the tab before returning to the site.
      value_b: String(customer.name || ''), value_c: String(customer.email || ''), value_d: String(customer.phone || ''),
    });
    const r = await fetch(`${base}/gwprocess/v4/api.php`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const text = await r.text();
    let j: any;
    try { j = JSON.parse(text); } catch { return fail(res, 502, `SSLCommerz returned non-JSON: ${text.slice(0, 120)}`); }
    if (j?.status !== 'SUCCESS' || !j?.GatewayPageURL)
      return fail(res, 502, j?.failedreason || j?.status || 'SSLCommerz session failed');
    // Bug-2 edge case: stash SLIM line items (base64 stripped) keyed by orderId
    // so a server-to-server IPN that fires when the shopper never returns can
    // rebuild a recovery order WITH its real items instead of items: [].
    await savePendingOrderItems(backend, oid, {
      items: toSlimOrderItems(body.items),
      customer: {
        name: customer.name, email: customer.email, phone: customer.phone,
        address: customer.address, city: customer.city, postalCode: customer.postalCode,
      },
      storeTotal: Number(body.orderTotal) || undefined,
      storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
      subtotal: Number(body.subtotal) || undefined,
      deliveryFee: Number(body.deliveryFee) || undefined,
    });
    return ok(res, { success: true, redirectUrl: j.GatewayPageURL, sessionkey: j.sessionkey });
  } catch (e: any) { return fail(res, 500, e.message); }
  finally { setTimeout(() => _sslPending.delete(oid), 30_000); }
}
// Shared SSLCommerz validation helper — validates a transaction via val_id
// against the SSLCommerz validation API (developer.sslcommerz.com).
async function sslcommerzValidate(valId: string, sandboxOverride?: boolean): Promise<boolean> {
  if (!valId) return false;
  try {
    // Admin-panel credentials first (no double entry), env var as fallback.
    const ps = await loadDbPaymentSettings();
    const storeId   = env('SSLCZ_STORE_ID')       || String(ps?.sslCommerzStoreId       || '');
    const storePass = env('SSLCZ_STORE_PASSWORD') || String(ps?.sslCommerzStorePassword || '');
    // Use the mode the payment was actually created with (passed via callback URL)
    // and fall back to the admin panel / env only when no override was provided.
    const sandbox   = sandboxOverride !== undefined ? sandboxOverride
                    : (env('SSLCZ_STORE_ID') ? env('SSLCZ_SANDBOX') !== 'false'
                    : (ps?.sslCommerzSandboxMode !== undefined ? ps.sslCommerzSandboxMode !== false : true));
    if (!storeId || !storePass) { console.warn('[SSLCommerz] validate: no store credentials in env or admin panel'); return false; }
    const base = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
    const vr = await fetch(`${base}/validator/api/validationserverAPI.php?val_id=${encodeURIComponent(valId)}&store_id=${encodeURIComponent(storeId)}&store_passwd=${encodeURIComponent(storePass)}&format=json`);
    if (!vr.ok) return false;
    const vj: any = await vr.json().catch(() => ({}));
    return vj?.status === 'VALID' || vj?.status === 'VALIDATED';
  } catch { return false; }
}
// FIX (SSLCommerz 404): SSLCommerz POSTs (x-www-form-urlencoded) the customer's
// browser to success_url / fail_url / cancel_url — all of which point at
// /api/sslcommerz/callback. This handler was previously unregistered, so the
// router returned {"error":"Unknown action: callback"} (404). We now validate
// the transaction (on success) and 302-redirect the browser back to the SPA so
// the frontend can finalise the order.
async function sslcommerzCallback(req: VercelRequest, res: VercelResponse) {
  res.setHeader('X-Robots-Tag', 'noindex');
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const qs   = req.query;
  const status  = String(qs.status  || body.status  || '').toLowerCase();
  const orderId = String(qs.orderId || body.value_a || body.tran_id || '');
  const tranId  = String(body.tran_id || '');
  const valId   = String(body.val_id  || qs.val_id || '');
  const sandboxFlag = String((qs.sslcz_sandbox ?? body.sslcz_sandbox ?? '') as string);
  const sandboxOverride = sandboxFlag === '' ? undefined : (sandboxFlag === '1' || sandboxFlag.toLowerCase() === 'true');
  const verified = status === 'success' ? await sslcommerzValidate(valId, sandboxOverride) : false;
  const flag = status === 'success' ? (verified ? 'success' : 'failed')
             : (status === 'fail' || status === 'failed') ? 'failed'
             : 'cancelled';
  const redirectUrl = new URL('/', origin(req));
  // Frontend (CartModal) reads params.get('sslcz') || params.get('sslcommerz')
  redirectUrl.searchParams.set('sslcommerz', flag);
  if (orderId) redirectUrl.searchParams.set('orderId', orderId);
  if (tranId)  redirectUrl.searchParams.set('tranId', tranId);
  if (valId)   redirectUrl.searchParams.set('val_id', valId);
  return res.redirect(302, redirectUrl.toString());
}
// FIX: SSLCommerz IPN is a server-to-server webhook (developer.sslcommerz.com).
// It must validate via the validation API and always respond 200 OK — never a
// browser redirect (that was the previous incorrect behaviour).
async function sslcommerzIpn(req: VercelRequest, res: VercelResponse) {
  const body = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : {};
  const status  = String(body.status  || '');
  const orderId = String(body.value_a || body.tran_id || '');
  const valId   = String(body.val_id  || '');
  const sandboxFlag = String((req.query.sslcz_sandbox ?? body.sslcz_sandbox ?? '') as string);
  const sandboxOverride = sandboxFlag === '' ? undefined : (sandboxFlag === '1' || sandboxFlag.toLowerCase() === 'true');
  if (!valId) { console.warn('[SSLCommerz IPN] missing val_id — cannot validate'); return res.status(200).send('OK'); }
  const verified = await sslcommerzValidate(valId, sandboxOverride);
  const backend = String((req.query.backend ?? body.backend ?? '') as string);
  console.log('[SSLCommerz IPN]', verified ? 'VALID' : 'INVALID', { status, orderId, valId, backend });
  if (verified && (status === 'VALID' || status === 'VALIDATED')) {
    const chargedAmount = Number(body.currency_amount || body.store_amount || body.amount || 0);
    const storeTotal = Number(req.query.order_total ?? '') || undefined;
    const storeCurrency = (String(req.query.order_ccy ?? '') || '').toUpperCase() || undefined;
    await persistPaidOrder(backend, orderId, {
      amount: chargedAmount,
      storeTotal,
      storeCurrency,
      paidCurrency: 'BDT',
      customer: { name: String(body.value_b || ''), email: String(body.value_c || ''), phone: String(body.value_d || '') },
      method: 'SSLCommerz', txnId: valId,
    });
  }
  return res.status(200).send('OK');
}

// ── Stripe ────────────────────────────────────────────────────────────────────
async function stripeCreatePaymentIntent(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, currency = 'usd' } = body;
  if (!amount) return fail(res, 400, 'amount required');
  const secretKey = body.secretKey || dbc('stripeSecretKey') || env('STRIPE_SECRET_KEY');
  if (!secretKey) return fail(res, 400, 'Missing STRIPE_SECRET_KEY');
  const piParams = new URLSearchParams({
    amount: String(Math.round(Number(amount) * 100)),
    currency: String(currency).toLowerCase(),
    'automatic_payment_methods[enabled]': 'true',
  });
  // Thread the internal orderId (+ backend) into the PaymentIntent metadata so a
  // server-to-server webhook (payment_intent.succeeded) can map the charge back
  // to the order even if the shopper never returns to the site.
  if (body.orderId) {
    piParams.set('metadata[orderId]', String(body.orderId));
    if (body.backend) piParams.set('metadata[backend]', String(body.backend));
  }
  const r = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: piParams.toString(),
  });
  const d: any = await r.json().catch(() => ({}));
  if (d.error) return fail(res, 502, d.error.message);
  return ok(res, { success: true, clientSecret: d.client_secret, paymentIntentId: d.id });
}
async function stripeConfirmPayment(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { paymentIntentId, paymentMethodId } = body;
  if (!paymentIntentId || !paymentMethodId) return fail(res, 400, 'paymentIntentId and paymentMethodId required');
  const secretKey = body.secretKey || dbc('stripeSecretKey') || env('STRIPE_SECRET_KEY');
  if (!secretKey) return fail(res, 400, 'Missing STRIPE_SECRET_KEY');
  const r = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payment_method: paymentMethodId }).toString(),
  });
  const d: any = await r.json().catch(() => ({}));
  if (d.error) return fail(res, 502, d.error.message);
  return ok(res, { success: true, status: d.status, transactionId: d.id });
}
async function stripeCreateCheckoutSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, currency = 'usd', orderId, productName = 'Order', customerEmail, successUrl, cancelUrl } = body;
  if (!amount || !successUrl || !cancelUrl) return fail(res, 400, 'amount, successUrl, cancelUrl required');
  const secretKey = body.secretKey || dbc('stripeSecretKey') || env('STRIPE_SECRET_KEY');
  if (!secretKey) return fail(res, 400, 'Missing STRIPE_SECRET_KEY');
  const p = new URLSearchParams({
    mode: 'payment', success_url: successUrl, cancel_url: cancelUrl,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': String(currency).toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(Math.round(Number(amount) * 100)),
    'line_items[0][price_data][product_data][name]': String(productName).slice(0, 250),
  });
  if (customerEmail) p.set('customer_email', String(customerEmail));
  if (orderId) { p.set('client_reference_id', String(orderId)); p.set('metadata[orderId]', String(orderId)); if (body.backend) p.set('metadata[backend]', String(body.backend)); }
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST', headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
  });
  const d: any = await r.json().catch(() => ({}));
  if (d.error || !d.url) return fail(res, 502, d.error?.message || 'Stripe checkout session failed');
  // Bug-2 edge case: stash SLIM items keyed by orderId (== metadata.orderId the
  // Stripe webhook reads) so a shopper who pays but never returns still gets a
  // recovery order WITH its real items.
  if (orderId) await savePendingOrderItems(String(body.backend || ''), String(orderId), {
    items: toSlimOrderItems(body.items),
    customer: body.customer,
    storeTotal: Number(body.orderTotal) || undefined,
    storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
    subtotal: Number(body.subtotal) || undefined,
    deliveryFee: Number(body.deliveryFee) || undefined,
  });
  return ok(res, { success: true, sessionId: d.id, url: d.url });
}

// ── PayPal ────────────────────────────────────────────────────────────────────
async function ppToken(clientId: string, secret: string, sandbox: boolean) {
  const base = sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const d: any = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error(`PayPal token failed: ${d.error_description || r.status}`);
  return { token: d.access_token as string, base };
}
async function paypalCreateOrder(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, currency = 'USD' } = body;
  if (!amount) return fail(res, 400, 'amount required');
  const clientId     = body.clientId     || dbc('paypalClientId') || env('PAYPAL_CLIENT_ID');
  const clientSecret = body.clientSecret || dbc('paypalClientSecret') || env('PAYPAL_CLIENT_SECRET');
  const sandbox      = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('PAYPAL_SANDBOX') !== 'false');
  if (!clientId || !clientSecret) return fail(res, 400, 'Missing PayPal credentials');
  try {
    const { token, base } = await ppToken(clientId, clientSecret, sandbox);
    const o = origin(req);
    const r = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: String(currency).toUpperCase(), value: Number(amount).toFixed(2) }, ...((body.internalOrderId || body.orderId) ? { custom_id: String(body.internalOrderId || body.orderId) } : {}) }],
        application_context: {
          return_url: `${o}/api/paypal/callback?status=success`,
          cancel_url: `${o}/api/paypal/callback?status=cancelled`,
        },
      }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!d.id) return fail(res, 502, d.message || 'PayPal order creation failed');
    // Bug-2 edge case: stash SLIM items keyed by PayPal's order id (d.id) — the
    // same id the client sends back to /paypal/capture-order, whose recovery
    // branch reads it — so a capture that lands without the client rebuilds items.
    await savePendingOrderItems(String(body.backend || ''), String(d.id), {
      items: toSlimOrderItems(body.items),
      customer: body.customer,
      storeTotal: Number(body.orderTotal) || undefined,
      storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
      subtotal: Number(body.subtotal) || undefined,
      deliveryFee: Number(body.deliveryFee) || undefined,
    });
    return ok(res, { success: true, orderId: d.id, approvalUrl: d.links?.find((l: any) => l.rel === 'approve')?.href });
  } catch (e: any) { return fail(res, 500, e.message); }
}
async function paypalCaptureOrder(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { orderId } = body;
  if (!orderId) return fail(res, 400, 'orderId required');
  const clientId     = body.clientId     || dbc('paypalClientId') || env('PAYPAL_CLIENT_ID');
  const clientSecret = body.clientSecret || dbc('paypalClientSecret') || env('PAYPAL_CLIENT_SECRET');
  const sandbox      = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('PAYPAL_SANDBOX') !== 'false');
  if (!clientId || !clientSecret) return fail(res, 400, 'Missing PayPal credentials');
  try {
    const { token, base } = await ppToken(clientId, clientSecret, sandbox);
    const r = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const d: any = await r.json().catch(() => ({}));
    if (d.status === 'COMPLETED') {
      await persistPaidOrder(String(body.backend || ''), String(body.internalOrderId || body.orderId || ''), {
        method: 'PayPal', txnId: d.purchase_units?.[0]?.payments?.captures?.[0]?.id,
      });
      return ok(res, { success: true, transactionId: d.purchase_units?.[0]?.payments?.captures?.[0]?.id });
    }
    return fail(res, 502, d.message || 'PayPal capture failed');
  } catch (e: any) { return fail(res, 500, e.message); }
}
function paypalCallback(req: VercelRequest, res: VercelResponse) {
  const { token, status } = req.query;
  return res.redirect(302, `${origin(req)}/?paypal=${status === 'cancelled' ? 'cancelled' : 'approved'}&orderId=${token || ''}`);
}

// ── Razorpay ─────────────────────────────────────────────────────────────────
async function razorpayCreateOrder(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, currency = 'INR', orderId } = body;
  if (!amount) return fail(res, 400, 'amount required');
  const keyId     = body.keyId    || dbc('razorpayKeyId') || env('RAZORPAY_KEY_ID');
  // SECURITY FIX-01: keySecret must NEVER be read from client body
  // An attacker can forge any signature by sending their own keySecret.
  const keySecret = dbc('razorpayKeySecret') || env('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) return fail(res, 400, 'Missing Razorpay credentials');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(Number(amount) * 100), currency, receipt: String(orderId || `r_${Date.now()}`), notes: { orderId: String(orderId || ''), backend: String(body.backend || '') } }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!d.id) return fail(res, 502, d.error?.description || 'Razorpay order failed');
  // Bug-2 edge case: stash SLIM items keyed by the Razorpay order id (d.id). The
  // client verify-payment call sends this same id as orderId, so its recovery
  // branch rebuilds items if the client dies after a confirmed payment.
  await savePendingOrderItems(String(body.backend || ''), String(d.id), {
    items: toSlimOrderItems(body.items),
    customer: body.customer,
    storeTotal: Number(body.orderTotal) || undefined,
    storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
    subtotal: Number(body.subtotal) || undefined,
    deliveryFee: Number(body.deliveryFee) || undefined,
  });
  // Frontend (CartModal) reads rzpData.rzpOrderId for the Razorpay checkout order_id.
  return ok(res, { success: true, orderId: d.id, rzpOrderId: d.id, amount: d.amount, currency: d.currency, keyId });
}
async function razorpayVerifyPayment(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return fail(res, 400, 'Missing Razorpay signature fields');
  // SECURITY FIX-01: keySecret must NEVER be read from client body
  // An attacker can forge any signature by sending their own keySecret.
  const keySecret = dbc('razorpayKeySecret') || env('RAZORPAY_KEY_SECRET');
  if (!keySecret) return fail(res, 400, 'Missing RAZORPAY_KEY_SECRET');
  const expected = crypto.createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  const verified = expected.length === String(razorpay_signature).length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)));
  if (verified) await persistPaidOrder(String(body.backend || ''), String(body.orderId || body.internalOrderId || ''), {
    method: 'Razorpay', txnId: razorpay_payment_id,
  });
  return ok(res, { success: verified, verified });
}

// ── Paytm ────────────────────────────────────────────────────────────────────
async function paytmInitiate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId, customerId } = body;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const mid = body.mid || dbc('paytmMerchantId') || env('PAYTM_MID');
  const key = body.key || dbc('paytmMerchantKey') || env('PAYTM_MERCHANT_KEY') || env('PAYTM_KEY');
  if (!mid || !key) return fail(res, 400, 'Missing Paytm credentials (PAYTM_MID, PAYTM_MERCHANT_KEY)');
  const sandbox = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('PAYTM_SANDBOX') !== 'false');
  const base = sandbox ? 'https://securegw-stage.paytm.in' : 'https://securegw.paytm.in';
  const callbackUrl = body.callbackUrl || `${origin(req)}/api/paytm/callback?orderId=${encodeURIComponent(orderId)}`;
  // FIX-06: Paytm API requires {body:{}, head:{signature:...}} envelope
  //         websiteName=WEBSTAGING in sandbox, DEFAULT in live
  //         per https://business.paytm.com/docs/api/initiate-transaction-api
  const txnBodyObj = {
    requestType: 'Payment', mid,
    websiteName: sandbox ? 'WEBSTAGING' : 'DEFAULT',
    orderId, callbackUrl, txnAmount: { value: Number(amount).toFixed(2), currency: 'INR' },
    userInfo: { custId: customerId || 'CUST_' + Date.now() },
  };
  const bodyStr   = JSON.stringify(txnBodyObj);
  const signature = crypto.createHmac('sha256', key).update(bodyStr).digest('hex');
  const payload   = JSON.stringify({ body: txnBodyObj, head: { signature } });
  const r = await fetch(`${base}/theia/api/v1/initiateTransaction?mid=${mid}&orderId=${encodeURIComponent(orderId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  const d: any = await r.json().catch(() => ({}));
  const txnToken = d?.body?.txnToken;
  if (!txnToken) return fail(res, 502, d?.body?.resultInfo?.resultMsg || 'Paytm initiate failed');
  return ok(res, { success: true, txnToken, orderId, mid, base });
}
async function paytmCallback(req: VercelRequest, res: VercelResponse) {
  const orderId = (req.query.orderId as string) || req.body?.orderId || '';
  const status  = req.body?.STATUS || req.body?.status || 'UNKNOWN';
  return res.redirect(302, `${origin(req)}/?paytm=${status === 'TXN_SUCCESS' ? 'success' : 'fail'}&orderId=${encodeURIComponent(orderId)}`);
}

// ── UPI ──────────────────────────���───────────────────��───────────────────────
async function upiCreateIntent(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId, note } = body;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const upiId = body.upiId || dbc('upiId') || env('UPI_VPA') || env('UPI_ID');
  const payeeName = body.payeeName || dbc('upiPayeeName') || env('UPI_PAYEE_NAME') || 'Store';
  if (!upiId) return fail(res, 400, 'Missing UPI ID');
  const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note || `Order ${orderId}`)}&tr=${encodeURIComponent(orderId)}`;
  return ok(res, { success: true, upiLink, upiId, orderId });
}

// ── JazzCash ─────────────────────────────────────────────────────────────────
async function jazzcashInitiate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId, customerPhone } = body;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const mid     = body.mid     || dbc('jazzCashMerchantId') || env('JAZZCASH_MID');
  const password = body.password || dbc('jazzCashPassword') || env('JAZZCASH_PASSWORD');
  const hashKey  = body.hashKey  || dbc('jazzCashIntegritySalt') || env('JAZZCASH_HASH_KEY');
  if (!mid || !password || !hashKey) return fail(res, 400, 'Missing JazzCash credentials');
  const sandbox = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('JAZZCASH_SANDBOX') !== 'false');
  const base = sandbox
    ? 'https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction'
    : 'https://payments.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction';
  const dt = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const exp = new Date(Date.now() + 24 * 3600_000).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const amt = String(Math.round(Number(amount) * 100)).padStart(10, '0');
  // FIX-07: JazzCash wallet API hash = HMAC-SHA256(hashKey, hashKey + '&' + sorted param values)
  //         per developer.jazzcash.com.pk DoMWalletTransaction specification
  const jcFields: Record<string,string> = {
    pp_Amount: amt, pp_BillReference: orderId, pp_Description: `Order ${orderId}`,
    pp_Language: 'EN', pp_MerchantID: mid, pp_MobileNumber: customerPhone || '',
    pp_Password: password, pp_SubMerchantID: '',
    pp_TxnCurrency: 'PKR', pp_TxnDateTime: dt, pp_TxnExpiryDateTime: exp,
    pp_TxnRefNo: orderId, pp_TxnType: 'MWALLET', pp_Version: '1.1',
  };
  const sortedVals = Object.keys(jcFields).sort().map(k => jcFields[k]);
  const hashStr = hashKey + '&' + sortedVals.join('&');
  const hash = crypto.createHmac('sha256', hashKey).update(hashStr).digest('hex').toUpperCase();
  const r = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...jcFields, pp_SecureHash: hash }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (d?.pp_ResponseCode !== '000') return fail(res, 502, d?.pp_ResponseMessage || 'JazzCash initiate failed');
  return ok(res, { success: true, transactionId: d.pp_TxnRefNo, response: d });
}
async function jazzcashCallback(req: VercelRequest, res: VercelResponse) {
  const body = req.body || {};
  const code = String(body.pp_ResponseCode || '');
  const orderId = String(body.pp_TxnRefNo || req.query.orderId || '');
  return res.redirect(302, `${origin(req)}/?jazzcash=${code === '000' ? 'success' : 'fail'}&orderId=${encodeURIComponent(orderId)}`);
}

// ── Easypaisa ───────────────────────────────���───────��─────────────────────────
async function easypaisaInitiate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId, customerPhone } = body;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const storeId  = body.storeId  || dbc('easypaisaStoreId') || env('EASYPAISA_STORE_ID');
  const hashKey  = body.hashKey  || dbc('easypaisaHashKey') || env('EASYPAISA_HASH_KEY');
  if (!storeId || !hashKey) return fail(res, 400, 'Missing Easypaisa credentials');
  const ts = Date.now();
  const amt = Number(amount).toFixed(2);
  // FIX-09: Easypaisa hash = SHA256(amount + orderRefNum + postBackURL + storeId + hashKey)
  const epPostbackUrl = body.postbackUrl || `${origin(req)}/api/easypaisa/callback`;
  const epHashStr = `${amt}${orderId}${epPostbackUrl}${storeId}${hashKey}`;
  const hash = crypto.createHash('sha256').update(epHashStr).digest('hex').toUpperCase();
  const postbackUrl = body.postbackUrl || `${origin(req)}/api/easypaisa/callback`;
  const sandbox = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('EASYPAISA_SANDBOX') !== 'false');
  const base = sandbox ? 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf' : 'https://easypay.easypaisa.com.pk/easypay/Index.jsf';
  const r = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      storeId, amount: amt, orderRefNum: orderId, mobileAccountNo: customerPhone || '',
      emailAddress: '', paymentToken: '', timeStamp: String(ts),
      signature: hash, encryptedHashRequest: '', postBackURL: epPostbackUrl,
    }).toString(),
  });
  const text = await r.text().catch(() => '');
  if (r.status >= 400) return fail(res, 502, `Easypaisa error (HTTP ${r.status})`);
  return ok(res, { success: true, raw: text.slice(0, 500), orderId });
}
async function easypaisaCallback(req: VercelRequest, res: VercelResponse) {
  const body = req.body || {};
  const status  = String(body.status  || req.query.status  || 'fail');
  const orderId = String(body.orderRefNum || req.query.orderId || '');
  return res.redirect(302, `${origin(req)}/?easypaisa=${status === '00' || status.toLowerCase() === 'success' ? 'success' : 'fail'}&orderId=${encodeURIComponent(orderId)}`);
}

// ── PayFast ─────────────────���─────────────────────────────────────────────────
async function payfastInitiate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = req.body || {};
  const { amount, orderId, customerEmail, itemName = 'Order' } = body;
  if (!amount || !orderId) return fail(res, 400, 'amount and orderId required');
  const merchantId  = body.merchantId  || dbc('payFastMerchantId') || env('PAYFAST_MERCHANT_ID');
  const merchantKey = body.merchantKey || dbc('payFastMerchantKey') || env('PAYFAST_MERCHANT_KEY');
  const passphrase  = body.passphrase  || dbc('payFastPassphrase') || env('PAYFAST_PASSPHRASE') || '';
  if (!merchantId || !merchantKey) return fail(res, 400, 'Missing PayFast credentials');
  const sandbox = body.sandboxMode !== undefined ? (body.sandboxMode !== false) : (env('PAYFAST_SANDBOX') !== 'false');
  const base = sandbox ? 'https://sandbox.payfast.co.za/eng/process' : 'https://www.payfast.co.za/eng/process';
  const o = origin(req);
  const data: Record<string, string> = {
    merchant_id: merchantId, merchant_key: merchantKey,
    return_url:  `${o}/?payfast=success&orderId=${encodeURIComponent(orderId)}`,
    cancel_url:  `${o}/?payfast=cancelled&orderId=${encodeURIComponent(orderId)}`,
    notify_url:  `${o}/api/payfast/ipn`,
    email_address: customerEmail || '',
    m_payment_id: orderId,
    amount: Number(amount).toFixed(2),
    item_name: String(itemName).slice(0, 100),
  };
  if (passphrase) data.passphrase = passphrase;
  // Bug-2 edge case: stash SLIM items keyed by orderId (== m_payment_id the ITN
  // webhook reads) so a shopper who pays but never returns still gets a recovery
  // order WITH its real items.
  await savePendingOrderItems(String(body.backend || ''), String(orderId), {
    items: toSlimOrderItems(body.items),
    customer: body.customer,
    storeTotal: Number(body.orderTotal) || undefined,
    storeCurrency: (String(body.orderCurrency || '').toUpperCase()) || undefined,
    subtotal: Number(body.subtotal) || undefined,
    deliveryFee: Number(body.deliveryFee) || undefined,
  });
  const queryStr = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim())}`).join('&');
  const signature = crypto.createHash('md5').update(queryStr).digest('hex');
  data.signature = signature;
  const form = Object.entries(data).map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('');
  const html = `<!DOCTYPE html><html><body><form id="pf" method="POST" action="${base}">${form}</form><script>document.getElementById('pf').submit();</script></body></html>`;
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(html);
}
async function payfastCallback(req: VercelRequest, res: VercelResponse) {
  const body = req.body || {};
  const orderId = String(body.m_payment_id || req.query.orderId || '');
  return res.redirect(302, `${origin(req)}/?payfast=success&orderId=${encodeURIComponent(orderId)}`);
}
// FIX-05: PayFast ITN verification per https://developers.payfast.co.za/docs#notify_page
async function payfastIpn(req: VercelRequest, res: VercelResponse) {
  const body: Record<string, string> = req.body || {};
  const orderId        = String(body.m_payment_id   || '');
  const paymentStatus  = String(body.payment_status || '');
  const postedSig      = String(body.signature      || '');
  const passphrase     = dbc('payFastPassphrase') || env('PAYFAST_PASSPHRASE');
  const sandbox        = sbx(undefined, 'payFastSandboxMode', 'PAYFAST_SANDBOX');
  console.log('[PayFast ITN]', { orderId, paymentStatus, sandbox });
  // Step 1: Reconstruct signature (exclude 'signature' field)
  const paramPairs = Object.entries(body)
    .filter(([k]) => k !== 'signature')
    .map(([k, v]) => {
      const encoded = encodeURIComponent(String(v).trim()).replace(/%20/g, '+');
      return `${k}=${encoded}`;
    })
    .join('&');
  const passphraseEncoded = passphrase ? encodeURIComponent(passphrase.trim()).replace(/%20/g, '+') : '';
  const withPass = passphrase ? `${paramPairs}&passphrase=${passphraseEncoded}` : paramPairs;
  const expectedSig = crypto.createHash('md5').update(withPass).digest('hex');
  if (expectedSig !== postedSig) {
    console.warn('[PayFast ITN] Signature mismatch - possible spoofed ITN', { expected: expectedSig, received: postedSig });
    return res.status(400).send('Bad signature');
  }
  // Step 2: Verify with PayFast server to prevent replay attacks
  try {
    const pfBase = sandbox ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za';
    const vr = await fetch(`${pfBase}/eng/query/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: paramPairs,
    });
    const vt = await vr.text();
    if (!vt.includes('VALID')) {
      console.warn('[PayFast ITN] Server validation failed', vt);
      return res.status(400).send('PayFast validation failed');
    }
  } catch (ve: any) {
    console.error('[PayFast ITN] Validation request error', ve.message);
  }
  if (paymentStatus !== 'COMPLETE') {
    console.log('[PayFast ITN] Non-COMPLETE status', paymentStatus);
    return res.status(200).send('OK');
  }
  console.log('[PayFast ITN] Verified COMPLETE payment', { orderId });
  // Path-B recovery: PayFast ITN is a true server-to-server webhook, so this
  // fires even if the customer closed the tab. orderId = m_payment_id (ours).
  await persistPaidOrder(String(req.query.backend || ''), orderId, {
    amount: Number(body.amount_gross) || undefined,
    customer: { name: String(body.name_first || ''), email: String(body.email_address || '') },
    method: 'PayFast', txnId: String(body.pf_payment_id || ''),
  });
  return res.status(200).send('OK');
}

// ── Test Connection ───────────────────────────────────────────────────────────
async function testConnection(req: VercelRequest, res: VercelResponse) {
  const gateway = norm(req.query.gateway);
  const creds: any = req.body?.credentials || req.body || {};
  if (gateway === 'stripe') {
    const key = creds.secretKey || env('STRIPE_SECRET_KEY');
    if (!key) return ok(res, { success: false, error: 'Secret key required' });
    const r = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) return ok(res, { success: true, message: 'Stripe credentials valid' });
    const d: any = await r.json().catch(() => ({}));
    return ok(res, { success: false, error: d?.error?.message || 'Invalid Stripe credentials' });
  }
  if (gateway === 'paypal') {
    const clientId = creds.clientId || env('PAYPAL_CLIENT_ID');
    const secret   = creds.clientSecret || env('PAYPAL_CLIENT_SECRET');
    const sandbox  = (creds.sandbox ?? 'true') !== 'false';
    if (!clientId || !secret) return ok(res, { success: false, error: 'Client ID and Secret required' });
    try {
      const { token } = await ppToken(clientId, secret, sandbox);
      return ok(res, { success: !!token, message: 'PayPal credentials valid' });
    } catch (e: any) { return ok(res, { success: false, error: e.message }); }
  }
  if (gateway === 'sslcommerz') {
    const storeId   = creds.storeId   || env('SSLCZ_STORE_ID');
    const storePass = creds.storePass || env('SSLCZ_STORE_PASSWORD');
    const sandbox   = (creds.sandbox ?? 'true') !== 'false';
    if (!storeId || !storePass) return ok(res, { success: false, error: 'Store ID and Password required' });
    const base = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
    try {
      // FIX-03: Use gwprocess (session init API) to test credentials.
    //         validationserverAPI?val_id=test always returns INVALID_TRANSACTION.
    const form3 = new URLSearchParams({
      store_id: storeId, store_passwd: storePass, total_amount: '1', currency: 'BDT',
      tran_id: `conn-test-${Date.now()}`,
      success_url: 'http://localhost/cb', fail_url: 'http://localhost/cb', cancel_url: 'http://localhost/cb',
      cus_name: 'Test', cus_email: 'test@example.com', cus_add1: 'Test',
      cus_city: 'Dhaka', cus_postcode: '1000', cus_country: 'Bangladesh', cus_phone: '01700000000',
      shipping_method: 'NO', num_of_item: '1', product_name: 'Test',
      product_category: 'Test', product_profile: 'general',
    });
    const r = await fetch(`${base}/gwprocess/v4/api.php`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form3.toString(),
    });
    const d: any = await r.json().catch(() => ({}));
    const st3 = ((d?.status || '')).toUpperCase();
    const reason3 = d?.failedreason || '';
    if (st3 === 'SUCCESS') return ok(res, { success: true, message: 'SSLCommerz credentials are valid.' });
    if (reason3.toLowerCase().includes('inactive')) return ok(res, { success: false, error: 'SSLCommerz account is inactive.' });
    if (reason3) return ok(res, { success: false, error: `Invalid SSLCommerz credentials: ${reason3}` });
    return ok(res, { success: false, error: 'Invalid SSLCommerz Store ID or Password.' });
  } catch (e: any) { return ok(res, { success: false, error: e.message }); }
  }
  if (gateway === 'razorpay') {
    const keyId     = creds.keyId     || env('RAZORPAY_KEY_ID');
    const keySecret = creds.keySecret || env('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) return ok(res, { success: false, error: 'Key ID and Secret required' });
    const r = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64') },
    });
    if (r.ok) return ok(res, { success: true, message: 'Razorpay credentials valid' });
    const d: any = await r.json().catch(() => ({}));
    return ok(res, { success: false, error: d?.error?.description || 'Invalid Razorpay credentials' });
  }
  if (gateway === 'bkash') {
    const appKey    = creds.appKey    || env('BKASH_APP_KEY');
    const appSecret = creds.appSecret || env('BKASH_APP_SECRET');
    const username  = creds.username  || env('BKASH_USERNAME');
    const password  = creds.password  || env('BKASH_PASSWORD');
    const sandbox   = (creds.sandbox ?? 'true') !== 'false';
    if (!appKey || !appSecret || !username || !password) return ok(res, { success: false, error: 'All bKash credentials required' });
    try {
      const token = await bkashToken(appKey, appSecret, username, password, sandbox);
      return ok(res, { success: !!token, message: 'bKash credentials valid' });
    } catch (e: any) { return ok(res, { success: false, error: e.message }); }
  }
  return ok(res, { success: false, error: `Test connection not supported for gateway: ${gateway}` });
}

// ── Route Map ──────────────────────────────────────────────────────────────────
type Handler = (req: VercelRequest, res: VercelResponse) => unknown;
// NOTE: Rocket (DBBL) = manual gateway. Admin sets account number in Admin Panel.
// Customers send money manually and submit their transaction ID.
// No DBBL API integration needed for manual payment flow.
const ROUTES: Record<string, Record<string, Handler>> = {
  bkash:     { 'create-payment': bkashCreatePayment, 'execute-payment': bkashExecutePayment },
  nagad:     { 'create-payment': nagadCreatePayment,  'callback': nagadCallback, 'verify-payment':  nagadVerifyPayment },
  sslcommerz:{ 'create-payment': sslcommerzCreatePayment, 'callback': sslcommerzCallback, 'ipn': sslcommerzIpn },
  stripe:    { 'create-payment-intent': stripeCreatePaymentIntent, 'confirm-payment': stripeConfirmPayment, 'create-checkout-session': stripeCreateCheckoutSession },
  paypal:    { 'create-order': paypalCreateOrder, 'capture-order': paypalCaptureOrder, 'callback': paypalCallback },
  razorpay:  { 'create-order': razorpayCreateOrder, 'verify-payment': razorpayVerifyPayment },
  paytm:     { 'initiate': paytmInitiate, 'callback': paytmCallback },
  upi:       { 'create-intent': upiCreateIntent },
  jazzcash:  { 'initiate': jazzcashInitiate, 'callback': jazzcashCallback },
  easypaisa: { 'initiate': easypaisaInitiate, 'callback': easypaisaCallback },
  payfast:   { 'initiate': payfastInitiate, 'callback': payfastCallback, 'ipn': payfastIpn },
};

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.status(204).end();
    return;
  }

  // Pre-load admin-panel payment credentials once (body → DB → env fallback) so
  // no gateway handler needs its secrets duplicated into host env vars.
  try { await loadDbPaymentSettings(); } catch { /* non-fatal: handlers fall back to env */ }

  const gateway = norm(req.query.gateway);
  const action  = norm(req.query.action);

  if (!gateway || !action) {
    res.status(400).json({ error: 'Missing ?gateway=&action=', available: Object.keys(ROUTES) });
    return;
  }

  // Special: test-connection
  if (action === 'test-connection') {
    try { await testConnection(req, res); } catch (e: any) { if (!res.headersSent) fail(res, 500, e?.message); }
    return;
  }

  const gr = ROUTES[gateway];
  if (!gr) { res.status(404).json({ error: `Unknown gateway: ${gateway}`, available: Object.keys(ROUTES) }); return; }

  const fn = gr[action];
  if (!fn) { res.status(404).json({ error: `Unknown action: ${action}`, available: Object.keys(gr) }); return; }

  try {
    await fn(req, res);
  } catch (e: any) {
    if (!res.headersSent) fail(res, 500, e?.message || 'Internal error');
  }
}
