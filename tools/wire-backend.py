"""Apply Supabase/Stripe wiring to the design-tool pages.
Usage: python3 -I patch.py contractors|homeowner <in.html> <out.html>
Works on the unpacked template or the design-source file. Every edit must match exactly once."""
import sys, re

kind, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src, encoding="utf-8").read()
misses = []

def rep(old, new, count=1):
    global t
    n = t.count(old)
    if n != count:
        misses.append((n, old[:90]))
        return
    t = t.replace(old, new)

def rep_re(pattern, new, flags=re.S):
    global t
    m = list(re.finditer(pattern, t, flags))
    if len(m) != 1:
        misses.append((len(m), pattern[:90]))
        return
    t = t[:m[0].start()] + (new(m[0]) if callable(new) else new) + t[m[0].end():]

LABEL = 'style="display: block; font-size: 13.5px; font-weight: 600; color: #272019; margin-bottom: 7px;"'
REQ = '<span style="color: #C0492F; font-weight: 700;"> *</span>'
def field(key, label, ph, typ="text", extra=""):
    return ('<div>\n'
            f'                  <label {LABEL}>{label}{REQ}</label>\n'
            f'                  <input type="{typ}" {extra} placeholder="{ph}" value="{{{{ {key}Val }}}}" sc-camel-on-change="{{{{ {key}On }}}}" '
            f'style="width: 100%; font-family: inherit; font-size: 16px; color: #272019; background: #FCF8F1; border: 1px solid {{{{ {key}Bd }}}}; border-radius: 11px; padding: 13px 14px;">\n'
            f'                  <span style="display: {{{{ {key}Err }}}}; color: #C0492F; font-size: 12.5px; margin-top: 6px; font-weight: 600;">{{{{ {key}Msg }}}}</span>\n'
            '                </div>')

# Load the connector before the page runtime
rep_re(r'(<meta name="viewport"[^>]*>)', lambda m: m.group(1) + '\n<script src="/js/si.js"></script>')

if kind == "contractors":
    # ---------- markup: business name + password on sign-up ----------
    rep('              <hr style="border: none; border-top: 1px solid #E4D8C5; margin: 26px 0;">\n              <div style="font-size: 13px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #8A8071;">Business address</div>',
        '              <div data-m="fields" style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px;">\n                '
        + field("biz", "Business name", "Northwood Sauna Co.", extra='autocomplete="organization"') + '\n                '
        + field("pass", "Create a password", "At least 8 characters", "password", 'autocomplete="new-password"') +
        '\n              </div>\n\n              <hr style="border: none; border-top: 1px solid #E4D8C5; margin: 26px 0;">\n              <div style="font-size: 13px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #8A8071;">Business address</div>')

    # ---------- markup: payment step -> Stripe Checkout ----------
    rep('Add your card to unlock unlimited bids.</h1>', 'Start your free month to unlock unlimited bids.</h1>')
    rep('Your first month is free, then $24.99 a month for unlimited bids. Your card is processed once for membership. ACH details are where we send your payout after the homeowner marks the project completed.</p>',
        'Your first month is free, then $24.99 a month for unlimited bids. Add a card or bank account on Stripe\'s secure checkout page. You won\'t be charged until your free month ends, and you can cancel anytime.</p>')
    rep('>Credit card — $24.99/mo after your free month</div>', '>Contractor membership — $24.99/mo after your free month</div>')
    rep('                Encrypted · PCI compliant\n', '                Secure checkout by Stripe\n')
    BODY = 'style="font-size: 15.5px; color: #272019; display: flex; gap: 10px; align-items: flex-start;"'
    CHECK = '<svg sc-camel-view-box="0 0 20 20" fill="none" aria-hidden="true" style="width: 18px; height: 18px; color: #3E7A4E; flex: none; margin-top: 3px;"><path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
    rep_re(r'            <div style="margin-top: 16px;">\s*<label [^>]*>Name on card</label>.*?(?=\n            <div style="display: flex; gap: 12px; margin-top: 26px;">)',
        '            <div style="display: grid; gap: 12px; margin-top: 20px;">\n'
        f'              <div {BODY}>{CHECK}<span>Unlimited bids on every sauna project in your service areas.</span></div>\n'
        f'              <div {BODY}>{CHECK}<span>Free for your first month. Then $24.99 a month, billed by Stripe.</span></div>\n'
        f'              <div {BODY}>{CHECK}<span>Pay by card or bank account (ACH). Cancel anytime from your dashboard.</span></div>\n'
        '            </div>\n'
        '            <span style="display: {{ authErr }}; color: #C0492F; font-size: 13px; margin-top: 14px; font-weight: 600;">{{ authMsg }}</span>')

    # ---------- markup: copy that promised ACH payouts ----------
    rep('Your first month is free — a card is only processed before your first bid.', 'Your first month is free. You add a card or bank account before your first bid.')
    rep('Unlimited bids. ACH payout when the job is marked completed.', 'Unlimited bids. No commission on the jobs you win.')

    # ---------- logic ----------
    rep('      first: "", last: "", phone: "", email: "", addr: "", city: "", state: "", zip: "", site: "",\n      locs: ["83340", "83333", "Boise"], locInput: "",',
        '      first: "", last: "", phone: "", email: "", addr: "", city: "", state: "", zip: "", site: "", biz: "", pass: "", busy: false, projects: [],\n      locs: [], locInput: "",')
    rep_re(r'      bids: \[\n.*?\n      \],\n      err: \{\},', '      bids: [],\n      err: {},')

    rep('''  componentDidMount() {
    if (typeof window !== "undefined" && window.location.hash === "#login") this.setState({ step: 6 });
  }''', '''  componentDidMount() {
    if (typeof window === "undefined") return;
    const wantLogin = window.location.hash === "#login";
    if (wantLogin) this.setState({ step: 6 });
    if (!window.SI) return;
    const q = new URLSearchParams(window.location.search);
    const back = q.get("checkout");
    if (back) history.replaceState(null, "", window.location.pathname + window.location.hash);
    SI.session().then(sess => {
      if (!sess) return;
      return SI.me().then(m => {
        if (!m || !m.contractor) return;
        this.applyMe(m);
        if (back === "success") {
          this.setState({ busy: true, step: 1 });
          return SI.waitForMembership().then(m2 => {
            this.applyMe(m2);
            let pid = null; try { pid = sessionStorage.getItem("si.pendingBid"); sessionStorage.removeItem("si.pendingBid"); } catch (e) {}
            return this.refresh().then(() => {
              const ok = SI.isActive(m2 && m2.contractor);
              const has = pid && this.state.projects.some(p => p.id === pid);
              this.setState({ busy: false, step: ok && has ? 3 : 1, activeId: ok && has ? pid : this.state.activeId });
            });
          });
        }
        return this.refresh().then(() => this.setState({ step: wantLogin ? 5 : (back === "cancelled" ? 2 : 1) }));
      });
    }).catch(() => {});
  }

  applyMe(m) {
    if (!m || !m.profile) return;
    const p = m.profile, c = m.contractor || {};
    this.setState(st => ({
      first: p.first_name || st.first, last: p.last_name || st.last, email: m.email || st.email, phone: p.phone || st.phone,
      biz: c.business_name || st.biz, zip: c.zip || st.zip, paid: SI.isActive(c),
      locs: c.service_areas && c.service_areas.length ? c.service_areas : st.locs
    }));
  }

  refresh() {
    return Promise.all([SI.openProjects().catch(() => []), SI.myBids().catch(() => [])])
      .then(([projects, bids]) => this.setState({ projects, bids }));
  }

  saveLocs(list) { if (window.SI) SI.saveServiceAreas(list).catch(() => {}); }

  EMPTY = { id: null, title: "", type: "", model: "", size: "", city: "", st: "", zip: "", place: "", budget: "", posted: "", proposals: 0, distance: "", notes: "" };''')

    rep_re(r'  PROJECTS = \[\n.*?\n  \];', '  get PROJECTS() { return this.state.projects || []; }')

    rep('''    if (!/^\\d{5}$/.test(s.zip.trim())) err.zip = "5-digit ZIP.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    this.setState(st => ({''', '''    if (!/^\\d{5}$/.test(s.zip.trim())) err.zip = "5-digit ZIP.";
    if (!s.biz.trim()) err.biz = "Enter your business name.";
    if (s.pass.length < 8) err.pass = "Use at least 8 characters.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    if (s.busy) return;
    this.setState({ busy: true });
    SI.signUp(s.email, s.pass, {
      role: "contractor", first_name: s.first.trim(), last_name: s.last.trim(), phone: s.phone.trim(),
      business_name: s.biz.trim(), address: s.addr.trim(), city: s.city.trim(), state: s.state.trim(), zip: s.zip.trim(), website: s.site.trim()
    }).then(r => {
      if (r.needsConfirm) { this.setState({ busy: false, err: { email: "Check your inbox to confirm your email, then log in." } }); return; }
      return this.refresh().then(() => { this.afterSignup(); this.setState({ busy: false, pass: "" }); });
    }).catch(e => this.setState({ busy: false, err: { email: SI.friendly(e) } }));
  };

  afterSignup = () => {
    this.setState(st => ({''')

    rep('''  processCard = () => {
    const s = this.state, err = {};''', '''  processCard = () => {
    if (this.state.busy) return;
    this.setState({ busy: true, err: {} });
    try { if (this.state.pendingId) sessionStorage.setItem("si.pendingBid", this.state.pendingId); } catch (e) {}
    SI.startCheckout().catch(e => this.setState({ busy: false, err: { auth: SI.friendly(e) } }));
  };

  processCardDemo = () => {
    const s = this.state, err = {};''')

    rep('''    if (Object.keys(err).length) { this.setState({ err }); return; }
    const a = this.PROJECTS.filter(p => p.id === s.activeId)[0] || this.PROJECTS[0];
    const bid = {''', '''    if (Object.keys(err).length) { this.setState({ err }); return; }
    if (s.busy) return;
    const amount = parseInt(s.bidAmount.replace(/\\D/g, ""), 10) || 0;
    this.setState({ busy: true });
    SI.sendBid(s.activeId, amount, s.bidDate, s.bidNote.trim())
      .then(() => this.refresh())
      .then(() => { this.setState({ busy: false, err: {}, step: 4 }); window.scrollTo(0, 0); })
      .catch(e => this.setState({ busy: false, err: { bidAmount: SI.friendly(e) } }));
  };

  sendBidDemo = () => {
    const s = this.state;
    const a = this.PROJECTS.filter(p => p.id === s.activeId)[0] || this.PROJECTS[0];
    const bid = {''')

    rep('''    if (s.loginPass.length < 6) err.loginPass = "Enter your password.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    this.setState(st => ({
      err: {}, step: 5, paid: true, loginPass: "",''', '''    if (s.loginPass.length < 6) err.loginPass = "Enter your password.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    if (s.busy) return;
    this.setState({ busy: true });
    SI.signIn(s.loginEmail, s.loginPass)
      .then(() => SI.me())
      .then(m => {
        if (!m || !m.contractor) { SI.signOut(); throw new Error("This email belongs to a homeowner account. Use the homeowner login."); }
        this.applyMe(m);
        return this.refresh();
      })
      .then(() => { this.setState({ busy: false, err: {}, step: 5, loginPass: "" }); window.scrollTo(0, 0); })
      .catch(e => this.setState({ busy: false, err: { loginPass: /homeowner/.test(e.message) ? e.message : SI.friendly(e) } }));
  };

  submitLoginDemo = () => {
    this.setState(st => ({
      err: {}, step: 5, paid: true, loginPass: "",''')

    rep('''    this.setState(s => ({ locs: s.locs.indexOf(v) === -1 ? s.locs.concat([v]) : s.locs, locInput: "" }));''',
        '''    const list = this.state.locs.indexOf(v) === -1 ? this.state.locs.concat([v]) : this.state.locs;
    this.setState({ locs: list, locInput: "" });
    this.saveLocs(list);''')
    rep('''remove: () => this.setState(st => ({ locs: st.locs.filter(x => x !== l) }))''',
        '''remove: () => { const list = this.state.locs.filter(x => x !== l); this.setState({ locs: list }); this.saveLocs(list); }''')

    # membership / payout wording
    rep('memberBody: s.paid ? "Card on file · ACH payouts set up. No per-bid fees in any of your service areas." : "Add and process a card once to unlock unlimited bids, plus ACH details for payouts.",',
        'memberBody: s.paid ? "Membership active. No per-bid fees in any of your service areas." : "Start your free month to unlock unlimited bids.",')
    rep('memberLabel: s.paid ? "Unlimited bids active" : "Card required before bidding",', 'memberLabel: s.paid ? "Unlimited bids active" : "Membership required before bidding",')
    rep('memberBtnLabel: s.paid ? "Update payment details" : "Add payment details",', 'memberBtnLabel: s.paid ? "Manage membership & billing" : "Start free month",')
    rep('statusLabel: s.paid ? "Unlimited bids active" : "Card required before bidding",', 'statusLabel: s.paid ? "Unlimited bids active" : "Membership required before bidding",')
    rep('statusBody: s.paid ? "Your card is on file and ACH payouts are set up. Bid on as many projects as you like." : "Add and process a card once to unlock unlimited bids, plus ACH details for payouts.",',
        'statusBody: s.paid ? "Your membership is active. Bid on as many projects as you like." : "Start your free month to unlock unlimited bids and full site notes.",')
    rep('payBtnLabel: "Add payment details",', 'payBtnLabel: "Start free month",')
    rep('processLabel: "Process card & unlock unlimited bids",', 'processLabel: s.busy ? "Opening secure checkout…" : "Continue to secure checkout",')
    rep('goPayment: () => { this.setState({ step: 2, err: {} }); window.scrollTo(0, 0); },',
        'goPayment: () => { if (s.paid && window.SI) { SI.openBillingPortal().catch(e => alert(SI.friendly(e))); return; } this.setState({ step: 2, err: {} }); window.scrollTo(0, 0); },')
    rep('payout: b.status === "Paid" ? "Paid by ACH" : pendingPay ? "Payout pending" : b.status === "Declined" ? "—" : "Paid on completion",',
        'payout: b.status === "Declined" ? "—" : "Paid by homeowner",')
    rep('{ label: "Awaiting payout", value: this.money(sum(completed)), sub: completed.length + " completed", fg: "#B07C1E" },',
        '{ label: "Completed", value: completed.length, sub: "jobs finished", fg: "#B07C1E" },')
    rep('{ label: "Paid to date", value: this.money(sum(paid)), sub: "via ACH", fg: "#3E7A4E" }',
        '{ label: "Won to date", value: this.money(sum(hired) + sum(completed)), sub: "hired + completed", fg: "#3E7A4E" }')
    rep('''        ["Paid by ACH", "Funds land in your " + s.achType.toLowerCase() + " account, typically in 2 business days."]''',
        '''        ["Get paid", "Collect payment directly from the homeowner. saunainstall takes no commission."]''')

    rep('goDashboard: () => { this.setState({ step: 5, err: {} }); window.scrollTo(0, 0); },',
        'goDashboard: () => { this.refresh().catch(() => {}); this.setState({ step: 5, err: {} }); window.scrollTo(0, 0); },')
    rep('color: #CDA468;">Payouts</div>', 'color: #CDA468;">Jobs won</div>')
    rep('Awaiting release. Funds move by ACH to your {{ achTypeLower }} account once the homeowner marks a project completed.</p>',
        'Total of your hired and completed jobs. Homeowners pay you directly, and saunainstall takes no commission.</p>')
    rep('<span style="color: #B6A88F;">Paid year to date</span>', '<span style="color: #B6A88F;">Completed jobs</span>')
    rep('pendingPayout: this.money(sum(completed)),', 'pendingPayout: this.money(sum(hired) + sum(completed)),')
    rep('paidToDate: this.money(sum(paid)),', 'paidToDate: this.money(sum(completed)),')
    rep('<span>ACH payout as soon as the homeowner marks the job completed</span>', '<span>No commission on the jobs you win</span>')
    rep('A card on file is required and processed once before your first bid. ACH payout details are added in the same step.</p>',
        'Add a card or bank account before your first bid. You won\'t be charged until your free month ends.</p>')
    rep('Fixed price, all-in. Paid by ACH when the homeowner marks the project completed.</p>', 'Fixed price, all-in. The homeowner pays you directly.</p>')
    # real projects: location text + empty-safe active project
    rep('meta: p.city + ", " + p.st + " " + p.zip + " · " + p.posted,', 'meta: p.place + " · " + p.posted,')
    rep('const a = this.PROJECTS.filter(p => p.id === s.activeId)[0] || this.PROJECTS[0];\n    const name',
        'const a = this.PROJECTS.filter(p => p.id === s.activeId)[0] || this.PROJECTS[0] || this.EMPTY;\n    const name')
    rep('activeMeta: a.city + ", " + a.st + " " + a.zip + " · " + a.posted + " · " + a.proposals + " proposals",',
        'activeMeta: a.place + " · " + a.posted + " · " + a.proposals + " proposals",')
    rep('activeLoc: a.city + ", " + a.st + " " + a.zip,', 'activeLoc: a.place,')
    rep('"biz", "pass",', '"biz", "pass",', 0)  # sanity no-op
    rep('''    ["first", "last", "phone", "email", "addr", "city", "state", "zip", "site",''',
        '''    ["first", "last", "phone", "email", "addr", "city", "state", "zip", "site", "biz", "pass",''')

elif kind == "homeowner":
    # ---------- markup: password after the email block ----------
    rep('''                We only use your email information to send proposals.
              </div>
              <span style="display: {{ emailErr }}; color: #C0492F; font-size: 12.5px; margin-top: 6px; font-weight: 600;">{{ emailMsg }}</span>
            </div>
''', '''                We only use your email information to send proposals.
              </div>
              <span style="display: {{ emailErr }}; color: #C0492F; font-size: 12.5px; margin-top: 6px; font-weight: 600;">{{ emailMsg }}</span>
            </div>

            <div style="margin-top: 16px;">
              ''' + field("pass", "Create a password", "At least 8 characters", "password", 'autocomplete="new-password"') + '''
            </div>
''')
    # copy that promised ACH payment release
    rep('<b style="font-weight: 600; text-align: right;">ACH transfer to installer\'s bank</b>', '<b style="font-weight: 600; text-align: right;">Directly to your installer</b>')
    rep('Submit review &amp; release {{ payAmount }}', 'Submit review &amp; mark complete')
    rep("Payment is sent only after your review is submitted. Only mark complete once you're happy with the finished sauna.",
        "You pay your installer directly. Only mark complete once you're happy with the finished sauna.")
    rep('["Review & pay", "Rate your installer to release the ACH payment."]', '["Review & complete", "Rate your installer and mark the job complete."]')

    # ---------- logic ----------
    rep('      first: "", last: "", email: "", phone: "", zip: "",', '      first: "", last: "", email: "", phone: "", zip: "", pass: "", busy: false, projectId: null, proposals: [],')
    rep('''    if (typeof window !== "undefined" && window.location.hash === "#login") this.setState({ step: 3 });''',
        '''    if (typeof window !== "undefined" && window.location.hash === "#login") this.setState({ step: 3 });
    if (typeof window !== "undefined" && window.SI) {
      SI.session().then(sess => sess && SI.me()).then(m => {
        if (!m || !m.profile || m.profile.role !== "owner") return;
        this.applyMe(m);
        return this.loadDash();
      }).catch(() => {});
    }''')
    rep_re(r'  PROPOSALS = \[\n.*?\n  \];', '''  get PROPOSALS() { return this.state.proposals || []; }

  applyMe(m) {
    const p = m.profile;
    this.setState(st => ({ first: p.first_name || st.first, last: p.last_name || st.last, email: m.email || st.email, phone: p.phone || st.phone, zip: p.zip || st.zip }));
  }

  // Load the homeowner's latest project and its proposals. Goes to the dashboard, or to project details if none yet.
  loadDash(goTo) {
    return SI.myProject().then(r => {
      if (!r) { this.setState({ busy: false, step: 1, pzip: this.state.pzip || this.state.zip }); return; }
      const p = r.project, props = r.proposals;
      this.setState({
        busy: false, projectId: p.id, proposals: props, postedAgo: SI.ago(p.created_at),
        hiredId: p.awarded_bid_id, completedId: p.status === "completed" ? p.awarded_bid_id : null,
        declined: props.filter(x => x.status === "declined").map(x => x.id),
        savedRating: r.review ? r.review.rating : this.state.savedRating,
        type: p.sauna_type || "", make: p.brand || "", model: p.model || "", seats: p.capacity || "", power: p.power || "",
        elec: !!p.needs_electrician, date: p.install_date || "", notes: p.notes || "", city: p.city || "", pzip: p.zip || "",
        step: goTo === undefined ? 4 : goTo
      });
    });
  }

  act(promise) {
    this.setState({ busy: true });
    return promise.then(() => this.loadDash(this.state.step)).catch(e => { this.setState({ busy: false }); alert(SI.friendly(e)); });
  }''')

    rep('''    if (s.loginPass.length < 6) err.loginPass = "Enter your password.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    this.setState(st => ({
      err: {}, step: 4, loginPass: "",''', '''    if (s.loginPass.length < 6) err.loginPass = "Enter your password.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    if (s.busy) return;
    this.setState({ busy: true });
    SI.signIn(s.loginEmail, s.loginPass)
      .then(() => SI.me())
      .then(m => {
        if (!m || !m.profile || m.profile.role !== "owner") { SI.signOut(); throw new Error("This email belongs to a contractor account. Use the contractor login."); }
        this.applyMe(m);
        return this.loadDash();
      })
      .then(() => { this.setState({ err: {}, loginPass: "" }); window.scrollTo(0, 0); })
      .catch(e => this.setState({ busy: false, err: { loginPass: /contractor/.test(e.message) ? e.message : SI.friendly(e) } }));
  };

  submitLoginDemo = () => {
    this.setState(st => ({
      err: {}, step: 4, loginPass: "",''')

    rep('''  submitPay = () => {
    if (!this.state.rating) { this.setState({ err: { rating: true } }); return; }
    this.setState(st => ({ err: {}, completedId: st.hiredId, savedRating: st.rating, step: 4 }));
    window.scrollTo(0, 0);
  };''', '''  submitPay = () => {
    const s = this.state;
    if (!s.rating) { this.setState({ err: { rating: true } }); return; }
    if (s.busy) return;
    const hired = this.PROPOSALS.filter(p => p.id === s.hiredId)[0];
    if (!hired) return;
    this.setState({ busy: true, err: {}, savedRating: s.rating });
    SI.completeAndReview(s.projectId, hired.contractorId, s.rating, s.reviewText.trim())
      .then(() => this.loadDash(4))
      .then(() => window.scrollTo(0, 0))
      .catch(e => { this.setState({ busy: false }); alert(SI.friendly(e)); });
  };''')

    rep('const s = this.state, hired = this.PROPOSALS.filter(p => p.id === s.hiredId)[0] || this.PROPOSALS[0];',
        'const s = this.state, hired = this.PROPOSALS.filter(p => p.id === s.hiredId)[0] || this.PROPOSALS[0] || { company: "", amount: 0 };')
    rep('accept: () => this.setState({ hiredId: p.id }),', 'accept: () => this.act(SI.acceptBid(p.id)),')
    rep('decline: () => this.setState(prev => ({ declined: prev.declined.concat([p.id]) })),', 'decline: () => this.act(SI.declineBid(p.id)),')
    rep('dashDate: s.date || "Sep 15, 2026",', 'dashDate: s.date ? SI.longDate(s.date) : "Flexible",')
    rep('dashTitle: (s.type || "Traditional Sauna") + " install",', 'dashTitle: (s.type || "Sauna") + " install",')
    rep('dashType: s.type || "Traditional Sauna",', 'dashType: s.type || "Not sure",')
    rep('dashModel: s.model || "Golden Designs Arosa 4-Person Barrel Sauna",', 'dashModel: (s.model && s.model !== this.OTHER ? (s.make && s.model.indexOf(s.make) !== 0 ? s.make + " " + s.model : s.model) : (s.make && s.make !== this.OTHER ? s.make : "")) || "Not listed",')
    rep('dashPower: s.power || "240V 50A dedicated circuit",', 'dashPower: s.power || "Not specified",')
    rep('dashSize: s.seats || "4-person",', 'dashSize: s.seats || "Not specified",')
    rep('dashLoc: (s.city || "Ketchum") + ", " + (s.pzip || "83340")', 'dashLoc: [s.city, s.pzip].filter(Boolean).join(", ")')

    rep('''    if (!/^\\d{5}$/.test(s.zip.trim())) err.zip = "Enter a valid 5-digit ZIP.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    this.setState({ err: {}, step: 1, pzip: s.pzip || s.zip });
    window.scrollTo(0, 0);''', '''    if (!/^\\d{5}$/.test(s.zip.trim())) err.zip = "Enter a valid 5-digit ZIP.";
    if (s.pass.length < 8) err.pass = "Use at least 8 characters.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    if (s.busy) return;
    this.setState({ busy: true });
    SI.signUp(s.email, s.pass, { role: "owner", first_name: s.first.trim(), last_name: s.last.trim(), phone: s.phone.trim(), zip: s.zip.trim() })
      .then(r => {
        if (r.needsConfirm) { this.setState({ busy: false, err: { email: "Check your inbox to confirm your email, then log in." } }); return; }
        this.setState({ busy: false, err: {}, step: 1, pass: "", pzip: s.pzip || s.zip });
        window.scrollTo(0, 0);
      })
      .catch(e => this.setState({ busy: false, err: { email: SI.friendly(e) } }));''')

    rep('''    if (!s.confirm) err.confirm = "Please confirm your city and ZIP.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    this.setState({ err: {}, step: 2 });
    window.scrollTo(0, 0);''', '''    if (!s.confirm) err.confirm = "Please confirm your city and ZIP.";
    if (Object.keys(err).length) { this.setState({ err }); return; }
    if (s.busy) return;
    this.setState({ busy: true });
    SI.createProject({ type: s.type, make: s.make, model: s.model, seats: s.seats, power: s.power, elec: s.elec, date: s.date, notes: s.notes.trim(), city: s.city.trim(), pzip: s.pzip.trim() })
      .then(p => { this.setState({ busy: false, err: {}, step: 2, projectId: p.id }); window.scrollTo(0, 0); })
      .catch(e => this.setState({ busy: false, err: { confirm: SI.friendly(e) } }));''')

    rep('''["first", "last", "email", "phone", "zip", "date",''', '''["first", "last", "email", "phone", "zip", "pass", "date",''')
    rep('projectId: "#SI-" + (s.pzip || "83340") + "-4172",', 'projectId: "#SI-" + String(s.projectId || "").slice(0, 8).toUpperCase(),')

    rep('Completed · payment released by ACH', 'Completed · installer paid directly')
    rep('sub: s.completedId ? "payment released" :', 'sub: s.completedId ? "install complete" :')
    rep('{{ projectId }} · posted 3 days ago</p>', '{{ projectId }} · posted {{ postedAgo }}</p>')
    rep("Proposals keep arriving for about a week after a project goes live. You'll get an email each time one lands.</p>",
        "Proposals keep arriving for about a week after a project goes live. Check back here to see new ones.</p>")
    rep('live.length + " proposals to review.",', 'live.length + (live.length === 1 ? " proposal to review." : " proposals to review."),')
    rep('projectId: "#SI-" + String(s.projectId || "").slice(0, 8).toUpperCase(),', 'projectId: "#SI-" + String(s.projectId || "").slice(0, 8).toUpperCase(), postedAgo: s.postedAgo || "just now",')
    rep('goDash: () => { this.setState({ step: 4, err: {} }); window.scrollTo(0, 0); },',
        'goDash: () => { this.setState({ busy: true }); this.loadDash(4).then(() => window.scrollTo(0, 0)).catch(() => this.setState({ busy: false, step: 4 })); },')
open(dst, "w", encoding="utf-8").write(t)
print(kind, src.split("/")[-1], "->", "OK" if not misses else "MISSES:")
for m in misses: print("   ", m)
