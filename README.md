# Fruitopia — Dual-Backend E-Commerce Store

A complete storefront + admin panel that runs on **either Supabase or Firebase** (the store owner chooses in the Install Wizard), with automatic payment gateways, partial-COD, real-time cross-device sync, and multi-platform deployment.

> **New owner? Read this whole file once before deploying.** It covers setup, every environment variable, all payment gateways, cross-device sync, and a troubleshooting section for every issue we know about.

---

## 0. Fresh-start / security note (READ FIRST)

This repository ships **with NO real credentials**. There is only `.env.example` (placeholders). You (the new owner) supply your own keys.

- Never commit a real `.env` — it is already blocked by `.gitignore`.
- Only `VITE_`-prefixed variables are bundled into the browser and are **public** (use them only for *publishable/anon* keys).
- Secret keys (service-role key, gateway secret keys, SMTP password) must **never** have a `VITE_` prefix and must be set in your host's dashboard, never in the repo.
- If you go live, use LIVE gateway credentials and set every `*_SANDBOX=false`.

---

## 1. What you need

- **Node.js 22+**
- A backend: **Supabase** project *or* **Firebase** project (pick one; you can switch later).
- Optionally: payment gateway merchant accounts (SSLCommerz / Stripe / PayPal / bKash / Nagad / Razorpay), an SMTP account for email, an SMS provider.

---

## 2. Local setup (5 minutes)

```bash
npm install
cp .env.example .env      # then fill in your values
npm run dev               # starts on http://localhost:3000
```

The first time you open the site with an empty backend, the **Install Wizard** launches. It lets you:
1. Pick your backend engine (Supabase or Firebase).
2. Enter that backend's credentials.
3. Create the first admin account.
4. Seed default demo data.

> The wizard saves credentials to that browser's localStorage so you can finish setup. For a real deployment you MUST also set them as environment variables (see §5) — otherwise other browsers/devices won't connect. This is the #1 cause of "it only works in my browser."

---

## 3. Choosing & preparing your backend

### Option A — Supabase
1. Create a project at supabase.com.
2. Copy **Project URL** and the **anon/publishable key** (Settings → API).
3. Create the tables the app uses: `products`, `categories`, `coupons`, `reviews`, `orders`, `newsletter`, `settings`. Each is `id TEXT PRIMARY KEY` plus a `data`/`value` JSON column (see §3.1).
4. **Enable Realtime replication** on ALL those tables (Database → Replication → add tables to `supabase_realtime`). Without this, changes will NOT push live to other devices.
5. For server-side payment recovery, also copy the **service-role key** (Settings → API) → set as `SUPABASE_SERVICE_ROLE_KEY` (server-only, never `VITE_`).

### Option B — Firebase
1. Create a project at console.firebase.google.com and enable **Firestore**.
2. Project Settings → General → Your apps → copy the web config (apiKey, authDomain, projectId, etc.).
3. Firestore realtime (`onSnapshot`) works out of the box — no replication step needed.
4. For server-side payment recovery, create a **service account** (Project Settings → Service accounts → Generate key) and set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (or the whole `FIREBASE_SERVICE_ACCOUNT` JSON) — server-only.

### 3.1 Suggested Supabase table SQL
```sql
create table if not exists products   (id text primary key, data jsonb);
create table if not exists categories (id text primary key, data jsonb);
create table if not exists coupons    (id text primary key, data jsonb);
create table if not exists reviews    (id text primary key, data jsonb);
create table if not exists orders     (id text primary key, data jsonb);
create table if not exists newsletter (id text primary key, data jsonb);
create table if not exists settings   (key text primary key, value jsonb);
```

---

## 4. Real-time cross-device sync (how it works)

Every admin change (payment settings, products, orders, site settings, etc.) pushes live to all connected devices:
- **Firebase**: `onSnapshot` listeners (automatic).
- **Supabase**: `postgres_changes` channels (requires Realtime enabled — §3 step 4).
- **Same browser, multiple tabs**: `BroadcastChannel` fallback.

**Requirements for it to actually work across devices:**
1. Credentials set as env vars (so every device connects to the SAME backend).
2. Supabase only: Realtime replication enabled on the tables.

If a second browser shows defaults (e.g., a payment method looks "off"), it means that browser is NOT connected to your backend — fix the env vars, don't touch code.

---

## 5. Environment variables

Copy `.env.example` to `.env` and fill what you use. Full reference is inside `.env.example`; the essentials:

### Supabase
| Variable | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` / `SUPABASE_URL` | frontend / server | Project URL |
| `VITE_SUPABASE_ANON_KEY` or `VITE_SUPABASE_PUBLISHABLE_KEY` | frontend | Public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Payment recovery writes |

### Firebase
| Variable | Where | Purpose |
|---|---|---|
| `VITE_FIREBASE_API_KEY` + `VITE_FIREBASE_AUTH_DOMAIN` + `VITE_FIREBASE_PROJECT_ID` (+ storage/sender/appId) | frontend | Web SDK |
| `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (or `FIREBASE_SERVICE_ACCOUNT`) | **server only** | Payment recovery writes |

### Payments (set only the gateways you use; server-side)
`SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD`, `SSLCOMMERZ_SANDBOX`; `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_SANDBOX`; `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`; `BKASH_*`, `NAGAD_*`, etc. Most gateway creds can ALSO be entered in Admin → Payment Settings instead of env vars.

> **VITE_ = public.** Never give a `VITE_` prefix to any secret/service-role/gateway-secret key.

---

## 6. Deployment per platform

### Vercel (recommended — runs the /api backend)
1. Import the repo.
2. Add all env vars in **Project Settings → Environment Variables**.
3. Deploy. `vercel.json` already routes `/api/*` and `/supabase-config.json` + `/firebase-config.json`.
4. **Redeploy after changing any env var.**

### Render
- Build: `npm install && npm run build`; Start: `npm start`; Port `10000`. Add env vars in the dashboard.

### cPanel (Node app)
- Create a Node.js app, set env vars there (or a `.env` OUTSIDE `public_html`), run build, start `node dist-server/server.js`.

### Netlify (static only — IMPORTANT)
- Netlify serves the STATIC frontend and does **NOT** run `/api`. Host the backend elsewhere (Render/cPanel/VPS) and set `NODE_API_URL` on Netlify pointing to that backend, or payments will 500.

---

## 7. Automatic payment gateways

### How online payment succeeds even if the customer closes the tab (Path A + Path B)
- **Path A (client return):** customer pays → returns to the site → the app confirms the order. Works when the tab stays open.
- **Path B (server webhook/IPN):** the gateway calls YOUR server directly, so the order is marked paid even if the customer closed the tab. This is wired backend-agnostically (Supabase OR Firebase) for gateways that support server push:
  - ✅ **SSLCommerz** (IPN), **PayFast** (ITN), **Stripe** (webhook), **PayPal** (webhook), **Razorpay** (webhook).
  - ⚠️ bKash / Nagad / PayPal-capture / Razorpay-verify are client-initiated — they also persist server-side at confirm time, but true closed-tab recovery isn't possible where the gateway offers no push webhook.

### To enable Path B you must:
1. Register the webhook/IPN URL in each gateway's dashboard, pointing to your deployed domain:
   - Stripe: `https://YOURDOMAIN/api/stripe/webhook`
   - PayPal: `https://YOURDOMAIN/api/paypal/webhook`
   - Razorpay: `https://YOURDOMAIN/api/razorpay/webhook`
   - SSLCommerz IPN: `https://YOURDOMAIN/api/sslcommerz/ipn`
   - PayFast ITN: `https://YOURDOMAIN/api/payfast/ipn`
2. Set the server-side recovery credentials (`SUPABASE_SERVICE_ROLE_KEY` OR Firebase service account).
3. Set the webhook signing secrets where applicable (e.g., `STRIPE_WEBHOOK_SECRET`).

### Sandbox vs live
- Keep `*_SANDBOX=true` while testing. In sandbox, test cards/OTP always "succeed" — that is normal, not a bug.
- Before go-live: set every `*_SANDBOX=false`, switch to LIVE credentials, and run one real low-value transaction per gateway.

### Partial COD ("pay delivery fee online, rest on delivery")
- Admin sets an optional **`partialCodAmount`** per delivery zone (Admin → Payment Settings → Zones). If unset, the delivery fee is used as the advance.
- The customer pays that advance online; the order is saved as `paymentStatus: "Delivery Fee Paid"` with `paidAmount` and `outstandingAmount`, and auto-dispatches to courier. The remaining balance is collected on delivery.

---

## 8. Troubleshooting (issues a new owner will hit)

| Symptom | Cause | Fix |
|---|---|---|
| A payment method / setting shows only in the admin's browser | Other browser isn't connected to your backend (creds were only in localStorage) | Set creds as env vars + redeploy (§5/§6) |
| Changes don't sync live to other devices (Supabase) | Realtime replication not enabled | Enable Realtime on the tables (§3 step 4) |
| `500` error on Vercel when paying | Missing gateway env vars, or on Netlify (no `/api`) | Add gateway env vars / host backend + set `NODE_API_URL` |
| Online payment succeeds but order stays "Pending" after closing tab | Webhook/IPN not registered, or recovery creds missing | Register webhook URL + set service-role / service-account (§7) |
| Sandbox payment "succeeds" with any OTP/card | Expected sandbox behavior | Not a bug; switch to live to test real declines |
| Customer sees a different amount than charged (partial COD) | (Fixed) UI now uses the same `partialAdvance` as the charge | Update to latest build |
| Env var change had no effect | Not redeployed | Redeploy after every env var change |
| Firebase writes fail on server (recovery) | Service account not set / bad `FIREBASE_PRIVATE_KEY` newlines | Set service account; keep `\n` in the private key |

---

## 9. Go-live checklist

- [ ] Backend creds set as **env vars** on your host (not just in-browser).
- [ ] Supabase: Realtime enabled on all tables.
- [ ] `.env` NOT committed (verify `.gitignore`).
- [ ] No `VITE_` prefix on any secret key.
- [ ] All `*_SANDBOX=false` + LIVE gateway keys.
- [ ] Webhooks/IPN registered for every gateway you use.
- [ ] Server recovery creds set (service-role key / Firebase service account).
- [ ] One real transaction tested per gateway (incl. one Firebase closed-tab test if using Firebase).
- [ ] First admin account created; default demo data replaced with real products.

---

## 10. Handy scripts

```bash
npm run dev        # local dev (port 3000)
npm run build      # production build
npm start          # run built server (node dist-server/server.js)
npm run lint       # tsc --noEmit type check
```
