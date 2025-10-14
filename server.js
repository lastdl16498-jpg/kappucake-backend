// server.js
const express = require('express');
const bodyParser = require('body-parser');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// ---------- Config via env vars (set these on Render or locally for testing) ----------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;         // rzp_test_...
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET; // secret (keep private)
const ZOHO_SMTP_USER = process.env.ZOHO_SMTP_USER;           // e.g. orders@yourdomain.com
const ZOHO_SMTP_PASS = process.env.ZOHO_SMTP_PASS;           // app password (8 chars)
const FROM_EMAIL = process.env.FROM_EMAIL || ZOHO_SMTP_USER; // sender in emails

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('Razorpay keys not set. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars.');
}
if (!ZOHO_SMTP_USER || !ZOHO_SMTP_PASS) {
  console.warn('Zoho SMTP not set. Set ZOHO_SMTP_USER and ZOHO_SMTP_PASS env vars.');
}

// init Razorpay instance
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// nodemailer transporter (Zoho SMTP)
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.in', // zoho smtp host (India region); change if needed
  port: 465,
  secure: true,
  auth: {
    user: ZOHO_SMTP_USER,
    pass: ZOHO_SMTP_PASS
  }
});

// ---------------- Helper: compute order amount server-side ----------------
// This must use the same pricing logic as front-end but MUST be implemented on server to avoid tampering.
// For demo we expect client to send order details and we recalc the amount.
// Returns amount in paisa (integer)
function calculateAmountPaisa(payload) {
  // payload: { weight, flavour1PricePerKg, flavour2PricePerKg (optional), mix (bool) }
  // NOTE: prices are rupees per kg. Example: 999 means ₹999/kg
  const MIX_PREMIUM = 0.10;
  const PROFIT_MARGIN = 0.09;
  const EC_ENDINGS = [29,49,79,99];

  const base1 = Number(payload.flavour1PricePerKg || 0);
  const base2 = Number(payload.flavour2PricePerKg || 0);
  const weight = Number(payload.weight || 0);
  const mix = !!payload.mix;

  if (!base1 || !weight) return null;

  let base = base1;
  if (mix && base2) base = ((base1 + base2) / 2) * (1 + MIX_PREMIUM);

  const raw = base * weight;
  const withProfit = raw * (1 + PROFIT_MARGIN);

  // discount logic (example)
  let disc = 0;
  if (weight >= 7) disc = 0.05;
  else if (weight >= 5 && weight < 7) disc = 0.07;
  else if (weight > 3 && weight <= 4.5) disc = 0.08;
  else if (weight >= 2.5 && weight <= 3) disc = 0.09;

  const after = withProfit * (1 - disc);
  const rounded = roundToEcom(Math.round(after), EC_ENDINGS);

  // convert rupees to paisa
  return Math.round(rounded * 100);
}

function roundToEcom(value, endings) {
  // value is rupees integer
  const hundred = Math.floor(value / 100) * 100;
  for (let e of endings) {
    const cand = hundred + e;
    if (cand >= value) return cand;
  }
  return hundred + endings[0];
}

// ---------------- Endpoint: create-order ----------------
app.post('/create-order', async (req, res) => {
  try {
    const payload = req.body;
    // expected payload: { weight, flavour1PricePerKg, flavour2PricePerKg (optional), mix (bool), customer: {name,phone,email,address}, message }
    const amount = calculateAmountPaisa(payload);
    if (!amount) return res.status(400).json({ success: false, error: 'Invalid price data' });

    // Create Razorpay order (amount in paisa)
    const options = {
      amount: amount,
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      payment_capture: 1
    };
    const order = await razorpay.orders.create(options);

    return res.json({ success: true, order: { id: order.id, amount: order.amount, currency: order.currency } });
  } catch (err) {
    console.error('create-order error', err);
    return res.status(500).json({ success: false, error: 'Server error creating order' });
  }
});

// ---------------- Endpoint: verify-and-email ----------------
app.post('/verify-and-email', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderData } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing verification fields' });
    }

    // Verify signature
    const generated_signature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (generated_signature !== razorpay_signature) {
      console.warn('Signature mismatch', generated_signature, razorpay_signature);
      return res.status(400).json({ success: false, error: 'Signature verification failed' });
    }

    // If verified, send confirmation email via Zoho SMTP
    const mailOptions = {
      from: FROM_EMAIL,
      to: orderData.customer.email,
      subject: `KappuCake — Order received (${razorpay_payment_id})`,
      text: `Hi ${orderData.customer.name},

Thank you — we have received your payment and order.

Order details:
- Name: ${orderData.customer.name}
- Phone: ${orderData.customer.phone}
- Delivery date: ${orderData.deliveryDate}
- Address: ${orderData.customer.address}
- Flavour: ${orderData.flavour1}${orderData.flavour2 ? ' + ' + orderData.flavour2 : ''}
- Weight: ${orderData.weight} kg
- Message: ${orderData.message || '—'}

We will contact you within 24 hours with final confirmation.

Regards,
KappuCake
`,
      html: `<p>Hi <strong>${orderData.customer.name}</strong>,</p>
<p>Thank you — we have received your payment and order (Payment ID: <strong>${razorpay_payment_id}</strong>).</p>
<h4>Order details</h4>
<ul>
<li><strong>Name:</strong> ${orderData.customer.name}</li>
<li><strong>Phone:</strong> ${orderData.customer.phone}</li>
<li><strong>Delivery date:</strong> ${orderData.deliveryDate}</li>
<li><strong>Address:</strong> ${orderData.customer.address}</li>
<li><strong>Flavour:</strong> ${orderData.flavour1}${orderData.flavour2 ? ' + ' + orderData.flavour2 : ''}</li>
<li><strong>Weight:</strong> ${orderData.weight} kg</li>
<li><strong>Message:</strong> ${orderData.message || '—'}</li>
</ul>
<p>We will contact you within 24 hours with final confirmation.</p>
<p>Regards,<br/>KappuCake</p>`
    };

    // send mail
    await transporter.sendMail(mailOptions);

    // optionally: save order to DB or Google Sheet here (not implemented)
    return res.json({ success: true });
  } catch (err) {
    console.error('verify-and-email error', err);
    return res.status(500).json({ success: false, error: 'Server error verifying payment or sending email' });
  }
});

// health
app.get('/', (req, res) => res.send('KappuCake backend running'));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server started on port', PORT));
