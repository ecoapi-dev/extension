import Stripe from "stripe";
const stripe = new Stripe("sk_test", { apiVersion: "2024-04-10" });
async function charge() {
  return stripe.paymentIntents.create({ amount: 1000, currency: "usd" });
}
charge();
