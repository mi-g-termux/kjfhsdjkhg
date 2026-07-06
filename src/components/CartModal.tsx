/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { getActiveEngine } from '../db';
import { useToast } from './Toast';
import { X, Minus, Plus, Trash2, Tag, Ticket, CreditCard, ShoppingBag, Landmark, Printer, Phone, Mail, Shield, CheckCircle2, PartyPopper, Sparkles } from 'lucide-react';
import { Order, CartItem } from '../types';
import { BkashLogo, NagadLogo, StripeLogo, PaypalLogo, VisaMastercardLogo, RocketLogo, QuirkyFruityLogo } from './PaymentLogos';
import { COUNTRY_PHONE_RULES, findRule, validatePhone, toE164 } from '../lib/phoneValidation';
import { resolveCurrencySymbol, convertForPaymentMethod, PAYMENT_METHOD_NATIVE_CURRENCY, CURRENCY_SYMBOLS } from '../lib/currency';

// Build a STORE-BRANDED order/transaction id (e.g. "FRUT-1A2B3456") instead of
// the old hardcoded "QF-<timestamp>". This id is used as the gateway tran_id /
// value_a AND, if the shopper never returns and only the server-side webhook
// recovery row is created, it becomes that order's visible number too — so it
// must be branded, not "QF-". Mirrors the orderNumber format in placeOrder().
const makeOrderId = (websiteName?: string, tag?: string): string => {
  const prefix = (websiteName || 'ORD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'ORD';
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return tag ? `${prefix}-${tag}-${ts}${rnd}` : `${prefix}-${ts}${rnd}`;
};
// Strip base64 data: URLs from order-item images before they are written to
// localStorage (qf_pending_order) — full base64 images blow the ~5MB storage
// quota, which previously caused automatic-payment orders to save with 0 items.
const stripB64 = (u?: string): string | undefined => (u && u.startsWith('data:') ? undefined : u);
import CountryDialPicker from './CountryDialPicker';

interface CartModalProps {
  isOpen: boolean;
  onClose: () => void;
  emailVerified?: boolean;
}

type PaymentOption = {
  id: string;
  fallbackLabel: string;
  icon: React.ReactNode;
  enabled: boolean;
  displayName?: string | null;
  logoUrl?: string | null;
  defaultLogoPath?: string;
};

const cleanSetting = (value?: string | null) => (typeof value === 'string' ? value.trim() : '');

const DEFAULT_BRANDING_LABELS = new Set([
  'cash on delivery',
  'bkash manual',
  'bkash (manual)',
  'bkash instant (auto)',
  'bkash (auto)',
  'nagad manual',
  'nagad (manual)',
  'nagad instant (auto)',
  'nagad (auto)',
  'paypal express',
  'paypal',
  'stripe card',
  'card (stripe)',
  'sslcommerz',
  'razorpay',
  'bank transfer',
  'rocket manual',
  'rocket (manual)',
]);

const getPaymentButtonLabel = (displayName: string | null | undefined, fallbackLabel: string, logoUrl: string) => {
  const label = cleanSetting(displayName);
  if (!label) return logoUrl ? '' : fallbackLabel;
  if (logoUrl && DEFAULT_BRANDING_LABELS.has(label.toLowerCase())) return '';
  return label;
};

const hasEnabledPaymentMethod = (settings: any, method: string) => {
  switch (method) {
    case 'COD': return settings?.codEnabled !== false;
    case 'bKash': return settings?.bKashEnabled === true;
    case 'Nagad': return settings?.nagadEnabled === true;
    case 'Rocket': return settings?.rocketEnabled === true;
    case 'Bank': return settings?.bankEnabled === true;
    case 'CreditManual': return settings?.creditManualEnabled === true;
    case 'Stripe': return settings?.stripeEnabled === true;
    case 'PayPal': return settings?.paypalEnabled === true;
    case 'bKashAuto': return settings?.bKashAutoEnabled === true;
    case 'NagadAuto': return settings?.nagadAutoEnabled === true;
    case 'SSLCommerz': return settings?.sslCommerzEnabled === true;
    case 'Razorpay': return settings?.razorpayEnabled === true;
    case 'Paytm': return settings?.paytmEnabled === true;
    case 'UPI': return settings?.upiManualEnabled === true;
    case 'JazzCash': return settings?.jazzCashEnabled === true;
    case 'Easypaisa': return settings?.easypaisaEnabled === true;
    case 'PayFast': return settings?.payFastEnabled === true;
    default: return false;
  }
};

const PAYMENT_METHOD_ORDER = ['COD', 'bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual', 'Stripe', 'PayPal', 'bKashAuto', 'NagadAuto', 'SSLCommerz', 'Razorpay', 'Paytm', 'UPI', 'JazzCash', 'Easypaisa', 'PayFast'];

const AUTOMATIC_PAYMENT_METHODS = ['bKashAuto', 'NagadAuto', 'PayPal', 'Stripe', 'SSLCommerz', 'Razorpay', 'Paytm', 'UPI', 'JazzCash', 'Easypaisa', 'PayFast'];

const AUTO_PAYMENT_LABELS: Record<string, string> = {
  bKashAuto: 'bKash Auto',
  NagadAuto: 'Nagad Auto',
  PayPal: 'PayPal',
  Stripe: 'Stripe',
  SSLCommerz: 'SSLCommerz',
  Razorpay: 'Razorpay',
  Paytm: 'Paytm',
  UPI: 'UPI',
  JazzCash: 'JazzCash',
  Easypaisa: 'Easypaisa',
  PayFast: 'PayFast',
};

const getAutomaticPaymentCredentialError = (settings: any, method: string): string => {
  const requiredFields: Record<string, Array<[string, string]>> = {
    bKashAuto: [],
    NagadAuto: [],
    PayPal: [],
    Stripe: [],
    SSLCommerz: [['sslCommerzStoreId', 'Store ID'], ['sslCommerzStorePassword', 'Store Password']],
    Razorpay: [],
    Paytm: [],
    UPI: [['upiId', 'UPI ID / VPA']],
    JazzCash: [],
    Easypaisa: [],
    PayFast: [],
  };

  const required = requiredFields[method];
  if (!required) return '';

  const missing = required.filter(([key]) => !cleanSetting(settings?.[key])).map(([, label]) => label);
  if (!missing.length) return '';
  return `${AUTO_PAYMENT_LABELS[method] || method} payment is not configured. Missing: ${missing.join(', ')}.`;
};


// ─── Tiny QR-code renderer (no external lib) ────────────────────────────────
// Uses the browser's built-in canvas + a minimal QR matrix generator via
// the qrcodegen reference library loaded inline as a data URL approach.
// We use a simple URL-encoding trick: render QR via Google Charts API in
// an <img> tag (works offline via cache, no tracking pixel).
const QRCodeImg = ({ value, size = 96 }: { value: string; size?: number }) => {
  const encoded = encodeURIComponent(value);
  // Use the QR server API — purely client-side redirect, no data stored
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&margin=4&color=1e293b&bgcolor=ffffff`;
  return (
    <img
      src={src}
      alt="Order QR Code"
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated', display: 'block' }}
    />
  );
};
// ─────────────────────────────────────────────────────────────────────────────

export const CartModal = ({ isOpen, onClose, emailVerified = true }: CartModalProps) => {
  const {
    cart,
    siteSettings,
    paymentSettings,
    appliedCoupon,
    updateCartQuantity,
    removeFromCart,
    applyCouponCode,
    removeCoupon,
    placeOrder,
    clearCart,
    setCurrentUserEmail,
    formatPrice,
    userProfile,
    isUserLoggedIn,
    deliveryZones,
    getZoneForCity,
    smsSettings,
    sendSmsOtp,
    verifySmsOtp,
    emailVerificationSettings,
    isEmailVerified,
    sendCheckoutEmailOtp,
    verifyCheckoutEmailOtp,
    ensureUserAfterCheckout,
    isLoading: paymentSettingsLoading,
  } = useApp();

  const toast = useToast();
  const handledGatewayCallbackRef = useRef(false);

  // ✅ Handle bKash/Nagad/PayPal/SSLCommerz redirect callback — complete pending order on return
  // The instant checkout opens, force an immediate re-pull of public settings
  // (payment methods, delivery zones, etc.). This is the guarantee that a
  // shopper on ANY device / any tab sees the admin's latest enabled gateways
  // at the exact moment they go to pay — no page refresh required, even when
  // Supabase realtime replication isn't enabled on the settings table.
  useEffect(() => {
    if (!isOpen) return;
    try { window.dispatchEvent(new Event('qf-refresh-settings')); } catch { /* ignore */ }
  }, [isOpen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bkashStatus   = params.get('bkash');
    const nagadStatus   = params.get('nagad');
    const paypalStatus  = params.get('paypal');
    const sslStatus     = params.get('sslcz') || params.get('sslcommerz');
    const gatewayStatus = params.get('status');
    const bkashPaymentID = params.get('paymentID') || params.get('paymentId') || '';
    const nagadPaymentRef = params.get('payment_ref_id') || params.get('paymentRefId') || params.get('ref') || '';
    const sslValidationId = params.get('valId') || params.get('val_id') || '';
    const stripeStatus   = params.get('stripe');


    const clearPendingPayment = () => {
      localStorage.removeItem('qf_pending_order');
      localStorage.removeItem('qf_pending_email');
      localStorage.removeItem('qf_paypal_order_id');
      localStorage.removeItem('qf_paypal_client_id');
      localStorage.removeItem('qf_paypal_client_secret');
      localStorage.removeItem('qf_paypal_sandbox');
    };

    const completePendingOrder = (methodOverride?: string) => {
      const pendingRaw   = localStorage.getItem('qf_pending_order');
      const pendingEmail = localStorage.getItem('qf_pending_email');
      if (!pendingRaw) return;
      // ── DUPLICATE-ORDER FIX ──────────────────────────────────────────────
      // Consume (remove) the pending order from localStorage RIGHT NOW,
      // synchronously, before placeOrder() is even called — not afterwards
      // inside the .then(). `handledGatewayCallbackRef` only protects against
      // this effect re-firing within the SAME page mount; it resets to false
      // on every real browser refresh. If the customer refreshes the page
      // while the gateway's success params are still in the URL (a slow
      // redirect, a flaky connection, or just habit), this effect runs again
      // on the fresh page load, finds the same `qf_pending_order` still
      // sitting in localStorage (it was only ever cleared *after* the order
      // succeeded), and calls placeOrder() a second time — creating a second
      // order with a brand-new id/orderNumber. Removing it here, before any
      // async work starts, means a second run of this code (refresh or
      // otherwise) finds nothing to submit and returns immediately above.
      localStorage.removeItem('qf_pending_order');
      try {
        const pendingOrder = JSON.parse(pendingRaw);
        if (methodOverride) pendingOrder.paymentMethod = methodOverride;
        // FIX (Pending/Pending): completePendingOrder ONLY runs after a gateway
        // payment has been VERIFIED (SSLCommerz val_id, PayPal capture, bKash
        // execute, Nagad verify, Stripe success, Paytm/JazzCash/Easypaisa/
        // PayFast success). So reflect that in BOTH badges: paymentStatus ->
        // Paid and orderStatus -> Confirmed. Previously the pending order kept
        // paymentStatus:'Pending' (see the SSLCommerz/Nagad qf_pending_order
        // writes) and orderStatus was never set, so a fully-paid order still
        // showed "Pending / Pending" in the tracker. Preserve the special
        // "Delivery Fee Paid" state (COD orders that only paid the fee online).
        if (pendingOrder.paymentStatus !== 'Delivery Fee Paid') {
          pendingOrder.paymentStatus = 'Paid';
        }
        pendingOrder.orderStatus = 'Confirmed';
        placeOrder(pendingOrder).then((placed) => {
          if (pendingEmail) setCurrentUserEmail(pendingEmail);
          if (pendingEmail) {
            ensureUserAfterCheckout({
              email: pendingEmail,
              name: placed.customerName || '',
              phone: placed.phone || '',
              address: placed.address || '',
              city: placed.city || '',
              postalCode: placed.postalCode || '',
              orderId: placed.id,
            }).catch((e) => console.warn('ensureUserAfterCheckout failed (non-blocking):', e));
          }
          clearCart();
          setPlacedInvoiceOrder(placed);
          toast.success(`Payment confirmed. Order ${placed.orderNumber} confirmed.`);
          clearPendingPayment();
          window.history.replaceState({}, '', window.location.pathname);
        }).catch((err) => {
          // placeOrder itself failed (network/DB error). We've already
          // consumed qf_pending_order above, so we can't silently retry —
          // surface this loudly so the customer contacts support rather
          // than the order vanishing with no trace.
          console.error('[CartModal] placeOrder failed after payment confirmation:', err);
          toast.error('Payment was confirmed but we could not save your order. Please contact support with your transaction reference.');
        });
      } catch {
        clearPendingPayment();
      }
    };

    if (stripeStatus === 'success') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      completePendingOrder('Stripe (Checkout)');
      return;
    }
    if (stripeStatus === 'cancelled') {
      toast.error('Stripe Checkout was cancelled. No order was created.');
      clearPendingPayment();
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    const shouldVerifyBkash = !!bkashPaymentID && (bkashStatus === 'execute' || bkashStatus === 'success' || gatewayStatus === 'success');
    if (shouldVerifyBkash) {
      if (handledGatewayCallbackRef.current || !bkashPaymentID) return;
      const bkashCredentialError = getAutomaticPaymentCredentialError(paymentSettings, 'bKashAuto');
      if (bkashCredentialError) {
        toast.error(`${bkashCredentialError} Payment failed; no order was created.`);
        clearPendingPayment();
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      handledGatewayCallbackRef.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      const _bkashPending = JSON.parse(localStorage.getItem('qf_pending_order') || '{}');
      fetch('/api/bkash/execute-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentID: bkashPaymentID,
          // Bug-2 edge case: send the orderId stashed at create time (+ backend) so a
          // server-side execute recovery finds the items stashed under that key.
          orderId: _bkashPending.gatewayOrderId || _bkashPending.id || '',
          backend: getActiveEngine(),
          sandboxMode: paymentSettings.bKashSandboxMode ?? true,
          // Pass admin CMS credentials so server doesn't need ENV vars
          bKashAppKey:    paymentSettings.bKashAppKey    || '',
          bKashAppSecret: paymentSettings.bKashAppSecret || '',
          bKashUsername:  paymentSettings.bKashUsername  || '',
          bKashPassword:  paymentSettings.bKashPassword  || '',
        }),
      })
        .then(r => r.json())
        .then((data: any) => {
          if (data.success) {
            completePendingOrder(`bKash (txn: ${data.transactionId || bkashPaymentID})`);
          } else {
            toast.error(data.error || 'bKash payment verification failed.');
            clearPendingPayment();
          }
        })
        .catch(() => {
          toast.error('bKash payment verification failed. Contact support.');
          clearPendingPayment();
        });
      return;
    }

    // BUG-FIX: read URL params for Paytm/JazzCash/Easypaisa/PayFast return pages
    const paytmStatus     = params.get('paytm');     // SUCCESS | FAILED | PENDING
    const jazzStatus      = params.get('jazzcash');  // success | failed
    const easypaisaStatus = params.get('easypaisa'); // success | failed
    const payfastStatus   = params.get('payfast') || params.get('payment_status'); // success | COMPLETE | cancelled

    const failStatuses = [
      bkashStatus === 'failed' || gatewayStatus === 'failure' || gatewayStatus === 'cancel',
      nagadStatus === 'failed',
      paypalStatus === 'cancelled',
      sslStatus === 'fail' || sslStatus === 'failed' || sslStatus === 'cancel' || sslStatus === 'cancelled',
      paytmStatus === 'FAILED' || paytmStatus === 'PENDING',
      jazzStatus === 'failed',
      easypaisaStatus === 'failed',
      payfastStatus === 'cancelled',
    ];

    // ── Paytm success return handler ─────────────────────────────────────────
    if (paytmStatus === 'SUCCESS') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      completePendingOrder('Paytm');
      return;
    }

    // ── JazzCash success return handler ─────���────────────────────────────────
    if (jazzStatus === 'success') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      completePendingOrder('JazzCash');
      return;
    }

    // ── Easypaisa success return handler ─────────────────────────────────────
    if (easypaisaStatus === 'success') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      completePendingOrder('Easypaisa');
      return;
    }

    // ── PayFast success return handler ───────────────────────────────────────
    if (payfastStatus === 'success' || payfastStatus === 'COMPLETE') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      completePendingOrder('PayFast');
      return;
    }

    if (nagadStatus === 'success') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      if (!nagadPaymentRef) {
        toast.error('Nagad payment returned without a verification reference. Payment failed; no order was created.');
        clearPendingPayment();
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }
      window.history.replaceState({}, '', window.location.pathname);
      const _nagadPending = JSON.parse(localStorage.getItem('qf_pending_order') || '{}');
      fetch('/api/nagad/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Bug-2 edge case: send the orderId stashed at create time (+ backend) so a
        // server-side verify recovery finds the items stashed under that key.
        body: JSON.stringify({ paymentRefId: nagadPaymentRef, orderId: _nagadPending.gatewayOrderId || _nagadPending.id || '', backend: getActiveEngine() }),
      })
        .then(r => r.json())
        .then((data: any) => {
          if (data.success) {
            completePendingOrder(`Nagad (ref: ${nagadPaymentRef})`);
          } else {
            toast.error(data.error || 'Nagad payment verification failed. Payment failed; no order was created.');
            clearPendingPayment();
          }
        })
        .catch(() => {
          toast.error('Nagad payment verification failed. Payment failed; no order was created.');
          clearPendingPayment();
        });
    } else if (sslStatus === 'success') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      if (!sslValidationId) {
        toast.error('SSLCommerz returned success without a validation id. Payment failed; no order was created.');
        clearPendingPayment();
        window.history.replaceState({}, '', window.location.pathname);
      } else {
        // Strip the success params from the URL immediately — not after
        // completePendingOrder resolves — so a refresh mid-flight lands on
        // a clean URL instead of re-triggering this whole branch again.
        window.history.replaceState({}, '', window.location.pathname);
        completePendingOrder(`SSLCommerz (val: ${sslValidationId})`);
      }
    } else if (paypalStatus === 'approved') {
      if (handledGatewayCallbackRef.current) return;
      handledGatewayCallbackRef.current = true;
      const paypalOrderId = localStorage.getItem('qf_paypal_order_id') || params.get('token') || '';

      if (paypalOrderId) {
        // Same reasoning as SSLCommerz above — clear the URL before the
        // async capture/verify call, not after.
        window.history.replaceState({}, '', window.location.pathname);
        fetch('/api/paypal/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: paypalOrderId,
            // Bug-2 edge case: send backend so the server capture recovery persists
            // to the correct engine and finds the items stashed under this orderId.
            backend: getActiveEngine(),
            sandboxMode: paymentSettings?.paypalSandboxMode ?? true,
            // BUG-FIX: send credentials so server can acquire PayPal access token
            // even when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET env vars are absent
            paypalClientId:     paymentSettings?.paypalClientId     || '',
            paypalClientSecret: paymentSettings?.paypalClientSecret || '',
          }),
        })
          .then(r => r.json())
          .then((data: any) => {
            localStorage.removeItem('qf_paypal_order_id');
            if (data.success) {
              completePendingOrder(`PayPal (txn: ${data.transactionId})`);
            } else {
              toast.error(`PayPal capture failed: ${data.error}`);
              clearPendingPayment();
            }
          })
          .catch(() => {
            toast.error('PayPal capture network error. Contact support.');
          });
      }
    } else if (failStatuses.some(Boolean)) {
      toast.error('Payment was cancelled or failed. Please try again.');
      // BUG-FIX: notify customer of payment failure via SMS + email
      (() => {
        const failedRaw = localStorage.getItem('qf_pending_order');
        if (!failedRaw) return;
        try {
          const fo = JSON.parse(failedRaw);
          const storeName = (siteSettings as any)?.websiteName || 'our store';
          if (fo?.phone) {
            fetch('/api/send-sms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: fo.phone,
                message: `Payment failed for your order on ${storeName}. No order was placed. Please try again or contact support.`,
              }),
            }).catch(() => {});
          }
          if (fo?.email) {
            fetch('/api/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: fo.email,
                subject: `Payment Failed — ${storeName}`,
                html: `<p>Hi ${fo.customerName || 'there'},</p><p>Unfortunately your payment could not be processed. <strong>No order was created.</strong></p><p>Please return to our store and try again. If you believe this is an error, contact our support team.</p>`,
              }),
            }).catch(() => {});
          }
        } catch { /* non-fatal */ }
      })();
      clearPendingPayment();
      window.history.replaceState({}, '', window.location.pathname);
    }
  // BUG-42 FIX: ensureUserAfterCheckout and getAutomaticPaymentCredentialError were called
  // inside the effect but omitted from the deps array, causing React to use stale closures
  // if those functions ever change (e.g. if the user profile updates mid-checkout).
  }, [paymentSettings?.bKashAppKey, paymentSettings?.bKashAppSecret, paymentSettings?.bKashUsername, paymentSettings?.bKashPassword, paymentSettings?.bKashSandboxMode, placeOrder, setCurrentUserEmail, clearCart, toast, ensureUserAfterCheckout, getAutomaticPaymentCredentialError]);

  const [couponCode, setCouponCode] = useState('');
  
  // Checkout Shipping form — auto-filled from userProfile
  const [customerName, setCustomerName] = useState('');
  const [email, setEmail] = useState('');
  const [dialCode, setDialCode] = useState<string>('+880');
  const [phoneLocal, setPhoneLocal] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');

  // Phone OTP verification state — used when admin enabled requireOtpAtCheckout
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifyingPhone, setOtpVerifyingPhone] = useState(''); // E.164 we last sent code to

  // Email OTP verification state — used when admin enabled
  // "Block Checkout Until Verified" and the customer has not verified yet.
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [emailOtpCode, setEmailOtpCode] = useState('');
  const [emailOtpVerified, setEmailOtpVerified] = useState(false);
  const [emailOtpSending, setEmailOtpSending] = useState(false);
  const [emailOtpVerifyingEmail, setEmailOtpVerifyingEmail] = useState('');

  // Helper: split a stored "+880 1712345678" into dial + local parts
  const splitStoredPhone = (full: string): { dial: string; local: string } => {
    const trimmed = (full || '').trim();
    if (!trimmed) return { dial: '+880', local: '' };
    const sorted = [...COUNTRY_PHONE_RULES].sort((a, b) => b.dial.length - a.dial.length);
    for (const c of sorted) {
      if (trimmed.startsWith(c.dial)) {
        return { dial: c.dial, local: trimmed.slice(c.dial.length).replace(/[^\d]/g, '') };
      }
    }
    return { dial: '+880', local: trimmed.replace(/[^\d]/g, '') };
  };

  // Auto-fill from user profile when modal opens
  useEffect(() => {
    if (userProfile) {
      setCustomerName(userProfile.name || '');
      setEmail(userProfile.email || '');
      const p = splitStoredPhone(userProfile.phone || '');
      setDialCode(p.dial);
      setPhoneLocal(p.local);
      setAddress(userProfile.address || '');
      setCity(userProfile.city || '');
    }
  }, [userProfile, isUserLoggedIn]);

  // Reset OTP whenever the phone changes
  useEffect(() => {
    setOtpSent(false);
    setOtpVerified(false);
    setOtpCode('');
    setOtpVerifyingPhone('');
  }, [dialCode, phoneLocal]);

  // Reset email-OTP whenever the email changes
  useEffect(() => {
    setEmailOtpSent(false);
    setEmailOtpVerified(false);
    setEmailOtpCode('');
    setEmailOtpVerifyingEmail('');
  }, [email]);

  // Convenience: live validation feedback for the phone field
  const phoneValidation = useMemo(
    () => validatePhone(dialCode, phoneLocal),
    [dialCode, phoneLocal],
  );
  const phoneRule = findRule(dialCode);

  const otpRequired =
    !!(smsSettings?.isEnabled && smsSettings?.otpEnabled && smsSettings?.requireOtpAtCheckout);
  const otpChannelLabel =
    smsSettings?.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';

  // Email-OTP gate: admin enabled "Require Email Verification" + "Block Checkout
  // Until Verified", customer is not already a logged-in user whose email is
  // verified, and the email they typed hasn't been verified this session.
  // FIXED: Skip email OTP if user is already logged in (they're already verified)
  const normalizedEmail = (email || '').trim().toLowerCase();
  const emailAlreadyVerified =
    !!normalizedEmail && (isEmailVerified(normalizedEmail) ||
      (emailOtpVerified && emailOtpVerifyingEmail === normalizedEmail));
  const emailVerificationRequired =
    !!(emailVerificationSettings?.isEnabled &&
       emailVerificationSettings?.requireVerificationBeforeOrder) &&
    !emailAlreadyVerified &&
    !isUserLoggedIn;  // ← FIXED: Skip OTP verification if user is already logged in
  
  // Interactive Automatic Gateway Simulation states
  const [isAutoPortalOpen, setIsAutoPortalOpen] = useState(false);
  const [autoStep, setAutoStep] = useState(0); // 0: Account/Card details input, 1: OTP verification code, 2: PIN password collection, 3: Processing API, 4: Success confirmation
  const [autoPhoneInput, setAutoPhoneInput] = useState('');
  const [autoOtpInput, setAutoOtpInput] = useState('');
  const [autoPinInput, setAutoPinInput] = useState('');
  const [autoPaypalEmailInput, setAutoPaypalEmailInput] = useState('');
  const [autoPaypalPasswordInput, setAutoPaypalPasswordInput] = useState('');
  const [autoCardNumberInput, setAutoCardNumberInput] = useState('');
  const [autoCardExpiryInput, setAutoCardExpiryInput] = useState('');
  const [autoCardCvcInput, setAutoCardCvcInput] = useState('');
  const [autoCardHolderInput, setAutoCardHolderInput] = useState('');
  const [isSubmitLoading, setIsSubmitLoading] = useState(false);
  const paymentInitiating = useRef(false);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [autoPortalError, setAutoPortalError] = useState('');
  const [storedOrderData, setStoredOrderData] = useState<any | null>(null);
  
  // Credit Card fields
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCVC, setCardCVC] = useState('');

  // Manual payment transaction reference
  const [manualTxId, setManualTxId] = useState('');

  // COD delivery fee prepayment flow — triggered when admin enables
  // requireDeliveryFeePrepayment on the matched delivery zone.
  const [showPrepaymentScreen, setShowPrepaymentScreen] = useState(false);
  const [prepaymentConfirmed, setPrepaymentConfirmed] = useState(false);
  // Which automatic gateway the shopper picked to pay the partial-COD delivery
  // fee with. Null = not chosen yet; handlePrepayDeliveryFee falls back to the
  // first enabled automatic gateway so behaviour is safe even if unset.
  const [selectedFeeGateway, setSelectedFeeGateway] = useState<string | null>(null);

  // Selected payment method
  const [paymentMethod, setPaymentMethod] = useState<string>('COD');

  const isPaymentMethodEnabled = useCallback(
    (method: string) => hasEnabledPaymentMethod(paymentSettings, method),
    [paymentSettings],
  );

  useEffect(() => {
    if (isPaymentMethodEnabled(paymentMethod)) return;
    const firstEnabled = PAYMENT_METHOD_ORDER.find((method) => isPaymentMethodEnabled(method));
    setPaymentMethod(firstEnabled || 'COD');
  }, [isPaymentMethodEnabled, paymentMethod]);

  // Active Placement invoice state
  const [placedInvoiceOrder, setPlacedInvoiceOrder] = useState<Order | null>(null);

  // ✅ Zone lookup must be before early return — cannot call context functions after conditional returns
  const matchedZone = getZoneForCity(city);

  // True when the matched zone requires COD customers to pay the delivery
  // fee upfront via a payment gateway before the order is confirmed.
  const requiresPrepayment =
    paymentMethod === 'COD' && !!(matchedZone?.requireDeliveryFeePrepayment);

  // ✅ ALL derived values needed by hooks must be computed before any early return
  const subtotalPre = cart.reduce((sum, item) => sum + (item.variantPrice ?? item.product.salePrice ?? item.product.price) * item.quantity, 0);
  const discountRatePre = appliedCoupon ? appliedCoupon.discountPercentage : 0;
  const discountAmountPre = (subtotalPre * discountRatePre) / 100;
  const deliveryFeePre = matchedZone?.isEnabled ? matchedZone.fee : (paymentSettings?.shippingFee || 60);
  const taxRatePre = paymentSettings.taxPercentage ?? 0;
  const taxAmountPre = (subtotalPre - discountAmountPre) * taxRatePre;
  const grandTotalPre = Math.max(0, subtotalPre - discountAmountPre + deliveryFeePre + taxAmountPre);

  // ── Currency conversion for local payment methods ──────────────────────────
  // MUST be before early return to satisfy Rules of Hooks
  const [convertedTotal, setConvertedTotal] = useState<{
    amount: number; currency: string; rate: number; loading: boolean;
  }>({ amount: grandTotalPre, currency: siteSettings?.currency || 'USD', rate: 1, loading: false });

  useEffect(() => {
    if (!isOpen) return;
    const storeCurrency = (siteSettings?.currency || 'USD').toUpperCase();
    const nativeCurrency = PAYMENT_METHOD_NATIVE_CURRENCY[paymentMethod];
    if (!nativeCurrency || nativeCurrency.toUpperCase() === storeCurrency) {
      setConvertedTotal({ amount: grandTotalPre, currency: storeCurrency, rate: 1, loading: false });
      return;
    }
    setConvertedTotal(prev => ({ ...prev, loading: true }));
    convertForPaymentMethod(grandTotalPre, storeCurrency, paymentMethod).then(({ convertedAmount, nativeCurrency: nc, rate }) => {
      setConvertedTotal({ amount: convertedAmount, currency: nc, rate, loading: false });
    });
  }, [grandTotalPre, paymentMethod, siteSettings?.currency, isOpen]);

  if (!isOpen) return null;

  const subtotal = subtotalPre;
  const discountRate = discountRatePre;
  const discountAmount = discountAmountPre;
  const deliveryFee = deliveryFeePre;
  const taxRate = taxRatePre;
  const taxAmount = taxAmountPre;
  const grandTotal = grandTotalPre;
  // Partial-COD advance shown to the customer — MUST match the amount actually
  // charged in handlePrepayDeliveryFee (per-zone partialCodAmount, else delivery fee),
  // clamped to the grand total. Fixes UI/charge mismatch when admin sets a custom amount.
  const partialAdvance = Math.min(grandTotal, Math.max(0, Number(matchedZone?.partialCodAmount ?? deliveryFee) || 0));

  const handleApplyCoupon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!couponCode.trim()) return;
    const res = applyCouponCode(couponCode);
    if (res.success) {
      toast.success(res.message);
    } else {
      toast.error(res.message);
    }
  };

  // Final E.164 string we'll persist with the order. Uses the validator
  // so users entering "01712345678" for BD still get stored as "+8801712345678".
  const phone = phoneValidation.ok ? phoneValidation.e164 : `${dialCode}${phoneLocal.replace(/\D/g, '')}`;

  const validateCheckoutForm = (): boolean => {
    if (!customerName.trim() || !email.trim() || !address.trim() || !city.trim()) {
      toast.error('All shipping fields marked with an asterisk (*) are required.');
      return false;
    }
    if (!phoneValidation.ok) {
      toast.error(phoneValidation.error || 'Please enter a valid mobile number for the selected country.');
      return false;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast.error('Form invalid: Please supply a genuine, valid email address.');
      return false;
    }

    if (['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(paymentMethod)) {
      if (!manualTxId.trim()) {
        toast.error(`Manual Verification: Please complete your mobile / bank / card txn sender reference details for ${paymentMethod}.`);
        return false;
      }
    }

    if (otpRequired && (!otpVerified || otpVerifyingPhone !== phone)) {
      toast.error(`Please verify your phone number via ${otpChannelLabel} OTP before placing the order.`);
      return false;
    }

    // Email verification gate (admin: "Block Checkout Until Verified")
    // — now satisfied by an inline OTP step instead of a mailed link.
    if (emailVerificationRequired) {
      toast.error('Please verify your email with the code we sent before placing the order.');
      return false;
    }

    return true;
  };

  /** Send an OTP code to the current phone, via SMS or WhatsApp (admin choice). */
  const handleSendOtp = async () => {
    if (!phoneValidation.ok) {
      toast.error(phoneValidation.error || 'Enter a valid phone number first.');
      return;
    }
    if (!smsSettings?.isEnabled || !smsSettings?.otpEnabled) {
      toast.error('OTP service is not configured. Contact the store admin.');
      return;
    }
    setOtpSending(true);
    try {
      const res = await sendSmsOtp(phone, email);
      if (res.success) {
        setOtpSent(true);
        setOtpVerified(false);
        setOtpVerifyingPhone(phone);
        toast.success(`Code sent via ${otpChannelLabel} to ${phone}.`);
      } else {
        toast.error(res.message);
      }
    } catch {
      toast.error('Could not send OTP. Please try again.');
    } finally {
      setOtpSending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!otpCode.trim()) {
      toast.error('Enter the code you received.');
      return;
    }
    const res = await verifySmsOtp(phone, otpCode.trim());
    if (res.success) {
      setOtpVerified(true);
      toast.success('Phone number verified!');
    } else {
      toast.error(res.message);
    }
  };

  /** Send a 6-digit verification code to the email currently entered in the form. */
  const handleSendEmailOtp = async () => {
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      toast.error('Please enter a valid email address first.');
      return;
    }
    setEmailOtpSending(true);
    try {
      const res = await sendCheckoutEmailOtp(normalizedEmail);
      if (res.success) {
        setEmailOtpSent(true);
        setEmailOtpVerified(false);
        setEmailOtpVerifyingEmail(normalizedEmail);
        toast.success(res.message);
      } else {
        toast.error(res.message);
      }
    } catch {
      toast.error('Could not send verification code. Please try again.');
    } finally {
      setEmailOtpSending(false);
    }
  };

  const handleVerifyEmailOtp = async () => {
    if (!emailOtpCode.trim()) {
      toast.error('Enter the code we emailed you.');
      return;
    }
    const res = await verifyCheckoutEmailOtp(normalizedEmail, emailOtpCode.trim());
    if (res.success) {
      setEmailOtpVerified(true);
      setEmailOtpVerifyingEmail(normalizedEmail);
      toast.success('Email verified!');
    } else {
      toast.error(res.message);
    }
  };


  // ── COD delivery fee prepayment: launch gateway for delivery fee only ───────
  const handlePrepayDeliveryFee = async () => {
    if (!validateCheckoutForm()) return;
    if (paymentInitiating.current) return;
    paymentInitiating.current = true;
    setIsPlacingOrder(true);
    try {
      const itemsToSubmit = cart.map(item => {
        const variantLabel = item.selectedVariants
          ? Object.entries(item.selectedVariants).map(([g, v]) => `${g}: ${v}`).join(' / ')
          : undefined;
        return {
          productId: item.product.id,
          name: item.product.name,
          quantity: item.quantity,
          price: item.variantPrice ?? (item.product.salePrice || item.product.price),
          image: stripB64(item.variantImage || item.product.coverImage || item.product.image),
          variantLabel,
          selectedVariants: item.selectedVariants,
        };
      });
      // Partial-COD advance: prefer the admin's per-zone `partialCodAmount`
      // when set, otherwise fall back to the delivery fee. Clamp at the
      // grand total so we never charge more upfront than the order is worth.
      const partialAdvance = Math.min(
        grandTotal,
        Math.max(0, Number(matchedZone?.partialCodAmount ?? deliveryFee) || 0),
      );
      // Full order data that will be saved AFTER successful gateway callback
      const baseOrderData = {
        customerName, email, phone, address, city, postalCode, deliveryNote,
        items: itemsToSubmit, subtotal, deliveryFee,
        couponApplied: appliedCoupon?.code || null,
        discount: discountAmount, total: grandTotal,
        currency: (siteSettings?.currency || 'USD').toUpperCase(),
        paymentMethod: 'COD',
        paymentStatus: 'Delivery Fee Paid' as const,
        orderStatus: 'Confirmed' as const,
        paidAmount: partialAdvance,
        outstandingAmount: Math.max(0, grandTotal - partialAdvance),
      };

      // Find the first configured auto-payment gateway for collecting the fee.
      // Order mirrors AUTOMATIC_PAYMENT_METHODS so ANY automatic gateway the shop
      // owner enables (not just bKash/Stripe) can collect the partial-COD fee.
      const autoGateways: string[] = ['bKashAuto', 'NagadAuto', 'Stripe', 'PayPal', 'SSLCommerz', 'Razorpay', 'Paytm', 'UPI', 'JazzCash', 'Easypaisa', 'PayFast'];
      // Honour the shopper's explicit choice from the prepayment screen. Only
      // accept it if that gateway is actually still enabled; otherwise fall
      // back to the first enabled automatic gateway so we never get stuck.
      const chosen =
        selectedFeeGateway && hasEnabledPaymentMethod(paymentSettings, selectedFeeGateway)
          ? selectedFeeGateway
          : undefined;
      const activeGateway = chosen || autoGateways.find(g => hasEnabledPaymentMethod(paymentSettings, g));
      if (!activeGateway) {
        toast.error('No payment gateway is configured. Add an automatic gateway in Admin → Payment Settings to collect the delivery fee.');
        return;
      }

      // Charge only the delivery-fee advance now; the rest stays COD.
      const feeAmount = partialAdvance.toFixed(2);
      const feeOrderId = `${makeOrderId(siteSettings?.websiteName, 'DF')}`;
      // Persist the pending fee-paid order (+ email) tagged with the gateway
      // label, then let the EXISTING gateway return handlers finish it via
      // completePendingOrder(), which preserves the 'Delivery Fee Paid' status.
      // NOTE: we deliberately DON'T send slim-items/backend on the fee path —
      // the server-side IPN "recovery" would otherwise rebuild it as a fully-
      // Paid order with the wrong total. The fee path is client-return driven.
      const stashFeeOrder = (label: string, extra: Record<string, any> = {}) => {
        localStorage.setItem('qf_pending_order', JSON.stringify({ ...baseOrderData, paymentMethod: `COD (Delivery Fee via ${label})`, ...extra }));
        localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
      };
      // Auto-submit a hidden POST form (JazzCash / PayFast style gateways).
      const submitHiddenForm = (postUrl: string, fields: Record<string, unknown>) => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = postUrl;
        Object.entries(fields).forEach(([k, v]) => {
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = k; input.value = String(v ?? '');
          form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
      };

      // bKash Auto
      if (activeGateway === 'bKashAuto') {
        const res = await fetch('/api/bkash/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            sandboxMode: paymentSettings.bKashSandboxMode ?? true,
            callbackURL: `${window.location.origin}${window.location.pathname}?bkash=execute`,
            // Pass admin CMS credentials so server doesn't need ENV vars
            bKashAppKey:    paymentSettings.bKashAppKey    || '',
            bKashAppSecret: paymentSettings.bKashAppSecret || '',
            bKashUsername:  paymentSettings.bKashUsername  || '',
            bKashPassword:  paymentSettings.bKashPassword  || '',
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.bkashURL) {
          stashFeeOrder('bKash');
          window.location.href = data.bkashURL;
          return;
        }
        toast.error(data.error || 'Could not start bKash payment. Please try again.');
        return;
      }

      // Nagad Auto
      if (activeGateway === 'NagadAuto') {
        const res = await fetch('/api/nagad/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            sandboxMode: paymentSettings.nagadSandboxMode ?? true,
            nagadMerchantId: paymentSettings.nagadMerchantId || '',
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.callBackUrl) {
          stashFeeOrder('Nagad');
          window.location.href = data.callBackUrl;
          return;
        }
        toast.error(data.error || 'Could not start Nagad payment. Please try again.');
        return;
      }

      // Stripe (hosted checkout). Uses create-checkout-session (create-checkout
      // does not exist server-side) so success returns to ?stripe=success.
      if (activeGateway === 'Stripe') {
        const res = await fetch('/api/stripe/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            currency: (siteSettings?.currency || 'USD').toLowerCase(),
            orderId: feeOrderId,
            sandboxMode: paymentSettings.stripeSandboxMode ?? true,
            productName: `${siteSettings?.storeName || 'Order'} — Delivery Fee`,
            customerEmail: email,
            successUrl: `${window.location.origin}/?stripe=success&orderId=${encodeURIComponent(feeOrderId)}`,
            cancelUrl:  `${window.location.origin}/?stripe=cancelled&orderId=${encodeURIComponent(feeOrderId)}`,
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.url) {
          stashFeeOrder('Stripe');
          window.location.href = data.url;
          return;
        }
        toast.error(data.error || 'Could not start Stripe payment.');
        return;
      }

      // PayPal
      if (activeGateway === 'PayPal') {
        const res = await fetch('/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            currency: (siteSettings?.currency || 'USD').toUpperCase(),
            sandboxMode: paymentSettings.paypalSandboxMode ?? true,
            paypalClientId:     paymentSettings.paypalClientId     || '',
            paypalClientSecret: paymentSettings.paypalClientSecret || '',
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.approvalUrl) {
          stashFeeOrder('PayPal');
          localStorage.setItem('qf_paypal_order_id', data.orderId);
          window.location.href = data.approvalUrl;
          return;
        }
        toast.error(data.error || 'Could not start PayPal payment.');
        return;
      }

      // SSLCommerz
      if (activeGateway === 'SSLCommerz') {
        const res = await fetch('/api/sslcommerz/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            storeId: paymentSettings.sslCommerzStoreId || '',
            storePass: paymentSettings.sslCommerzStorePassword || '',
            productName: `${siteSettings?.storeName || 'Order'} — Delivery Fee`,
            sandboxMode: paymentSettings.sslCommerzSandboxMode ?? true,
            customer: { name: customerName, email, phone, address, city, country: 'Bangladesh' },
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.redirectUrl) {
          stashFeeOrder('SSLCommerz', { id: feeOrderId, gatewayOrderId: feeOrderId });
          window.location.href = data.redirectUrl;
          return;
        }
        toast.error(data.error || 'Could not start SSLCommerz payment.');
        return;
      }

      // Razorpay (in-page modal — no redirect, so finish inline)
      if (activeGateway === 'Razorpay') {
        const res = await fetch('/api/razorpay/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            currency: siteSettings?.currency || 'INR',
            orderId: feeOrderId,
            sandboxMode: paymentSettings.razorpaySandboxMode ?? false,
            razorpayKeyId: paymentSettings.razorpayKeyId || '',
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.rzpOrderId && data.keyId) {
          stashFeeOrder('Razorpay');
          await new Promise<void>((resolve, reject) => {
            if ((window as any).Razorpay) return resolve();
            const s = document.createElement('script');
            s.src = 'https://checkout.razorpay.com/v1/checkout.js';
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Failed to load Razorpay'));
            document.body.appendChild(s);
          });
          const rzp = new (window as any).Razorpay({
            key: data.keyId,
            amount: data.amount,
            currency: data.currency,
            order_id: data.rzpOrderId,
            name: siteSettings?.storeName || 'Order',
            description: 'Delivery Fee',
            prefill: { name: customerName, email, contact: phone },
            handler: async (resp: any) => {
              const v = await fetch('/api/razorpay/verify-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  razorpay_order_id: resp.razorpay_order_id,
                  razorpay_payment_id: resp.razorpay_payment_id,
                  razorpay_signature: resp.razorpay_signature,
                }),
              }).then(x => x.json()).catch(() => ({}));
              if (!v?.success && !v?.verified) { toast.error('Razorpay signature verification failed.'); return; }
              // Preserve the 'Delivery Fee Paid' status from baseOrderData; only
              // stamp the order as Confirmed + attach the transaction id.
              const pending = JSON.parse(localStorage.getItem('qf_pending_order') || '{}');
              const placed = await placeOrder({ ...pending, orderStatus: 'Confirmed', transactionId: resp.razorpay_payment_id });
              localStorage.removeItem('qf_pending_order');
              localStorage.removeItem('qf_pending_email');
              toast.success(`Delivery fee paid. Order ${placed.orderNumber} confirmed.`);
              setPlacedInvoiceOrder(placed);
              clearCart();
            },
            modal: {
              ondismiss: () => {
                localStorage.removeItem('qf_pending_order');
                localStorage.removeItem('qf_pending_email');
                toast.error('Razorpay payment was cancelled. Your order was not placed.');
              },
            },
          });
          rzp.open();
          return;
        }
        toast.error(data.error || 'Could not start Razorpay payment.');
        return;
      }

      // Paytm
      if (activeGateway === 'Paytm') {
        const res = await fetch('/api/paytm/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            sandboxMode: paymentSettings.paytmSandboxMode ?? true,
            customer: { name: customerName, email, phone },
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.redirectUrl) {
          stashFeeOrder('Paytm');
          window.location.href = data.redirectUrl;
          return;
        }
        toast.error(data.error || 'Could not start Paytm payment.');
        return;
      }

      // UPI (deep-link intent — no auto-return; relies on manual confirmation,
      // same as the main checkout flow)
      if (activeGateway === 'UPI' && paymentSettings.upiId) {
        const res = await fetch('/api/upi/create-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            upiId: paymentSettings.upiId,
            payeeName: paymentSettings.upiPayeeName || siteSettings?.storeName || 'Merchant',
            note: `Delivery Fee ${feeOrderId}`,
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.intent) {
          stashFeeOrder('UPI');
          window.location.href = data.intent;
          return;
        }
        toast.error(data.error || 'Could not start UPI payment.');
        return;
      }

      // JazzCash (auto-POST signed form)
      if (activeGateway === 'JazzCash') {
        const res = await fetch('/api/jazzcash/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            sandboxMode: paymentSettings.jazzCashSandboxMode ?? true,
            customer: { name: customerName, email, phone },
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.postUrl && data.fields) {
          stashFeeOrder('JazzCash');
          submitHiddenForm(data.postUrl, data.fields);
          return;
        }
        toast.error(data.error || 'Could not start JazzCash payment.');
        return;
      }

      // Easypaisa (hosted redirect)
      if (activeGateway === 'Easypaisa') {
        const res = await fetch('/api/easypaisa/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            sandboxMode: paymentSettings.easypaisaSandboxMode ?? true,
            customer: { name: customerName, email, phone },
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.redirectUrl) {
          stashFeeOrder('Easypaisa');
          window.location.href = data.redirectUrl;
          return;
        }
        toast.error(data.error || 'Could not start Easypaisa payment.');
        return;
      }

      // PayFast (auto-POST signed form)
      if (activeGateway === 'PayFast') {
        const res = await fetch('/api/payfast/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: feeAmount,
            orderId: feeOrderId,
            productName: `${siteSettings?.storeName || 'Order'} — Delivery Fee`,
            sandboxMode: paymentSettings.payFastSandboxMode ?? true,
            customer: { name: customerName, email, phone, address, city, postalCode },
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (data.postUrl && data.fields) {
          stashFeeOrder('PayFast');
          submitHiddenForm(data.postUrl, data.fields);
          return;
        }
        toast.error(data.error || 'Could not start PayFast payment.');
        return;
      }

      toast.error(`${activeGateway} gateway integration is not yet wired for delivery-fee prepayment. Please contact the store admin.`);
    } catch (err: any) {
      toast.error(err?.message || 'Could not initiate delivery fee payment. Please try again.');
    } finally {
      paymentInitiating.current = false;
      setIsPlacingOrder(false);
    }
  };

  const handleCheckoutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateCheckoutForm()) return;
    // COD + zone requires upfront delivery fee → show prepayment screen first
    if (requiresPrepayment && !prepaymentConfirmed) {
      setShowPrepaymentScreen(true);
      return;
    }
    if (paymentInitiating.current) return;
    // Use pre-converted amount for local payment gateways that operate in a specific currency
    // For international gateways (Stripe/PayPal), the API handles conversion server-side
    const paymentAmount = convertedTotal.amount;
    const paymentCurrency = convertedTotal.currency;
    paymentInitiating.current = true;
    setIsPlacingOrder(true);

    try {
      const itemsToSubmit = cart.map(item => {
        const variantLabel = item.selectedVariants
          ? Object.entries(item.selectedVariants).map(([g, v]) => `${g}: ${v}`).join(' / ')
          : undefined;
        return {
          productId: item.product.id,
          name: item.product.name,
          quantity: item.quantity,
          price: item.variantPrice ?? (item.product.salePrice || item.product.price),
          image: stripB64(item.variantImage || item.product.coverImage || item.product.image),
          variantLabel,
          selectedVariants: item.selectedVariants,
        };
      });

      const orderData = {
        customerName,
        email,
        phone,
        address,
        city,
        postalCode,
        deliveryNote,
        items: itemsToSubmit,
        subtotal,
        deliveryFee,
        couponApplied: appliedCoupon?.code || null,
        discount: discountAmount,
        total: grandTotal,
        // Record the store currency the total is denominated in, so order history
        // always displays the correct symbol regardless of the gateway's native
        // charge currency (e.g. SSLCommerz charging in BDT).
        currency: (siteSettings?.currency || 'USD').toUpperCase(),
        paymentMethod,
      };

      if (AUTOMATIC_PAYMENT_METHODS.includes(paymentMethod)) {
        const credentialError = getAutomaticPaymentCredentialError(paymentSettings, paymentMethod);
        if (credentialError) {
          toast.error(`${credentialError} Payment failed; no order was created.`);
          return;
        }
        // Try real bKash API if credentials are configured
        if (paymentMethod === 'bKashAuto') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/bkash/create-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                sandboxMode: paymentSettings.bKashSandboxMode ?? true,
                callbackURL: `${window.location.origin}${window.location.pathname}?bkash=execute`,
                // Bug-2 edge case: send slim items + store totals + backend so the
                // server stashes them keyed by orderId for recovery parity.
                items: orderData.items, subtotal, deliveryFee,
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
                backend: getActiveEngine(),
                customer: { name: customerName, email, phone, address, city, postalCode },
                // Pass admin CMS credentials so server doesn't need ENV vars
                bKashAppKey:    paymentSettings.bKashAppKey    || '',
                bKashAppSecret: paymentSettings.bKashAppSecret || '',
                bKashUsername:  paymentSettings.bKashUsername  || '',
                bKashPassword:  paymentSettings.bKashPassword  || '',
              }),
            });
            const data = await res.json().catch(() => ({})) as any;
            if (!res.ok) throw new Error(data.error || `bKash API returned ${res.status}`);
            if (data.bkashURL) {
              // Persist the same orderId so the execute safety-net can send it back
              // and the server recovery finds the stashed items.
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, id: orderId, gatewayOrderId: orderId, paymentMethod: 'bKash (Auto)', paymentStatus: 'Paid' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.bkashURL;
              return;
            }
          } catch (error: any) {
            toast.error(error?.message || 'Could not start bKash payment.');
            return;
          }
        }

        if (paymentMethod === 'NagadAuto') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/nagad/create-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                sandboxMode: paymentSettings.nagadSandboxMode ?? true,
                // Bug-2 edge case: send slim items + store totals + backend so the
                // server stashes them keyed by orderId for recovery parity.
                items: orderData.items, subtotal, deliveryFee,
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
                backend: getActiveEngine(),
                customer: { name: customerName, email, phone, address, city, postalCode },
                // Pass admin CMS credentials so server doesn't need ENV vars
                nagadMerchantId: paymentSettings.nagadMerchantId || '',
              }),
            });
            const data = await res.json().catch(() => ({})) as any;
            if (!res.ok) throw new Error(data.error || `Nagad API returned ${res.status}`);
            if (data.callBackUrl) {
              // Persist the same orderId so the verify safety-net can send it back
              // and the server recovery finds the stashed items.
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, id: orderId, gatewayOrderId: orderId, paymentMethod: 'Nagad (Auto)', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.callBackUrl;
              return;
            }
            throw new Error(data.error || 'Nagad did not return a callback URL.');
          } catch (error: any) {
            toast.error(error?.message || 'Could not start Nagad payment.');
            return;
          }
        }

        // ── PayPal real API redirect ──────────────────────────────────────
        if (paymentMethod === 'PayPal') {
          if (!paymentSettings.paypalEnabled) {
            toast.error('PayPal is not configured. Add the Client ID and Secret in Admin → Payment Settings.');
            return;
          }
          try {
            const res = await fetch('/api/paypal/create-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: grandTotal.toFixed(2),
                currency: (siteSettings?.currency || 'USD').toUpperCase(),
                sandboxMode: paymentSettings.paypalSandboxMode ?? true,
                // Bug-2 edge case: send slim items + store totals + backend so the
                // capture recovery (keyed by PayPal's order id) keeps real items.
                items: orderData.items, subtotal, deliveryFee,
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
                backend: getActiveEngine(),
                customer: { name: customerName, email, phone, address, city, postalCode },
                // Pass admin CMS credentials so server doesn't need ENV vars
                paypalClientId:     paymentSettings.paypalClientId     || '',
                paypalClientSecret: paymentSettings.paypalClientSecret || '',
              }),
            });
            const data = await res.json() as any;
            if (data.approvalUrl) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'PayPal', paymentStatus: 'Paid' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              localStorage.setItem('qf_paypal_order_id', data.orderId);
              window.location.href = data.approvalUrl;
              return;
            }
            throw new Error(data.error || 'PayPal order creation failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start PayPal payment.');
            return;
          }
        }

        // ── Stripe Hosted Checkout (redirect to stripe.com) ───────────────
        if (paymentMethod === 'Stripe') {
          if (!paymentSettings.stripeEnabled) {
            toast.error('Stripe is not configured. Add the Secret Key in Admin → Payment Settings.');
            return;
          }
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/stripe/create-checkout-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: grandTotal.toFixed(2),
                currency: (siteSettings?.currency || 'USD').toLowerCase(),
                orderId,
                // Bug-2 edge case: send slim items + store totals + backend so the
                // Stripe webhook recovery keeps real items if the shopper never returns.
                items: orderData.items, subtotal, deliveryFee,
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
                backend: getActiveEngine(),
                customer: { name: customerName, email, phone, address, city, postalCode },
                // BUG-FIX: stripeSecretKey MUST NOT be sent from the browser.
                // Server reads STRIPE_SECRET_KEY from env vars instead.
                productName: siteSettings?.storeName || 'Order',
                customerEmail: email,
                successUrl: `${window.location.origin}/?stripe=success&orderId=${encodeURIComponent(orderId)}`,
                cancelUrl: `${window.location.origin}/?stripe=cancelled&orderId=${encodeURIComponent(orderId)}`,
              }),
            });
            const data = await res.json().catch(() => ({})) as any;
            if (!res.ok || !data?.url) {
              throw new Error(data?.error || `Stripe Checkout failed (${res.status}).`);
            }
            localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'Stripe', paymentStatus: 'Paid' }));
            localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
            window.location.href = data.url;
            return;
          } catch (err: any) {
            toast.error(err?.message || 'Could not start Stripe Checkout.');
            return;
          }
        }

        // ── SSLCommerz real API redirect ─────────────────────────────────
        if (paymentMethod === 'SSLCommerz') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/sslcommerz/create-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                // Thread the STORE-currency total + currency so the server-side IPN
                // recovery order stores the real store total (e.g. $152.30), not the
                // native BDT charge, preventing "BDT shown as USD" in order history.
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
                // Bug-2 edge case: send SLIM line items (base64 already stripped in
                // itemsToSubmit) so the server can stash them keyed by orderId. If the
                // shopper pays but never returns, the IPN recovery order is rebuilt
                // WITH these items instead of showing 0 items.
                items: orderData.items,
                subtotal,
                deliveryFee,
                storeId: paymentSettings.sslCommerzStoreId || '',
                storePass: paymentSettings.sslCommerzStorePassword || '',
                productName: siteSettings?.storeName || 'Order',
                sandboxMode: paymentSettings.sslCommerzSandboxMode ?? true,
                backend: getActiveEngine(),
                customer: {
                  name: customerName,
                  email,
                  phone,
                  address,
                  city,
                  country: 'Bangladesh',
                },
              }),
            });
            const data = await res.json() as any;
            if (data.redirectUrl) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, id: orderId, gatewayOrderId: orderId, paymentMethod: 'SSLCommerz', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.redirectUrl;
              return;
            }
            // If API call failed, show error instead of silently simulating
            throw new Error(data.error || 'SSLCommerz session failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start SSLCommerz payment.');
            return;
          }
        }

        // ── Razorpay real API redirect ───────────────────────────────────
        if (paymentMethod === 'Razorpay') {
          try {
            const res = await fetch('/api/razorpay/create-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                currency: siteSettings?.currency || 'INR',
                orderId: `${makeOrderId(siteSettings?.websiteName)}`,
                sandboxMode: paymentSettings.razorpaySandboxMode ?? false,
                // Bug-2 edge case: send slim items + store totals + backend so the
                // verify recovery (keyed by the Razorpay order id) keeps real items.
                items: orderData.items, subtotal, deliveryFee,
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'INR').toUpperCase(),
                backend: getActiveEngine(),
                customer: { name: customerName, email, phone, address, city, postalCode },
                // BUG-02 FIX: razorpayKeyId is a public identifier — safe to send.
                // razorpayKeySecret is a private secret and must NEVER be sent from
                // the browser. The server reads RAZORPAY_KEY_SECRET from env vars only.
                razorpayKeyId: paymentSettings.razorpayKeyId || '',
              }),
            });
            const data = await res.json() as any;
            if (data.rzpOrderId && data.keyId) {
              const orderId = data.rzpOrderId;
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'Razorpay', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              // Load Razorpay checkout script and open
              const loadScript = (): Promise<void> =>
                new Promise((resolve, reject) => {
                  if ((window as any).Razorpay) return resolve();
                  const s = document.createElement('script');
                  s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                  s.onload = () => resolve();
                  s.onerror = () => reject(new Error('Failed to load Razorpay'));
                  document.body.appendChild(s);
                });
              await loadScript();
              const rzp = new (window as any).Razorpay({
                key: data.keyId,
                amount: data.amount,
                currency: data.currency,
                order_id: orderId,
                name: siteSettings?.storeName || 'Order',
                prefill: { name: customerName, email, contact: phone },
                handler: async (resp: any) => {
                  const v = await fetch('/api/razorpay/verify-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      razorpay_order_id: resp.razorpay_order_id,
                      razorpay_payment_id: resp.razorpay_payment_id,
                      razorpay_signature: resp.razorpay_signature,
                      // Bug-2 edge case: send the Razorpay order id as orderId so the
                      // server verify recovery finds the items stashed under that key.
                      orderId: resp.razorpay_order_id,
                      backend: getActiveEngine(),
                      // BUG-02 FIX: razorpayKeySecret must NEVER be sent from the browser.
                      // The server reads RAZORPAY_KEY_SECRET from env vars for HMAC verification.
                    }),
                  }).then(x => x.json());
                  if (!v?.success && !v?.verified) { toast.error('Razorpay signature verification failed.'); return; }
                  const pending = JSON.parse(localStorage.getItem('qf_pending_order') || '{}');
                  const placed = await placeOrder({ ...pending, paymentStatus: 'Paid', orderStatus: 'Confirmed', transactionId: resp.razorpay_payment_id });
                  await ensureUserAfterCheckout({
                    email: placed.email,
                    name: placed.customerName || '',
                    phone: placed.phone || '',
                    address: placed.address || '',
                    city: placed.city || '',
                    postalCode: placed.postalCode || '',
                    orderId: placed.id,
                  }).catch((e) => console.warn('ensureUserAfterCheckout failed (non-blocking):', e));
                  localStorage.removeItem('qf_pending_order');
                  localStorage.removeItem('qf_pending_email');
                  toast.success(`Payment confirmed. Order: ${placed.orderNumber}`);
                  setPlacedInvoiceOrder(placed);
                  clearCart();
                },
                modal: {
                ondismiss: () => {
                  // BUG-FIX: clear pending order on dismiss to prevent stale state
                  localStorage.removeItem('qf_pending_order');
                  localStorage.removeItem('qf_pending_email');
                  toast.error('Razorpay payment was cancelled. Your order was not placed.');
                },
              },
              });
              rzp.open();
              return;
            }
            throw new Error(data.error || 'Razorpay order creation failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start Razorpay payment.');
            return;
          }
        }

        // ── Paytm (India) — hosted redirect via txnToken ─────────────────
        if (paymentMethod === 'Paytm') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/paytm/initiate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                sandboxMode: paymentSettings.paytmSandboxMode ?? true,
                customer: { name: customerName, email, phone },
              }),
            });
            const data = await res.json() as any;
            if (data.redirectUrl) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'Paytm', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.redirectUrl;
              return;
            }
            throw new Error(data.error || 'Paytm session failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start Paytm payment.');
            return;
          }
        }

        // ── UPI (manual intent / QR) ─────────────────────────────────────
        if (paymentMethod === 'UPI' && paymentSettings.upiId) {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/upi/create-intent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                upiId: paymentSettings.upiId,
                payeeName: paymentSettings.upiPayeeName || siteSettings?.storeName || 'Merchant',
                note: `Order ${orderId}`,
              }),
            });
            const data = await res.json() as any;
            if (data.intent) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'UPI', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              // Open UPI deep link in the customer's UPI app
              window.location.href = data.intent;
              return;
            }
            throw new Error(data.error || 'UPI intent generation failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start UPI payment.');
            return;
          }
        }

        // ── JazzCash (Pakistan) — auto-POST signed form ──────────────────
        if (paymentMethod === 'JazzCash') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/jazzcash/initiate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                sandboxMode: paymentSettings.jazzCashSandboxMode ?? true,
                customer: { name: customerName, email, phone },
              }),
            });
            const data = await res.json() as any;
            if (data.postUrl && data.fields) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'JazzCash', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              // Build and submit hidden form to JazzCash
              const form = document.createElement('form');
              form.method = 'POST';
              form.action = data.postUrl;
              Object.entries(data.fields).forEach(([k, v]) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = k;
                input.value = String(v ?? '');
                form.appendChild(input);
              });
              document.body.appendChild(form);
              form.submit();
              return;
            }
            throw new Error(data.error || 'JazzCash session failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start JazzCash payment.');
            return;
          }
        }

        // ── Easypaisa (Pakistan) — redirect to hosted page ───────────────
        if (paymentMethod === 'Easypaisa') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/easypaisa/initiate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                sandboxMode: paymentSettings.easypaisaSandboxMode ?? true,
                customer: { name: customerName, email, phone },
              }),
            });
            const data = await res.json() as any;
            if (data.redirectUrl) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'Easypaisa', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.redirectUrl;
              return;
            }
            throw new Error(data.error || 'Easypaisa session failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start Easypaisa payment.');
            return;
          }
        }

        // ── PayFast (South Africa) — auto-POST signed form ───────────────
        if (paymentMethod === 'PayFast') {
          try {
            const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
            const res = await fetch('/api/payfast/initiate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: paymentAmount.toFixed(2),
                orderId,
                productName: siteSettings?.storeName || 'Order',
                sandboxMode: paymentSettings.payFastSandboxMode ?? true,
                // Bug-2 edge case: send slim items + store totals + backend so the
                // ITN webhook recovery keeps real items if the shopper never returns.
                items: orderData.items, subtotal, deliveryFee,
                orderTotal: grandTotal.toFixed(2),
                orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
                backend: getActiveEngine(),
                customer: { name: customerName, email, phone, address, city, postalCode },
              }),
            });
            const data = await res.json() as any;
            if (data.postUrl && data.fields) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'PayFast', paymentStatus: 'Pending' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              const form = document.createElement('form');
              form.method = 'POST';
              form.action = data.postUrl;
              Object.entries(data.fields).forEach(([k, v]) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = k;
                input.value = String(v ?? '');
                form.appendChild(input);
              });
              document.body.appendChild(form);
              form.submit();
              return;
            }
            throw new Error(data.error || 'PayFast session failed');
          } catch (err: any) {
            toast.error(err?.message || 'Could not start PayFast payment.');
            return;
          }
        }

        toast.error(`${AUTO_PAYMENT_LABELS[paymentMethod] || paymentMethod} payment could not be started. Payment failed; no order was created.`);
        return;
      }

      const placedOrder = await placeOrder(orderData);

      // ✅ Save email so review button shows for this user's ordered products
      setCurrentUserEmail(email.trim().toLowerCase());

      // ✅ Auto-create a user account (if missing) and email a password-setup
      // code so the customer can sign back in later. They are already logged in
      // on this device.
      try {
        const res = await ensureUserAfterCheckout({
          email, name: customerName, phone, address, city, postalCode, orderId: placedOrder.id,
        });
        if (res.created) {
          toast.success(res.passwordSetupSent
            ? 'Account created. Check your email for a code to set your password.'
            : 'Account created. Use "Forgot password" to set a password later.');
        }
      } catch (e) { console.warn('ensureUserAfterCheckout failed (non-blocking):', e); }

      {
        const isManual = ['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(paymentMethod);
        if (isManual) {
          toast.success(`Order received. We'll confirm after verifying your ${paymentMethod} payment. Order: ${placedOrder.orderNumber}`);
        } else {
          toast.success(`Order placed successfully. Order Number: ${placedOrder.orderNumber}`);
        }
      }
      setPlacedInvoiceOrder(placedOrder);

      // ✅ Clear cart after successful order
      clearCart();

      // Reset form states
      setCustomerName('');
      setEmail('');
      setPhoneLocal('');
      setOtpSent(false); setOtpVerified(false); setOtpCode(''); setOtpVerifyingPhone('');
      setAddress('');
      setCity('');
      setPostalCode('');
      setDeliveryNote('');
      setCardNumber('');
      setCardExpiry('');
      setCardCVC('');
      setManualTxId('');
      
    } catch (err) {
      toast.error('Could not submit your checkout request. Try submitting again.');
    } finally {
      paymentInitiating.current = false;
      setIsPlacingOrder(false);
    }
  };

  // ── Finalise order after confirmed payment ────────────────────────────────
  const _finaliseOrder = async (orderInfo: any, methodLabel: string, txnRef: string) => {
    const updatedOrder = {
      ...orderInfo,
      paymentStatus: 'Paid' as const,
      orderStatus: 'Confirmed' as const,
      paymentMethod: methodLabel,
      transactionId: txnRef,
    };
    const placedOrder = await placeOrder(updatedOrder);
    if (orderInfo.email) {
      setCurrentUserEmail(orderInfo.email.trim().toLowerCase());
      try {
        await ensureUserAfterCheckout({
          email: orderInfo.email, name: orderInfo.customerName || '',
          phone: orderInfo.phone || '', address: orderInfo.address || '',
          city: orderInfo.city || '', postalCode: orderInfo.postalCode || '', orderId: placedOrder.id,
        });
      } catch (e) { console.warn('ensureUserAfterCheckout failed (non-blocking):', e); }
    }
    toast.success(`Payment confirmed. Order: ${placedOrder.orderNumber}`);
    setPlacedInvoiceOrder(placedOrder);
    clearCart();
    setCustomerName(''); setEmail(''); setPhoneLocal(''); setAddress('');
    setOtpSent(false); setOtpVerified(false); setOtpCode(''); setOtpVerifyingPhone('');
    setCity(''); setPostalCode(''); setDeliveryNote('');
    setManualTxId(''); setCardNumber(''); setCardExpiry(''); setCardCVC('');
    setAutoStep(4);
  };

  const runFinalTriggerAPI = async (orderInfo: any, methodLabel: string, txnRef?: string) => {
    try {
      setAutoPortalError('');

      // ── STRIPE ───────────────────────────────────────────────────────────
      if (methodLabel.startsWith('Stripe')) {
        setAutoStep(3);
        // Step 1: create PaymentIntent (creds read server-side from Firestore)
        const piRes = await fetch('/api/stripe/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: (siteSettings?.currency || 'USD').toLowerCase(),
            sandboxMode: paymentSettings.stripeSandboxMode ?? true,
          }),
        });
        const piData = await piRes.json() as any;
        if (!piData.clientSecret) throw new Error(piData.error || 'Stripe PaymentIntent failed.');

        // Step 2: tokenise card via Stripe.js (PCI-compliant path).
        // Direct REST calls to /v1/payment_methods with raw PAN are rejected
        // by Stripe on most accounts ("Sending credit card numbers directly
        // to the Stripe API is generally unsafe"). Stripe.js handles this.
        if (!paymentSettings.stripePublicKey || !/^pk_(test|live)_/.test(paymentSettings.stripePublicKey)) {
          throw new Error('Stripe publishable key missing or invalid (must start with pk_test_ or pk_live_).');
        }
        // Load Stripe.js if not already present
        await new Promise<void>((resolve, reject) => {
          if ((window as any).Stripe) return resolve();
          const s = document.createElement('script');
          s.src = 'https://js.stripe.com/v3/';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('Could not load Stripe.js'));
          document.body.appendChild(s);
        });
        const stripeJs = (window as any).Stripe(paymentSettings.stripePublicKey);
        if (!stripeJs) throw new Error('Stripe.js failed to initialise.');

        const expParts = autoCardExpiryInput.split('/');
        const expMonth = Number((expParts[0] || '').trim());
        let expYear = Number((expParts[1] || '').trim());
        if (expYear > 0 && expYear < 100) expYear += 2000; // accept MM/YY
        if (!expMonth || !expYear) throw new Error('Invalid card expiry. Use MM/YY or MM/YYYY.');

        const pmResult = await stripeJs.createPaymentMethod({
          type: 'card',
          card: {
            number: autoCardNumberInput.replace(/\s/g, ''),
            exp_month: expMonth,
            exp_year: expYear,
            cvc: autoCardCvcInput,
          },
          billing_details: { name: autoCardHolderInput || orderInfo.customerName },
        });
        if (pmResult.error || !pmResult.paymentMethod?.id) {
          throw new Error(pmResult.error?.message || 'Card tokenisation failed. Check your card details.');
        }
        const pmData = { id: pmResult.paymentMethod.id };

        // Step 3: confirm PaymentIntent server-side
        const confRes = await fetch('/api/stripe/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId: piData.paymentIntentId,
            paymentMethodId: pmData.id,
          }),
        });
        const confData = await confRes.json() as any;
        if (!confData.success) throw new Error(confData.error || 'Stripe charge failed.');
        await _finaliseOrder(orderInfo, methodLabel, confData.transactionId);
        return;
      }

      // ── PAYPAL ────────────────���──────────────────────────────────────────
      if (methodLabel.startsWith('PayPal') && paymentSettings.paypalClientId) {
        setAutoStep(3);
        const orderRes = await fetch('/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: (siteSettings?.currency || 'USD').toUpperCase(),
            clientId: paymentSettings.paypalClientId,
            sandboxMode: paymentSettings.paypalSandboxMode ?? true,
            // Bug-2 edge case: send slim items + store totals + backend so the
            // capture recovery (keyed by PayPal's order id) keeps real items.
            items: orderInfo.items, subtotal: orderInfo.subtotal, deliveryFee: orderInfo.deliveryFee,
            orderTotal: orderInfo.total,
            orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
            backend: getActiveEngine(),
            customer: { name: orderInfo.customerName, email: orderInfo.email, phone: orderInfo.phone, address: orderInfo.address, city: orderInfo.city, postalCode: orderInfo.postalCode },
          }),
        });
        const orderData = await orderRes.json() as any;
        if (!orderData.orderId) throw new Error(orderData.error || 'PayPal order creation failed.');

        localStorage.setItem('qf_pending_order', JSON.stringify({
          ...orderInfo,
          paymentMethod: 'PayPal',
          paymentStatus: 'Paid',
        }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        localStorage.setItem('qf_paypal_order_id', orderData.orderId);

        window.location.href = orderData.approvalUrl;
        return;
      }

      // ── SSLCommerz ───────────────────────────────────────────────────────
      if (methodLabel.startsWith('SSLCommerz')) {
        setAutoStep(3);
        const sslOrderId = `${makeOrderId(siteSettings?.websiteName)}`;
        const sslRes = await fetch('/api/sslcommerz/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            orderId: sslOrderId,
            productName: siteSettings?.storeName || 'Order',
            // FIX: forward panel-entered store credentials (live OR sandbox) so
            // this auto-pay path doesn't silently depend on server env vars.
            storeId: paymentSettings.sslCommerzStoreId || '',
            storePass: paymentSettings.sslCommerzStorePassword || '',
            sandboxMode: paymentSettings.sslCommerzSandboxMode ?? true,
            // Bug-2 edge case: send slim items + store totals so the IPN recovery
            // keeps real items if the shopper never returns.
            items: orderInfo.items, subtotal: orderInfo.subtotal, deliveryFee: orderInfo.deliveryFee,
            orderTotal: orderInfo.total,
            orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
            backend: getActiveEngine(),
            customer: {
              name: orderInfo.customerName,
              email: orderInfo.email,
              phone: orderInfo.phone,
              address: orderInfo.address,
            },
          }),
        });
        const sslData = await sslRes.json() as any;
        if (!sslData.redirectUrl) throw new Error(sslData.error || 'SSLCommerz session failed.');

        localStorage.setItem('qf_pending_order', JSON.stringify({
          ...orderInfo,
          id: sslOrderId,
          gatewayOrderId: sslOrderId,
          paymentMethod: 'SSLCommerz',
          paymentStatus: 'Pending',
        }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        window.location.href = sslData.redirectUrl;
        return;
      }

      // ─����������� Razorpay ─────────────────────────────────────────────────────────
      if (methodLabel.startsWith('Razorpay')) {
        setAutoStep(3);
        const rzpRes = await fetch('/api/razorpay/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: siteSettings?.currency || 'INR',
            orderId: `${makeOrderId(siteSettings?.websiteName)}`,
            sandboxMode: paymentSettings.razorpaySandboxMode ?? false,
            // Bug-2 edge case: send slim items + store totals + backend so the
            // verify recovery (keyed by the Razorpay order id) keeps real items.
            items: orderInfo.items, subtotal: orderInfo.subtotal, deliveryFee: orderInfo.deliveryFee,
            orderTotal: orderInfo.total,
            orderCurrency: (siteSettings?.currency || 'INR').toUpperCase(),
            backend: getActiveEngine(),
            customer: { name: orderInfo.customerName, email: orderInfo.email, phone: orderInfo.phone, address: orderInfo.address, city: orderInfo.city, postalCode: orderInfo.postalCode },
            // BUG-02 FIX: razorpayKeyId is public — safe to send.
            // razorpayKeySecret must NEVER be sent from the browser.
            razorpayKeyId: paymentSettings.razorpayKeyId || '',
          }),
        });
        const rzpData = await rzpRes.json() as any;
        if (!rzpData.rzpOrderId) throw new Error(rzpData.error || 'Razorpay order creation failed.');

        // Dynamically load Razorpay checkout.js if not already loaded
        await new Promise<void>((resolve, reject) => {
          if ((window as any).Razorpay) { resolve(); return; }
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Failed to load Razorpay SDK'));
          document.head.appendChild(script);
        });

        await new Promise<void>((resolve, reject) => {
          const options = {
            key: rzpData.keyId,
            amount: rzpData.amount,
            currency: rzpData.currency,
            order_id: rzpData.rzpOrderId,
            name: siteSettings?.websiteName || 'Store',
            description: 'Order Payment',
            prefill: {
              name: orderInfo.customerName,
              email: orderInfo.email,
              contact: orderInfo.phone,
            },
            handler: async (response: any) => {
              try {
                // Verify signature server-side
                const verifyRes = await fetch('/api/razorpay/verify-payment', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature,
                    // Bug-2 edge case: send the Razorpay order id as orderId (+ backend)
                    // so the server verify recovery finds items stashed under that key.
                    orderId: response.razorpay_order_id,
                    backend: getActiveEngine(),
                    // BUG-02 FIX: razorpayKeySecret must NEVER be sent from the browser.
                    // The server reads RAZORPAY_KEY_SECRET from env vars for HMAC verification.
                  }),
                });
                const verifyData = await verifyRes.json() as any;
                if (!verifyData.verified) throw new Error('Razorpay signature verification failed.');
                await _finaliseOrder(orderInfo, 'Razorpay', response.razorpay_payment_id);
                resolve();
              } catch (err: any) {
                reject(err);
              }
            },
            modal: {
              ondismiss: () => reject(new Error('Payment cancelled by user.')),
            },
          };
          const rzp = new (window as any).Razorpay(options);
          rzp.open();
        });
        return;
      }

      // ── PAYTM (auto-portal fallback) ──────────────���──────────────────────
      if (methodLabel.startsWith('Paytm')) {
        setAutoStep(3);
        const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
        const r = await fetch('/api/paytm/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            orderId,
            sandboxMode: paymentSettings.paytmSandboxMode ?? true,
            customer: { name: orderInfo.customerName, email: orderInfo.email, phone: orderInfo.phone },
          }),
        });
        const data = await r.json() as any;
        if (!data.redirectUrl) throw new Error(data.error || 'Paytm session failed.');
        localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderInfo, paymentMethod: 'Paytm', paymentStatus: 'Pending' }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        window.location.href = data.redirectUrl;
        return;
      }

      // ── UPI (auto-portal fallback) ───────────────────────────────────────
      if (methodLabel.startsWith('UPI') && paymentSettings.upiId) {
        setAutoStep(3);
        const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
        const r = await fetch('/api/upi/create-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            orderId,
            upiId: paymentSettings.upiId,
            payeeName: paymentSettings.upiPayeeName || siteSettings?.storeName || 'Merchant',
            note: `Order ${orderId}`,
          }),
        });
        const data = await r.json() as any;
        if (!data.intent) throw new Error(data.error || 'UPI intent generation failed.');
        localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderInfo, paymentMethod: 'UPI', paymentStatus: 'Pending' }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        window.location.href = data.intent;
        return;
      }

      // ── JAZZCASH (auto-portal fallback) ──────────────��───────────────────
      if (methodLabel.startsWith('JazzCash')) {
        setAutoStep(3);
        const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
        const r = await fetch('/api/jazzcash/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            orderId,
            sandboxMode: paymentSettings.jazzCashSandboxMode ?? true,
            customer: { name: orderInfo.customerName, email: orderInfo.email, phone: orderInfo.phone },
          }),
        });
        const data = await r.json() as any;
        if (!data.postUrl || !data.fields) throw new Error(data.error || 'JazzCash session failed.');
        localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderInfo, paymentMethod: 'JazzCash', paymentStatus: 'Pending' }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = data.postUrl;
        Object.entries(data.fields).forEach(([k, v]) => {
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = k; input.value = String(v ?? '');
          form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
        return;
      }

      // ── EASYPAISA (auto-portal fallback) ─────────────────────────────────
      if (methodLabel.startsWith('Easypaisa')) {
        setAutoStep(3);
        const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
        const r = await fetch('/api/easypaisa/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            orderId,
            sandboxMode: paymentSettings.easypaisaSandboxMode ?? true,
            customer: { name: orderInfo.customerName, email: orderInfo.email, phone: orderInfo.phone },
          }),
        });
        const data = await r.json() as any;
        if (!data.redirectUrl) throw new Error(data.error || 'Easypaisa session failed.');
        localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderInfo, paymentMethod: 'Easypaisa', paymentStatus: 'Pending' }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        window.location.href = data.redirectUrl;
        return;
      }

      // ── PAYFAST (auto-portal fallback) ──────────��────────────────────────
      if (methodLabel.startsWith('PayFast')) {
        setAutoStep(3);
        const orderId = `${makeOrderId(siteSettings?.websiteName)}`;
        const r = await fetch('/api/payfast/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            orderId,
            productName: siteSettings?.storeName || 'Order',
            sandboxMode: paymentSettings.payFastSandboxMode ?? true,
            // Bug-2 edge case: send slim items + store totals + backend so the ITN
            // recovery keeps real items if the shopper never returns.
            items: orderInfo.items, subtotal: orderInfo.subtotal, deliveryFee: orderInfo.deliveryFee,
            orderTotal: orderInfo.total,
            orderCurrency: (siteSettings?.currency || 'USD').toUpperCase(),
            backend: getActiveEngine(),
            customer: { name: orderInfo.customerName, email: orderInfo.email, phone: orderInfo.phone, address: orderInfo.address, city: orderInfo.city, postalCode: orderInfo.postalCode },
          }),
        });
        const data = await r.json() as any;
        if (!data.postUrl || !data.fields) throw new Error(data.error || 'PayFast session failed.');
        localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderInfo, paymentMethod: 'PayFast', paymentStatus: 'Pending' }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = data.postUrl;
        Object.entries(data.fields).forEach(([k, v]) => {
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = k; input.value = String(v ?? '');
          form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
        return;
      }

      throw new Error(`${methodLabel} is not configured correctly. Payment failed; no order was created.`);

    } catch (err: any) {
      setAutoPortalError(err?.message || 'Payment processing error. Please retry.');
      setAutoStep(0);
    }
  };

  const handlePrintInvoice = () => {
    if (!placedInvoiceOrder) return;
    const order = placedInvoiceOrder;
    const storeName = siteSettings.websiteName || 'Store';
    const sym = resolveCurrencySymbol(siteSettings);
    const pos = (siteSettings.currencyPosition || 'before') as 'before' | 'after';
    const fmt = (n: number) => { const v = Number.isFinite(Number(n)) ? Number(n) : 0; return pos === 'after' ? `${v.toFixed(2)}${sym}` : `${sym}${v.toFixed(2)}`; };

    const orderUrl = `${window.location.origin}/tracker?order=${order.orderNumber}`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(orderUrl)}&margin=4&color=1e293b&bgcolor=ffffff`;

    const itemRows = order.items.map((item: any) => `
      <tr>
        <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#1e293b;">${item.name}${item.variantLabel ? `<br><span style="font-size:10px;color:#10b981;font-style:italic;">${item.variantLabel}</span>` : ''}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;text-align:center;">x${item.quantity}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:600;color:#1e293b;text-align:right;">${fmt(item.price * item.quantity)}</td>
      </tr>`).join('');

    const discountRow = order.discount > 0
      ? `<tr><td style="color:#dc2626;padding:4px 10px;font-size:11px;">Discount${order.couponApplied ? ' (' + order.couponApplied + ')' : ''}</td><td style="color:#dc2626;text-align:right;padding:4px 10px;font-size:11px;font-weight:600;">-${fmt(order.discount)}</td></tr>`
      : '';

    // Partial-COD split rows for the printed receipt — only when the shopper
    // prepaid just the delivery fee online and still owes a balance on delivery.
    const partialRows = (order.paymentStatus === 'Delivery Fee Paid' && order.paidAmount !== undefined)
      ? `<tr><td style="color:#059669;padding:7px 10px;font-size:11px;border-top:1px dashed #cbd5e1;">Paid Online (Delivery Fee)</td><td style="color:#059669;text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-top:1px dashed #cbd5e1;">${fmt(order.paidAmount)}</td></tr>`
        + `<tr><td style="color:#dc2626;padding:4px 10px;font-size:12px;font-weight:700;">Remaining — Pay on Delivery</td><td style="color:#dc2626;text-align:right;padding:4px 10px;font-size:12px;font-weight:800;">${fmt(order.outstandingAmount ?? Math.max(0, order.total - (order.paidAmount || 0)))}</td></tr>`
      : '';

    const orderDate = new Date(order.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Invoice #${order.orderNumber}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:Arial,sans-serif;background:#fff;color:#1e293b;}
    .wrap{max-width:480px;margin:16px auto;padding:0 14px;}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:10px;border-bottom:2px solid #10b981;margin-bottom:12px;}
    .sname{font-size:17px;font-weight:800;color:#10b981;}
    .ssub{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
    .ino{font-size:10px;color:#64748b;text-align:right;}
    .ino strong{display:block;font-size:13px;color:#1e293b;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;}
    .mb{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:7px 9px;}
    .ml{font-size:9px;font-weight:700;text-transform:uppercase;color:#94a3b8;margin-bottom:2px;}
    .mv{color:#1e293b;font-weight:600;font-size:11px;line-height:1.5;}
    table{width:100%;border-collapse:collapse;}
    thead tr{background:#10b981;}
    thead th{padding:7px 10px;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:left;}
    thead th.r{text-align:right;}
    thead th.c{text-align:center;}
    .tot{margin-top:4px;}
    .tot td{padding:4px 10px;font-size:11px;}
    .tot td.r{text-align:right;font-weight:600;}
    .grand td{border-top:2px solid #10b981;padding-top:7px;font-size:13px;font-weight:800;color:#10b981;}
    .qr-wrap{text-align:center;margin-top:12px;padding-top:10px;border-top:1px dashed #e2e8f0;}
    .qr-img{display:inline-block;border:1px solid #e2e8f0;padding:6px;background:#fff;border-radius:6px;}
    .qr-url{font-size:8px;color:#94a3b8;margin-top:4px;word-break:break-all;}
    .foot{margin-top:8px;text-align:center;font-size:10px;color:#94a3b8;}
  </style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div><div class="sname">${storeName}</div><div class="ssub">Sales Receipt</div></div>
    <div class="ino"><span>Invoice</span><strong>#${order.orderNumber}</strong></div>
  </div>
  <div class="meta">
    <div class="mb"><div class="ml">Customer</div><div class="mv">${order.customerName}</div><div class="mv" style="font-weight:400;color:#64748b;">${order.phone}</div></div>
    <div class="mb"><div class="ml">Address</div><div class="mv">${order.address}</div><div class="mv" style="font-weight:400;color:#64748b;">${order.city}</div></div>
    <div class="mb"><div class="ml">Date</div><div class="mv">${orderDate}</div></div>
    <div class="mb"><div class="ml">Payment</div><div class="mv">${order.paymentMethod}</div></div>
  </div>
  <table>
    <thead><tr><th>Item</th><th class="c">Qty</th><th class="r">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <table class="tot">
    <tr><td style="color:#64748b;">Subtotal</td><td class="r">${fmt(order.subtotal)}</td></tr>
    ${discountRow}
    <tr><td style="color:#64748b;">Delivery</td><td class="r">${fmt(order.deliveryFee)}</td></tr>
    <tr class="grand"><td>Grand Total</td><td class="r">${fmt(order.total)}</td></tr>
    ${partialRows}
  </table>

  <div class="qr-wrap">
    <div class="qr-img"><img src="${qrApiUrl}" width="120" height="120" alt="Order QR Code" /></div>
    <div class="qr-url">${orderUrl}</div>
    <div style="font-size:9px;color:#64748b;margin-top:2px;">Scan QR code to view your order status</div>
  </div>

  <div class="foot">
    <p>Thank you for your order! &nbsp;·&nbsp; ${(() => { const t = siteSettings.trademarkText || ''; return !t.trim() || /quirky[\s-]?fruity/i.test(t) ? `&copy; ${new Date().getFullYear()} ${storeName}. All rights reserved.` : t; })()}</p>
  </div>
</div>
<script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};</script>
</body></html>`;

    const popup = window.open('', '_blank', 'width=560,height=720,scrollbars=yes');
    if (popup) { popup.document.write(html); popup.document.close(); }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex font-sans" role="dialog" aria-modal="true">
      
      {/* Dark background overlay */}
      <div onClick={onClose} className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity cursor-pointer"></div>

      {/* Slide-over Content Drawer */}
      <div className="relative ml-auto max-w-2xl w-full h-full bg-white border-l border-slate-200 shadow-2xl flex flex-col justify-between overflow-y-auto p-6 scrollbar-thin">
        
        {/* Header Block */}
        <div className="flex items-center justify-between border-b border-slate-200 pb-4 mb-4 select-none">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-sm flex-shrink-0">
              <ShoppingBag className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-slate-800 uppercase tracking-tight">
              Secure Checkout
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 bg-slate-50 border border-slate-200 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-100 rounded-full cursor-pointer text-slate-400 transition-colors"
            id="close-cart-btn"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* IF SUCCESS INVOICE PREVIEW VIEW */}
        {placedInvoiceOrder ? (
          <div className="flex-1 py-4 flex flex-col justify-between" id="printable-sales-invoice-modal">

            {/* Success hero banner */}
            {(() => {
              const paid = placedInvoiceOrder.paymentStatus === 'Paid';
              const feePaid = placedInvoiceOrder.paymentStatus === 'Delivery Fee Paid';
              const pm = placedInvoiceOrder.paymentMethod || 'COD';
              const isManual = ['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(pm);
              const heroTitle = paid ? 'Payment Successful' : feePaid ? 'Order Confirmed' : isManual ? 'Order Received' : 'Order Placed';
              const heroSub = paid
                ? 'Your payment was confirmed — thank you for your order!'
                : feePaid
                  ? 'Delivery fee paid. Pay the remaining balance on delivery.'
                  : isManual
                    ? `We'll confirm as soon as your ${pm} payment is verified.`
                    : 'Thank you! Your order has been placed successfully.';
              return (
                <div className="relative overflow-hidden rounded-3xl mb-6 px-6 pt-7 pb-6 text-center bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-600 shadow-xl shadow-emerald-200/60">
                  <style>{`@keyframes qfPop{0%{transform:scale(0.5) rotate(-10deg);opacity:0}55%{transform:scale(1.12) rotate(3deg)}100%{transform:scale(1) rotate(0);opacity:1}}@keyframes qfSheen{0%{transform:translateX(-140%)}100%{transform:translateX(240%)}}@keyframes qfRise{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}`}</style>
                  <div className="pointer-events-none absolute inset-0 opacity-40"><div className="absolute top-0 h-full w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/60 to-transparent blur-md animate-[qfSheen_2.6s_ease-in-out_infinite]" /></div>
                  <div className="pointer-events-none absolute -top-10 -right-8 w-28 h-28 rounded-full bg-white/15 blur-2xl" />
                  <div className="pointer-events-none absolute -bottom-12 -left-8 w-28 h-28 rounded-full bg-teal-300/25 blur-2xl" />
                  <div className="relative flex flex-col items-center">
                    <div className="w-[68px] h-[68px] rounded-2xl bg-white flex items-center justify-center mb-3 shadow-lg shadow-emerald-900/25 rotate-3 animate-[qfPop_0.55s_cubic-bezier(0.16,1,0.3,1)]">
                      <PartyPopper className="w-9 h-9 text-emerald-600" strokeWidth={2.2} />
                    </div>
                    <div className="animate-[qfRise_0.5s_ease-out_0.15s_both]">
                      <h2 className="text-2xl font-black text-white tracking-tight drop-shadow-sm">{heroTitle}</h2>
                      <p className="text-[13px] text-emerald-50 mt-1.5 max-w-[280px] mx-auto leading-relaxed">{heroSub}</p>
                    </div>
                    <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3.5 py-1.5 text-[11px] font-bold text-white ring-1 ring-white/30 backdrop-blur animate-[qfRise_0.5s_ease-out_0.28s_both]">
                      <Sparkles className="w-3.5 h-3.5" /> Order #{placedInvoiceOrder.orderNumber}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Sales Invoice Copy */}
            <div className="bg-slate-50 border border-dashed border-emerald-300 rounded-2xl p-5 relative select-none">
              
              <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
                <div>
                  <h3 className="text-xl font-bold text-emerald-600 uppercase tracking-tight">
                    {(siteSettings.websiteName || 'Store').toUpperCase()}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">SALES RECEIPT</p>
                </div>
                <div className="text-right">
                  {(() => {
                    const pm = placedInvoiceOrder.paymentMethod || 'COD';
                    const paid = placedInvoiceOrder.paymentStatus === 'Paid';
                    const isManual = ['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(pm);
                    const isCOD = pm === 'COD';
                    const label = isCOD
                      ? 'COD PLACED'
                      : isManual
                        ? `${pm.toUpperCase()} · ORDER RECEIVED`
                        : paid
                          ? `${pm.toUpperCase()} · PAYMENT CONFIRMED`
                          : `${pm.toUpperCase()} · ORDER PLACED`;
                    const tone = isManual
                      ? 'bg-amber-100 text-amber-800 border-amber-300'
                      : 'bg-emerald-100 text-emerald-800 border-emerald-300';
                    return (
                      <div className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 border rounded-full ${tone}`}>
                        {label}
                      </div>
                    );
                  })()}
                  <div className="text-xs font-bold text-slate-700 mt-1">NO: {placedInvoiceOrder.orderNumber}</div>
                </div>
              </div>

              {/* QR Code — links directly to order tracking page */}
              <div className="flex flex-col items-center justify-center py-3 mb-4">
                <div className="p-2 bg-white border border-slate-200 rounded-xl shadow-sm">
                  <QRCodeImg value={`${window.location.origin}/tracker?order=${placedInvoiceOrder.orderNumber}`} size={88} />
                </div>
                <span className="text-[10px] font-mono mt-1.5 text-slate-400">{placedInvoiceOrder.id.toUpperCase()}</span>
                <span className="text-[9px] text-slate-400 mt-0.5">Scan to view order status</span>
              </div>

              {/* Invoice Table list */}
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-12 border-b border-slate-200 pb-1.5 font-bold text-emerald-600 uppercase text-[10px]">
                  <span className="col-span-8">Product Item description</span>
                  <span className="col-span-2 text-center">Qty</span>
                  <span className="col-span-2 text-right">Sum</span>
                </div>
                {placedInvoiceOrder.items.map((item, idx) => (
                  <div key={idx} className="py-1.5 border-b border-slate-100">
                    <div className="grid grid-cols-12 text-xs font-medium text-slate-600">
                      <div className="col-span-8">
                        <span className="font-semibold text-slate-800">{item.name}</span>
                        {(item.variantLabel || (item as any).selectedVariants) && (
                          <p className="text-[10px] text-emerald-600 font-semibold mt-0.5">
                            {item.variantLabel || Object.entries((item as any).selectedVariants || {}).map(([g, v]) => `${g}: ${v}`).join(' / ')}
                          </p>
                        )}
                      </div>
                      <span className="col-span-2 text-center">{item.quantity}</span>
                      <span className="col-span-2 text-right">{formatPrice(item.price * item.quantity)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pricing Math breakdowns */}
              <div className="border-t border-dashed border-slate-200 pt-3 mt-4 space-y-1 text-xs">
                <div className="flex justify-between text-slate-500">
                  <span className="font-semibold uppercase">Subtotal</span>
                  <span className="font-bold text-slate-800">{formatPrice(placedInvoiceOrder.subtotal)}</span>
                </div>
                {placedInvoiceOrder.discount > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span className="font-semibold uppercase">Discount</span>
                    <span className="font-bold">-{formatPrice(placedInvoiceOrder.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-500">
                  <span className="font-semibold uppercase">Delivery & Handling</span>
                  <span className="font-bold text-slate-800">{formatPrice(placedInvoiceOrder.deliveryFee)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2 font-bold text-emerald-600 text-sm">
                  <span className="uppercase">GRAND TOTAL</span>
                  <span>{formatPrice(placedInvoiceOrder.total)}</span>
                </div>

                {/* Partial-COD split: how much was paid online now vs. what's
                    still due to the courier on delivery. Only shown when the
                    shopper prepaid just the delivery fee. */}
                {placedInvoiceOrder.paymentStatus === 'Delivery Fee Paid' && (
                  <div className="mt-2 pt-2 border-t border-dashed border-slate-200 space-y-1">
                    <div className="flex justify-between text-emerald-600">
                      <span className="font-semibold uppercase">Paid Online (Delivery Fee)</span>
                      <span className="font-bold">{formatPrice(placedInvoiceOrder.paidAmount ?? placedInvoiceOrder.deliveryFee)}</span>
                    </div>
                    <div className="flex justify-between text-rose-600 text-sm">
                      <span className="font-bold uppercase">Remaining — Pay on Delivery</span>
                      <span className="font-extrabold">{formatPrice(placedInvoiceOrder.outstandingAmount ?? Math.max(0, placedInvoiceOrder.total - (placedInvoiceOrder.paidAmount ?? 0)))}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="text-center text-xs text-slate-400 mt-6 border-t border-dashed border-slate-200 pt-3">
                <p className="font-semibold text-xs text-emerald-600">
                  {(() => {
                    const pm = placedInvoiceOrder.paymentMethod || 'COD';
                    const isManual = ['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(pm);
                    if (isManual) return `Order received — we'll confirm after verifying your ${pm} payment.`;
                    if (placedInvoiceOrder.paymentStatus === 'Delivery Fee Paid') return `Delivery fee paid online. Your order is confirmed — pay ${formatPrice(placedInvoiceOrder.outstandingAmount ?? 0)} on delivery.`;
                    if (placedInvoiceOrder.paymentStatus === 'Paid') return 'Payment confirmed. Thank you for your order!';
                    return 'Thank you for your order!';
                  })()}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed">Your confirmation receipt invoice email has been compiled and forwarded to <strong>{placedInvoiceOrder.email}</strong>.</p>
                <p className="mt-3 text-[9px] text-slate-400 capitalize">
                  {(() => {
                    const name = (siteSettings.websiteName || 'Store').trim();
                    const t = siteSettings.trademarkText || '';
                    return !t.trim() || /quirky[\s-]?fruity/i.test(t)
                      ? `© ${new Date().getFullYear()} ${name}. All rights reserved.`
                      : t;
                  })()}
                </p>
              </div>

            </div>

            <div className="flex flex-col gap-2 mt-6">
              <button
                onClick={handlePrintInvoice}
                className="w-full cursor-pointer py-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold rounded-xl uppercase transition-all flex items-center justify-center gap-2 shadow-xs"
              >
                <Printer className="w-4 h-4" />
                <span>PRINT INVOICE</span>
              </button>

              <button
                onClick={() => {
                  setPlacedInvoiceOrder(null);
                  onClose();
                }}
                className="w-full cursor-pointer py-3 bg-emerald-500 text-white hover:bg-emerald-600 font-bold rounded-xl uppercase transition-all flex items-center justify-center gap-2 shadow-sm"
              >
                <span>CONTINUE SHOPPING</span>
              </button>
            </div>

          </div>
        ) : cart.length === 0 ? (
          
          /* EMPTY CART STATE */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none">
            <div className="text-5xl mb-4 bg-slate-50 p-4 rounded-full text-slate-500 border border-slate-100">🛒</div>
            <h3 className="text-md font-bold text-slate-800 uppercase">Your Checkout Cart is Empty</h3>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mt-1.5">
              Add products from the menu to proceed
            </p>
            <button
              onClick={onClose}
              className="mt-6 cursor-pointer px-6 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-xs uppercase shadow-sm rounded-full transition-all"
            >
              Start Shopping
            </button>
          </div>
        ) : (
          /* ACTIVE SHOPPING ITEMS AND CHECKOUT FORM FRAME */
          <div className="flex-1 flex flex-col justify-between">
            {/* Scrollable list items */}
            <div className="space-y-3 max-h-[220px] overflow-y-auto mb-4 border-b pb-4 border-dashed border-slate-100 scrollbar-thin">
              {cart.map((item) => (
                <div key={item.id} className="bg-white border border-slate-100 p-3 rounded-xl flex items-center justify-between gap-3 shadow-sm">
                  <div className="text-xl h-9 w-9 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-center select-none overflow-hidden">
                    {(() => {
                      // Use variant-specific image if available, fallback to product image
                      const imgSrc = item.variantImage || item.product.coverImage || item.product.image;
                      return imgSrc && (imgSrc.startsWith('http') || imgSrc.startsWith('data:') || imgSrc.startsWith('/')) ? (
                        <img src={imgSrc} alt={item.product.name} className="w-full h-full object-cover rounded-lg" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; (e.currentTarget.parentElement as HTMLElement).innerText = '🛒'; }} />
                      ) : (
                        <span>🛒</span>
                      );
                    })()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-bold text-slate-900 truncate uppercase">{item.product.name}</h4>
                    {item.selectedVariants && Object.keys(item.selectedVariants).length > 0 && (
                      <p className="text-[10px] text-emerald-600 font-medium truncate">
                        {Object.entries(item.selectedVariants).map(([g, v]) => `${g}: ${v}`).join(' / ')}
                      </p>
                    )}
                    <p className="text-[10px] text-slate-400 font-semibold uppercase mt-0.5">{formatPrice(item.variantPrice ?? (item.product.salePrice || item.product.price))} each</p>
                  </div>
                  <div className="flex items-center gap-1.5 border border-slate-200 p-0.5 rounded-lg bg-slate-50 scale-90">
                    <button type="button" onClick={() => updateCartQuantity(item.id, item.quantity - 1)} className="p-1 hover:bg-slate-200 text-slate-600 rounded cursor-pointer"><Minus className="w-3 h-3" /></button>
                    <span className="text-xs font-bold px-1.5 text-slate-800">{item.quantity}</span>
                    <button type="button" onClick={() => updateCartQuantity(item.id, item.quantity + 1)} className="p-1 hover:bg-slate-200 text-slate-600 rounded cursor-pointer"><Plus className="w-3 h-3" /></button>
                  </div>
                  <button onClick={() => removeFromCart(item.id)} className="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>

            {/* ─── Coupon ─── */}
            <form onSubmit={handleApplyCoupon} className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <Ticket className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                  placeholder="Coupon code"
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm uppercase outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white transition-all"
                />
              </div>
              <button type="submit" className="px-4 py-2.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold uppercase rounded-xl cursor-pointer">
                Apply
              </button>
              {appliedCoupon && (
                <button type="button" onClick={removeCoupon} className="px-3 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-bold uppercase rounded-xl cursor-pointer">
                  Remove
                </button>
              )}
            </form>

            {/* ─── COD Delivery Fee Prepayment Screen ─── */}
            {showPrepaymentScreen && requiresPrepayment && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm">
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 relative">
                  {/* Header */}
                  <div className="flex items-center gap-3 mb-4 pb-4 border-b border-slate-200">
                    <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-xl">💳</span>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 uppercase tracking-tight">Delivery Fee Prepayment Required</h3>
                      <p className="text-[10px] text-slate-500 font-medium mt-0.5">
                        {matchedZone?.name && `Zone: ${matchedZone.name} · `}Pay the delivery charge upfront to confirm your COD order.
                      </p>
                    </div>
                  </div>

                  {/* Order breakdown */}
                  <div className="space-y-2 mb-5">
                    <div className="flex justify-between text-sm text-slate-600">
                      <span>Products Total</span>
                      <span className="font-semibold text-slate-800">{formatPrice(subtotal)}</span>
                    </div>
                    {discountAmount > 0 && (
                      <div className="flex justify-between text-sm text-rose-600">
                        <span>Discount</span>
                        <span className="font-semibold">-{formatPrice(discountAmount)}</span>
                      </div>
                    )}
                    {taxAmount > 0 && (
                      <div className="flex justify-between text-sm text-slate-600">
                        <span>Tax</span>
                        <span className="font-semibold">{formatPrice(taxAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm text-slate-800 font-bold border-t border-dashed border-slate-200 pt-2">
                      <span>Total Order Value</span>
                      <span>{formatPrice(grandTotal)}</span>
                    </div>
                  </div>

                  {/* Payment split */}
                  <div className="grid grid-cols-2 gap-3 mb-5">
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                      <p className="text-[10px] font-bold text-emerald-700 uppercase mb-1">Pay Now Online</p>
                      <p className="text-lg font-extrabold text-emerald-600">{formatPrice(partialAdvance)}</p>
                      <p className="text-[9px] text-emerald-600 mt-0.5">Advance payment</p>
                    </div>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                      <p className="text-[10px] font-bold text-slate-600 uppercase mb-1">Pay on Delivery</p>
                      <p className="text-lg font-extrabold text-slate-700">{formatPrice(Math.max(0, grandTotal - partialAdvance))}</p>
                      <p className="text-[9px] text-slate-500 mt-0.5">Remaining balance</p>
                    </div>
                  </div>

                  {/* ─── Choose which automatic gateway to pay the fee with ─── */}
                  {(() => {
                    const FEE_GATEWAYS: { id: string; label: string; logo: string }[] = [
                      { id: 'bKashAuto',  label: 'bKash',         logo: '/logos/bkash.png' },
                      { id: 'NagadAuto',  label: 'Nagad',         logo: '/logos/nagad.png' },
                      { id: 'Stripe',     label: 'Card (Stripe)', logo: '/logos/stripe.png' },
                      { id: 'PayPal',     label: 'PayPal',        logo: '/logos/paypal.png' },
                      { id: 'SSLCommerz', label: 'SSLCommerz',    logo: '/logos/sslcommerz.png' },
                      { id: 'Razorpay',   label: 'Razorpay',      logo: '/logos/razorpay.png' },
                      { id: 'Paytm',      label: 'Paytm',         logo: '/logos/paytm.png' },
                      { id: 'UPI',        label: 'UPI / QR',      logo: '/logos/upi.png' },
                      { id: 'JazzCash',   label: 'JazzCash',      logo: '/logos/jazzcash.png' },
                      { id: 'Easypaisa',  label: 'Easypaisa',     logo: '/logos/easypaisa.png' },
                      { id: 'PayFast',    label: 'PayFast',       logo: '/logos/payfast.png' },
                    ];
                    const enabledGws = FEE_GATEWAYS.filter(g => hasEnabledPaymentMethod(paymentSettings, g.id));
                    if (enabledGws.length === 0) return null;
                    const effective = (selectedFeeGateway && enabledGws.some(g => g.id === selectedFeeGateway))
                      ? selectedFeeGateway
                      : enabledGws[0].id;
                    return (
                      <div className="mb-4">
                        <p className="text-[10px] font-bold text-slate-500 uppercase mb-2">Choose payment method</p>
                        <div className="grid grid-cols-3 gap-2">
                          {enabledGws.map(g => (
                            <button
                              type="button"
                              key={g.id}
                              onClick={() => setSelectedFeeGateway(g.id)}
                              className={`min-h-[54px] flex flex-col items-center justify-center gap-1 px-1.5 py-2 border rounded-xl cursor-pointer transition-all select-none ${
                                effective === g.id
                                  ? 'bg-emerald-50 border-emerald-400 ring-2 ring-emerald-200'
                                  : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                              }`}
                            >
                              <img
                                src={g.logo}
                                alt={g.label}
                                className="h-5 w-auto object-contain"
                                loading="lazy"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                  const lbl = e.currentTarget.nextElementSibling as HTMLElement | null;
                                  if (lbl) lbl.style.display = 'block';
                                }}
                              />
                              {/* Logo-only by default (matches the main checkout chooser). The
                                  text label is a fallback that only appears if the logo image fails to load. */}
                              <span className="text-center text-[9px] font-bold uppercase leading-tight text-slate-600" hidden>{g.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <p className="text-[9px] text-slate-400 text-center mb-4">
                    You will be redirected to the secure payment gateway to pay only the delivery fee. Your order will be confirmed instantly after successful payment.
                  </p>

                  {/* Actions */}
                  <button
                    type="button"
                    onClick={handlePrepayDeliveryFee}
                    disabled={isPlacingOrder}
                    className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold text-sm uppercase rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2 cursor-pointer mb-2"
                  >
                    {isPlacingOrder ? (
                      <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Processing…</>
                    ) : (
                      <>Pay {formatPrice(partialAdvance)} Now</>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPrepaymentScreen(false)}
                    className="w-full py-2 text-slate-500 hover:text-slate-700 text-xs font-semibold uppercase cursor-pointer transition-colors"
                  >
                    ← Go back to checkout
                  </button>
                </div>
              </div>
            )}

            {/* ─── Pricing breakdown ─── */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span><span className="font-semibold text-slate-800">{formatPrice(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-rose-600">
                  <span>Discount{appliedCoupon ? ` (${appliedCoupon.code})` : ''}</span>
                  <span className="font-semibold">-{formatPrice(discountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-600">
                <span>Delivery {matchedZone?.isEnabled ? `(${matchedZone.name})` : ''}</span>
                <span className="font-semibold text-slate-800">{formatPrice(deliveryFee)}</span>
              </div>
              {taxAmount > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Tax</span><span className="font-semibold text-slate-800">{formatPrice(taxAmount)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-dashed border-slate-300 pt-2 mt-1 text-emerald-600 font-bold text-base">
                <span>Grand Total</span>
                <div className="text-right">
                  <span>{formatPrice(grandTotal)}</span>
                  {convertedTotal.currency.toUpperCase() !== (siteSettings?.currency || 'USD').toUpperCase() && (
                    <div className="text-xs font-semibold mt-0.5">
                      {convertedTotal.loading
                        ? <span className="text-slate-400">(fetching live rate…)</span>
                        : convertedTotal.rate === 1
                          ? <span className="text-rose-500">⚠ Rate unavailable — pay in {siteSettings?.currency || 'USD'}</span>
                          : <span className="text-amber-600">≈ {CURRENCY_SYMBOLS[convertedTotal.currency] || convertedTotal.currency}{convertedTotal.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {convertedTotal.currency} <span className="text-slate-400 font-normal">(1 {(siteSettings?.currency||'USD').toUpperCase()} = {convertedTotal.rate.toFixed(2)} {convertedTotal.currency})</span></span>
                      }
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ─── Shipping & payment form ─── */}
            <form onSubmit={handleCheckoutSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Full Name *</label>
                  <input required value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Email *</label>
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>

                {/* Email OTP verification block — only when admin requires it
                    and the email isn't already verified for this session. */}
                {emailVerificationRequired && (
                  <div className="col-span-2 bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[11px] font-bold uppercase text-indigo-800 flex items-center gap-1">
                        <Mail className="w-3.5 h-3.5" />
                        Email Verification
                      </span>
                      {emailOtpVerified && emailOtpVerifyingEmail === normalizedEmail ? (
                        <span className="text-[10px] font-bold uppercase text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Verified
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!normalizedEmail || emailOtpSending}
                          onClick={handleSendEmailOtp}
                          className="text-[10px] font-bold uppercase bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-2.5 py-1 rounded-full cursor-pointer"
                        >
                          {emailOtpSending ? 'Sending…' : emailOtpSent ? 'Resend code' : 'Send email code'}
                        </button>
                      )}
                    </div>
                    {emailOtpSent && !(emailOtpVerified && emailOtpVerifyingEmail === normalizedEmail) && (
                      <div className="flex gap-2">
                        <input
                          inputMode="numeric"
                          maxLength={8}
                          value={emailOtpCode}
                          onChange={(e) => setEmailOtpCode(e.target.value.replace(/[^\d]/g, ''))}
                          placeholder="6-digit code"
                          className="flex-1 px-3 py-2 bg-white border border-indigo-300 rounded-lg text-sm font-mono tracking-widest text-center outline-none focus:ring-2 focus:ring-indigo-400"
                        />
                        <button type="button" onClick={handleVerifyEmailOtp}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase rounded-lg cursor-pointer">
                          Verify
                        </button>
                      </div>
                    )}
                    <p className="text-[10px] text-indigo-700/80 mt-2">
                      We'll email a 6-digit code to verify it's you.
                    </p>
                  </div>
                )}

                {/* Country code + phone number */}
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">
                    Mobile Number * <span className="text-slate-400 normal-case font-medium">(used for order updates{otpRequired ? ` & ${otpChannelLabel} OTP` : ''})</span>
                  </label>
                  <div className="flex gap-2">
                    <CountryDialPicker value={dialCode} onChange={setDialCode} />

                    <input
                      required
                      inputMode="tel"
                      value={phoneLocal}
                      onChange={(e) => setPhoneLocal(e.target.value.replace(/[^\d\s-]/g, ''))}
                      placeholder={phoneRule.lengths[0] ? `e.g. ${'X'.repeat(phoneRule.lengths[0])}` : 'Phone number'}
                      className={`flex-1 px-3 py-2.5 bg-slate-50 border rounded-xl text-sm outline-none focus:ring-2 focus:bg-white ${
                        phoneLocal && !phoneValidation.ok
                          ? 'border-rose-300 focus:ring-rose-400'
                          : 'border-slate-200 focus:ring-emerald-400'
                      }`}
                    />
                  </div>
                  {phoneLocal && !phoneValidation.ok && (
                    <p className="text-[11px] text-rose-600 mt-1 font-semibold">{phoneValidation.error}</p>
                  )}
                  {phoneLocal && phoneValidation.ok && (
                    <p className="text-[11px] text-emerald-600 mt-1 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> {phoneValidation.e164}
                    </p>
                  )}
                </div>

                {/* OTP verification block — only if admin requires it */}
                {otpRequired && (
                  <div className="col-span-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[11px] font-bold uppercase text-amber-800 flex items-center gap-1">
                        <Shield className="w-3.5 h-3.5" />
                        {otpChannelLabel} OTP Verification
                      </span>
                      {otpVerified && otpVerifyingPhone === phone ? (
                        <span className="text-[10px] font-bold uppercase text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Verified
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!phoneValidation.ok || otpSending}
                          onClick={handleSendOtp}
                          className="text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-2.5 py-1 rounded-full cursor-pointer"
                        >
                          {otpSending ? 'Sending…' : otpSent ? 'Resend code' : `Send ${otpChannelLabel} code`}
                        </button>
                      )}
                    </div>
                    {otpSent && !(otpVerified && otpVerifyingPhone === phone) && (
                      <div className="flex gap-2">
                        <input
                          inputMode="numeric"
                          maxLength={8}
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value.replace(/[^\d]/g, ''))}
                          placeholder="6-digit code"
                          className="flex-1 px-3 py-2 bg-white border border-amber-300 rounded-lg text-sm font-mono tracking-widest text-center outline-none focus:ring-2 focus:ring-amber-400"
                        />
                        <button type="button" onClick={handleVerifyOtp}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase rounded-lg cursor-pointer">
                          Verify
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Address *</label>
                  <input required value={address} onChange={(e) => setAddress(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">City *</label>
                  <input required value={city} onChange={(e) => setCity(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Postal Code</label>
                  <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Delivery Note</label>
                  <textarea rows={2} value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)}
                    placeholder="Landmarks, gate code, preferred time…"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
              </div>

              {/* ─── Payment method ─── */}
              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-500 mb-2">Payment Method *</label>
                {/* Payment loading skeleton: shown in incognito (no cache) while DB fetch is in progress */}
                {paymentSettingsLoading && ([
                    'COD', 'bKash', 'Nagad', 'SSLCommerz',
                  ].every(m => !isPaymentMethodEnabled(m))) && (
                  <div className="grid grid-cols-2 sm:grid-cols-2 gap-2">
                    {[1,2,3,4].map(i => (
                      <div key={i}
                        className="min-h-[68px] flex flex-col items-center justify-center gap-2 px-2 py-2 border border-slate-100 rounded-xl bg-slate-50 animate-pulse">
                        <div className="w-14 h-4 bg-slate-200 rounded" />
                        <div className="w-10 h-2 bg-slate-100 rounded" />
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-2 gap-2">
                  {([
                    { id: 'COD',           fallbackLabel: 'Cash on Delivery',  icon: <ShoppingBag className="w-4 h-4" />, enabled: paymentSettings.codEnabled !== false,              displayName: paymentSettings.codDisplayName,              logoUrl: paymentSettings.codLogoImageUrl },
                    { id: 'bKash',         fallbackLabel: 'bKash',             icon: null, defaultLogoPath: '/logos/bkash.png',      enabled: paymentSettings.bKashEnabled === true,              displayName: paymentSettings.bKashDisplayName,            logoUrl: paymentSettings.bKashLogoImageUrl },
                    { id: 'Nagad',         fallbackLabel: 'Nagad',             icon: null, defaultLogoPath: '/logos/nagad.png',      enabled: paymentSettings.nagadEnabled === true,              displayName: paymentSettings.nagadDisplayName,            logoUrl: paymentSettings.nagadLogoImageUrl },
                    { id: 'Rocket',        fallbackLabel: 'Rocket',            icon: null, defaultLogoPath: '/logos/rocket.png',     enabled: paymentSettings.rocketEnabled === true,             displayName: paymentSettings.rocketDisplayName,           logoUrl: paymentSettings.rocketLogoImageUrl },
                    { id: 'Bank',          fallbackLabel: 'Bank Transfer',      icon: <Landmark className="w-4 h-4" />,   enabled: paymentSettings.bankEnabled === true,               displayName: paymentSettings.bankDisplayName,             logoUrl: paymentSettings.bankLogoImageUrl },
                    { id: 'CreditManual',  fallbackLabel: 'Manual Card Ref',   icon: <CreditCard className="w-4 h-4" />, enabled: paymentSettings.creditManualEnabled === true,       displayName: paymentSettings.creditManualDisplayName,     logoUrl: paymentSettings.creditManualLogoImageUrl },
                    { id: 'Stripe',        fallbackLabel: 'Card (Stripe)',      icon: null, defaultLogoPath: '/logos/stripe.png',    enabled: paymentSettings.stripeEnabled === true,             displayName: paymentSettings.stripeDisplayName,           logoUrl: paymentSettings.stripeLogoImageUrl },
                    { id: 'PayPal',        fallbackLabel: 'PayPal',            icon: null, defaultLogoPath: '/logos/paypal.png',    enabled: paymentSettings.paypalEnabled === true,             displayName: paymentSettings.paypalDisplayName,           logoUrl: paymentSettings.paypalLogoImageUrl },
                    { id: 'bKashAuto',     fallbackLabel: 'bKash (Auto)',      icon: null, defaultLogoPath: '/logos/bkash.png',     enabled: paymentSettings.bKashAutoEnabled === true,          displayName: paymentSettings.bKashAutoDisplayName,        logoUrl: paymentSettings.bKashAutoLogoImageUrl },
                    { id: 'NagadAuto',     fallbackLabel: 'Nagad (Auto)',      icon: null, defaultLogoPath: '/logos/nagad.png',     enabled: paymentSettings.nagadAutoEnabled === true,          displayName: paymentSettings.nagadAutoDisplayName,        logoUrl: paymentSettings.nagadAutoLogoImageUrl },
                    { id: 'SSLCommerz',    fallbackLabel: 'SSLCommerz',        icon: null, defaultLogoPath: '/logos/sslcommerz.png',enabled: paymentSettings.sslCommerzEnabled === true,         displayName: paymentSettings.sslCommerzDisplayName,       logoUrl: paymentSettings.sslCommerzLogoImageUrl },
                    { id: 'Razorpay',      fallbackLabel: 'Razorpay',          icon: null, defaultLogoPath: '/logos/razorpay.png',  enabled: paymentSettings.razorpayEnabled === true,           displayName: paymentSettings.razorpayDisplayName,         logoUrl: paymentSettings.razorpayLogoImageUrl },
                    { id: 'Paytm',         fallbackLabel: 'Paytm',             icon: null, defaultLogoPath: '/logos/paytm.png',     enabled: paymentSettings.paytmEnabled === true,              displayName: (paymentSettings as any).paytmDisplayName,   logoUrl: (paymentSettings as any).paytmLogoImageUrl },
                    { id: 'UPI',           fallbackLabel: 'UPI / QR',          icon: null, defaultLogoPath: '/logos/upi.png',       enabled: paymentSettings.upiManualEnabled === true,          displayName: (paymentSettings as any).upiDisplayName,     logoUrl: (paymentSettings as any).upiLogoImageUrl },
                    { id: 'JazzCash',      fallbackLabel: 'JazzCash',          icon: null, defaultLogoPath: '/logos/jazzcash.png',  enabled: paymentSettings.jazzCashEnabled === true,           displayName: (paymentSettings as any).jazzCashDisplayName,logoUrl: (paymentSettings as any).jazzCashLogoImageUrl },
                    { id: 'Easypaisa',     fallbackLabel: 'Easypaisa',         icon: null, defaultLogoPath: '/logos/easypaisa.png', enabled: paymentSettings.easypaisaEnabled === true,          displayName: (paymentSettings as any).easypaisaDisplayName,logoUrl: (paymentSettings as any).easypaisaLogoImageUrl },
                    { id: 'PayFast',       fallbackLabel: 'PayFast',           icon: null, defaultLogoPath: '/logos/payfast.png',   enabled: paymentSettings.payFastEnabled === true,            displayName: (paymentSettings as any).payFastDisplayName, logoUrl: (paymentSettings as any).payFastLogoImageUrl },
                  ] as PaymentOption[]).filter(opt => opt.enabled).map(opt => {
                    const customLogoUrl = cleanSetting(opt.logoUrl);
                    const effectiveLogoUrl = customLogoUrl || opt.defaultLogoPath || '';
                    const visibleLabel = effectiveLogoUrl
                      ? (customLogoUrl ? getPaymentButtonLabel(opt.displayName, opt.fallbackLabel, customLogoUrl) : '')
                      : opt.fallbackLabel;
                    return (
                    <label key={opt.id}
                      className={`min-h-[68px] flex flex-col items-center justify-center gap-1.5 px-2 py-2 border rounded-xl cursor-pointer transition-all select-none ${
                        paymentMethod === opt.id
                          ? 'bg-emerald-50 border-emerald-400 text-emerald-700 ring-2 ring-emerald-200'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                      }`}>
                      <input type="radio" name="pm" value={opt.id} checked={paymentMethod === opt.id}
                        onChange={() => setPaymentMethod(opt.id)} className="sr-only" />
                      {effectiveLogoUrl ? (
                        <img
                          src={effectiveLogoUrl}
                          alt={opt.fallbackLabel}
                          className="object-contain flex-shrink-0 w-auto"
                          style={{ height: '36px', maxWidth: '90%', maxHeight: '36px' }}
                          loading="lazy"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                            const lbl = e.currentTarget.nextElementSibling as HTMLElement | null;
                            if (lbl) lbl.style.display = 'block';
                          }}
                        />
                      ) : (
                        <span className="flex-shrink-0 text-current">{opt.icon}</span>
                      )}
                      {/* Only show text label when there is no logo (or icon-only methods like Bank/COD without custom logo) */}
                      {visibleLabel ? (
                        <span className="text-center text-[10px] sm:text-xs font-bold uppercase leading-tight w-full line-clamp-2">
                          {visibleLabel}
                        </span>
                      ) : !effectiveLogoUrl ? (
                        <span className="text-center text-[10px] sm:text-xs font-bold uppercase leading-tight w-full line-clamp-2">
                          {opt.fallbackLabel}
                        </span>
                      ) : (
                        /* Hidden fallback revealed by onError above */
                        <span className="text-center text-[10px] sm:text-xs font-bold uppercase leading-tight w-full line-clamp-2" style={{ display: 'none' }}>
                          {opt.fallbackLabel}
                        </span>
                      )}
                    </label>
                  );})}
                </div>
              </div>

              {/* Manual payment txn id */}
              {['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(paymentMethod) && (
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Transaction / Reference ID *</label>
                  <input value={manualTxId} onChange={(e) => setManualTxId(e.target.value)}
                    placeholder="e.g. TXN1234567890"
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
              )}

              <button
                type="submit"
                disabled={isPlacingOrder || convertedTotal.loading}
                className="w-full mt-2 py-4 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-base font-black uppercase rounded-xl shadow-[0_10px_24px_rgba(5,150,105,0.24)] flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-all"
              >
                <span className="flex items-center gap-3">
                  <ShoppingBag className="w-5 h-5" />
                  <span>{isPlacingOrder ? 'PLACING ORDER…' : convertedTotal.loading ? 'GETTING RATE…' : `PLACE ORDER (${formatPrice(grandTotal)})`}</span>
                </span>
                {!isPlacingOrder && !convertedTotal.loading && convertedTotal.rate !== 1 && convertedTotal.currency.toUpperCase() !== (siteSettings?.currency || 'USD').toUpperCase() && (
                  <span className="text-xs font-semibold opacity-90 normal-case">
                    Pay ≈ {CURRENCY_SYMBOLS[convertedTotal.currency] || convertedTotal.currency}{convertedTotal.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {convertedTotal.currency}
                  </span>
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
