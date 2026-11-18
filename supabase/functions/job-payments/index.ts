import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// Homeowner job payments + contractor payouts (Stripe Connect, separate charges and transfers).
// Homeowners pay when they hire. saunainstall holds the payment until it's released by:
//   the homeowner's rating (database trigger), auto-release 7 days after the job date (hourly schedule), or an admin.
// Browser actions authenticate with the user's Supabase session; scheduled/system actions use the shared notify secret.
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = Deno.env.get("SITE_URL") ?? "https://saunainstall.com";
const API_VERSION = "2025-02-24.acacia";

const cache: Record<string, string> = {};
async function secret(name: string) {
  if (cache[name]) return cache[name];
  const { data, error } = await admin.rpc("get_app_secret", { secret_name: name });
  if (error || !data) throw new Error("missing secret " + name);
  return (cache[name] = data as string);
}
let _stripe: Stripe | null = null;
async function stripe() {
  if (!_stripe) _stripe = new Stripe(await secret("stripe_secret_key"), { httpClient: Stripe.createFetchHttpClient(), apiVersion: API_VERSION as any });
  return _stripe;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function notify(payload: Record<string, unknown>) {
  try {
    await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/notify", {
      method: "POST", headers: { "Content-Type": "application/json", "x-notify-secret": await secret("notify_secret") }, body: JSON.stringify(payload),
    });
  } catch (e) { console.error("notify failed", e); }
}

// ---------- contractor payout account (Express) ----------
async function contractorFor(userId: string) {
  const { data: c } = await admin.from("contractors").select("*").eq("id", userId).single();
  if (!c) throw new HttpError(403, "Contractor account required");
  return c;
}

async function ensureConnectAccount(c: any, email: string) {
  if (c.stripe_connect_id) return c.stripe_connect_id as string;
  const s = await stripe();
  const acct = await s.accounts.create({
    country: "US",
    email,
    business_profile: { name: c.business_name || undefined, url: c.website || undefined, mcc: "1520", product_description: "Sauna installation services booked through saunainstall.com" },
    controller: {
      stripe_dashboard: { type: "express" },
      fees: { payer: "application" },          // Sauna Install pays Connect account/payout fees
      losses: { payments: "application" },     // Sauna Install is liable for negative balances (allows transfer reversals)
      requirement_collection: "stripe",
    },
    capabilities: { transfers: { requested: true } },
    metadata: { supabase_user_id: c.id },
  });
  await admin.from("contractors").update({ stripe_connect_id: acct.id }).eq("id", c.id);
  return acct.id;
}

async function refreshConnect(c: any) {
  if (!c.stripe_connect_id) return { payouts_enabled: false, details_submitted: false };
  const a = await (await stripe()).accounts.retrieve(c.stripe_connect_id);
  const ready = a.capabilities?.transfers === "active" && !!a.payouts_enabled;
  const st = { payouts_enabled: ready, payout_details_submitted: !!a.details_submitted };
  await admin.from("contractors").update(st).eq("id", c.id);
  return { payouts_enabled: ready, details_submitted: !!a.details_submitted, due: a.requirements?.currently_due?.length || 0 };
}

// ---------- homeowner payment (at hire) ----------
async function startPayment(userId: string, projectId: string, method: string) {
  if (!["us_bank_account", "card"].includes(method)) throw new HttpError(400, "Choose bank account or card");
  const { data: p } = await admin.from("projects").select("*").eq("id", projectId).single();
  if (!p || p.owner_id !== userId) throw new HttpError(404, "Project not found");
  if (!p.awarded_bid_id || p.status !== "awarded") throw new HttpError(409, "Hire an installer before paying");
  const { data: bid } = await admin.from("bids").select("*").eq("id", p.awarded_bid_id).single();
  const { data: contractor } = await admin.from("contractors").select("business_name").eq("id", bid.contractor_id).single();
  const { data: owner } = await admin.from("profiles").select("email, first_name, last_name").eq("id", userId).single();

  let { data: pay } = await admin.from("payments").select("*").eq("project_id", projectId).maybeSingle();
  if (pay && ["processing", "succeeded", "refunded", "disputed"].includes(pay.status)) throw new HttpError(409, "This project has already been paid");
  const amount = Math.round(Number(bid.amount) * 100);
  if (!pay) {
    const ins = await admin.from("payments").insert({ project_id: projectId, bid_id: bid.id, owner_id: userId, contractor_id: bid.contractor_id, amount_cents: amount }).select().single();
    if (ins.error) throw ins.error;
    pay = ins.data;
  }
  const s = await stripe();
  if (pay.checkout_session_id) { try { await s.checkout.sessions.expire(pay.checkout_session_id); } catch (_) { /* already finished/expired */ } }

  const name = (p.model && p.model !== "Other / not listed" ? p.model : (p.sauna_type || "Sauna")) + " installation";
  const session = await s.checkout.sessions.create({
    mode: "payment",
    payment_method_types: [method as any],
    customer_email: owner?.email || undefined,
    client_reference_id: userId,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount,
      product_data: { name, description: `Installed by ${contractor?.business_name || "your installer"} · ${[p.city, p.zip].filter(Boolean).join(", ")} · held by saunainstall until the job is done` } } }],
    payment_intent_data: {
      transfer_group: `project_${projectId}`,
      description: `saunainstall job payment · project ${projectId}`,
      metadata: { payment_id: pay.id, project_id: projectId, bid_id: bid.id },
    },
    ...(method === "us_bank_account" ? { payment_method_options: { us_bank_account: { verification_method: "automatic" } } } : {}),
    metadata: { payment_id: pay.id, project_id: projectId, kind: "job_payment" },
    success_url: `${SITE}/list-project?login=1&paid=1`,
    cancel_url: `${SITE}/list-project?login=1`,
  });
  await admin.from("payments").update({ checkout_session_id: session.id, method, status: "pending" }).eq("id", pay.id);
  return session.url;
}

// ---------- payout release: transfer job price minus the exact Stripe fee ----------
// Only payments whose release was requested (rating, auto-release or admin) and that aren't on hold.
async function release(payId: string) {
  const { data: pay } = await admin.from("payments").select("*").eq("id", payId).single();
  if (!pay || pay.status !== "succeeded" || pay.transfer_id || !pay.charge_id) return { skipped: true };
  if (!pay.release_requested_at) return { skipped: "held until released" };
  if (pay.on_hold) return { skipped: "on hold" };
  const { data: c } = await admin.from("contractors").select("*").eq("id", pay.contractor_id).single();
  if (!c?.stripe_connect_id) return { waiting: "contractor payout setup" };
  if (!c.payouts_enabled) { const r = await refreshConnect(c); if (!r.payouts_enabled) return { waiting: "contractor payout setup" }; }
  const s = await stripe();
  let fee = pay.stripe_fee_cents;
  if (fee == null) {
    const ch = await s.charges.retrieve(pay.charge_id, { expand: ["balance_transaction"] });
    const bt = ch.balance_transaction as Stripe.BalanceTransaction | null;
    if (!bt) return { waiting: "fee not final yet" };
    fee = bt.fee;
  }
  const transferCents = pay.amount_cents - fee;
  const t = await s.transfers.create({
    amount: transferCents, currency: "usd", destination: c.stripe_connect_id,
    source_transaction: pay.charge_id,
    transfer_group: `project_${pay.project_id}`,
    description: "saunainstall job payout",
    metadata: { payment_id: pay.id, project_id: pay.project_id, stripe_fee_cents: String(fee), release_reason: pay.release_reason || "" },
  }, { idempotencyKey: `transfer-${pay.id}` });
  await admin.from("payments").update({ stripe_fee_cents: fee, transfer_cents: transferCents, transfer_id: t.id, transferred_at: new Date().toISOString() }).eq("id", pay.id);
  await notify({ type: "payout_sent", payment_id: pay.id });
  return { transfer: t.id, amount: transferCents };
}

async function releaseAll() {
  const { data } = await admin.from("payments").select("id").eq("status", "succeeded").is("transfer_id", null)
    .not("release_requested_at", "is", null).eq("on_hold", false).limit(50);
  const out = [];
  for (const p of data || []) { try { out.push(await release(p.id)); } catch (e) { console.error("release failed", p.id, e); out.push({ error: String(e) }); } }
  return out;
}

// ---------- admin (emails listed in private.admin_emails) ----------
async function adminList() {
  const { data: pays, error } = await admin.from("payments").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  const projIds = [...new Set((pays || []).map((p) => p.project_id))];
  const userIds = [...new Set((pays || []).flatMap((p) => [p.owner_id, p.contractor_id]))];
  const [{ data: projects }, { data: profiles }, { data: contractors }] = await Promise.all([
    admin.from("projects").select("id, city, zip, sauna_type, model, install_date, status").in("id", projIds.length ? projIds : ["00000000-0000-0000-0000-000000000000"]),
    admin.from("profiles").select("id, email, first_name, last_name").in("id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]),
    admin.from("contractors").select("id, business_name, payouts_enabled").in("id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const by = (rows: any[] | null) => Object.fromEntries((rows || []).map((r) => [r.id, r]));
  const P = by(projects), U = by(profiles), C = by(contractors);
  const rows = (pays || []).map((p) => ({
    ...p,
    project: P[p.project_id] || null,
    owner: U[p.owner_id] || null,
    contractor: { ...(U[p.contractor_id] || {}), ...(C[p.contractor_id] || {}) },
  }));
  const s = await stripe();
  const bal = await s.balance.retrieve();
  const usd = (arr: any[]) => (arr || []).filter((x) => x.currency === "usd").reduce((a, x) => a + x.amount, 0);
  const held = rows.filter((r) => ["succeeded", "processing"].includes(r.status) && !r.transfer_id)
    .reduce((a, r) => a + r.amount_cents - (r.stripe_fee_cents || 0), 0);
  const acct = await s.accounts.retrieve();
  return { rows, balance: { available: usd(bal.available), pending: usd(bal.pending), held, payout_interval: acct.settings?.payouts?.schedule?.interval || null } };
}

async function adminPayment(id: string) {
  const { data: pay } = await admin.from("payments").select("*").eq("id", id).single();
  if (!pay) throw new HttpError(404, "Payment not found");
  return pay;
}

async function adminRelease(id: string) {
  const pay = await adminPayment(id);
  if (pay.status !== "succeeded" || pay.transfer_id) throw new HttpError(409, "Only held, cleared payments can be released");
  await admin.from("payments").update({ on_hold: false, release_requested_at: new Date().toISOString(), release_reason: "admin" }).eq("id", id);
  await admin.from("projects").update({ status: "completed" }).eq("id", pay.project_id).eq("status", "awarded");
  return release(id);
}

async function adminHold(id: string, hold: boolean, note?: string) {
  const pay = await adminPayment(id);
  if (pay.transfer_id) throw new HttpError(409, "Payout already sent");
  await admin.from("payments").update({ on_hold: hold, hold_note: hold ? (note || null) : null }).eq("id", id);
  return { ok: true };
}

// Cancel the job and refund the homeowner the full price minus Stripe's (non-refundable) processing fee
async function adminRefund(id: string) {
  const pay = await adminPayment(id);
  if (pay.transfer_id) throw new HttpError(409, "Payout already sent to the installer. Refund in the Stripe Dashboard and reverse the transfer.");
  if (pay.status !== "succeeded") throw new HttpError(409, pay.status === "processing" ? "Bank payment still clearing. Put it on hold and refund once it clears." : "Nothing to refund");
  const s = await stripe();
  let fee = pay.stripe_fee_cents;
  if (fee == null) {
    const ch = await s.charges.retrieve(pay.charge_id, { expand: ["balance_transaction"] });
    fee = (ch.balance_transaction as Stripe.BalanceTransaction | null)?.fee ?? 0;
  }
  const refund = pay.amount_cents - fee;
  const r = await s.refunds.create({ payment_intent: pay.payment_intent_id, amount: refund, reason: "requested_by_customer",
    metadata: { payment_id: pay.id, project_id: pay.project_id, kept_stripe_fee_cents: String(fee) } }, { idempotencyKey: `refund-${pay.id}` });
  await admin.from("payments").update({ status: "refunded", refund_cents: refund, stripe_fee_cents: fee, on_hold: false }).eq("id", id);
  await admin.from("projects").update({ status: "cancelled" }).eq("id", pay.project_id);
  await notify({ type: "refund_issued", payment_id: pay.id });
  return { refund: r.id, amount: refund };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    // system actions (database schedule / triggers / webhook)
    if (req.headers.get("x-notify-secret")) {
      if (req.headers.get("x-notify-secret") !== await secret("notify_secret")) return json({ error: "Forbidden" }, 403);
      if (body.action === "release_all") return json({ ok: true, out: await releaseAll() });
      if (body.action === "release") return json({ ok: true, out: await release(body.payment_id) });
      return json({ error: "Unknown action" }, 400);
    }
    // browser actions
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Please log in again." }, 401);

    if (String(body.action || "").startsWith("admin_")) {
      const { data: ok } = await admin.rpc("is_admin_email", { p_email: user.email });
      if (!ok) return json({ error: "Admin access only" }, 403);
      switch (body.action) {
        case "admin_list": return json(await adminList());
        case "admin_release": return json({ ok: true, out: await adminRelease(body.payment_id) });
        case "admin_hold": return json(await adminHold(body.payment_id, true, body.note));
        case "admin_unhold": return json(await adminHold(body.payment_id, false));
        case "admin_refund": return json({ ok: true, out: await adminRefund(body.payment_id) });
      }
      return json({ error: "Unknown action" }, 400);
    }

    if (body.action === "pay") return json({ url: await startPayment(user.id, body.project_id, body.method) });

    const c = await contractorFor(user.id);
    if (body.action === "connect_link") {
      const id = await ensureConnectAccount(c, user.email!);
      const link = await (await stripe()).accountLinks.create({ account: id, type: "account_onboarding",
        refresh_url: `${SITE}/contractors?login=1&payouts=retry`, return_url: `${SITE}/contractors?login=1&payouts=done` });
      return json({ url: link.url });
    }
    if (body.action === "connect_status") {
      const st = await refreshConnect(c);
      if (st.payouts_enabled) await releaseAll();
      return json(st);
    }
    if (body.action === "connect_dashboard") {
      if (!c.stripe_connect_id) throw new HttpError(404, "Set up payouts first");
      const l = await (await stripe()).accounts.createLoginLink(c.stripe_connect_id);
      return json({ url: l.url });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e: any) {
    console.error(e);
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: "Payment service error. Please try again." }, 500);
  }
});
