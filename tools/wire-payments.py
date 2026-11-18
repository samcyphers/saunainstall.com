"""Job payments + payouts wiring for the design-tool pages (run AFTER tools/wire-backend.py).
Usage: python3 tools/wire-payments.py contractors|homeowner|index <in.html> <out.html>
Homeowners pay through saunainstall when they hire (bank account recommended, or card). saunainstall holds the
payment until the homeowner rates the job (or 7 days after the install date, or an admin releases it); contractors
then receive the job price minus Stripe's processing fee by ACH payout (Stripe Connect Express).
Every edit must match exactly once; misses are reported."""
import sys, re

kind, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src, encoding="utf-8").read()
misses = []

def rep(old, new, count=1):
    global t
    n = t.count(old)
    if n != count:
        misses.append((n, old[:100]))
        return
    t = t.replace(old, new)

def rep_re(pattern, new, flags=re.S):
    global t
    m = list(re.finditer(pattern, t, flags))
    if len(m) != 1:
        misses.append((len(m), pattern[:100]))
        return
    t = t[:m[0].start()] + (new(m[0]) if callable(new) else new) + t[m[0].end():]

FEES = "bank 0.8%, max $5; card 2.9% + 30¢"

if kind == "contractors":
    # ---- sign-up: fee acknowledgement checkbox ----
    rep('<button type="button" sc-camel-on-click="{{ submitSignup }}"',
        '<label style="display: flex; align-items: flex-start; gap: 10px; margin-top: 20px; font-size: 14.5px; color: #272019; cursor: pointer;">'
        '<input type="checkbox" checked="{{ feesAckVal }}" sc-camel-on-change="{{ feesAckOn }}" style="width: 18px; height: 18px; margin-top: 3px; accent-color: #8A5424; flex: none;">'
        f'<span>I understand homeowners pay for jobs through saunainstall when they hire me, saunainstall holds the payment until the job is done, and Stripe\'s processing fee ({FEES}) is deducted from my job payouts. '
        '<a href="/terms#contractor-payments" target="_blank" rel="noopener" style="color: #8A5424; text-decoration: underline; text-underline-offset: 3px;">Terms</a></span></label>\n'
        '<span style="display: {{ feesAckErr }}; color: #C0492F; font-size: 12.5px; margin-top: 6px; font-weight: 600;">{{ feesAckMsg }}</span>\n'
        '<button type="button" sc-camel-on-click="{{ submitSignup }}"')
    rep('''    if (s.pass.length < 8) err.pass = "Use at least 8 characters.";''',
        '''    if (s.pass.length < 8) err.pass = "Use at least 8 characters.";
    if (!s.feesAck) err.feesAck = "Please confirm you understand how job payments and processing fees work.";''')
    rep('role: "contractor", first_name:', 'role: "contractor", fees_acknowledged: "true", first_name:')

    # ---- pricing card: processing fee row + note ----
    rep_re(r'(<div style="display: flex; justify-content: space-between; gap: 12px;"><span style="color: #8A8071;">Commission on jobs</span><b style="font-weight: 700; color: #272019;">0%</b></div>)',
        lambda m: m.group(1) +
        '\n<div style="display: flex; justify-content: space-between; gap: 12px;"><span style="color: #8A8071;">Job payment processing</span><b style="font-weight: 700; color: #272019;">From payout</b></div>'
        f'\n<p style="font-size: 12.5px; color: #8A8071; margin: 2px 0 0; line-height: 1.5;">Homeowners pay through saunainstall when they hire you, and we hold it until the job is done. Stripe\'s processing fee ({FEES}) is deducted from each job payout.</p>')

    # ---- bid form: live payout estimator ----
    rep('<p style="font-size: 13px; color: #8A8071; margin: 8px 0 0;">Fixed price, all-in. The homeowner pays you directly.</p>',
        '<p style="font-size: 13px; color: #8A8071; margin: 8px 0 0;">Fixed price, all-in. The homeowner pays through saunainstall when they hire you. We hold it until the job is done, then send your payout minus Stripe\'s processing fee.</p>\n'
        '<div style="display: {{ estDisplay }}; margin-top: 10px; background: #F4ECE0; border: 1px solid #E4D8C5; border-radius: 11px; padding: 12px 14px; font-size: 14px; color: #272019; line-height: 1.4;">'
        '<div style="display: grid; grid-template-columns: 1fr auto auto; gap: 6px 16px; align-items: baseline;">'
        '<span style="font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #8A8071;">If paid by</span><span style="font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #8A8071; text-align: right;">Fee</span><span style="font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #8A8071; text-align: right;">You receive</span>'
        '<span>Bank</span><span style="text-align: right; color: #6B6253;">{{ estBankFee }}</span><b style="text-align: right; font-weight: 700;">{{ estBankNet }}</b>'
        '<span>Card</span><span style="text-align: right; color: #6B6253;">{{ estCardFee }}</span><b style="text-align: right; font-weight: 700;">{{ estCardNet }}</b>'
        '</div><div style="font-size: 12.5px; color: #8A8071; margin-top: 8px;">Estimate using Stripe\'s standard rates. Homeowners are encouraged to pay by bank.</div></div>')
    rep('''      out[k + "Msg"] = e[k] || "";
    });

    const railDefs = [["1", "Sign up"]''', '''      out[k + "Msg"] = e[k] || "";
    });
    // sign-up fee acknowledgement + bid payout estimator
    out.feesAckVal = !!s.feesAck;
    out.feesAckOn = ev => this.setState(st => ({ feesAck: ev.target.checked, err: Object.assign({}, st.err, { feesAck: "" }) }));
    out.feesAckErr = e.feesAck ? "block" : "none";
    out.feesAckMsg = e.feesAck || "";
    const est = SI.estimateFees(parseInt(String(s.bidAmount).replace(/\\D/g, ""), 10) || 0);
    out.estDisplay = est.amount > 0 ? "block" : "none";
    out.estBankFee = SI.money(est.bankFee); out.estBankNet = SI.money(est.bankNet);
    out.estCardFee = SI.money(est.cardFee); out.estCardNet = SI.money(est.cardNet);

    const railDefs = [["1", "Sign up"]''')

    # ---- dashboard: payouts card (cloned from the membership card) ----
    def payouts_card(m):
        card = m.group(0)
        clone = (card.replace(">Membership<", ">Payouts<").replace("memberFg", "payoutFg").replace("memberCheckDisplay", "payoutCheckDisplay")
                 .replace("memberLabel", "payoutLabel").replace("memberBody", "payoutBody").replace("goPayment", "goPayouts").replace("memberBtnLabel", "payoutBtnLabel"))
        return card + "\n" + clone
    rep_re(r'<div style="[^"]*">\s*<div style="[^"]*">Membership</div>.*?\{\{ memberBtnLabel \}\}</button>\s*</div>', payouts_card)
    rep('''      memberBtnLabel: s.paid ? "Manage membership & billing" : "Start free month",''',
        '''      memberBtnLabel: s.paid ? "Manage membership & billing" : "Start free month",
      payoutFg: s.payoutsEnabled ? "#3E7A4E" : "#B07C1E",
      payoutCheckDisplay: s.payoutsEnabled ? "block" : "none",
      payoutLabel: s.payoutsEnabled ? "Payouts active" : s.payoutsStarted ? "Payout setup unfinished" : "Payouts not set up",
      payoutBody: s.payoutsEnabled ? "Released job payments go to your bank by ACH, minus Stripe's processing fee." : "Add your bank account so we can send your job payments when they're released. About 5 minutes.",
      payoutBtnLabel: s.payoutsEnabled ? "View payouts" : s.payoutsStarted ? "Finish payout setup" : "Set up payouts",
      goPayouts: () => { (s.payoutsEnabled ? SI.payoutDashboard() : SI.payoutSetup()).catch(e => alert(SI.friendly(e))); },''')
    rep('''      biz: c.business_name || st.biz, zip: c.zip || st.zip, paid: SI.isActive(c),''',
        '''      biz: c.business_name || st.biz, zip: c.zip || st.zip, paid: SI.isActive(c),
      payoutsEnabled: !!c.payouts_enabled, payoutsStarted: !!c.stripe_connect_id,''')
    # back from Stripe payout onboarding
    rep('''        if (!m || !m.contractor) return;
        this.applyMe(m);
        if (back === "success") {''', '''        if (!m || !m.contractor) return;
        this.applyMe(m);
        if (q.get("payouts")) {
          history.replaceState(null, "", window.location.pathname);
          SI.payoutStatus().then(st => this.setState({ payoutsEnabled: !!st.payouts_enabled, payoutsStarted: true })).catch(() => {});
        }
        if (back === "success") {''')

    # ---- dashboard copy + per-job payout column ----
    rep('Total of your hired and completed jobs. Homeowners pay you directly, and saunainstall takes no commission.',
        'Total of your hired and completed jobs. Homeowners pay through saunainstall when they hire you; Stripe\'s processing fee is deducted from each payout.')
    rep('const completed = s.bids.filter(b => b.status === "Completed");', 'const completed = s.bids.filter(b => b.status === "Completed" || b.status === "Paid");')
    rep('payout: b.status === "Declined" ? "—" : "Paid by homeowner",', 'payout: b.payoutText || (b.status === "Declined" ? "—" : ""),')
    rep('payoutFg: b.status === "Paid" ? "#3E7A4E" : pendingPay ? "#B07C1E" : "#8A8071"', 'payoutFg: b.payoutFg || (pendingPay ? "#B07C1E" : "#8A8071")')
    rep('''        ["Get paid", "Collect payment directly from the homeowner. saunainstall takes no commission."]''',
        '''        ["Get paid", "The homeowner pays when they hire you and we hold it. When they rate the job (or 7 days after the install date), we send your payout by ACH, minus Stripe's processing fee."]''')

elif kind == "homeowner":
    # ---- copy ----
    rep('Your ideal start date — installers can propose an alternative.</p>',
        'Your ideal install date — installers can propose an alternative. You pay when you hire, and saunainstall holds it until the job is done.</p>')
    rep('<b style="font-weight: 600; text-align: right;">Directly to your installer</b>', '<b style="font-weight: 600; text-align: right;">Bank account (recommended) or card</b>')
    rep("You pay your installer directly. Only mark complete once you're happy with the finished sauna.</p>",
        "Submitting your review releases your payment to your installer. Only submit once you're happy with the finished sauna. Problem with the job? <a href=\"/support\" style=\"color: #8A5424;\">Contact support</a> first.</p>")
    rep(">Final step</span>", ">{{ payKicker }}</span>")
    rep(">Review your installer and release payment.</h1>", ">{{ payHeading }}</h1>")
    rep(">A star rating is required to complete the project. Your review is posted to the installer's profile and helps other sauna owners choose.</p>", ">{{ payIntro }}</p>")
    rep_re(r"Submit review &amp; mark complete", "Submit review &amp; release payment")
    rep('["Installer hired", "Schedule the install directly with them."]', '["Installer hired", "Pay to confirm, then schedule the install with them."]')
    rep('["Hire your installer", "Accept the proposal you trust. Schedule directly with the contractor."', '["Hire your installer", "Accept the proposal you trust and pay through saunainstall. We hold it until the job is done."')
    rep('No fees and no commission — homeowners never pay saunainstall.', 'No fees and no commission for homeowners. You pay only your installer\'s price.')
    rep('["Review & complete", "Rate your installer and mark the job complete."]', '["Review & release", "Rate your installer to release your held payment."]')
    rep('''["Install complete", "Mark the project completed once you're happy with the finished sauna.", 4]''',
        '''["Install complete", "Rate your installer to release your held payment.", 4]''')
    rep('>Mark project completed</button>', '>Job done? Rate &amp; release payment</button>')
    rep('Completed · installer paid directly', '{{ p.doneLabel }}')

    # ---- dashboard: "Pay now" button (cloned from "Accept proposal") ----
    rep_re(r'<button type="button" sc-camel-on-click="\{\{ p\.accept \}\}"[^>]*>Accept proposal</button>',
        lambda m: m.group(0) + '\n' + m.group(0).replace('{{ p.accept }}', '{{ p.pay }}').replace('{{ p.acceptDisplay }}', '{{ p.payDisplay }}').replace('>Accept proposal<', '>Pay to confirm hire<'))
    # held-payment status line under a hired proposal
    rep_re(r'(\{\{ p\.doneLabel \}\}\s*</span>)', lambda m: m.group(1) +
        '\n<span style="display: {{ p.heldDisplay }}; align-items: center; gap: 7px; font-size: 14px; font-weight: 600; color: {{ p.heldFg }}; flex-basis: 100%;">{{ p.heldLabel }}</span>')
    rep('''        completeDisplay: st === "Hired" ? "inline-flex" : "none",''',
        '''        completeDisplay: st === "Hired" && s.payStatus === "succeeded" ? "inline-flex" : "none",''')
    rep('''        doneDisplay: st === "Completed" ? "inline-flex" : "none",''',
        '''        doneDisplay: st === "Completed" ? "inline-flex" : "none",
        doneLabel: s.payTransferred ? "Completed · paid to installer" : s.payStatus === "refunded" ? "Completed · refunded"
          : s.payStatus === "disputed" ? "Completed · payment disputed" : s.payHold ? "Completed · payment on hold" : "Completed · payment released",
        payDisplay: st === "Hired" && ["succeeded", "processing", "refunded", "disputed"].indexOf(s.payStatus) === -1 ? "inline-flex" : "none",
        heldDisplay: st === "Hired" ? "inline-flex" : "none",
        heldFg: s.payStatus === "succeeded" && !s.payHold ? "#3E7A4E" : s.payStatus === "failed" ? "#C0492F" : "#B07C1E",
        heldLabel: s.payStatus === "succeeded" ? (s.payHold ? "Payment on hold while we look into an issue" : "Payment held by saunainstall · released when you rate the job" + (s.payReleaseOn ? " or on " + s.payReleaseOn : ""))
          : s.payStatus === "processing" ? "Bank payment clearing · about 4 business days" : s.payStatus === "failed" ? "Payment didn't go through · please try again"
          : "saunainstall holds your payment until the job is done",
        pay: () => { this.setState({ step: 5, err: {} }); window.scrollTo(0, 0); },''')
    rep('''        savedRating: r.review ? r.review.rating : this.state.savedRating,''',
        '''        savedRating: r.review ? r.review.rating : this.state.savedRating,
        reviewDone: !!r.review, payStatus: r.payment ? r.payment.status : null,
        payTransferred: !!(r.payment && r.payment.transfer_id), payHold: !!(r.payment && r.payment.on_hold),
        payReleaseOn: r.payment && r.payment.auto_release_on ? SI.longDate(r.payment.auto_release_on) : "",''')

    # ---- step 5: rate first, then choose how to pay ----
    rep_re(r'<div data-m="pad2" style="(?=[^"]*"\s*>\s*<label[^>]*>Rate \{\{ payCompany \}\})', '<div data-m="pad2" style="display: {{ reviewDisplay }}; ')
    PAY_CARD = (
        '\n<div data-m="pad2" style="display: {{ payChoiceDisplay }}; margin-top: 18px; background: #FFFDF9; border: 1px solid #E4D8C5; border-radius: 22px; padding: 30px; box-shadow: 0 1px 2px rgba(42,34,25,.06);">'
        '<div style="font-size: 13px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #8A8071;">Pay {{ payAmount }}</div>'
        '<p style="font-size: 15px; color: #6B6253; margin: 8px 0 0;">We hold your payment until the job is done, then release it to your installer when you rate the job (or automatically 7 days after the install date).</p>'
        '<button type="button" sc-camel-on-click="{{ payBank }}" style="width: 100%; margin-top: 18px; display: flex; flex-direction: column; align-items: center; gap: 2px; font-family: inherit; font-size: 17px; font-weight: 600; cursor: pointer; border-radius: 11px; border: 1px solid transparent; padding: 13px 20px; background: #8A5424; color: #fff;" style-hover="background: #6F421A;">'
        'Pay by bank account<span style="font-size: 13px; font-weight: 500; opacity: .85;">Recommended · lowest fees for your installer</span></button>'
        '<button type="button" sc-camel-on-click="{{ payCard }}" style="width: 100%; margin-top: 10px; display: flex; align-items: center; justify-content: center; font-family: inherit; font-size: 16px; font-weight: 600; cursor: pointer; border-radius: 11px; border: 1px solid #D8C8AF; padding: 13px 20px; background: #FFFDF9; color: #272019; min-height: 50px;" style-hover="background: #F4ECE0;">Pay by card</button>'
        '<span style="display: {{ payErrDisplay }}; color: #C0492F; font-size: 13px; margin-top: 12px; font-weight: 600;">{{ payErrMsg }}</span>'
        '<p style="font-size: 13px; color: #8A8071; margin: 14px 0 0; text-align: center;">Secure checkout by Stripe. Your installer is confirmed once payment goes through. Bank payments take about 4 business days to clear.</p>'
        '</div>')
    rep_re(r"(Problem with the job\? <a href=\"/support\" style=\"color: #8A5424;\">Contact support</a> first\.</p>\s*</div>)", lambda m: m.group(1) + PAY_CARD)
    rep('''      payAmount: this.money(hired.amount),''', '''      payAmount: this.money(hired.amount),
      reviewDisplay: s.payStatus === "succeeded" && !s.reviewDone ? "block" : "none",
      payChoiceDisplay: ["succeeded", "processing", "refunded", "disputed"].indexOf(s.payStatus) === -1 ? "block" : "none",
      payKicker: s.payStatus === "succeeded" ? "Final step" : "Confirm your hire",
      payHeading: s.payStatus === "succeeded" ? "Review your installer and release payment." : "Pay to confirm your installer.",
      payIntro: s.payStatus === "succeeded" ? "A star rating is required to complete the project. Your review is posted to the installer's profile and releases your payment to them."
        : "Pay the agreed price through saunainstall. We hold it until the job is done, so your installer knows the job is secured and you're protected if something goes wrong.",
      payBank: () => this.payJob("us_bank_account"),
      payCard: () => this.payJob("card"),
      payErrDisplay: s.err.pay ? "block" : "none",
      payErrMsg: s.err.pay || "",''')
    rep('''  submitPay = () => {''', '''  payJob(method) {
    if (this.state.busy) return;
    this.setState({ busy: true, err: {} });
    SI.payJob(this.state.projectId, method).catch(e => this.setState({ busy: false, err: { pay: SI.friendly(e) } }));
  }

  submitPay = () => {''')
    # after rating: back to the dashboard (rating releases the held payment)

    rep('''      dashHeading: s.completedId ? "Your sauna install is complete." : hired ? hired.company + " is installing your sauna." :''',
        '''      dashHeading: s.completedId ? "Your sauna install is complete." : hired && ["succeeded", "processing"].indexOf(s.payStatus) === -1 ? "Pay to confirm " + hired.company.replace(/\\.$/, "") + "." : hired ? hired.company + " is installing your sauna." :''')
    rep('''sub: s.completedId ? "install complete" : hired ? "install scheduled" : "accepting proposals"''',
        '''sub: s.completedId ? "install complete" : hired && ["succeeded", "processing"].indexOf(s.payStatus) === -1 ? "payment needed" : hired ? "payment held" : "accepting proposals"''')

elif kind == "index":
    rep('Compare price, reviews, and portfolios. Book directly — no markup from us.', 'Compare price, reviews, and portfolios. No markup from us.')
    rep('''Installers pay a small fee to bid on jobs they're matched to."],''',
        '''Installers pay a small fee to bid on jobs they're matched to."],
      ["How do I pay my installer?", "When you hire an installer, you pay the agreed price on saunainstall by bank account (recommended) or card. We hold it until the job is done and release it when you rate your installer, or automatically 7 days after the install date. If something isn't right, contact us before then and we'll hold the payment."],
      ["How do installers get paid?", "Once the homeowner's payment is released, saunainstall sends the job price to the installer's bank by ACH, minus Stripe's processing fee (bank 0.8%, max $5; card 2.9% + 30\\u00a2). Installers see an estimate of their payout before they bid."],''')

open(dst, "w", encoding="utf-8").write(t)
print(kind, src.split("/")[-1], "->", "OK" if not misses else "MISSES:")
for m in misses: print("   ", m)
