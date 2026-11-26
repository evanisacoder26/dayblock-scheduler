// Dayblock server: serves the app and proxies AI calls so API keys stay on the server.
// Put GEMINI_API_KEY or ANTHROPIC_API_KEY in a .env file next to this one, then `npm start`.
// If both are set, Gemini is used unless AI_PROVIDER=claude.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  createAuth, createRateLimiter, validateSignup, validateEmail, validatePassword,
  parseCookies, sessionCookie, deviceCookie, clearCookie, SESSION_COOKIE, DEVICE_COOKIE,
} from "./auth.mjs";
import { createMailer, maskEmail } from "./mailer.mjs";
import { CATEGORIES, PRIORITIES, TASKS_SCHEMA, PARSE_SYSTEM, ADVICE_SYSTEM, EVENT_SCHEMA, EVENT_SYSTEM, CHAT_SCHEMA, CHAT_RULES } from "./ai-prompts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = "claude-opus-5-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
// Tried in order when the main model is overloaded or times out.
const GEMINI_BACKUPS = ["gemini-flash-latest", "gemini-3.5-flash-lite"].filter((m) => m !== GEMINI_MODEL);
const MAX_BODY = 64 * 1024;

const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const hasGemini = Boolean(process.env.GEMINI_API_KEY);
const PROVIDER = (process.env.AI_PROVIDER || (hasGemini ? "gemini" : hasClaude ? "claude" : "none")).toLowerCase();
const hasCredentials = (PROVIDER === "gemini" && hasGemini) || (PROVIDER === "claude" && hasClaude);
if (!hasCredentials) console.warn("No AI key found (GEMINI_API_KEY or ANTHROPIC_API_KEY). The app will use its built-in parser.");
const client = hasClaude ? new Anthropic() : null; // reads ANTHROPIC_API_KEY from the environment




/* ---------- Gemini (REST) ---------- */
class GeminiError extends Error {
  constructor(status, message) { super(message); this.geminiStatus = status; }
}

async function geminiGenerate(opts) {
  const models = [GEMINI_MODEL, ...GEMINI_BACKUPS];
  let lastErr;
  for (const model of models) {
    try {
      return await geminiCall(model, opts);
    } catch (e) {
      const retryable = e instanceof GeminiError && (e.geminiStatus === 503 || e.geminiStatus === 500 || e.geminiStatus === 429 || e.geminiStatus === 0);
      if (!retryable) throw e;
      lastErr = e;
      console.warn(`${model} unavailable (${e.message.slice(0, 80)}); trying the next model`);
    }
  }
  throw lastErr;
}

async function geminiCall(model, { system, user, schema, maxOutputTokens = 8192, turns = null }) {
  const generationConfig = { maxOutputTokens };
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = schema;
  }
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns
          ? turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }))
          : [{ role: "user", parts: [{ text: user }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new GeminiError(0, "Couldn't reach Gemini.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GeminiError(res.status, json?.error?.message || `Gemini error (${res.status}).`);
  const cand = json.candidates?.[0];
  if (!cand) throw httpError(422, "Gemini declined to process this request.");
  if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") throw httpError(422, "Gemini declined to process these notes.");
  if (cand.finishReason === "MAX_TOKENS") throw httpError(502, "The notes were too long to process in one go. Try splitting them.");
  return (cand.content?.parts || []).map((p) => p.text || "").join("");
}


async function parseTasks(text, date) {
  const user = `Planner date: ${date}\n\nNotes:\n${text}`;
  if (PROVIDER === "gemini") {
    const out = await geminiGenerate({ system: PARSE_SYSTEM, user, schema: TASKS_SCHEMA });
    return sanitizeTasks(JSON.parse(out).tasks);
  }
  return parseTasksClaude(user);
}

async function getAdvice(summary) {
  if (PROVIDER === "gemini") return (await geminiGenerate({ system: ADVICE_SYSTEM, user: summary, maxOutputTokens: 2048 })).trim();
  return getAdviceClaude(summary);
}

/* ---------- Event suggestions (for the New event form) ---------- */


async function suggestEvent({ title, notes, date, schedule, earliest }) {
  const user = `Date: ${date}\nEarliest allowed start: ${earliest}\n\nNew event: ${title}${notes ? `\nNotes: ${notes}` : ""}\n\nAlready scheduled:\n${schedule || "(nothing)"}`;
  let out;
  if (PROVIDER === "gemini") {
    out = await geminiGenerate({ system: EVENT_SYSTEM, user, schema: EVENT_SCHEMA, maxOutputTokens: 2048 });
  } else {
    out = await claudeJson({ system: EVENT_SYSTEM, user, schema: EVENT_SCHEMA, maxTokens: 4000 });
  }
  const e = JSON.parse(out);
  return {
    title: String(e.title || title).slice(0, 120),
    minutes: Math.min(480, Math.max(15, Math.round((Number(e.minutes) || 30) / 15) * 15)),
    category: CATEGORIES.includes(e.category) ? e.category : "Deep Work",
    priority: PRIORITIES.includes(e.priority) ? e.priority : "Medium",
    start: typeof e.start === "string" && /^\d{1,2}:\d{2}$/.test(e.start) ? e.start : null,
    reason: String(e.reason || "").slice(0, 300),
  };
}

/* ---------- Chat assistant (review + edit the schedule) ---------- */


async function chatTurn({ turns, context }) {
  const system = `${CHAT_RULES}\n\n${context}`;
  const out = PROVIDER === "gemini"
    ? await geminiGenerate({ system, turns, schema: CHAT_SCHEMA, maxOutputTokens: 4096 })
    : await claudeJson({ system, turns, schema: CHAT_SCHEMA, maxTokens: 6000 });
  const j = JSON.parse(out);
  return { reply: String(j.reply || "").slice(0, 3000), actions: Array.isArray(j.actions) ? j.actions.slice(0, 60) : [] };
}

/* ---------- Claude ---------- */
async function claudeJson({ system, user, schema, maxTokens, turns = null }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: turns ? turns.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: t.content })) : [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw httpError(422, "The AI declined to process this request.");
  if (response.stop_reason === "max_tokens") throw httpError(502, "The AI reply was cut off. Try again with less text.");
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function parseTasksClaude(user) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: TASKS_SCHEMA },
    },
    system: PARSE_SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw httpError(422, "The AI declined to process these notes.");
  if (response.stop_reason === "max_tokens") throw httpError(502, "The notes were too long to process in one go. Try splitting them.");
  const out = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(out);
  return sanitizeTasks(parsed.tasks);
}

async function getAdviceClaude(summary) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: ADVICE_SYSTEM,
    messages: [{ role: "user", content: summary }],
  });
  if (response.stop_reason === "refusal") throw httpError(422, "The AI declined to answer.");
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

function sanitizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 40).map((t) => ({
    title: String(t.title || "Untitled task").slice(0, 120),
    minutes: Math.min(480, Math.max(15, Math.round((Number(t.minutes) || 30) / 15) * 15)),
    priority: PRIORITIES.includes(t.priority) ? t.priority : "Medium",
    category: CATEGORIES.includes(t.category) ? t.category : "Deep Work",
    preferredStart: typeof t.preferredStart === "string" && /^\d{1,2}:\d{2}$/.test(t.preferredStart) ? t.preferredStart : null,
  }));
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, "Request is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(httpError(400, "Request body must be JSON.")); }
    });
    req.on("error", reject);
  });
}

/* ---------- Accounts ---------- */
const auth = createAuth(process.env.DATA_DIR || path.join(here, "data"));
// Secure cookies need HTTPS. On Render (which sets RENDER=true) the site is always HTTPS.
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : Boolean(process.env.RENDER);
// Behind a hosting proxy, the visitor's address is in a header instead of the socket.
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === "true" : Boolean(process.env.RENDER);
const loginLimiter = createRateLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const signupLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const aiLimiter = createRateLimiter({ max: 80, windowMs: 60 * 60 * 1000 });
const verifyLimiter = createRateLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
const mailer = createMailer();

// Sends a code and returns what the browser needs for the "enter your code" step.
async function sendCodeOrFail({ to, code, purpose, name }) {
  try { await mailer.sendCode({ to, code, purpose, name }); }
  catch (e) { console.error("Email send failed:", e.message); throw httpError(502, "We couldn't send the code email. Try again in a moment."); }
}
const verifyResponse = (challenge, email) => ({ verify: true, challenge, email: maskEmail(email), devMode: mailer.mode === "dev" });

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...BASE_HEADERS, ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function redirect(res, to) {
  res.writeHead(302, { Location: to, ...BASE_HEADERS });
  res.end();
}
async function sendPage(res, file) {
  let html = await readFile(path.join(here, file), "utf8");
  // index.html is written as an artifact body; wrap it in a document skeleton for local serving.
  if (!/^\s*<!doctype/i.test(html)) {
    html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${html}</body></html>`;
  }
  send(res, 200, html, "text/html; charset=utf-8", { "Content-Security-Policy": PAGE_CSP });
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf.trim();
    const xff = req.headers["x-forwarded-for"];
    // The proxy appends the real client address last; earlier entries can be forged by the client.
    if (typeof xff === "string" && xff) return xff.split(",").map((x) => x.trim()).filter(Boolean).pop();
  }
  return req.socket.remoteAddress || "unknown";
}
const meta = (req) => ({ ua: req.headers["user-agent"] || "" });
const pwLimiter = createRateLimiter({ max: 8, windowMs: 15 * 60 * 1000 }); // password re-checks in settings
// Blocks cross-site form/JS posts: a browser always sends Origin on cross-origin writes.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
const PAGES = ["/dashboard", "/planner", "/settings"];
const safeNext = (n) => (PAGES.includes(n) ? n : "/dashboard");

const CATS_SET = new Set(CATEGORIES), PRI_SET = new Set(PRIORITIES);
function sanitizeUserData(body) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks.slice(0, 3000) : [];
  return {
    focus: Boolean(body?.focus),
    dump: typeof body?.dump === "string" ? body.dump.slice(0, 8000) : "",
    tasks: tasks.filter((t) => t && typeof t.id === "string" && typeof t.title === "string").map((t) => {
      const start = Number.isInteger(t.start) && t.start >= 0 && t.start < 1440 ? t.start : null;
      const date = start != null && typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null;
      return {
        id: t.id.slice(0, 40),
        title: t.title.slice(0, 120),
        notes: typeof t.notes === "string" ? t.notes.slice(0, 1000) : "",
        minutes: Math.min(480, 1440 - (start ?? 0), Math.max(15, Math.round((Number(t.minutes) || 30) / 15) * 15)),
        priority: PRI_SET.has(t.priority) ? t.priority : "Medium",
        category: CATS_SET.has(t.category) ? t.category : "Deep Work",
        date: date, start: date ? start : null,
        done: Boolean(t.done),
      };
    }),
  };
}

function apiErrorResponse(err) {
  if (err instanceof GeminiError) {
    if (err.geminiStatus === 401 || err.geminiStatus === 403) return [503, "The server's Gemini API key was rejected."];
    if (err.geminiStatus === 429) return [429, "Gemini is rate limited right now. Try again in a minute."];
    if (err.geminiStatus === 503 || err.geminiStatus === 500) return [502, "Google's AI is overloaded right now. Try again in a minute."];
    if (err.geminiStatus === 0) return [502, "Couldn't reach Google's AI. Try again in a moment."];
    return [502, `Gemini error: ${err.message}`];
  }
  if (err instanceof Anthropic.AuthenticationError) return [503, "The server's Anthropic API key is invalid."];
  if (err instanceof Anthropic.RateLimitError) return [429, "The AI is rate limited right now. Try again in a minute."];
  if (err instanceof Anthropic.BadRequestError) return [502, "The AI request was rejected. Check the server logs."];
  if (err instanceof Anthropic.APIConnectionError) return [502, "Couldn't reach the AI service."];
  if (err instanceof Anthropic.APIError) return [502, `AI service error (${err.status ?? "unknown"}).`];
  if (err instanceof SyntaxError) return [502, "The AI reply couldn't be read. Try again."];
  if (err.status) return [err.status, err.message];
  return [500, "Something went wrong on the server."];
}


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = auth.getSessionUser(token);

  try {
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });

    /* ----- Pages ----- */
    if (req.method === "GET") {
      if (p === "/") return sendPage(res, "landing.html");
      if (p === "/login" || p === "/signup") return user ? redirect(res, safeNext(url.searchParams.get("next"))) : sendPage(res, "auth.html");
      if (p === "/dashboard") return user ? sendPage(res, "dashboard.html") : redirect(res, "/login?next=/dashboard");
      if (p === "/planner" || p === "/index.html") return user ? sendPage(res, "index.html") : redirect(res, "/login?next=/planner");
      if (p === "/settings") return user ? sendPage(res, "settings.html") : redirect(res, "/login?next=/settings");
      if (p === "/privacy" || p === "/terms") return sendPage(res, "legal.html");
      if (p === "/guide") return sendPage(res, "guide.html");
    }

    if (p.startsWith("/api/") && req.method !== "GET" && !sameOrigin(req)) throw httpError(403, "Cross-site request blocked.");

    /* ----- Auth API ----- */
    if (req.method === "POST" && p === "/api/auth/signup") {
      if (!signupLimiter.check(clientIp(req)).ok) throw httpError(429, "Too many sign-ups from this network. Try again later.");
      const { name, email, password } = await readJson(req);
      const problem = validateSignup({ name, email, password });
      if (problem) throw httpError(400, problem);
      const pending = await auth.preparePendingUser({ name, email, password });
      const { id, code } = auth.startChallenge({ purpose: "signup", email: pending.email, name: pending.name, pending });
      await sendCodeOrFail({ to: pending.email, code, purpose: "signup", name: pending.name });
      return send(res, 202, verifyResponse(id, pending.email));
    }

    if (req.method === "POST" && p === "/api/auth/login") {
      const { email, password, remember } = await readJson(req);
      if (validateEmail(email) || typeof password !== "string" || !password) throw httpError(400, "Enter your email and password.");
      const key = `${clientIp(req)}|${email.trim().toLowerCase()}`;
      const rl = loginLimiter.check(key);
      if (!rl.ok) throw httpError(429, `Too many attempts. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.`);
      const found = await auth.checkLogin(email, password);
      if (!found) throw httpError(401, "Email or password is incorrect.");
      loginLimiter.reset(key);
      // A device the user chose to trust skips the email code.
      if (auth.isTrustedDevice(parseCookies(req.headers.cookie)[DEVICE_COOKIE], found.id)) {
        const session = await auth.createSession(found.id, Boolean(remember), meta(req));
        return send(res, 200, { user: found }, undefined, { "Set-Cookie": sessionCookie(session.token, session.maxAge, COOKIE_SECURE) });
      }
      const { id, code } = auth.startChallenge({ purpose: "login", email: found.email, name: found.name, userId: found.id, remember: Boolean(remember) });
      await sendCodeOrFail({ to: found.email, code, purpose: "login", name: found.name });
      return send(res, 202, verifyResponse(id, found.email));
    }

    if (req.method === "POST" && p === "/api/auth/verify") {
      if (!verifyLimiter.check(clientIp(req)).ok) throw httpError(429, "Too many attempts. Wait a few minutes and try again.");
      const { challenge, code, trustDevice } = await readJson(req);
      if (typeof challenge !== "string" || !challenge) throw httpError(400, "Start again from the login page.");
      const { user: verified, remember } = await auth.verifyChallenge(challenge, code);
      const session = await auth.createSession(verified.id, remember, meta(req));
      const cookies = [sessionCookie(session.token, session.maxAge, COOKIE_SECURE)];
      if (trustDevice) { const d = await auth.trustDevice(verified.id, meta(req)); cookies.push(deviceCookie(d.token, d.maxAge, COOKIE_SECURE)); }
      return send(res, 200, { user: verified }, undefined, { "Set-Cookie": cookies });
    }

    if (req.method === "POST" && p === "/api/auth/resend") {
      if (!verifyLimiter.check(clientIp(req)).ok) throw httpError(429, "Too many attempts. Wait a few minutes and try again.");
      const { challenge } = await readJson(req);
      if (typeof challenge !== "string" || !challenge) throw httpError(400, "Start again from the login page.");
      const r = auth.resendChallenge(challenge);
      await sendCodeOrFail({ to: r.email, code: r.code, purpose: r.purpose, name: r.name });
      return send(res, 200, { ok: true, devMode: mailer.mode === "dev" });
    }

    if (req.method === "POST" && p === "/api/auth/logout") {
      await auth.destroySession(token);
      return send(res, 200, { ok: true }, undefined, { "Set-Cookie": clearCookie(COOKIE_SECURE) });
    }

    if (req.method === "GET" && p === "/api/me") {
      if (!user) throw httpError(401, "Not logged in.");
      return send(res, 200, { user, ai: hasCredentials ? (PROVIDER === "gemini" ? "Gemini" : "Claude") : null });
    }

    /* ----- Everything below needs a logged-in user ----- */
    if (p.startsWith("/api/") && !user) throw httpError(401, "Your session has ended. Log in again.");

    /* ----- Account settings ----- */
    const deviceToken = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    async function requirePassword(password) {
      if (!pwLimiter.check(user.id).ok) throw httpError(429, "Too many password attempts. Wait 15 minutes and try again.");
      if (!(await auth.confirmPassword(user.id, password))) throw httpError(400, "Your password is incorrect.");
    }

    if (req.method === "GET" && p === "/api/account") {
      return send(res, 200, {
        user,
        sessions: auth.listSessions(user.id, token),
        devices: auth.listDevices(user.id, deviceToken),
        emailMode: mailer.mode,
      });
    }

    if (req.method === "POST" && p === "/api/account/name") {
      const { name } = await readJson(req);
      if (typeof name !== "string" || !name.trim()) throw httpError(400, "Enter your name.");
      if (name.trim().length > 60) throw httpError(400, "Keep your name under 60 characters.");
      return send(res, 200, { user: await auth.updateName(user.id, name) });
    }

    if (req.method === "POST" && p === "/api/account/email") {
      const { email, password } = await readJson(req);
      const problem = validateEmail(email);
      if (problem) throw httpError(400, problem);
      const newEmail = email.trim().toLowerCase();
      if (newEmail === user.email) throw httpError(400, "That's already your email.");
      await requirePassword(password);
      if (auth.emailTaken(newEmail)) throw httpError(409, "That email is already used by another account.");
      const { id, code } = auth.startChallenge({ purpose: "email-change", email: newEmail, name: user.name, userId: user.id });
      await sendCodeOrFail({ to: newEmail, code, purpose: "email-change", name: user.name });
      return send(res, 202, verifyResponse(id, newEmail));
    }

    if (req.method === "POST" && p === "/api/account/email/verify") {
      if (!verifyLimiter.check(clientIp(req)).ok) throw httpError(429, "Too many attempts. Wait a few minutes and try again.");
      const { challenge, code } = await readJson(req);
      const { user: updated, oldEmail } = await auth.verifyChallenge(String(challenge || ""), code, { purposes: ["email-change"], userId: user.id });
      // Tell the old address, in case this wasn't them. A failed notice doesn't undo the change.
      mailer.sendNotice({
        to: oldEmail,
        subject: "Your Dayblock email was changed",
        lines: [`Hi ${updated.name},`, `The email on your Dayblock account was changed from ${oldEmail} to ${updated.email}.`, "If you made this change, there's nothing else to do. If you didn't, reply to this email right away so we can secure your account."],
      }).catch((e) => console.warn("Email-change notice not sent:", e.message));
      return send(res, 200, { user: updated });
    }

    if (req.method === "POST" && p === "/api/account/sessions/revoke") {
      const { id } = await readJson(req);
      await auth.revokeSession(user.id, id, token);
      return send(res, 200, { sessions: auth.listSessions(user.id, token) });
    }
    if (req.method === "POST" && p === "/api/account/sessions/revoke-others") {
      await auth.destroyOtherSessions(user.id, token);
      return send(res, 200, { sessions: auth.listSessions(user.id, token) });
    }
    if (req.method === "POST" && p === "/api/account/devices/forget") {
      await auth.revokeDevices(user.id);
      return send(res, 200, { devices: [] }, undefined, { "Set-Cookie": `${DEVICE_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}` });
    }

    if (req.method === "GET" && p === "/api/account/export") {
      const data = await auth.exportData(user.id);
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, JSON.stringify(data, null, 2), "application/json; charset=utf-8", { "Content-Disposition": `attachment; filename="dayblock-export-${stamp}.json"` });
    }

    if (req.method === "POST" && p === "/api/account/delete") {
      const { password, confirm } = await readJson(req);
      if (confirm !== "DELETE") throw httpError(400, "Type DELETE to confirm.");
      await requirePassword(password);
      await auth.deleteUser(user.id);
      console.log(`Account deleted: ${user.id}`);
      return send(res, 200, { ok: true }, undefined, { "Set-Cookie": [clearCookie(COOKIE_SECURE), `${DEVICE_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`] });
    }

    if (req.method === "POST" && p === "/api/auth/password") {
      const { current, next } = await readJson(req);
      if (typeof current !== "string" || !current) throw httpError(400, "Enter your current password.");
      const problem = validatePassword(next);
      if (problem) throw httpError(400, problem);
      await auth.changePassword(user.id, current, next);
      await auth.destroyOtherSessions(user.id, token);
      await auth.revokeDevices(user.id);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/data") {
      return send(res, 200, await auth.getUserData(user.id));
    }
    if (req.method === "PUT" && p === "/api/data") {
      const body = await readJson(req, 2 * 1024 * 1024);
      await auth.saveUserData(user.id, sanitizeUserData(body));
      return send(res, 200, { ok: true });
    }

    /* ----- AI ----- */
    if (req.method === "POST" && ["/api/parse", "/api/suggest-event", "/api/advice", "/api/chat"].includes(p)) {
      if (!hasCredentials) throw httpError(503, "AI is not configured on this server. Set GEMINI_API_KEY or ANTHROPIC_API_KEY to turn it on.");
      if (!aiLimiter.check(user.id).ok) throw httpError(429, "You've used a lot of AI requests this hour. Try again later.");
    }

    if (req.method === "POST" && p === "/api/parse") {
      const { text, date } = await readJson(req);
      if (typeof text !== "string" || !text.trim()) throw httpError(400, "Add some notes first.");
      if (text.length > 8000) throw httpError(413, "Notes are too long. Keep them under 8,000 characters.");
      const safeDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
      return send(res, 200, { tasks: await parseTasks(text, safeDate) });
    }

    if (req.method === "POST" && p === "/api/suggest-event") {
      const { title, notes, date, schedule, earliest } = await readJson(req);
      if (typeof title !== "string" || !title.trim()) throw httpError(400, "Give the event a title first.");
      const okTime = (t) => typeof t === "string" && /^\d{1,2}:\d{2}$/.test(t);
      const suggestion = await suggestEvent({
        title: title.slice(0, 200),
        notes: typeof notes === "string" ? notes.slice(0, 1000) : "",
        date: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10),
        schedule: typeof schedule === "string" ? schedule.slice(0, 4000) : "",
        earliest: okTime(earliest) ? earliest : "08:00",
      });
      return send(res, 200, suggestion);
    }

    if (req.method === "POST" && p === "/api/chat") {
      const { messages, context } = await readJson(req, 256 * 1024);
      if (!Array.isArray(messages) || !messages.length) throw httpError(400, "Say something first.");
      const turns = messages.slice(-14)
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      while (turns.length && turns[0].role !== "user") turns.shift();
      if (!turns.length || turns[turns.length - 1].role !== "user") throw httpError(400, "Say something first.");
      return send(res, 200, await chatTurn({ turns, context: typeof context === "string" ? context.slice(0, 60000) : "" }));
    }

    if (req.method === "POST" && p === "/api/advice") {
      const { summary } = await readJson(req);
      if (typeof summary !== "string" || !summary.trim()) throw httpError(400, "Missing schedule summary.");
      return send(res, 200, { advice: await getAdvice(summary.slice(0, 6000)) });
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    send(res, 404, "<!doctype html><title>Not found</title><p style=\"font-family:system-ui;padding:2rem\">Page not found. <a href=\"/\">Go home</a></p>", "text/html; charset=utf-8");
  } catch (err) {
    const [status, message] = apiErrorResponse(err);
    if (status >= 500) console.error(err);
    send(res, status, { error: message });
  }
});

await auth.init();
server.listen(PORT, () => {
  console.log(`Dayblock running at http://localhost:${PORT} (AI: ${hasCredentials ? (PROVIDER === "gemini" ? GEMINI_MODEL : MODEL) : "off"}, email: ${mailer.mode})`);
  if (process.env.RENDER && !process.env.DATA_DIR) console.warn("WARNING: no DATA_DIR set. On Render, accounts and plans are lost on every deploy or restart unless DATA_DIR points at a persistent disk.");
  if (mailer.mode === "dev") console.log("Email isn't configured, so verification codes are printed here. See README to set up Gmail or Resend.");
});
