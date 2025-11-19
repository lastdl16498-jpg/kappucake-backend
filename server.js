// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------- Razorpay instance ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---------- Pricing logic (same as frontend) ----------
const MIX_PREMIUM = 0.10;
const PROFIT_MARGIN = 0.09;
const EC_ENDINGS = [29, 49, 79, 99];

function discountForWeight(w) {
  if (w >= 7) return 0.05;
  if (w >= 5 && w < 7) return 0.07;
  if (w > 3 && w <= 4.5) return 0.08;
  if (w >= 2.5 && w <= 3) return 0.09;
  return 0;
}

function roundToEcom(value) {
  const h = Math.floor(value / 100) * 100;
  for (const e of EC_ENDINGS) {
    const c = h + e;
    if (c >= value) return c;
  }
  return h + EC_ENDINGS[0];
}

function calculateFinalPrice(b1, b2, mix, weight) {
  b1 = Number(b1 || 0);
  b2 = Number(b2 || 0);
  if (!b1 || !weight) return null;
  let base = b1;
  if (mix && b2) base = ((b1 + b2) / 2) * (1 + MIX_PREMIUM);
  const raw = base * weight;
  const withProfit = raw * (1 + PROFIT_MARGIN);
  const disc = discountForWeight(weight);
  const after = withProfit * (1 - disc);
  const rounded = roundToEcom(Math.round(after));
  return {
    rounded,
    raw: Math.round(raw),
    withProfit: Math.round(withProfit),
    discountPercent: Math.round(disc * 100),
    saved: Math.round(withProfit - after)
  };
}

// ---------- Google Sheets helper ----------
async function appendToSheet(orderData, razorpayPaymentId) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID) {
    console.warn('[Sheets] Skipping: env not configured');
    return;
  }

  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const {
    customer,
    flavour1,
    flavour2,
    flavour1PricePerKg,
    flavour2PricePerKg,
    mix,
    weight,
    deliveryDate,
    message,
    timeSlot,
    preferredTime
  } = orderData;

  const now = new Date();
  const values = [[
    now.toISOString(),
    customer.name,
    customer.phone,
    customer.email,
    customer.address,
    deliveryDate,
    timeSlot,
    preferredTime || '',
    flavour1,
    flavour2 || '',
    flavour1PricePerKg,
    flavour2PricePerKg || '',
    mix ? 'Yes' : 'No',
    weight,
    message || '',
    razorpayPaymentId || ''
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
}

// ---------- Zoho OAuth helper ----------
async function getZohoAccessToken() {
  if (!process.env.ZOHO_CLIENT_ID ||
      !process.env.ZOHO_CLIENT_SECRET ||
      !process.env.ZOHO_REFRESH_TOKEN) {
    throw new Error('Zoho OAuth env vars missing');
  }

  const url = 'https://accounts.zoho.in/oauth/v2/token';
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error('Zoho token error:', txt);
    throw new Error('Failed to fetch Zoho access token');
  }

  const data = await res.json();
  if (!data.access_token) {
    console.error('Zoho token payload:', data);
    throw new Error('No access_token from Zoho');
  }
  return data.access_token;
}

// ---------- Email via Zoho ----------
async function sendOrderEmail(orderData, amountRupees, razorpayPaymentId) {
  if (!process.env.ZOHO_FROM_EMAIL) {
    console.warn('[Email] Skipping: ZOHO_FROM_EMAIL not set');
    return;
  }

  const accessToken = await getZohoAccessToken();

  const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.in',
    port: 465,
    secure: true,
    auth: {
      type: 'OAuth2',
      user: process.env.ZOHO_FROM_EMAIL,
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
      accessToken
    }
  });

  const { customer, flavour1, flavour2, weight, deliveryDate, timeSlot, preferredTime, message } = orderData;

  const subject = `KappuCake Order Confirmed - ₹${amountRupees}`;
  const html = `
    <h2>🎂 Thank you for your order, ${customer.name}!</h2>
    <p>We’ve received your payment and your cake is now queued for baking. 💕</p>
    <h3>Order Summary</h3>
    <ul>
      <li><strong>Name:</strong> ${customer.name}</li>
      <li><strong>Phone:</strong> ${customer.phone}</li>
      <li><strong>Email:</strong> ${customer.email}</li>
      <li><strong>Address:</strong> ${customer.address}</li>
      <li><strong>Delivery Date:</strong> ${deliveryDate}</li>
      <li><strong>Delivery Slot:</strong> ${timeSlot}</li>
      <li><strong>Preferred Time:</strong> ${preferredTime || '—'}</li>
      <li><strong>Flavour(s):</strong> ${flavour1}${flavour2 ? ' + ' + flavour2 : ''}</li>
      <li><strong>Weight:</strong> ${weight} kg</li>
      <li><strong>Cake Message:</strong> ${message || '—'}</li>
      <li><strong>Paid Amount:</strong> ₹${amountRupees}</li>
      <li><strong>Razorpay Payment ID:</strong> ${razorpayPaymentId}</li>
    </ul>
    <p>Our cakes are 100% eggless. We’ll reach out if we need any clarification.</p>
    <p>Love,<br/>Team KappuCake</p>
  `;

  const mailOptions = {
    from: `KappuCake <${process.env.ZOHO_FROM_EMAIL}>`,
    to: customer.email,
    bcc: process.env.ZOHO_FROM_EMAIL, // keep a copy for yourself
    subject,
    html
  };

  await transporter.sendMail(mailOptions);
}

// ---------- Routes ----------

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'KappuCake backend running' });
});

// Create Razorpay order
app.post('/create-order', async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.customer || !payload.weight || !payload.flavour1PricePerKg) {
      return res.status(400).json({ success: false, error: 'Invalid payload' });
    }

    const priceObj = calculateFinalPrice(
      payload.flavour1PricePerKg,
      payload.flavour2PricePerKg || 0,
      payload.mix,
      Number(payload.weight)
    );

    if (!priceObj) {
      return res.status(400).json({ success: false, error: 'Could not calculate price' });
    }

    const amountRupees = priceObj.rounded;
    const amountPaise = amountRupees * 100;

    const options = {
      amount: amountPaise,
      currency: 'INR',
      receipt: 'kappucake_' + Date.now(),
      notes: {
        customer_name: payload.customer.name,
        customer_phone: payload.customer.phone,
        delivery_date: payload.deliveryDate,
        flavour1: payload.flavour1,
        flavour2: payload.flavour2 || ''
      }
    };

    const order = await razorpay.orders.create(options);
    return res.json({ success: true, order, amountRupees });

  } catch (err) {
    console.error('Error in /create-order:', err);
    res.status(500).json({ success: false, error: 'Server error creating order' });
  }
});

// Verify payment and send email + sheets
app.post('/verify-and-email', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderData } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderData) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const payload = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(payload)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    const priceObj = calculateFinalPrice(
      orderData.flavour1PricePerKg,
      orderData.flavour2PricePerKg || 0,
      orderData.mix,
      Number(orderData.weight)
    );
    const amountRupees = priceObj ? priceObj.rounded : 'NA';

    await appendToSheet(orderData, razorpay_payment_id).catch(err => {
      console.error('Sheets error:', err);
    });

    await sendOrderEmail(orderData, amountRupees, razorpay_payment_id).catch(err => {
      console.error('Email error:', err);
    });

    return res.json({ success: true });

  } catch (err) {
    console.error('Error in /verify-and-email:', err);
    res.status(500).json({ success: false, error: 'Server error verifying payment' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KappuCake backend listening on port ${PORT}`);
});
