// api/verify-and-create-account.js
//
// Deploy this as a serverless function (Vercel: drop it in an /api folder and
// it just works. Netlify: adapt the export to `exports.handler`. Node/Express:
// wrap it in a POST route.) The landing page's form calls this endpoint —
// it never talks to Paystack or Supabase directly for account creation.
//
// Why this file has to exist at all:
// Paystack's inline popup only tells the BROWSER "the popup finished."
// A browser can be tampered with, so that message is not proof anything was
// paid. The only trustworthy check is server-to-server: ask Paystack directly,
// using a secret key that never ships to the browser. This function is that
// check. No verified payment → it returns { verified: false } → the front-end
// shows an error and creates nothing. There is no path to an account that
// skips this.
//
// Environment variables this needs (set these in your hosting provider,
// never in the HTML/JS that ships to the browser):
//   PAYSTACK_SECRET_KEY   — starts with sk_, from your Paystack dashboard
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — the *service role* key (not the anon key),
//                                from Supabase project settings > API.
//                                This key can create users, so it must only
//                                ever live on the server.
//
// npm install @supabase/supabase-js

const { createClient } = require("@supabase/supabase-js");

const EXPECTED_AMOUNT_KOBO = 1000000; // ₦10,000 — must match what the front-end charges
const EXPECTED_CURRENCY = "NGN";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ verified: false, message: "Method not allowed" });
  }

  const { reference, account } = req.body || {};
  if (!reference || !account || !account.email) {
    return res.status(400).json({ verified: false, message: "Missing reference or account details" });
  }

  try {
    // 1. Ask Paystack directly — this is the only step that actually matters.
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    const tx = verifyData && verifyData.data;
    const paymentIsGenuine =
      verifyRes.ok &&
      tx &&
      tx.status === "success" &&
      tx.amount === EXPECTED_AMOUNT_KOBO &&
      tx.currency === EXPECTED_CURRENCY &&
      tx.customer &&
      tx.customer.email &&
      tx.customer.email.toLowerCase() === account.email.toLowerCase();

    if (!paymentIsGenuine) {
      return res.status(402).json({ verified: false, message: "Payment could not be verified" });
    }

    // 2. Only now, with a confirmed payment in hand, create the login the app will accept.
    //    (If this reference was already used — e.g. the request retried — Supabase
    //    will simply report the user already exists, which is fine to treat as success.)
    if (account.password) {
      const { error } = await supabaseAdmin.auth.admin.createUser({
        email: account.email,
        password: account.password,
        email_confirm: true,
        user_metadata: {
          full_name: account.name || "",
          business_name: account.business || ""
        }
      });
      if (error && !String(error.message || "").toLowerCase().includes("already registered")) {
        return res.status(500).json({ verified: false, message: "Payment succeeded but account creation failed: " + error.message });
      }
    }

    return res.status(200).json({ verified: true });
  } catch (err) {
    return res.status(500).json({ verified: false, message: "Server error verifying payment" });
  }
};
