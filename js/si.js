/* saunainstall.com — connects the site to Supabase (accounts, projects, bids) and Stripe (membership).
 * No dependencies. Exposes window.SI. The page logic in contractors.html and list-project.html calls it.
 * The key below is Supabase's public (anon) key: it is safe in the browser; database access rules protect the data. */
(function () {
  "use strict";
  var URL = "https://knpxvuicsjlhruqpdmzy.supabase.co";
  var KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtucHh2dWljc2psaHJ1cXBkbXp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODc1NDAsImV4cCI6MjEwODI2MzU0MH0._kxyBhvhERQBFbTir84UYoecON5cLMipUrBK3ZUORvE";
  var STORE = "si.session";

  // Arriving from an email confirmation link: Supabase appends tokens (or an error) after "#".
  // Remove them from the address bar and open the login screen.
  (function () {
    try {
      var h = window.location.hash || "";
      if (/access_token=|error_code=|type=signup/.test(h)) {
        var q = new URLSearchParams(window.location.search);
        q.set("login", "1");
        history.replaceState(null, "", window.location.pathname + "?" + q.toString());
      }
    } catch (e) {}
  })();
  function wantsLogin() {
    return window.location.hash === "#login" || /[?&]login=1(&|$)/.test(window.location.search);
  }

  // ---------- session storage ----------
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; } }
  function save(s) {
    try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch (e) {}
    if (!s) setRole(null);
  }
  var ROLE = "si.role";
  function getRole() { try { return localStorage.getItem(ROLE); } catch (e) { return null; } }
  function setRole(r) {
    try { r ? localStorage.setItem(ROLE, r) : localStorage.removeItem(ROLE); } catch (e) {}
    decorate();
  }
  function fromAuth(d) {
    if (!d || !d.access_token) return null;
    return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600)), user: d.user };
  }

  function SIError(message, code) { var e = new Error(message); e.code = code; return e; }

  async function http(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ apikey: KEY, "Content-Type": "application/json" }, opts.headers || {});
    var res = await fetch(URL + path, { method: opts.method || "GET", headers: headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    var text = await res.text(), data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      var msg = (data && (data.msg || data.message || data.error_description || data.error)) || ("Request failed (" + res.status + ")");
      throw SIError(typeof msg === "string" ? msg : "Request failed", (data && (data.code || data.error_code)) || res.status);
    }
    return data;
  }

  var refreshing = null;
  async function session() {
    var s = load();
    if (!s) return null;
    if (s.expires_at - 60 > Date.now() / 1000) return s;
    if (!refreshing) {
      refreshing = http("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: s.refresh_token } })
        .then(function (d) { var n = fromAuth(d); save(n); return n; })
        .catch(function () { save(null); return null; })
        .finally(function () { refreshing = null; });
    }
    return refreshing;
  }

  async function authed(path, opts) {
    var s = await session();
    if (!s) throw SIError("Please log in again.", "no_session");
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + s.access_token }, opts.headers || {});
    return http(path, opts);
  }
  function rest(path, opts) { return authed("/rest/v1/" + path, opts); }
  function rpc(fn, args) { return rest("rpc/" + fn, { method: "POST", body: args || {} }); }

  // ---------- friendly errors ----------
  function friendly(e) {
    if (e && e.code === "user") return e.message;
    var m = String((e && e.message) || e || "");
    if (/already registered|already been registered|user_already_exists/i.test(m)) return "An account with this email already exists. Log in instead.";
    if (/invalid login credentials/i.test(m)) return "That email and password don't match. Try again.";
    if (/email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for the link.";
    if (/password should be|weak password/i.test(m)) return "Choose a stronger password (at least 8 characters).";
    if (/duplicate key|bids_project_id_contractor_id_key/i.test(m)) return "You've already sent a proposal for this project.";
    if (/row-level security/i.test(m)) return "Your account can't do that yet. An active membership is required to bid.";
    if (/failed to fetch|network/i.test(m)) return "Can't reach the server. Check your connection and try again.";
    if (/log in again/i.test(m)) return m;
    return "Something went wrong. Please try again.";
  }

  // ---------- auth ----------
  async function signUp(email, password, meta) {
    // The confirmation email links back to the login page for this account type
    var back = window.location.origin + ((meta && meta.role === "contractor") ? "/contractors" : "/list-project") + "?login=1";
    var d = await http("/auth/v1/signup?redirect_to=" + encodeURIComponent(back), { method: "POST", body: { email: email.trim().toLowerCase(), password: password, data: meta || {} } });
    var s = fromAuth(d);
    if (s) { save(s); setRole(meta && meta.role === "contractor" ? "contractor" : "owner"); return { session: s, needsConfirm: false }; }
    // Supabase returns a fake user with no identities when the email is already taken (and confirmations are on)
    var user = d && (d.user || d);
    if (user && Array.isArray(user.identities) && user.identities.length === 0) throw SIError("User already registered", "user_already_exists");
    return { session: null, needsConfirm: true };
  }
  async function signIn(email, password) {
    var d = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email: email.trim().toLowerCase(), password: password } });
    var s = fromAuth(d); save(s); return s;
  }
  async function signOut() {
    var s = load();
    save(null);
    if (s) { try { await http("/auth/v1/logout", { method: "POST", headers: { Authorization: "Bearer " + s.access_token } }); } catch (e) {} }
  }
  async function resetPassword(email) {
    await http("/auth/v1/recover", { method: "POST", body: { email: email.trim().toLowerCase() } });
  }

  // ---------- account ----------
  async function me() {
    var s = await session();
    if (!s) return null;
    var id = s.user.id;
    var rows = await rest("profiles?select=*&id=eq." + id);
    var profile = rows[0] || null, contractor = null;
    if (profile) setRole(profile.role);
    if (profile && profile.role === "contractor") {
      var c = await rest("contractors?select=*&id=eq." + id);
      contractor = c[0] || null;
    }
    return { id: id, email: s.user.email, profile: profile, contractor: contractor };
  }
  function isActive(contractor) { return !!contractor && ["active", "trialing"].indexOf(contractor.subscription_status) !== -1; }

  // ---------- payments (Stripe via Supabase functions) ----------
  async function fn(name) {
    var d = await authed("/functions/v1/" + name, { method: "POST", body: {} });
    if (!d || !d.url) throw SIError((d && d.error) || "Payment service unavailable");
    return d.url;
  }
  async function startCheckout() { window.location.href = await fn("create-checkout"); }

  // ---------- job payments + contractor payouts (function: job-payments) ----------
  async function jobFn(body) {
    try { return await authed("/functions/v1/job-payments", { method: "POST", body: body }); }
    catch (e) { if (e && e.message && !/^Request failed/.test(e.message) && e.code !== "no_session") throw SIError(e.message, "user"); throw e; }
  }
  async function payJob(projectId, method) {
    var d = await jobFn({ action: "pay", project_id: projectId, method: method });
    window.location.href = d.url;
  }
  async function payoutSetup() { var d = await jobFn({ action: "connect_link" }); window.location.href = d.url; }
  async function payoutDashboard() { var d = await jobFn({ action: "connect_dashboard" }); window.location.href = d.url; }
  function payoutStatus() { return jobFn({ action: "connect_status" }); }
  // Stripe's standard US rates (exact fee is taken from Stripe at payment time)
  function estimateFees(amount) {
    amount = Math.max(0, Number(amount) || 0);
    var bank = Math.min(Math.round(amount * 0.8) / 100, 5), card = amount ? Math.round(amount * 2.9 + 30) / 100 : 0;
    return { amount: amount, bankFee: bank, bankNet: Math.max(0, amount - bank), cardFee: card, cardNet: Math.max(0, amount - card) };
  }
  function money(n) {
    n = Number(n) || 0;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  async function openBillingPortal() { window.location.href = await fn("billing-portal"); }
  // After Stripe Checkout, the webhook updates the membership within a few seconds.
  async function waitForMembership(maxMs) {
    var until = Date.now() + (maxMs || 15000);
    while (Date.now() < until) {
      var m = await me();
      if (m && isActive(m.contractor)) return m;
      await new Promise(function (r) { setTimeout(r, 1500); });
    }
    return me();
  }

  // ---------- formatting helpers ----------
  function ago(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return mins <= 1 ? "just now" : mins + " minutes ago";
    var h = Math.round(mins / 60); if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.round(h / 24); if (d === 1) return "yesterday"; if (d < 7) return d + " days ago";
    var w = Math.round(d / 7); if (w < 5) return w + (w === 1 ? " week ago" : " weeks ago");
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function shortDate(v) { return v ? new Date(v + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "TBD"; }
  function longDate(v) { return v ? new Date(v + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; }
  function modelName(brand, model) {
    var ok = function (x) { return x && x !== "Other / not listed"; };
    if (ok(model)) return ok(brand) && model.indexOf(brand) !== 0 ? brand + " " + model : model;
    return ok(brand) ? brand : "";
  }
  function place(city, zip, st) { return [city, [st, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "); }

  // ---------- contractor ----------
  async function openProjects() {
    var rows = await rpc("open_projects");
    return rows.map(function (p) {
      var name = p.model && p.model !== "Other / not listed" ? p.model : (p.sauna_type || "Sauna");
      return {
        id: p.id,
        title: name + " install",
        type: p.sauna_type || "Sauna",
        model: modelName(p.brand, p.model) || "Model not listed",
        size: [p.capacity, p.power].filter(Boolean).join(" · ") + (p.needs_electrician ? " · electrician needed" : ""),
        city: p.city || "", st: "", zip: p.zip,
        place: place(p.city, p.zip),
        budget: p.install_date ? "Install by " + longDate(p.install_date) : "Flexible timing",
        posted: "Posted " + ago(p.created_at),
        proposals: p.bid_count,
        distance: p.my_bid ? "you've bid" : "open for proposals",
        notes: p.notes == null ? "Site notes unlock with your membership." : (p.notes || "No site notes added."),
        myBid: p.my_bid
      };
    });
  }
  async function sendBid(projectId, amount, startDate, note) {
    var s = await session();
    return rest("bids", { method: "POST", headers: { Prefer: "return=representation" },
      body: { project_id: projectId, contractor_id: s.user.id, amount: amount, start_date: startDate || null, note: note || null } });
  }
  async function myBids() {
    var s = await session();
    var rows = await rest("bids?select=id,amount,start_date,note,status,created_at,project:projects(id,city,zip,sauna_type,model,status,awarded_bid_id),payment:payments(status,amount_cents,stripe_fee_cents,transfer_cents,transfer_id)&contractor_id=eq." + s.user.id + "&order=created_at.desc");
    return rows.map(function (b) {
      var p = b.project || {}, status, note;
      if (b.status === "accepted") {
        status = p.status === "completed" ? "Completed" : "Hired";
        note = p.status === "completed" ? "Homeowner marked the project completed." : "You were hired. Schedule directly with the homeowner.";
      } else if (b.status === "declined") { status = "Declined"; note = p.awarded_bid_id ? "Homeowner chose another installer." : "Homeowner declined this proposal."; }
      else if (b.status === "withdrawn") { status = "Declined"; note = "You withdrew this proposal."; }
      else { status = "Sent"; note = "Waiting on the homeowner to review your proposal."; }
      var pay = Array.isArray(b.payment) ? b.payment[0] : b.payment, payoutText = "", payoutFg = "";
      if (pay && pay.status === "succeeded" && pay.transfer_id) { status = "Paid"; payoutText = "Payout " + money(pay.transfer_cents / 100) + " sent"; payoutFg = "#3E7A4E"; note = "Paid. Stripe fee " + money((pay.stripe_fee_cents || 0) / 100) + " deducted."; }
      else if (pay && pay.status === "succeeded") { status = "Paid"; payoutText = "Paid · payout pending"; payoutFg = "#B07C1E"; note = "The homeowner paid. Your payout is sent once payouts are set up."; }
      else if (pay && pay.status === "processing") { payoutText = "Bank payment processing"; payoutFg = "#B07C1E"; }
      else if (pay && pay.status === "failed") { payoutText = "Homeowner payment failed"; payoutFg = "#C0492F"; }
      else if (pay && (pay.status === "refunded" || pay.status === "disputed")) { payoutText = pay.status === "refunded" ? "Refunded" : "Payment disputed"; payoutFg = "#C0492F"; }
      else if (status === "Completed") { payoutText = "Awaiting homeowner payment"; payoutFg = "#B07C1E"; }
      else if (status === "Hired") { payoutText = "Paid after completion"; }
      var name = p.model && p.model !== "Other / not listed" ? p.model : (p.sauna_type || "Sauna");
      return { id: b.id, title: name + " install", meta: place(p.city, p.zip) + " · sent " + ago(b.created_at), amount: Number(b.amount), start: shortDate(b.start_date), status: status, note: note, payoutText: payoutText, payoutFg: payoutFg };
    });
  }
  async function saveServiceAreas(list) {
    var s = await session(); if (!s) return;
    await rest("contractors?id=eq." + s.user.id, { method: "PATCH", body: { service_areas: list } });
  }

  // ---------- homeowner ----------
  async function createProject(f) {
    var s = await session();
    var rows = await rest("projects", { method: "POST", headers: { Prefer: "return=representation" }, body: {
      owner_id: s.user.id, sauna_type: f.type || null, brand: f.make || null, model: f.model || null, capacity: f.seats || null,
      power: f.power || null, needs_electrician: !!f.elec, install_date: f.date || null, notes: f.notes || null, city: f.city, zip: f.pzip } });
    return rows[0];
  }
  async function myProject() {
    var s = await session();
    var rows = await rest("projects?select=*&owner_id=eq." + s.user.id + "&status=neq.cancelled&order=created_at.desc&limit=1");
    var p = rows[0];
    if (!p) return null;
    var bids = await rest("bids?select=id,amount,start_date,note,status,created_at,contractor_id,contractor:contractors(business_name,city,state)&project_id=eq." + p.id + "&status=neq.withdrawn&order=created_at.asc");
    var ids = bids.map(function (b) { return b.contractor_id; });
    var stats = {};
    if (ids.length) {
      var rv = await rest("reviews?select=contractor_id,rating&contractor_id=in.(" + ids.join(",") + ")");
      rv.forEach(function (r) { var x = stats[r.contractor_id] || (stats[r.contractor_id] = { n: 0, sum: 0 }); x.n++; x.sum += r.rating; });
    }
    var proposals = bids.map(function (b) {
      var c = b.contractor || {}, st = stats[b.contractor_id];
      var rating = st ? (st.sum / st.n).toFixed(1) + " ★ (" + st.n + (st.n === 1 ? " review)" : " reviews)") : "New on saunainstall";
      return { id: b.id, company: c.business_name || "Independent installer", meta: [place(c.city, "", c.state), rating, "sent " + ago(b.created_at)].filter(Boolean).join(" · "),
        amount: Number(b.amount), start: shortDate(b.start_date), rating: "Verified contractor", note: b.note || "No additional notes.", status: b.status, contractorId: b.contractor_id };
    });
    var review = null;
    if (p.status === "completed") { var rr = await rest("reviews?select=rating&project_id=eq." + p.id); review = rr[0] || null; }
    var pays = await rest("payments?select=status,method,amount_cents&project_id=eq." + p.id);
    return { project: p, proposals: proposals, review: review, payment: pays[0] || null };
  }
  function acceptBid(id) { return rpc("accept_bid", { p_bid: id }); }
  function declineBid(id) { return rpc("decline_bid", { p_bid: id }); }
  async function completeAndReview(projectId, contractorId, rating, text) {
    await rpc("complete_project", { p_project: projectId });
    var s = await session();
    await rest("reviews", { method: "POST", body: { project_id: projectId, owner_id: s.user.id, contractor_id: contractorId, rating: rating, body: text || null } });
  }


  // ---------- header: logged-in state ----------
  // While logged in, hide every "log in" link/menu and show one "My proposals" (owner) or "My bids" (contractor) link
  // in the same places: desktop header, phone header menu and phone bottom bar.
  var LOGIN_HREFS = ["/list-project#login", "/contractors#login"];
  var LOGIN_TEXT = /^(sauna owner log in|contractor log in|my proposals|my bids)$/i;
  function activeRole() { return load() ? getRole() : null; }
  var decorating = false;
  var LOGOUT_STYLE = "background:none;border:0;padding:8px 4px;margin:0 2px;font:inherit;font-size:13.5px;font-weight:600;color:#6B6253;" +
    "text-decoration:underline;text-underline-offset:3px;cursor:pointer;white-space:nowrap;align-self:center;";
  function logoutButton(role) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Log out";
    b.setAttribute("data-si-added", role);
    b.setAttribute("data-si-logout", "");
    b.setAttribute("aria-label", "Log out");
    b.setAttribute("style", LOGOUT_STYLE);
    return b;
  }
  function decorate() {
    if (decorating || typeof document === "undefined" || !document.body) return;
    decorating = true;
    try {
      var role = activeRole();
      var root = document.documentElement;
      if (role) root.setAttribute("data-si", role); else root.removeAttribute("data-si");
      if (!document.getElementById("si-style")) {
        var st = document.createElement("style");
        st.id = "si-style";
        st.textContent = "html[data-si] [data-si-hide]{display:none!important}html:not([data-si]) [data-si-added]{display:none!important}" +
          "[data-si-phone]{display:none!important}@media (max-width:760px){[data-si-phone]{display:flex!important}}" +
          // narrow phones: tighten the header so the logo, Log out and My proposals stay on one line
          "@media (max-width:400px){header [data-si-phone][data-si-logout]{padding:8px 2px!important;margin-right:-14px!important;font-size:13px!important}" +
          "header a[data-si-phone]{padding:0 9px!important;font-size:14px!important}}" +
          "@media (max-width:374px){html[data-si] header a[href='/']{font-size:17px!important;gap:8px!important}}";
        (document.head || root).appendChild(st);
      }
      var label = role === "contractor" ? "My bids" : "My proposals";
      var href = role === "contractor" ? "/contractors?login=1" : "/list-project?login=1";
      // remove links added for a different state
      Array.prototype.forEach.call(document.querySelectorAll("[data-si-added]"), function (a) {
        if (!role || a.getAttribute("data-si-added") !== role) a.remove();
      });
      if (!role) return;
      var header = document.querySelector("header");
      var scopes = [header].concat(Array.prototype.slice.call(document.querySelectorAll("details"))).filter(Boolean);
      // desktop header: hide log-in links/buttons (and the page's own My proposals/My bids button), add ours
      if (header) {
        var desk = null;
        Array.prototype.forEach.call(header.querySelectorAll("a, button"), function (el) {
          if (el.closest("details") || el.hasAttribute("data-si-added")) return;
          var txt = (el.textContent || "").trim();
          if (LOGIN_HREFS.indexOf(el.getAttribute("href")) !== -1 || LOGIN_TEXT.test(txt)) {
            el.setAttribute("data-si-hide", "");
            if (!desk && el.tagName === "A") desk = el;
            if (!desk) desk = el;
          }
        });
        if (desk && !desk.parentNode.querySelector("[data-si-added]")) {
          var a = document.createElement("a");
          a.setAttribute("href", href);
          a.setAttribute("data-si-added", role);
          a.setAttribute("style", (desk.getAttribute("style") || "").replace(/display\s*:[^;]*;?/g, "") + ";display:inline-flex;align-items:center;");
          a.textContent = label;
          desk.parentNode.insertBefore(a, desk);
          desk.parentNode.insertBefore(logoutButton(role), a.nextSibling);
        }
      }
      // phone menus ("Log in" dropdowns): hide the dropdown, show a direct link styled like its button
      Array.prototype.forEach.call(document.querySelectorAll("details"), function (d) {
        var sum = d.querySelector("summary");
        if (!sum || !/log in/i.test(sum.textContent || "")) return;
        d.setAttribute("data-si-hide", "");
        var next = d.nextElementSibling;
        if (next && next.getAttribute("data-si-added") === role) return;
        var a = document.createElement("a");
        a.setAttribute("href", href);
        a.setAttribute("data-si-added", role);
        var dStyle = d.getAttribute("style") || "";
        a.setAttribute("style", (sum.getAttribute("style") || "") + ";text-decoration:none;" + (dStyle.indexOf("margin-left") !== -1 ? "margin-left:auto;" : ""));
        // header menu only exists on phones (the site's 760px breakpoint); the bottom bar is already phone-only
        if (/display\s*:\s*none/.test(d.getAttribute("style") || "")) a.setAttribute("data-si-phone", "");
        a.innerHTML = sum.innerHTML;
        // replace the "Log in" text node, keep the icon
        Array.prototype.forEach.call(a.childNodes, function (n) { if (n.nodeType === 3 && /log in/i.test(n.textContent)) n.textContent = label; });
        if (!/my (proposals|bids)/i.test(a.textContent)) a.insertBefore(document.createTextNode(label), a.firstChild);
        // drop the dropdown arrow that followed "Log in" (this is a direct link now); keep leading icons
        var seenText = false;
        Array.prototype.slice.call(a.childNodes).forEach(function (n) {
          if (n.nodeType === 3 && n.textContent.trim()) seenText = true;
          else if (seenText && n.nodeType === 1 && n.tagName.toLowerCase() === "svg") n.remove();
        });
        d.parentNode.insertBefore(a, d.nextSibling);
        if (a.hasAttribute("data-si-phone")) {
          var lo = logoutButton(role);
          lo.setAttribute("data-si-phone", "");
          if (a.style.marginLeft === "auto") { a.style.marginLeft = "0"; lo.style.marginLeft = "auto"; }
          d.parentNode.insertBefore(lo, a);
        }
      });
    } finally { decorating = false; }
  }
  if (typeof window !== "undefined") {
    var schedule = function () { (window.requestAnimationFrame || setTimeout)(decorate); };
    var watch = function () {
      decorate();
      try { new MutationObserver(function () { if (!decorating) schedule(); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch); else watch();
    window.addEventListener("storage", function (e) { if (e.key === STORE || e.key === ROLE) decorate(); });
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest && e.target.closest("[data-si-logout]");
      if (!t) return;
      e.preventDefault();
      t.disabled = true;
      signOut().then(function () { window.location.href = "/"; });
    });
    // sessions from before the account type was cached: look it up once
    if (load() && !getRole()) setTimeout(function () { me().catch(function () {}); }, 0);
  }

  window.SI = {
    session: session, signUp: signUp, signIn: signIn, signOut: signOut, resetPassword: resetPassword,
    me: me, role: activeRole, isActive: isActive, friendly: friendly, wantsLogin: wantsLogin,
    startCheckout: startCheckout, openBillingPortal: openBillingPortal, waitForMembership: waitForMembership,
    openProjects: openProjects, sendBid: sendBid, myBids: myBids, saveServiceAreas: saveServiceAreas,
    createProject: createProject, myProject: myProject, acceptBid: acceptBid, declineBid: declineBid, completeAndReview: completeAndReview,
    longDate: longDate, ago: ago,
    payJob: payJob, payoutSetup: payoutSetup, payoutDashboard: payoutDashboard, payoutStatus: payoutStatus,
    estimateFees: estimateFees, money: money
  };
})();
