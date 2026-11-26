// Dayblock edge function: the server-side half of the GitHub Pages + Supabase version.
// Handles the emailed sign-in codes, trusted devices, account changes that need a
// password check or admin rights, and every AI call (so API keys never reach the browser).
//
// Secrets (set by scripts/setup-supabase.mjs, or Dashboard > Edge Functions > Secrets):
//   GEMINI_API_KEY, RESEND_API_KEY, EMAIL_FROM (optional), GEMINI_MODEL (optional)
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CATEGORIES, PRIORITIES, TASKS_SCHEMA, PARSE_SYSTEM, ADVICE_SYSTEM,
  EVENT_SCHEMA, EVENT_SYSTEM, CHAT_SCHEMA, CHAT_RULES,
} from "./ai-prompts.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash";
const GEMINI_MODELS = [GEMINI_MODEL, "gemini-flash-latest", "gemini-3.5-flash-lite"].filter((m, i, a) => a.indexOf(m) === i);
const CODE_TTL_MS = 10 * 60 * 1000, MAX_ATTEMPTS = 5, MAX_SENDS = 5, RESEND_COOLDOWN_MS = 60 * 1000, DEVICE_DAYS = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*", // requests are authorized by the user's login token, not cookies
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/* ---------- small helpers ---------- */
async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sixDigits() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4_294_000_000); // remove modulo bias
  return String(a[0] % 1_000_000).padStart(6, "0");
}
function randomToken() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function jwtClaims(token: string) {
  const part = token.split(".")[1] || "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  try { return JSON.parse(atob(b64)); } catch { return {}; }
}
const maskEmail = (email: string) => {
  const [u, d] = email.split("@"); if (!d) return email;
  const shown = u.length <= 2 ? u[0] : u.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(2, Math.min(6, u.length - shown.length)))}@${d}`;
};
const validEmail = (e: unknown) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
function validPassword(p: unknown) {
  if (typeof p !== "string" || p.length < 8) return "Use a password with at least 8 characters.";
  if (p.length > 200) return "Keep your password under 200 characters.";
  if (!/[a-zA-Z]/.test(p) || !/[0-9\W_]/.test(p)) return "Use a mix of letters and numbers or symbols.";
  return null;
}

// Checks a password without leaving a session behind.
async function passwordIsCorrect(email: string, password: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  if (j.access_token) await admin.auth.admin.signOut(j.access_token, "local").catch(() => {});
  return true;
}

/* ---------- email (Resend) ---------- */
async function sendEmail(to: string, subject: string, lines: string[], code?: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new HttpError(503, "Email isn't set up yet: add RESEND_API_KEY to the edge function secrets.");
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const codeBlock = code ? `<tr><td style="padding:16px 28px"><div style="font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;background:#eef2ff;color:#3730a3;border-radius:10px;padding:16px;text-align:center">${code}</div></td></tr>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border:1px solid #e2e8f0;border-radius:14px"><tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:700">Dayblock</td></tr>${lines.map((l, i) => (i === 1 && code ? `<tr><td style="padding:8px 28px;font-size:15px">${esc(l)}</td></tr>${codeBlock}` : `<tr><td style="padding:8px 28px;font-size:14px;line-height:1.55;color:${i > 1 ? "#475569" : "#0f172a"}">${esc(l)}</td></tr>`)).join("")}<tr><td style="padding:0 0 20px"></td></tr></table></td></tr></table></body></html>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("EMAIL_FROM") || "Dayblock <onboarding@resend.dev>", to: [to], subject, text: lines.join("\n\n") + (code ? `\n\nCode: ${code}` : ""), html }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    console.error("Resend error", r.status, j);
    throw new HttpError(502, "We couldn't send the code email. Try again in a moment.");
  }
}
const codeEmail = (to: string, name: string, code: string, purpose: "login" | "email-change") => sendEmail(
  to, `${code} is your Dayblock code`,
  [`Hi${name ? ` ${name}` : ""},`,
    purpose === "login" ? "Use this code to log in to Dayblock:" : "Use this code to confirm this as the new email for your Dayblock account:",
    "It expires in 10 minutes.",
    purpose === "login" ? "If this wasn't you, someone knows your password. Log in and change it from your account settings." : "If you didn't ask to change your email, you can ignore this email."],
  code,
);

/* ---------- email-code challenges ---------- */
async function startChallenge(userId: string, sessionId: string | null, purpose: "login" | "email-change", email: string, name: string) {
  const { count } = await admin.from("email_challenges").select("id", { count: "exact", head: true })
    .eq("user_id", userId).gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if ((count ?? 0) >= 10) throw new HttpError(429, "Too many codes requested. Try again in an hour.");
  if (purpose === "email-change") await admin.from("email_challenges").delete().eq("user_id", userId).eq("purpose", "email-change");
  const code = sixDigits();
  const id = crypto.randomUUID();
  const { error } = await admin.from("email_challenges").insert({
    id, user_id: userId, session_id: sessionId, purpose, email, code_hash: await sha256(`${id}:${code}`),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (error) throw new HttpError(500, "Couldn't start verification.");
  await codeEmail(email, name, code, purpose);
  return id;
}
async function checkChallenge(id: string, userId: string, purpose: string, code: string) {
  const { data: c } = await admin.from("email_challenges").select("*").eq("id", id).maybeSingle();
  if (!c || c.user_id !== userId || c.purpose !== purpose || Date.now() - Date.parse(c.created_at) > 30 * 60 * 1000) {
    throw new HttpError(410, "This verification has expired. Start again.");
  }
  if (Date.parse(c.expires_at) < Date.now()) throw new HttpError(400, "That code has expired. Send a new one.");
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6 || (await sha256(`${id}:${clean}`)) !== c.code_hash) {
    const attempts = c.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) { await admin.from("email_challenges").delete().eq("id", id); throw new HttpError(429, "Too many wrong codes. Start again."); }
    await admin.from("email_challenges").update({ attempts }).eq("id", id);
    const left = MAX_ATTEMPTS - attempts;
    throw new HttpError(400, `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`);
  }
  await admin.from("email_challenges").delete().eq("id", id);
  return c;
}
async function resendChallenge(id: string, userId: string, name: string) {
  const { data: c } = await admin.from("email_challenges").select("*").eq("id", id).maybeSingle();
  if (!c || c.user_id !== userId) throw new HttpError(410, "This verification has expired. Start again.");
  const wait = Date.parse(c.last_sent) + RESEND_COOLDOWN_MS - Date.now();
  if (wait > 0) throw new HttpError(429, `Wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`);
  if (c.sends >= MAX_SENDS) throw new HttpError(429, "Too many codes sent. Start again in a few minutes.");
  const code = sixDigits();
  await admin.from("email_challenges").update({
    code_hash: await sha256(`${id}:${code}`), sends: c.sends + 1, attempts: 0,
    last_sent: new Date().toISOString(), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  }).eq("id", id);
  await codeEmail(c.email, name, code, c.purpose);
}

/* ---------- AI (Gemini) ---------- */
async function gemini({ system, user, turns, schema, maxOutputTokens = 4096 }: { system: string; user?: string; turns?: { role: string; content: string }[]; schema?: unknown; maxOutputTokens?: number }) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new HttpError(503, "AI is not configured: add GEMINI_API_KEY to the edge function secrets.");
  const generationConfig: Record<string, unknown> = { maxOutputTokens };
  if (schema) { generationConfig.responseMimeType = "application/json"; generationConfig.responseJsonSchema = schema; }
  const contents = turns ? turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })) : [{ role: "user", parts: [{ text: user }] }];
  let last = "";
  for (const model of GEMINI_MODELS) {
    let r: Response;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch { last = "unreachable"; continue; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 503 || r.status === 500 || r.status === 429) { last = "overloaded"; continue; }
    if (!r.ok) { console.error("Gemini error", r.status, j?.error?.message); throw new HttpError(502, "The AI request failed. Try again."); }
    const cand = j.candidates?.[0];
    if (!cand || cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") throw new HttpError(422, "The AI declined to process that.");
    if (cand.finishReason === "MAX_TOKENS") throw new HttpError(502, "The AI reply was cut off. Try with less text.");
    return (cand.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  }
  throw new HttpError(502, last === "overloaded" ? "Google's AI is overloaded right now. Try again in a minute." : "Couldn't reach Google's AI. Try again in a moment.");
}
const clampMinutes = (m: unknown) => Math.min(480, Math.max(15, Math.round((Number(m) || 30) / 15) * 15));
const isTime = (t: unknown) => typeof t === "string" && /^\d{1,2}:\d{2}$/.test(t);
const isDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/* ---------- request handling ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) throw new HttpError(401, "Your session has ended. Log in again.");
    const sessionId: string | null = jwtClaims(token).session_id || null;
    const name = String(user.user_metadata?.name || "");
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    const verified = async () => {
      if (!sessionId) return false;
      const { data } = await admin.from("verified_sessions").select("session_id").eq("session_id", sessionId).eq("user_id", user.id).maybeSingle();
      return Boolean(data);
    };
    const requireVerified = async () => { if (!(await verified())) throw new HttpError(401, "Enter your email code to continue."); };

    switch (action) {
      case "status":
        return json(200, { verified: await verified() });

      /* ----- second factor ----- */
      case "2fa-start": {
        if (!sessionId) throw new HttpError(400, "Log in again.");
        if (typeof body.deviceToken === "string" && body.deviceToken) {
          const { data: d } = await admin.from("trusted_devices").select("user_id, expires_at").eq("token_hash", await sha256(body.deviceToken)).maybeSingle();
          if (d && d.user_id === user.id && Date.parse(d.expires_at) > Date.now()) {
            await admin.from("verified_sessions").upsert({ session_id: sessionId, user_id: user.id });
            return json(200, { verified: true });
          }
        }
        const id = await startChallenge(user.id, sessionId, "login", user.email!, name);
        return json(202, { verify: true, challenge: id, email: maskEmail(user.email!), devMode: false });
      }
      case "2fa-verify": {
        const c = await checkChallenge(String(body.challenge || ""), user.id, "login", body.code);
        if (c.session_id !== sessionId) throw new HttpError(410, "This verification belongs to another login. Start again.");
        await admin.from("verified_sessions").upsert({ session_id: sessionId, user_id: user.id });
        let deviceToken: string | null = null;
        if (body.trustDevice) {
          deviceToken = randomToken();
          await admin.from("trusted_devices").insert({
            token_hash: await sha256(deviceToken), user_id: user.id, label: String(body.deviceLabel || "").slice(0, 80),
            expires_at: new Date(Date.now() + DEVICE_DAYS * 864e5).toISOString(),
          });
        }
        return json(200, { ok: true, deviceToken });
      }
      case "2fa-resend":
        await resendChallenge(String(body.challenge || ""), user.id, name);
        return json(200, { ok: true, devMode: false });

      /* ----- account changes (need a verified session) ----- */
      case "email-change-start": {
        await requireVerified();
        if (!validEmail(body.email)) throw new HttpError(400, "Enter a valid email address.");
        const email = String(body.email).trim().toLowerCase();
        if (email === user.email) throw new HttpError(400, "That's already your email.");
        if (!(await passwordIsCorrect(user.email!, String(body.password || "")))) throw new HttpError(400, "Your password is incorrect.");
        const id = await startChallenge(user.id, sessionId, "email-change", email, name);
        return json(202, { verify: true, challenge: id, email: maskEmail(email), devMode: false });
      }
      case "email-change-verify": {
        await requireVerified();
        const c = await checkChallenge(String(body.challenge || ""), user.id, "email-change", body.code);
        const oldEmail = user.email!;
        const { error } = await admin.auth.admin.updateUserById(user.id, { email: c.email, email_confirm: true });
        if (error) throw new HttpError(409, /already|registered|exists/i.test(error.message) ? "That email is already used by another account." : "Couldn't change your email.");
        sendEmail(oldEmail, "Your Dayblock email was changed", [`Hi ${name},`, `The email on your Dayblock account was changed from ${oldEmail} to ${c.email}.`, "If you made this change, there's nothing else to do. If you didn't, reply to this email right away."]).catch(() => {});
        return json(200, { ok: true, email: c.email });
      }
      case "password-change": {
        await requireVerified();
        const problem = validPassword(body.next);
        if (problem) throw new HttpError(400, problem);
        if (!(await passwordIsCorrect(user.email!, String(body.current || "")))) throw new HttpError(400, "Your current password is incorrect.");
        const { error } = await admin.auth.admin.updateUserById(user.id, { password: body.next });
        if (error) throw new HttpError(400, error.message);
        await admin.auth.admin.signOut(token, "others").catch(() => {});
        await admin.from("verified_sessions").delete().eq("user_id", user.id).neq("session_id", sessionId);
        await admin.from("trusted_devices").delete().eq("user_id", user.id);
        return json(200, { ok: true });
      }
      case "delete-account": {
        await requireVerified();
        if (body.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");
        if (!(await passwordIsCorrect(user.email!, String(body.password || "")))) throw new HttpError(400, "Your password is incorrect.");
        const { error } = await admin.auth.admin.deleteUser(user.id); // plans, devices, codes cascade
        if (error) throw new HttpError(500, "Couldn't delete the account.");
        return json(200, { ok: true });
      }

      /* ----- AI ----- */
      case "parse": {
        await requireVerified();
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "Add some notes first.");
        if (body.text.length > 8000) throw new HttpError(413, "Notes are too long. Keep them under 8,000 characters.");
        const out = await gemini({ system: PARSE_SYSTEM, user: `Planner date: ${isDate(body.date) ? body.date : new Date().toISOString().slice(0, 10)}\n\nNotes:\n${body.text}`, schema: TASKS_SCHEMA, maxOutputTokens: 8192 });
        const tasks = (JSON.parse(out).tasks || []).slice(0, 40).map((t: Record<string, unknown>) => ({
          title: String(t.title || "Untitled task").slice(0, 120), minutes: clampMinutes(t.minutes),
          priority: PRIORITIES.includes(t.priority as string) ? t.priority : "Medium",
          category: CATEGORIES.includes(t.category as string) ? t.category : "Deep Work",
          preferredStart: isTime(t.preferredStart) ? t.preferredStart : null,
        }));
        return json(200, { tasks });
      }
      case "suggest-event": {
        await requireVerified();
        if (typeof body.title !== "string" || !body.title.trim()) throw new HttpError(400, "Give the event a title first.");
        const userMsg = `Date: ${isDate(body.date) ? body.date : new Date().toISOString().slice(0, 10)}\nEarliest allowed start: ${isTime(body.earliest) ? body.earliest : "08:00"}\n\nNew event: ${body.title.slice(0, 200)}${body.notes ? `\nNotes: ${String(body.notes).slice(0, 1000)}` : ""}\n\nAlready scheduled:\n${String(body.schedule || "").slice(0, 4000) || "(nothing)"}`;
        const e = JSON.parse(await gemini({ system: EVENT_SYSTEM, user: userMsg, schema: EVENT_SCHEMA, maxOutputTokens: 2048 }));
        return json(200, {
          title: String(e.title || body.title).slice(0, 120), minutes: clampMinutes(e.minutes),
          category: CATEGORIES.includes(e.category) ? e.category : "Deep Work", priority: PRIORITIES.includes(e.priority) ? e.priority : "Medium",
          start: isTime(e.start) ? e.start : null, reason: String(e.reason || "").slice(0, 300),
        });
      }
      case "advice": {
        await requireVerified();
        if (typeof body.summary !== "string" || !body.summary.trim()) throw new HttpError(400, "Missing schedule summary.");
        return json(200, { advice: (await gemini({ system: ADVICE_SYSTEM, user: body.summary.slice(0, 6000), maxOutputTokens: 2048 })).trim() });
      }
      case "chat": {
        await requireVerified();
        const turns = (Array.isArray(body.messages) ? body.messages : []).slice(-14)
          .filter((m: { role?: string; content?: unknown }) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content.slice(0, 4000) }));
        while (turns.length && turns[0].role !== "user") turns.shift();
        if (!turns.length || turns[turns.length - 1].role !== "user") throw new HttpError(400, "Say something first.");
        const context = typeof body.context === "string" ? body.context.slice(0, 60000) : "";
        const j = JSON.parse(await gemini({ system: `${CHAT_RULES}\n\n${context}`, turns, schema: CHAT_SCHEMA, maxOutputTokens: 4096 }));
        return json(200, { reply: String(j.reply || "").slice(0, 3000), actions: Array.isArray(j.actions) ? j.actions.slice(0, 60) : [] });
      }
      default:
        throw new HttpError(404, "Unknown action.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e instanceof SyntaxError) return json(502, { error: "The AI reply couldn't be read. Try again." });
    console.error(e);
    return json(500, { error: "Something went wrong on the server." });
  }
});
