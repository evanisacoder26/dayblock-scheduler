// Dayblock on GitHub Pages: answers the same /api/... requests the Node server does,
// using Supabase (accounts + database) and the "dayblock-api" edge function (email codes,
// account changes, AI). The pages keep calling fetch("/api/...") and don't need to know.
// Needs window.supabase (supabase-js) and window.DAYBLOCK_SUPABASE = { url, anonKey }.
(() => {
  "use strict";
  const cfg = window.DAYBLOCK_SUPABASE || {};
  if (!window.supabase || !cfg.url || !cfg.anonKey) { console.error("Dayblock: Supabase is not configured."); return; }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "dayblock-auth" } });
  window.dayblockSupabase = sb;
  const DEVICE_KEY = "dayblock.trustedDevice";

  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const fail = (status, message) => { throw new ApiError(status, message); };

  async function session() { const { data } = await sb.auth.getSession(); return data.session; }
  async function fn(action, body = {}) {
    const s = await session();
    if (!s) fail(401, "Your session has ended. Log in again.");
    let r;
    try {
      r = await fetch(`${cfg.url}/functions/v1/dayblock-api`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.access_token}`, apikey: cfg.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
    } catch { fail(502, "Couldn't reach the server. Check your connection."); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) fail(r.status, j.error || `Request failed (${r.status}).`);
    return { status: r.status, ...j };
  }
  let verifiedCache = null;
  async function isVerified() {
    if (verifiedCache !== null) return verifiedCache;
    try { verifiedCache = (await fn("status")).verified === true; } catch { verifiedCache = false; }
    return verifiedCache;
  }
  const toUser = (u) => ({ id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || u.email.split("@")[0], createdAt: u.created_at });
  async function currentUser() {
    const s = await session();
    if (!s) fail(401, "Not logged in.");
    if (!(await isVerified())) fail(401, "Enter your email code to continue.");
    return s.user;
  }
  function describeUA(ua = navigator.userAgent) {
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${browser} on ${os}` : browser;
  }
  const readDevice = () => { try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || "null"); } catch { return null; } };
  const EMPTY_PLAN = { tasks: [], series: [], focus: false, dump: "" };

  async function getPlan(userId) {
    const { data, error } = await sb.from("plans").select("data").eq("user_id", userId).maybeSingle();
    if (error) fail(500, "Couldn't load your plan.");
    return (data && data.data) || EMPTY_PLAN;
  }

  /* ---------- routes (same shapes as server.mjs) ---------- */
  async function handle(route, method, body) {
    switch (`${method} ${route}`) {
      case "GET /api/me": {
        const u = await currentUser();
        return [200, { user: toUser(u), ai: "Gemini" }];
      }
      case "POST /api/auth/signup": {
        const { name, email, password } = body;
        if (typeof name !== "string" || !name.trim()) fail(400, "Enter your name.");
        const { data, error } = await sb.auth.signUp({ email: String(email).trim().toLowerCase(), password, options: { data: { name: name.trim().slice(0, 60) } } });
        if (error) fail(/registered|exists/i.test(error.message) ? 409 : 400, /registered|exists/i.test(error.message) ? "An account with this email already exists. Log in instead." : error.message);
        if (!data.session) {
          // Supabase returns a fake success for an existing email when confirmations are on.
          fail(409, "An account with this email may already exist. Try logging in.");
        }
        verifiedCache = null;
        const r = await fn("2fa-start", {});
        return [202, r];
      }
      case "POST /api/auth/login": {
        const { error } = await sb.auth.signInWithPassword({ email: String(body.email || "").trim().toLowerCase(), password: String(body.password || "") });
        if (error) fail(/rate|too many/i.test(error.message) ? 429 : 401, /rate|too many/i.test(error.message) ? "Too many attempts. Wait a few minutes and try again." : "Email or password is incorrect.");
        verifiedCache = null;
        const s = await session();
        const dev = readDevice();
        const r = await fn("2fa-start", { deviceToken: dev && dev.userId === s.user.id ? dev.token : null });
        if (r.verified) { verifiedCache = true; return [200, { user: toUser(s.user) }]; }
        return [202, r];
      }
      case "POST /api/auth/verify": {
        const r = await fn("2fa-verify", { challenge: body.challenge, code: body.code, trustDevice: Boolean(body.trustDevice), deviceLabel: describeUA() });
        const s = await session();
        if (r.deviceToken) localStorage.setItem(DEVICE_KEY, JSON.stringify({ userId: s.user.id, token: r.deviceToken }));
        verifiedCache = true;
        return [200, { user: toUser(s.user) }];
      }
      case "POST /api/auth/resend":
        return [200, await fn("2fa-resend", { challenge: body.challenge })];
      case "POST /api/auth/logout":
        await sb.auth.signOut({ scope: "local" });
        verifiedCache = null;
        return [200, { ok: true }];

      case "GET /api/data": {
        const u = await currentUser();
        return [200, await getPlan(u.id)];
      }
      case "PUT /api/data": {
        const u = await currentUser();
        const plan = { tasks: Array.isArray(body.tasks) ? body.tasks.slice(0, 3000) : [], series: Array.isArray(body.series) ? body.series.slice(0, 200) : [], focus: Boolean(body.focus), dump: typeof body.dump === "string" ? body.dump.slice(0, 8000) : "" };
        const { error } = await sb.from("plans").upsert({ user_id: u.id, data: plan, updated_at: new Date().toISOString() });
        if (error) fail(500, "Couldn't save your plan.");
        return [200, { ok: true }];
      }

      case "POST /api/parse": return [200, await fn("parse", body)];
      case "POST /api/suggest-event": return [200, await fn("suggest-event", body)];
      case "POST /api/advice": return [200, await fn("advice", body)];
      case "POST /api/chat": return [200, await fn("chat", body)];

      case "GET /api/account": {
        const u = await currentUser();
        const s = await session();
        const { data: devs } = await sb.from("trusted_devices").select("label, created_at, expires_at").order("created_at", { ascending: false });
        return [200, {
          user: toUser(u),
          sessions: [{ id: "current", current: true, created: s.user.last_sign_in_at ? Date.parse(s.user.last_sign_in_at) : null, lastSeen: Date.now(), device: describeUA() }],
          otherSessionsUnknown: true, // Supabase doesn't list other devices; offer "log out everywhere else" instead
          devices: (devs || []).map((d) => ({ current: false, created: Date.parse(d.created_at), expires: Date.parse(d.expires_at), device: d.label || "Unknown device" })),
          emailMode: "resend",
        }];
      }
      case "POST /api/account/name": {
        await currentUser();
        const name = String(body.name || "").trim();
        if (!name) fail(400, "Enter your name.");
        if (name.length > 60) fail(400, "Keep your name under 60 characters.");
        const { data, error } = await sb.auth.updateUser({ data: { name } });
        if (error) fail(400, "Couldn't update your name.");
        return [200, { user: toUser(data.user) }];
      }
      case "POST /api/account/email":
        return [202, await fn("email-change-start", { email: body.email, password: body.password })];
      case "POST /api/account/email/verify": {
        await fn("email-change-verify", { challenge: body.challenge, code: body.code });
        const { data } = await sb.auth.refreshSession();
        return [200, { user: toUser(data.user || (await session()).user) }];
      }
      case "POST /api/auth/password": {
        await fn("password-change", { current: body.current, next: body.next });
        localStorage.removeItem(DEVICE_KEY);
        return [200, { ok: true }];
      }
      case "POST /api/account/sessions/revoke-others": {
        await currentUser();
        await sb.auth.signOut({ scope: "others" });
        const r = await handle("/api/account", "GET", {});
        return [200, { sessions: r[1].sessions }];
      }
      case "POST /api/account/sessions/revoke":
        fail(400, "Use “Log out of all other devices” instead.");
        break;
      case "POST /api/account/devices/forget": {
        const u = await currentUser();
        await sb.from("trusted_devices").delete().eq("user_id", u.id);
        localStorage.removeItem(DEVICE_KEY);
        return [200, { devices: [] }];
      }
      case "GET /api/account/export": {
        const u = await currentUser();
        return [200, { exportedAt: new Date().toISOString(), account: toUser(u), planner: await getPlan(u.id) }];
      }
      case "POST /api/account/delete": {
        await fn("delete-account", { password: body.password, confirm: body.confirm });
        localStorage.removeItem(DEVICE_KEY);
        await sb.auth.signOut({ scope: "local" }).catch(() => {});
        return [200, { ok: true }];
      }
    }
    fail(404, "Not found");
  }

  /* ---------- route the page's fetch("/api/...") calls here ---------- */
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = url.pathname.indexOf("/api/");
    if (url.origin !== location.origin || at < 0) return realFetch(input, init);
    const route = url.pathname.slice(at);
    const method = String(init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    try {
      const [status, data] = await handle(route, method, body);
      return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      if (!(e instanceof ApiError)) console.error(e);
      return new Response(JSON.stringify({ error: e.message || "Something went wrong." }), { status, headers: { "Content-Type": "application/json" } });
    }
  };

  // "Download my data" is a plain link on the localhost version; build the file here instead.
  document.addEventListener("click", async (e) => {
    const a = e.target.closest && e.target.closest('a[href$="api/account/export"]');
    if (!a) return;
    e.preventDefault();
    const r = await window.fetch("/api/account/export");
    if (!r.ok) return;
    const blob = new Blob([JSON.stringify(await r.json(), null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `dayblock-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  });
})();
