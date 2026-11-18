import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// Called by Stripe, authenticated by the webhook signature (not a Supabase JWT).
// Handles contractor memberships (subscriptions) and homeowner job payments.
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cryptoProvider = Stripe.createSubtleCryptoProvider();

async function secret(envName: string, vaultName: string): Promise<string> {
  const v = Deno.env.get(envName);
  if (v) return v;
  const { data, error } = await admin.rpc("get_app_secret", { secret_name: vaultName });
  if (error || !data) throw new Error(`Missing secret ${vaultName}`);
  return data as string;
}
let _stripe: Stripe | null = null;
async function getStripe() {
  if (!_stripe) _stripe = new Stripe(await secret("STRIPE_SECRET_KEY", "stripe_secret_key"), { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2025-02-24.acacia" as any });
  return _stripe;
}
async function callFn(name: string, payload: Record<string, unknown>) {
  try {
    await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/" + name, {
      method: "POST", headers: { "Content-Type": "application/json", "x-notify-secret": await secret("NOTIFY_SECRET", "notify_secret") }, body: JSON.stringify(payload),
    });
  } catch (e) { console.error("call failed", name, e); }
}

// ---------- memberships ----------
async function syncSubscription(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const end = (sub as any).current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  const fields = {
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
  };
  const userId = sub.metadata?.supabase_user_id;
  const q = admin.from("contractors").update(fields);
  const { error } = userId ? await q.eq("id", userId) : await q.eq("stripe_customer_id", customerId);
  if (error) throw error;
}

// ---------- job payments (held by saunainstall until released) ----------
// Auto-release date: 7 days after the later of the homeowner's install date and the installer's start date
// (never sooner than tomorrow). No date on file: released only by the homeowner's rating or an admin.
async function autoReleaseOn(pay: any) {
  const [{ data: p }, { data: b }] = await Promise.all([
    admin.from("projects").select("install_date").eq("id", pay.project_id).single(),
    admin.from("bids").select("start_date").eq("id", pay.bid_id).single(),
  ]);
  const dates = [p?.install_date, b?.start_date].filter(Boolean).sort();
  if (!dates.length) return null;
  const d = new Date(dates[dates.length - 1] + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7);
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return (d > tomorrow ? d : tomorrow).toISOString().slice(0, 10);
}

async function paymentSucceeded(paymentId: string, piId: string, method?: string) {
  const { data: pay } = await admin.from("payments").select("*").eq("id", paymentId).single();
  if (!pay || pay.status === "succeeded") return;
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] });
  const ch = pi.latest_charge as Stripe.Charge;
  const bt = ch?.balance_transaction as Stripe.BalanceTransaction | null;
  await admin.from("payments").update({
    status: "succeeded", payment_intent_id: pi.id, charge_id: ch?.id, method: method || pay.method,
    stripe_fee_cents: bt ? bt.fee : null, paid_at: new Date().toISOString(), auto_release_on: await autoReleaseOn(pay),
  }).eq("id", paymentId);
  await callFn("notify", { type: "payment_received", payment_id: paymentId });
  if (pay.release_requested_at) await callFn("job-payments", { action: "release", payment_id: paymentId });
}

async function onCheckoutCompleted(s: Stripe.Checkout.Session, eventType: string) {
  if (s.mode === "subscription" && s.subscription) {
    const sub = await (await getStripe()).subscriptions.retrieve(s.subscription as string);
    return syncSubscription(sub);
  }
  if (s.mode !== "payment" || s.metadata?.kind !== "job_payment") return;
  const paymentId = s.metadata.payment_id;
  const piId = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
  const method = s.payment_method_types?.[0];
  if (eventType === "checkout.session.async_payment_failed") {
    await admin.from("payments").update({ status: "failed", payment_intent_id: piId }).eq("id", paymentId);
    await callFn("notify", { type: "payment_failed", payment_id: paymentId });
    return;
  }
  if (s.payment_status === "paid") return paymentSucceeded(paymentId, piId!, method);
  // bank payments take a few business days to clear
  await admin.from("payments").update({ status: "processing", payment_intent_id: piId, method }).eq("id", paymentId);
  await callFn("notify", { type: "payment_processing", payment_id: paymentId });
}

async function paymentForCharge(chargeId: string) {
  const { data } = await admin.from("payments").select("*").eq("charge_id", chargeId).maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  const sig = req.headers.get("Stripe-Signature");
  if (!sig) return new Response("Missing signature", { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    const whsec = await secret("STRIPE_WEBHOOK_SECRET", "stripe_webhook_secret");
    event = await Stripe.webhooks.constructEventAsync(body, sig, whsec, undefined, cryptoProvider);
  } catch (e) {
    console.error("Bad signature", e);
    return new Response("Invalid signature", { status: 400 });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        await onCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event.type);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const d = event.data.object as Stripe.Dispute;
        const chargeId = typeof d.charge === "string" ? d.charge : d.charge.id;
        const pay = await paymentForCharge(chargeId);
        if (pay) {
          // a new dispute freezes any payout that hasn't gone out yet
          const freeze = !pay.transfer_id && event.type === "charge.dispute.created" ? { on_hold: true, hold_note: "Card dispute: " + d.reason } : {};
          await admin.from("payments").update({ status: d.status === "won" ? "succeeded" : "disputed", dispute_status: d.status, ...freeze }).eq("id", pay.id);
          await callFn("notify", { type: "dispute_alert", payment_id: pay.id, dispute_status: d.status, reason: d.reason });
        }
        break;
      }
      case "charge.refunded": {
        const ch = event.data.object as Stripe.Charge;
        const pay = await paymentForCharge(ch.id);
        if (pay && ch.amount_refunded > 0 && pay.status !== "refunded") await admin.from("payments").update({ status: "refunded", refund_cents: ch.amount_refunded }).eq("id", pay.id);
        break;
      }
      default:
        break;
    }
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Handler error", e);
    return new Response("Handler error", { status: 500 });
  }
});
