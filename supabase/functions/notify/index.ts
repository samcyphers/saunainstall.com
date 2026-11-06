import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Sends marketplace emails via Resend. Called by database triggers / other functions (shared secret header), never by browsers.
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = "https://saunainstall.com";
const FROM = "saunainstall <notifications@saunainstall.com>";
const SUPPORT = "info@saunainstall.com";

const cache: Record<string, string> = {};
async function secret(name: string) {
  if (cache[name]) return cache[name];
  const { data, error } = await admin.rpc("get_app_secret", { secret_name: name });
  if (error || !data) throw new Error("missing secret " + name);
  return (cache[name] = data as string);
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const money = (n: number) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const cents = (c: number) => money(c / 100);
const day = (d?: string | null) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "To be scheduled";
const place = (p: any) => [p?.city, p?.zip].filter(Boolean).join(", ");
const projName = (p: any) => (p?.model && p.model !== "Other / not listed" ? p.model : (p?.sauna_type || "Sauna")) + " install";
// Stripe's standard US rates; the exact fee is taken from Stripe when the homeowner pays
const bankFee = (amt: number) => Math.min(Math.round(amt * 0.8) / 100, 5);
const cardFee = (amt: number) => Math.round(amt * 2.9 + 30) / 100;
const methodName = (m?: string | null) => m === "card" ? "card" : "bank account (ACH)";

function layout(title: string, intro: string, rows: [string, string][], cta: [string, string] | null, foot: string, after = "") {
  const table = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#8A8071;font-size:14px;width:44%;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-size:14px;font-weight:600;color:#272019">${v}</td></tr>`).join("");
  const button = cta ? `<a href="${cta[1]}" style="display:inline-block;margin-top:22px;background:#8A5424;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:10px">${esc(cta[0])}</a>` : "";
  return `<!doctype html><html><body style="margin:0;background:#FCF8F1;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#272019">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<div style="font-weight:800;font-size:18px;letter-spacing:-.01em;margin-bottom:18px">sauna<span style="color:#8A5424">install</span></div>
<div style="background:#FFFDF9;border:1px solid #E4D8C5;border-radius:16px;padding:26px">
<h1 style="font-size:22px;line-height:1.25;margin:0 0 10px">${esc(title)}</h1>
<p style="font-size:15px;line-height:1.55;color:#4A4136;margin:0 0 14px">${intro}</p>
<table style="width:100%;border-collapse:collapse;border-top:1px solid #E4D8C5;margin-top:6px">${table}</table>
${after}
${button}
</div>
<p style="font-size:12.5px;color:#8A8071;line-height:1.5;margin:18px 4px 0">${foot} Questions? Reply to this email or write to ${SUPPORT}.<br>Sauna Install LLC · <a href="${SITE}/privacy" style="color:#8A8071">Privacy</a> · <a href="${SITE}/terms" style="color:#8A8071">Terms</a></p>
</div></body></html>`;
}
const note = (html: string) => `<p style="font-size:13.5px;line-height:1.55;color:#4A4136;background:#F4ECE0;border-radius:10px;padding:12px 14px;margin:16px 0 0">${html}</p>`;

async function send(to: string, subject: string, html: string, idem: string, replyTo?: string) {
  if (!to) return { skipped: "no recipient" };
  if (/\.(invalid|test)$/i.test(to)) { console.log("DRY RUN", to, subject); return { dryRun: true }; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + await secret("resend_api_key"), "Content-Type": "application/json", "Idempotency-Key": idem },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, reply_to: replyTo || SUPPORT }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error("Resend error", res.status, JSON.stringify(out)); throw new Error("send failed " + res.status); }
  console.log("sent", subject, "->", to, out.id);
  return out;
}

async function load(bidId: string) {
  const { data: bid } = await admin.from("bids").select("*").eq("id", bidId).single();
  if (!bid) throw new Error("bid not found");
  const [{ data: project }, { data: contractor }, { data: cProfile }] = await Promise.all([
    admin.from("projects").select("*").eq("id", bid.project_id).single(),
    admin.from("contractors").select("*").eq("id", bid.contractor_id).single(),
    admin.from("profiles").select("*").eq("id", bid.contractor_id).single(),
  ]);
  const { data: owner } = await admin.from("profiles").select("*").eq("id", project.owner_id).single();
  return { bid, project, contractor, cProfile, owner };
}
async function loadPayment(paymentId: string) {
  const { data: pay } = await admin.from("payments").select("*").eq("id", paymentId).single();
  if (!pay) throw new Error("payment not found");
  return { pay, ...(await load(pay.bid_id)) };
}

async function bidCreated(bidId: string) {
  const { bid, project, contractor, owner } = await load(bidId);
  const company = contractor?.business_name || "An installer";
  return send(owner.email, `New proposal: ${company} bid ${money(bid.amount)} on your sauna install`,
    layout("You have a new proposal.", `Hi ${esc(owner.first_name || "there")}, <b>${esc(company)}</b> sent a fixed-price proposal for your ${esc(projName(project).toLowerCase())}.`,
      [["Installer", esc(company)], ["Price", money(bid.amount)], ["Proposed start", day(bid.start_date)], ["Notes", esc(bid.note || "—")]],
      ["Review proposals", `${SITE}/list-project?login=1`],
      "You're receiving this because you listed a sauna project on saunainstall."),
    `bid-created-${bid.id}`);
}

async function bidStatus(bidId: string, status: string) {
  const { bid, project, contractor, cProfile, owner } = await load(bidId);
  const name = cProfile?.first_name || contractor?.business_name || "there";
  const job = projName(project);
  if (status === "accepted") {
    const ownerName = [owner.first_name, owner.last_name].filter(Boolean).join(" ") || "The homeowner";
    const amt = Number(bid.amount);
    const payoutSetup = contractor?.payouts_enabled ? "" :
      note(`<b>Set up payouts now</b> so you can be paid as soon as the homeowner pays: open your dashboard and choose <b>Set up payouts</b> (about 5 minutes, bank account required).`);
    return send(cProfile.email, `You're hired: ${job} in ${project.city || project.zip}`,
      layout("You won the job.", `Hi ${esc(name)}, ${esc(ownerName)} accepted your ${money(amt)} proposal. Reach out to schedule the install.`,
        [["Project", esc(job)], ["Location", esc(place(project))], ["Install date", day(project.install_date)], ["Proposed start", day(bid.start_date)],
         ["Homeowner", esc(ownerName)], ["Email", `<a href="mailto:${esc(owner.email)}" style="color:#8A5424">${esc(owner.email)}</a>`], ["Phone", esc(owner.phone || "—")],
         ["Job price", money(amt)],
         ["Processing fee", `${money(bankFee(amt))} if paid by bank · ${money(cardFee(amt))} if paid by card`],
         ["Your payout", `${money(amt - bankFee(amt))} by bank · ${money(amt - cardFee(amt))} by card`]],
        ["Open my bids", `${SITE}/contractors?login=1`],
        "You can reply to this email to reach the homeowner directly.",
        note(`The homeowner pays through saunainstall within 24 hours of the job being completed, after rating your work. Stripe's processing fee is deducted from your payout; the exact amount depends on how the homeowner pays.`) + payoutSetup),
      `bid-accepted-${bid.id}`, owner.email);
  }
  let why = "The homeowner decided not to move forward with this proposal.";
  if (project.status === "cancelled") why = "The homeowner closed this project.";
  else if (project.awarded_bid_id && project.awarded_bid_id !== bid.id) why = "The homeowner chose another installer for this project.";
  return send(cProfile.email, `Update on your proposal: ${job}`,
    layout("Your proposal wasn't selected.", `Hi ${esc(name)}, ${why} Thanks for bidding. New projects are posted every week.`,
      [["Project", esc(job)], ["Location", esc(place(project))], ["Your price", money(bid.amount)]],
      ["Find more projects", `${SITE}/contractors`],
      "You're receiving this because you bid on a project on saunainstall."),
    `bid-declined-${bid.id}`);
}

async function paymentReminder(projectId: string) {
  const { data: project } = await admin.from("projects").select("*").eq("id", projectId).single();
  if (!project?.awarded_bid_id) return { skipped: "no hire" };
  const { bid, contractor, owner } = await load(project.awarded_bid_id);
  const { data: review } = await admin.from("reviews").select("id").eq("project_id", projectId).maybeSingle();
  const company = contractor?.business_name || "your installer";
  return send(owner.email, `Reminder: rate and pay for your sauna install`,
    layout("Time to wrap up your install.", `Hi ${esc(owner.first_name || "there")}, your installation with <b>${esc(company)}</b> was scheduled for ${day(project.install_date)}. ` +
      (review ? "Thanks for your rating. Please complete payment so we can pay your installer." : "Please rate your installer, then complete payment so we can pay them."),
      [["Installer", esc(company)], ["Amount due", money(bid.amount)], ["Pay by", "Bank account (recommended) or card"]],
      [review ? "Pay now" : "Rate & pay", `${SITE}/list-project?login=1`],
      "Payment is due within 24 hours of your installation being completed. Your payment is held by saunainstall and released to your installer, so we can step in if something isn't right.",
      note(`Not finished yet, or something wrong with the install? Reply to this email and we'll help before any money moves.`)),
    `pay-reminder-${projectId}`);
}

async function paymentProcessing(paymentId: string) {
  const { pay, project, contractor, owner } = await loadPayment(paymentId);
  return send(owner.email, `Payment started: ${cents(pay.amount_cents)} for your sauna install`,
    layout("Your bank payment is on its way.", `Hi ${esc(owner.first_name || "there")}, thanks for paying by bank account. Bank payments take about 4 business days to clear. We'll email you when it's complete.`,
      [["Installer", esc(contractor?.business_name || "")], ["Amount", cents(pay.amount_cents)], ["Project", esc(projName(project))]],
      null, "This is your payment confirmation from saunainstall."),
    `pay-processing-${pay.id}`);
}

async function paymentReceived(paymentId: string) {
  const { pay, project, contractor, cProfile, owner } = await loadPayment(paymentId);
  const fee = pay.stripe_fee_cents;
  await send(owner.email, `Paid: ${cents(pay.amount_cents)} for your sauna install`,
    layout("Payment complete. Thank you!", `Hi ${esc(owner.first_name || "there")}, your payment to <b>${esc(contractor?.business_name || "your installer")}</b> through saunainstall is complete.`,
      [["Amount", cents(pay.amount_cents)], ["Paid by", methodName(pay.method)], ["Project", esc(projName(project))]],
      null, "Keep this email as your receipt."),
    `pay-received-owner-${pay.id}`);
  return send(cProfile.email, `Homeowner paid: ${cents(pay.amount_cents)} for ${projName(project)}`,
    layout("The homeowner paid.", `Hi ${esc(cProfile.first_name || contractor?.business_name || "there")}, payment for your job in ${esc(place(project))} is complete.` +
      (contractor?.payouts_enabled ? " Your payout is being sent to your bank." : " <b>Set up payouts</b> in your dashboard so we can send your money."),
      [["Job price", cents(pay.amount_cents)], ["Paid by", methodName(pay.method)], ["Processing fee", fee != null ? cents(fee) : "Calculated by Stripe"],
       ["Your payout", fee != null ? cents(pay.amount_cents - fee) : "Job price minus processing fee"]],
      [contractor?.payouts_enabled ? "View my bids" : "Set up payouts", `${SITE}/contractors?login=1`],
      "Payouts arrive in your bank account by ACH, usually within 2 business days of release."),
    `pay-received-pro-${pay.id}`);
}

async function payoutSent(paymentId: string) {
  const { pay, project, contractor, cProfile } = await loadPayment(paymentId);
  return send(cProfile.email, `Payout sent: ${cents(pay.transfer_cents)}`,
    layout("Your payout is on its way.", `Hi ${esc(cProfile.first_name || contractor?.business_name || "there")}, we released your payment for the ${esc(projName(project).toLowerCase())} in ${esc(place(project))}.`,
      [["Job price", cents(pay.amount_cents)], ["Processing fee (Stripe)", "−" + cents(pay.stripe_fee_cents)], ["Your payout", cents(pay.transfer_cents)]],
      ["View payouts", `${SITE}/contractors?login=1`],
      "Funds reach your bank by ACH, usually within 2 business days (bank-account payments can take a few extra days to clear first)."),
    `payout-sent-${pay.id}`);
}

async function paymentFailed(paymentId: string) {
  const { pay, owner } = await loadPayment(paymentId);
  return send(owner.email, `Your sauna install payment didn't go through`,
    layout("Your payment didn't go through.", `Hi ${esc(owner.first_name || "there")}, your bank declined or returned the payment of ${cents(pay.amount_cents)}. Please try again with another bank account or a card.`,
      [["Amount due", cents(pay.amount_cents)]], ["Try again", `${SITE}/list-project?login=1`], ""),
    `pay-failed-${pay.id}-${pay.updated_at}`);
}

async function disputeAlert(paymentId: string, status: string, reason: string) {
  const { pay, project, contractor, owner } = await loadPayment(paymentId);
  return send(SUPPORT, `[Action needed] Payment dispute ${status}: ${cents(pay.amount_cents)}`,
    layout("A homeowner disputed a payment.", `Status: <b>${esc(status)}</b>. Reason: ${esc(reason)}. Respond in the Stripe Dashboard → Payments → Disputes before the deadline.`,
      [["Project", esc(projName(project)) + " · " + esc(place(project))], ["Homeowner", esc(owner.email)], ["Installer", esc(contractor?.business_name || "")],
       ["Amount", cents(pay.amount_cents)], ["Payout sent", pay.transfer_id ? `${cents(pay.transfer_cents)} (${esc(pay.transfer_id)})` : "Not yet"]],
      ["Open Stripe disputes", "https://dashboard.stripe.com/disputes"], "Internal alert."),
    `dispute-${pay.id}-${status}`);
}

async function sample(to: string) {
  const t = Date.now();
  const amt = 2650;
  return send(to, "[Test] You're hired: Arosa 4-Person Barrel Sauna install in Ketchum",
    layout("You won the job.", "Hi Sam, Jordan Avery accepted your $2,650 proposal. Reach out to schedule the install.",
      [["Project", "Arosa 4-Person Barrel Sauna install"], ["Location", "Ketchum, 83340"], ["Install date", day("2026-12-05")], ["Proposed start", day("2026-12-01")],
       ["Homeowner", "Jordan Avery"], ["Email", "jordan@example.com"], ["Phone", "(208) 555-0142"], ["Job price", money(amt)],
       ["Processing fee", `${money(bankFee(amt))} if paid by bank · ${money(cardFee(amt))} if paid by card`],
       ["Your payout", `${money(amt - bankFee(amt))} by bank · ${money(amt - cardFee(amt))} by card`]],
      ["Open my bids", `${SITE}/contractors?login=1`], "This is a test email from saunainstall.",
      note("The homeowner pays through saunainstall within 24 hours of the job being completed, after rating your work. Stripe's processing fee is deducted from your payout; the exact amount depends on how the homeowner pays.")),
    `test-hired-${t}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== await secret("notify_secret")) return new Response("Forbidden", { status: 403 });
  try {
    const job = await req.json();
    let out;
    switch (job.type) {
      case "bid_created": out = await bidCreated(job.bid_id); break;
      case "bid_status": out = await bidStatus(job.bid_id, job.status); break;
      case "payment_reminder": out = await paymentReminder(job.project_id); break;
      case "payment_processing": out = await paymentProcessing(job.payment_id); break;
      case "payment_received": out = await paymentReceived(job.payment_id); break;
      case "payment_failed": out = await paymentFailed(job.payment_id); break;
      case "payout_sent": out = await payoutSent(job.payment_id); break;
      case "dispute_alert": out = await disputeAlert(job.payment_id, job.dispute_status, job.reason); break;
      case "test": out = await sample(job.to); break;
      default: return new Response("Unknown job", { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("notify failed", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
