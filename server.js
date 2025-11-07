import express from "express";
import Razorpay from "razorpay";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Your Razorpay Test Keys
const razorpay = new Razorpay({
  key_id: "rzp_test_RMDaOFfd7seUeX",
  key_secret: "x1ttb9YC1oIivyYRS8qeS32L"
});

// ✅ 1) Create Order
app.post("/create-order", async (req, res) => {
  try {
    const price = req.body?.weight ? req.body.weight * 1000 * 100 : 50000; // fallback 500₹ test

    const order = await razorpay.orders.create({
      amount: Number(price), // should be in paise
      currency: "INR",
      receipt: "order_" + Date.now()
    });

    return res.json({ success: true, order });
  } catch (error) {
    console.error("Order Error:", error);
    return res.json({ success: false, error: "Failed to create Razorpay order" });
  }
});

// ✅ 2) Verify Razorpay Payment (No Email Yet)
app.post("/verify-and-email", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", "x1ttb9YC1oIivyYRS8qeS32L")
      .update(sign)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      console.log("🎉 Payment Verified Successfully");

      // ✅ For now: just confirm without email
      return res.json({ success: true });
    } else {
      return res.json({ success: false, error: "Invalid Signature" });
    }
  } catch (error) {
    console.error("Verify Error:", error);
    return res.json({ success: false, error: "Verification Failed" });
  }
});

// ✅ Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`KappuCake backend running on port ${PORT}`));
