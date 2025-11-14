import express from "express";
import cors from "cors";
import Razorpay from "razorpay";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

/********************************
 * 🟢 HEALTH CHECK
 ********************************/
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend running" });
});

/********************************
 * 🔑 RAZORPAY CONFIG
 ********************************/
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/********************************
 * 📧 ZOHO MAIL CONFIG
 ********************************/
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_PASS,
  },
});

/********************************
 * 📄 GOOGLE SHEET CONFIG
 ********************************/

let sheets = null;

// Load service account from Render Environment Variable
try {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheets = google.sheets({ version: "v4", auth });

  console.log("✅ Google Sheets initialized");
} catch (err) {
  console.error("❌ Could NOT load GOOGLE_SERVICE_ACCOUNT:", err.message);
}

/********************************
 * 🧮 CREATE ORDER
 ********************************/
app.post("/create-order", async (req, res) => {
  try {
    const { weight, flavour1PricePerKg } = req.body;

    if (!weight || !flavour1PricePerKg) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    const amount = Math.round(weight * flavour1PricePerKg * 100); // paise

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: "order_" + Date.now(),
    });

    return res.json({ success: true, order });
  } catch (err) {
    console.error("❌ Create Order Error:", err);
    return res.json({ success: false, error: err.message });
  }
});

/********************************
 * 💳 VERIFY PAYMENT + SEND EMAIL + SHEET LOG
 ********************************/
app.post("/verify-and-email", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderData,
    } = req.body;

    /******** VERIFY SIGNATURE ********/
    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const digest = hmac.digest("hex");

    if (digest !== razorpay_signature) {
      return res.json({ success: false, error: "Invalid signature" });
    }

    /******** SEND CUSTOMER EMAIL ********/
    await transporter.sendMail({
      from: `"KappuCake" <${process.env.ZOHO_USER}>`,
      to: orderData.customer.email,
      subject: `🎂 Order Confirmed — ${orderData.customer.name}`,
      html: `
        <h2>Hi ${orderData.customer.name},</h2>
        <p>Your payment was successful!</p>
        <p><b>Order summary:</b></p>
        <ul>
          <li><b>Flavour:</b> ${orderData.flavour1}${
        orderData.flavour2 ? " + " + orderData.flavour2 : ""
      }</li>
          <li><b>Weight:</b> ${orderData.weight} kg</li>
          <li><b>Delivery:</b> ${orderData.deliveryDate}</li>
        </ul>
      `,
    });

    /******** SEND ADMIN EMAIL ********/
    await transporter.sendMail({
      from: `"KappuCake Orders" <${process.env.ZOHO_USER}>`,
      to: "orders@kappucake.com",
      subject: `🧾 New Paid Order — ${orderData.customer.name}`,
      html: `
        <h2>New Paid Order</h2>
        <ul>
          <li>Name: ${orderData.customer.name}</li>
          <li>Phone: ${orderData.customer.phone}</li>
          <li>Flavours: ${orderData.flavour1}${
        orderData.flavour2 ? " + " + orderData.flavour2 : ""
      }</li>
          <li>Weight: ${orderData.weight} kg</li>
          <li>Delivery Date: ${orderData.deliveryDate}</li>
        </ul>
      `,
    });

    /******** WRITE TO GOOGLE SHEET ********/
    if (sheets) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: "Orders!A:K",
        valueInputOption: "RAW",
        requestBody: {
          values: [
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
              orderData.preferredTime || "-",
              orderData.message || "-",
              razorpay_payment_id,
            ],
          ],
        },
      });

      console.log("✅ Logged to Google Sheet");
    } else {
      console.log("⚠️ Google Sheets not configured. Skipped logging.");
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Verify/Error:", err);
    return res.json({ success: false, error: err.message });
  }
});

/********************************
 * 🚀 START SERVER
 ********************************/
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 KappuCake backend running on port ${PORT}`)
);
