/* saunainstall.com — connects the site to Supabase (accounts, projects, bids) and Stripe (membership).
 * No dependencies. Exposes window.SI. The page logic in contractors.html and list-project.html calls it.
 * The key below is Supabase's public (anon) key: it is safe in the browser; database access rules protect the data. */
(function () {
  "use strict";
  var URL = "https://knpxvuicsjlhruqpdmzy.supabase.co";
  var KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtucHh2dWljc2psaHJ1cXBkbXp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODc1NDAsImV4cCI6MjEwODI2MzU0MH0._kxyBhvhERQBFbTir84UYoecON5cLMipUrBK3ZUORvE";
  var STORE = "si.session";

  // ---------- session storage ----------
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; } }
  function save(s) { try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch (e) {} }
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
    var d = await http("/auth/v1/signup", { method: "POST", body: { email: email.trim().toLowerCase(), password: password, data: meta || {} } });
    var s = fromAuth(d);
    if (s) { save(s); return { session: s, needsConfirm: false }; }
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
    var rows = await rest("bids?select=id,amount,start_date,note,status,created_at,project:projects(id,city,zip,sauna_type,model,status,awarded_bid_id)&contractor_id=eq." + s.user.id + "&order=created_at.desc");
    return rows.map(function (b) {
      var p = b.project || {}, status, note;
      if (b.status === "accepted") {
        status = p.status === "completed" ? "Completed" : "Hired";
        note = p.status === "completed" ? "Homeowner marked the project completed." : "You were hired. Schedule directly with the homeowner.";
      } else if (b.status === "declined") { status = "Declined"; note = p.awarded_bid_id ? "Homeowner chose another installer." : "Homeowner declined this proposal."; }
      else if (b.status === "withdrawn") { status = "Declined"; note = "You withdrew this proposal."; }
      else { status = "Sent"; note = "Waiting on the homeowner to review your proposal."; }
      var name = p.model && p.model !== "Other / not listed" ? p.model : (p.sauna_type || "Sauna");
      return { id: b.id, title: name + " install", meta: place(p.city, p.zip) + " · sent " + ago(b.created_at), amount: Number(b.amount), start: shortDate(b.start_date), status: status, note: note };
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
    return { project: p, proposals: proposals, review: review };
  }
  function acceptBid(id) { return rpc("accept_bid", { p_bid: id }); }
  function declineBid(id) { return rpc("decline_bid", { p_bid: id }); }
  async function completeAndReview(projectId, contractorId, rating, text) {
    await rpc("complete_project", { p_project: projectId });
    var s = await session();
    await rest("reviews", { method: "POST", body: { project_id: projectId, owner_id: s.user.id, contractor_id: contractorId, rating: rating, body: text || null } });
  }

  window.SI = {
    session: session, signUp: signUp, signIn: signIn, signOut: signOut, resetPassword: resetPassword,
    me: me, isActive: isActive, friendly: friendly,
    startCheckout: startCheckout, openBillingPortal: openBillingPortal, waitForMembership: waitForMembership,
    openProjects: openProjects, sendBid: sendBid, myBids: myBids, saveServiceAreas: saveServiceAreas,
    createProject: createProject, myProject: myProject, acceptBid: acceptBid, declineBid: declineBid, completeAndReview: completeAndReview,
    longDate: longDate, ago: ago
  };
})();
