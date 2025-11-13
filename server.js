import express from "express";
import cors from "cors";
import Razorpay from "razorpay";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

/*************************
 * 🔑 1️⃣ RAZORPAY CONFIG
 *************************/
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/*************************
 * 📧 2️⃣ ZOHO SMTP CONFIG
 *************************/
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER, // "orders@kappucake.com"
    pass: process.env.ZOHO_PASS, // app password
  },
});

/*************************
 * 🧾 3️⃣ GOOGLE SHEETS CONFIG
 *************************/
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
let auth;
try {
  const credentials = JSON.parse(
    fs.readFileSync("serviceAccount.json", "utf8")
  );
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
} catch (err) {
  console.error("⚠️ Could not load serviceAccount.json:", err.message);
}
const sheets = google.sheets({ version: "v4", auth });

/*************************
 * 🧮 4️⃣ CREATE ORDER
 *************************/
app.post("/create-order", async (req, res) => {
  try {
    const { weight, flavour1PricePerKg } = req.body;
    if (!weight || !flavour1PricePerKg)
      return res.json({ success: false, error: "Missing data" });

    const price = Math.round(weight * flavour1PricePerKg * 100); // paise
    const order = await razorpay.orders.create({
      amount: price,
      currency: "INR",
      receipt: "order_" + Date.now(),
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error("❌ Error creating order:", err);
    res.json({ success: false, error: err.message });
  }
});

/*************************
 * 🧾 5️⃣ VERIFY PAYMENT + SEND EMAIL + LOG SHEET
 *************************/
app.post("/verify-and-email", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderData,
    } = req.body;

    // Verify signature
    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const digest = hmac.digest("hex");
    if (digest !== razorpay_signature) {
      return res.json({ success: false, error: "Invalid signature" });
    }

    /*************************
     * ✅ SEND EMAILS
     *************************/
    const customerEmail = {
      from: `"KappuCake" <${process.env.ZOHO_USER}>`,
      to: orderData.customer.email,
      subject: `🎂 Order Confirmed — ${orderData.customer.name}`,
      html: `
        <h2>Hi ${orderData.customer.name},</h2>
        <p>Thank you for your order with <b>KappuCake</b>! We’ve received your payment successfully.</p>
        <p><b>Order Summary:</b></p>
        <ul>
          <li>Flavour: ${orderData.flavour1}${
        orderData.flavour2 ? " + " + orderData.flavour2 : ""
      }</li>
          <li>Weight: ${orderData.weight} kg</li>
          <li>Delivery: ${orderData.deliveryDate} (${orderData.timeSlot})</li>
          <li>Message: ${orderData.message || "—"}</li>
        </ul>
        <p>We’ll contact you soon with delivery updates.</p>
        <p>— KappuCake Team 🍰</p>
      `,
    };

    const adminEmail = {
      from: `"KappuCake Orders" <${process.env.ZOHO_USER}>`,
      to: "orders@kappucake.com",
      subject: `🧾 New Order from ${orderData.customer.name}`,
      html: `
        <h3>New Paid Order</h3>
        <ul>
          <li><b>Name:</b> ${orderData.customer.name}</li>
          <li><b>Phone:</b> ${orderData.customer.phone}</li>
          <li><b>Email:</b> ${orderData.customer.email}</li>
          <li><b>Flavours:</b> ${orderData.flavour1}${
        orderData.flavour2 ? " + " + orderData.flavour2 : ""
      }</li>
          <li><b>Weight:</b> ${orderData.weight} kg</li>
          <li><b>Date:</b> ${orderData.deliveryDate}</li>
          <li><b>Time Slot:</b> ${orderData.timeSlot}</li>
          <li><b>Preferred:</b> ${orderData.preferredTime || "—"}</li>
          <li><b>Message:</b> ${orderData.message || "—"}</li>
        </ul>
      `,
    };

    await transporter.sendMail(customerEmail);
    await transporter.sendMail(adminEmail);

    /*************************
     * ✅ LOG TO GOOGLE SHEET
     *************************/
    const SHEET_ID = process.env.SHEET_ID;
    const values = [
      [
        new Date().toLocaleString("en-IN"),
        orderData.customer.name,
        orderData.customer.phone,
        orderData.customer.email,
        orderData.flavour1 +
          (orderData.flavour2 ? " + " + orderData.flavour2 : ""),
        orderData.weight,
        orderData.deliveryDate,
        orderData.timeSlot,
        orderData.preferredTime,
        orderData.message,
        razorpay_payment_id,
      ],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Orders!A:K",
      valueInputOption: "RAW",
      requestBody: { values },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Verification or Email error:", err);
    res.json({ success: false, error: err.message });
  }
});

/*************************
 * 🚀 6️⃣ SERVER START
 *************************/
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 KappuCake backend running on port " + PORT));
