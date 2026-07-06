/**
 * courierService.ts
 * Real courier API integrations — Bangladesh + International
 * Each function returns { success, trackingId?, message }
 */

import type { CourierSettings } from '../types';

export interface CourierDispatchPayload {
  orderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  city: string;
  total: number;
  deliveryFee: number;
  codAmount: number; // amount to collect on delivery (0 if pre-paid)
  itemCount: number;
  weight?: number; // kg, default 0.5
  note?: string;
}

export interface CourierDispatchResult {
  success: boolean;
  trackingId?: string;
  consignmentId?: string;
  message: string;
  provider: string;
}

// ─── Pathao ──────────────────────────────────────────────────────────────────
async function getPathaoToken(cfg: CourierSettings): Promise<string | null> {
  try {
    const base = cfg.pathaoSandboxMode
      ? 'https://hermes-sandbox.pathao.com'
      : 'https://api-hermes.pathao.com';
    const res = await fetch(`${base}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: cfg.pathaoClientId,
        client_secret: cfg.pathaoClientSecret,
        username: cfg.pathaoClientId,
        password: cfg.pathaoClientSecret,
        grant_type: 'password',
      }),
    });
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

export async function dispatchPathao(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'Pathao';
  try {
    const token = await getPathaoToken(cfg);
    if (!token) return { success: false, provider, message: 'Failed to get Pathao auth token. Check credentials.' };
    const base = cfg.pathaoSandboxMode
      ? 'https://hermes-sandbox.pathao.com'
      : 'https://api-hermes.pathao.com';
    const body = {
      store_id: cfg.pathaoStoreId,
      merchant_order_id: payload.orderNumber,
      recipient_name: payload.customerName,
      recipient_phone: payload.phone,
      recipient_address: payload.address,
      recipient_city: cfg.pathaoCityId ?? 1,
      recipient_zone: cfg.pathaoZoneId ?? 1,
      recipient_area: cfg.pathaoAreaId ?? 1,
      delivery_type: cfg.pathaoServiceType ?? 48, // 48h express
      item_type: 2, // parcel
      special_instruction: payload.note ?? '',
      item_quantity: payload.itemCount,
      item_weight: payload.weight ?? 0.5,
      amount_to_collect: payload.codAmount,
      item_description: `Order ${payload.orderNumber}`,
    };
    const res = await fetch(`${base}/aladdin/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code === 200 && data.data?.consignment_id) {
      return { success: true, provider, trackingId: data.data.consignment_id, consignmentId: data.data.consignment_id, message: `Pathao order created. Tracking: ${data.data.consignment_id}` };
    }
    return { success: false, provider, message: data.message ?? JSON.stringify(data) };
  } catch (e: unknown) {
    return { success: false, provider, message: `Pathao error: ${(e as Error).message}` };
  }
}

// ─── RedX ────────────────────────────────────────────────────────────────────
export async function dispatchRedx(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'RedX';
  try {
    const base = cfg.redxSandboxMode
      ? 'https://sandbox.redx.com.bd'
      : 'https://openapi.redx.com.bd';
    const body = {
      customer_name: payload.customerName,
      customer_phone: payload.phone,
      delivery_address: payload.address,
      pickup_store_id: cfg.redxPickupAreaId ?? '',
      cash_collection_amount: payload.codAmount,
      weight: (payload.weight ?? 0.5) * 1000, // grams
      value: payload.total,
      merchant_invoice_id: payload.orderNumber,
      instruction_to_courier: payload.note ?? '',
    };
    const res = await fetch(`${base}/v1.0.0-beta/parcel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'API-ACCESS-TOKEN': `Bearer ${cfg.redxApiKey ?? ''}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.parcel?.tracking_id) {
      return { success: true, provider, trackingId: data.parcel.tracking_id, message: `RedX parcel created. Tracking: ${data.parcel.tracking_id}` };
    }
    return { success: false, provider, message: data.message ?? JSON.stringify(data) };
  } catch (e: unknown) {
    return { success: false, provider, message: `RedX error: ${(e as Error).message}` };
  }
}

// ─── Steadfast ───────────────────────────────────────────────────────────────
export async function dispatchSteadfast(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'Steadfast';
  try {
    const body = {
      invoice: payload.orderNumber,
      recipient_name: payload.customerName,
      recipient_phone: payload.phone,
      recipient_address: payload.address,
      cod_amount: payload.codAmount,
      note: payload.note ?? '',
    };
    const res = await fetch('https://portal.steadfast.com.bd/public-api/v1/create_order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Api-Key': cfg.steadfastApiKey ?? '',
        'Secret-Key': cfg.steadfastSecretKey ?? '',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.status === 200 && data.consignment?.tracking_code) {
      return { success: true, provider, trackingId: data.consignment.tracking_code, message: `Steadfast order created. Tracking: ${data.consignment.tracking_code}` };
    }
    return { success: false, provider, message: data.message ?? JSON.stringify(data) };
  } catch (e: unknown) {
    return { success: false, provider, message: `Steadfast error: ${(e as Error).message}` };
  }
}

// ─── eCourier ────────────────────────────────────────────────────────────────
export async function dispatchEcourier(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'eCourier';
  try {
    const body = {
      API_KEY: cfg.ecourierApiKey ?? '',
      API_PASSWORD: cfg.ecourierApiPassword ?? '',
      API_ID: cfg.ecourierApiId ?? '',
      pickup_address: 'Store',
      pickup_city: cfg.ecourierCity ?? 'Dhaka',
      pickup_zone: cfg.ecourierZone ?? '',
      pickup_area: cfg.ecourierArea ?? '',
      pickup_phone: '',
      product_price: payload.total,
      product_weight: payload.weight ?? 0.5,
      producttype: 'parcel',
      product_type: '1',
      number_of_items: payload.itemCount,
      payment_type: payload.codAmount > 0 ? 'COD' : 'PAID',
      delivery_type: 'D',
      recipient_name: payload.customerName,
      recipient_mobile: payload.phone,
      recipient_city: payload.city,
      recipient_address: payload.address,
      moneycolectionamount: payload.codAmount,
      merchant_invoice_id: payload.orderNumber,
      remarks: payload.note ?? '',
    };
    const res = await fetch('https://ecourier.com.bd/api/order-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success && data.tracking_number) {
      return { success: true, provider, trackingId: data.tracking_number, message: `eCourier order created. Tracking: ${data.tracking_number}` };
    }
    return { success: false, provider, message: data.message ?? JSON.stringify(data) };
  } catch (e: unknown) {
    return { success: false, provider, message: `eCourier error: ${(e as Error).message}` };
  }
}

// ─── DHL Express ─────────────────────────────────────────────────────────────
export async function dispatchDhl(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'DHL Express';
  try {
    const base = cfg.dhlSandboxMode
      ? 'https://express.api.dhl.com/mydhlapi/test'
      : 'https://express.api.dhl.com/mydhlapi';
    const authB64 = btoa(`${cfg.dhlApiKey ?? ''}:${cfg.dhlApiSecret ?? ''}`);
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      plannedShippingDateAndTime: `${today}T12:00:00 GMT+00:00`,
      pickup: { isRequested: false },
      productCode: 'P',
      localProductCode: 'P',
      accounts: [{ typeCode: 'shipper', number: cfg.dhlAccountNumber ?? '' }],
      customerDetails: {
        shipperDetails: {
          postalAddress: { cityName: 'Dhaka', countryCode: 'BD' },
          contactInformation: { fullName: 'Store', phone: payload.phone, email: '' },
        },
        receiverDetails: {
          postalAddress: { addressLine1: payload.address.slice(0, 45), cityName: payload.city.slice(0, 45), countryCode: 'BD' },
          contactInformation: { fullName: payload.customerName, phone: payload.phone },
        },
      },
      content: {
        packages: [{ weight: payload.weight ?? 0.5, dimensions: { length: 20, width: 15, height: 10 } }],
        isCustomsDeclarable: false,
        description: `Order ${payload.orderNumber}`,
        incoterm: 'DAP',
        unitOfMeasurement: 'metric',
      },
      customerReferences: [{ value: payload.orderNumber, typeCode: 'CU' }],
    };
    const res = await fetch(`${base}/shipments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${authB64}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const trackingNumber = data.shipmentTrackingNumber ?? data.trackingNumber ?? data.packages?.[0]?.trackingNumber;
    if (trackingNumber) {
      return { success: true, provider, trackingId: trackingNumber, message: `DHL shipment created. Tracking: ${trackingNumber}` };
    }
    return { success: false, provider, message: data.detail ?? data.message ?? JSON.stringify(data).slice(0, 200) };
  } catch (e: unknown) {
    return { success: false, provider, message: `DHL error: ${(e as Error).message}` };
  }
}

// ─── FedEx ───────────────────────────────────────────────────────────────────
async function getFedexToken(cfg: CourierSettings): Promise<string | null> {
  try {
    const base = cfg.fedexSandboxMode ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com';
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.fedexClientId ?? '',
      client_secret: cfg.fedexClientSecret ?? '',
    });
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

export async function dispatchFedex(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'FedEx';
  try {
    const token = await getFedexToken(cfg);
    if (!token) return { success: false, provider, message: 'Failed to get FedEx token. Check Client ID/Secret.' };
    const base = cfg.fedexSandboxMode ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com';
    const body = {
      labelResponseOptions: 'URL_ONLY',
      requestedShipment: {
        shipper: {
          contact: { personName: 'Store', phoneNumber: payload.phone },
          address: { streetLines: ['Store Address'], city: 'Dhaka', countryCode: 'BD' },
        },
        recipients: [{
          contact: { personName: payload.customerName, phoneNumber: payload.phone },
          address: { streetLines: [payload.address.slice(0, 35)], city: payload.city, countryCode: 'BD' },
        }],
        shipDatestamp: new Date().toISOString().slice(0, 10),
        serviceType: 'INTERNATIONAL_PRIORITY',
        packagingType: 'YOUR_PACKAGING',
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        requestedPackageLineItems: [{
          weight: { units: 'KG', value: payload.weight ?? 0.5 },
        }],
      },
      accountNumber: { value: cfg.fedexAccountNumber ?? '' },
    };
    const res = await fetch(`${base}/ship/v1/shipments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-locale': 'en_US',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const trackingNumber = data.output?.transactionShipments?.[0]?.masterTrackingNumber
      ?? data.output?.transactionShipments?.[0]?.pieceResponses?.[0]?.trackingNumber;
    if (trackingNumber) {
      return { success: true, provider, trackingId: trackingNumber, message: `FedEx shipment created. Tracking: ${trackingNumber}` };
    }
    return { success: false, provider, message: data.errors?.[0]?.message ?? JSON.stringify(data).slice(0, 200) };
  } catch (e: unknown) {
    return { success: false, provider, message: `FedEx error: ${(e as Error).message}` };
  }
}

// ─── Aramex ──────────────────────────────────────────────────────────────────
export async function dispatchAramex(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  const provider = 'Aramex';
  try {
    const body = {
      ClientInfo: {
        UserName: cfg.aramexUsername ?? '',
        Password: cfg.aramexPassword ?? '',
        Version: 'v1',
        AccountNumber: cfg.aramexAccountNumber ?? '',
        AccountPin: cfg.aramexAccountPin ?? '',
        AccountEntity: 'DAC',
        AccountCountryCode: 'BD',
        Source: 24,
      },
      Transaction: { Reference1: payload.orderNumber, Reference2: '', Reference3: '', Reference4: '', Reference5: '' },
      Shipments: [{
        Shipper: {
          Reference1: payload.orderNumber,
          Reference2: '',
          AccountNumber: cfg.aramexAccountNumber ?? '',
          PartyAddress: { Line1: 'Store', City: 'Dhaka', CountryCode: 'BD' },
          Contact: { PersonName: 'Store', PhoneNumber1: payload.phone, CellPhone: payload.phone, EmailAddress: '' },
        },
        Consignee: {
          Reference1: payload.orderNumber,
          Reference2: '',
          AccountNumber: '',
          PartyAddress: { Line1: payload.address.slice(0, 50), City: payload.city, CountryCode: 'BD' },
          Contact: { PersonName: payload.customerName, PhoneNumber1: payload.phone, CellPhone: payload.phone, EmailAddress: '' },
        },
        ShippingDateTime: new Date().toISOString(),
        DueDate: new Date(Date.now() + 5 * 86400000).toISOString(),
        Details: {
          Dimensions: { Length: 20, Width: 15, Height: 10, Unit: 'cm' },
          ActualWeight: { Value: payload.weight ?? 0.5, Unit: 'KG' },
          ProductGroup: 'EXP',
          ProductType: 'PPX',
          PaymentType: payload.codAmount > 0 ? 'C' : 'P',
          PaymentOptions: payload.codAmount > 0 ? 'CSHCD' : '',
          Services: payload.codAmount > 0 ? 'CODS' : '',
          CashOnDeliveryAmount: { Value: payload.codAmount, CurrencyCode: 'USD' },
          DescriptionOfGoods: `Order ${payload.orderNumber}`,
          GoodsOriginCountry: 'BD',
          NumberOfPieces: payload.itemCount,
        },
      }],
    };
    const res = await fetch('https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc/json/CreateShipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const tracking = data.Shipments?.[0]?.ID;
    if (tracking) {
      return { success: true, provider, trackingId: String(tracking), message: `Aramex shipment created. Tracking: ${tracking}` };
    }
    return { success: false, provider, message: data.Notifications?.[0]?.Message ?? JSON.stringify(data).slice(0, 200) };
  } catch (e: unknown) {
    return { success: false, provider, message: `Aramex error: ${(e as Error).message}` };
  }
}

// ─── Master dispatch function ─────────────────────────────────────────────────
export async function dispatchToCourier(
  cfg: CourierSettings,
  payload: CourierDispatchPayload
): Promise<CourierDispatchResult> {
  if (!cfg.enabled || cfg.activeProvider === 'none') {
    return { success: false, provider: 'none', message: 'Courier integration is disabled or no provider selected.' };
  }
  switch (cfg.activeProvider) {
    case 'pathao':    return dispatchPathao(cfg, payload);
    case 'redx':      return dispatchRedx(cfg, payload);
    case 'steadfast': return dispatchSteadfast(cfg, payload);
    case 'ecourier':  return dispatchEcourier(cfg, payload);
    case 'dhl':       return dispatchDhl(cfg, payload);
    case 'fedex':     return dispatchFedex(cfg, payload);
    case 'aramex':    return dispatchAramex(cfg, payload);
    default:          return { success: false, provider: cfg.activeProvider, message: 'Unknown courier provider.' };
  }
}
