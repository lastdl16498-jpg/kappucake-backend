import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import Razorpay from "razorpay";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------------- Razorpay Setup ----------------
const razor = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---------------- Zoho SMTP Setup ----------------
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.in",   // use smtp.zoho.com if outside India
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,   // e.g. orders@yourdomain.com
    pass: process.env.ZOHO_PASS    // Zoho App Password
  }
});

// ---------------- Booking Storage ----------------
let bookings = {}; // { "YYYY-MM-DD": [orders...] }
const MAX_ORDERS_PER_DAY = 20;

// ---------------- APIs ----------------

// 1️⃣ Create Razorpay Order
app.post("/api/create-order", async (req, res) => {
  const { amount } = req.body; // amount in paise
  try {
    const order = await razor.orders.create({
      amount,
      currency: "INR",
      payment_capture: 1
    });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2️⃣ Save Order + Send Email
app.post("/api/order", async (req, res) => {
  const order = req.body;
  const date = order.deliveryDate;

  if (!date) return res.status(400).json({ error: "Delivery date required" });

  // limit check
  if (bookings[date] && bookings[date].length >= MAX_ORDERS_PER_DAY) {
    return res.status(400).json({ error: "⚠️ We reached max orders for this date" });
  }

  if (!bookings[date]) bookings[date] = [];
  bookings[date].push(order);

  try {
    // send confirmation email
    await transporter.sendMail({
      from: `"KappuCake" <${process.env.ZOHO_USER}>`,
      to: `${order.email}, ${process.env.ZOHO_USER}`, // customer + bakery
      subject: "🎂 KappuCake Order Confirmation",
      text: `Hello ${order.name},

Thank you for your order! We’ll send you a quotation within 24 hours.

📅 Delivery Date: ${order.deliveryDate}
🍰 Cake: ${order.weight} kg ${order.flavour}
💬 Message: ${order.message || "-"}

We will confirm and share the quotation before preparation.
– Team KappuCake`
    });

    res.json({ success: true, message: "Order saved and email sent" });
  } catch (err) {
    res.status(500).json({ error: "Order saved but email failed", details: err.message });
  }
});

// 3️⃣ Get booking count for date
app.get("/api/bookings/:date", (req, res) => {
  const date = req.params.date;
  res.json({ count: bookings[date]?.length || 0 });
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
