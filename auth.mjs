// Accounts, sessions and per-user data for Dayblock.
// Storage is plain JSON files under ./data (no database needed). Writes are atomic
// (write temp file, then rename) and serialized per file.

import { randomBytes, randomUUID, randomInt, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 7;
const SESSION_DAYS_REMEMBER = 30;
export const SESSION_COOKIE = "dayblock_sid";
export const DEVICE_COOKIE = "dayblock_tdev";
const CODE_TTL = 10 * 60 * 1000;       // a code is valid for 10 minutes
const CODE_MAX_ATTEMPTS = 5;           // wrong guesses before the challenge is thrown away
const CODE_MAX_SENDS = 5;              // codes per challenge (first + 4 resends)
const RESEND_COOLDOWN = 60 * 1000;
const CHALLENGE_LIFETIME = 30 * 60 * 1000;
const DEVICE_DAYS = 30;

export function createAuth(dataDir) {
  const usersFile = path.join(dataDir, "users.json");
  const sessionsFile = path.join(dataDir, "sessions.json");
  const userDataDir = path.join(dataDir, "userdata");
  const devicesFile = path.join(dataDir, "devices.json");
  let devices = null;   // { [sha256(token)]: { userId, expires } }  "trust this device" tokens
  const challenges = new Map(); // in memory: pending email-code checks

  let users = null;     // { [id]: { id, email, name, passwordHash, createdAt } }
  let sessions = null;  // { [sha256(token)]: { userId, expires } }
  const queues = new Map();

  async function init() {
    await mkdir(userDataDir, { recursive: true });
    users = await readJsonFile(usersFile, {});
    sessions = await readJsonFile(sessionsFile, {});
    devices = await readJsonFile(devicesFile, {});
    pruneSessions();
  }

  // Serialize writes per file and write atomically.
  function writeJsonFile(file, value) {
    const prev = queues.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value), "utf8");
      await rename(tmp, file);
    });
    queues.set(file, next);
    return next;
  }

  /* ---------- Passwords ---------- */
  async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
  }
  async function verifyPassword(password, stored) {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const expected = Buffer.from(keyB64, "base64");
    const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return key.length === expected.length && timingSafeEqual(key, expected);
  }
  // Used when the email doesn't exist so login takes the same time either way.
  const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

  /* ---------- Users ---------- */
  const normEmail = (e) => String(e || "").trim().toLowerCase();
  const findByEmail = (email) => Object.values(users).find((u) => u.email === normEmail(email)) || null;
  const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt } : null);

  const emailTaken = (email) => Boolean(findByEmail(email));

  // Sign-up is two steps: hash the password now, create the account only after the email code checks out.
  async function preparePendingUser({ name, email, password }) {
    const e = normEmail(email);
    if (findByEmail(e)) throw authError(409, "An account with this email already exists. Log in instead.");
    return { email: e, name: String(name).trim(), passwordHash: await hashPassword(password) };
  }
  async function createUserFromPending(pending) {
    if (findByEmail(pending.email)) throw authError(409, "An account with this email already exists. Log in instead.");
    const user = { id: randomUUID(), ...pending, emailVerified: true, createdAt: new Date().toISOString() };
    users[user.id] = user;
    await writeJsonFile(usersFile, users);
    return publicUser(user);
  }

  /* ---------- Email codes (second factor) ---------- */
  const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = (id, code) => createHash("sha256").update(`${id}:${code}`).digest();

  function startChallenge({ purpose, email, name, userId = null, pending = null, remember = false }) {
    // Only one pending email change per user at a time.
    if (purpose === "email-change") for (const [k, c] of challenges) if (c.purpose === "email-change" && c.userId === userId) challenges.delete(k);
    const id = randomBytes(24).toString("base64url");
    const code = newCode();
    const now = Date.now();
    challenges.set(id, { id, purpose, email, name, userId, pending, remember, hash: codeHash(id, code), expires: now + CODE_TTL, created: now, attempts: 0, sends: 1, lastSent: now });
    return { id, code };
  }
  function resendChallenge(id) {
    const c = challenges.get(id);
    if (!c || Date.now() - c.created > CHALLENGE_LIFETIME) { challenges.delete(id); throw authError(410, "This verification has expired. Start again."); }
    const wait = c.lastSent + RESEND_COOLDOWN - Date.now();
    if (wait > 0) throw authError(429, `Wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`);
    if (c.sends >= CODE_MAX_SENDS) throw authError(429, "Too many codes sent. Start again in a few minutes.");
    const code = newCode();
    Object.assign(c, { hash: codeHash(id, code), sends: c.sends + 1, lastSent: Date.now(), expires: Date.now() + CODE_TTL, attempts: 0 });
    return { code, email: c.email, name: c.name, purpose: c.purpose };
  }
  async function verifyChallenge(id, code, { purposes = ["signup", "login"], userId = null } = {}) {
    const c = challenges.get(id);
    if (c && (!purposes.includes(c.purpose) || (userId && c.userId !== userId))) throw authError(410, "This verification has expired. Start again.");
    if (!c || Date.now() - c.created > CHALLENGE_LIFETIME) { challenges.delete(id); throw authError(410, "This verification has expired. Start again."); }
    if (c.expires < Date.now()) throw authError(400, "That code has expired. Send a new one.");
    const clean = String(code || "").replace(/\D/g, "");
    const ok = clean.length === 6 && timingSafeEqual(codeHash(id, clean), c.hash);
    if (!ok) {
      c.attempts++;
      if (c.attempts >= CODE_MAX_ATTEMPTS) { challenges.delete(id); throw authError(429, "Too many wrong codes. Start again."); }
      const left = CODE_MAX_ATTEMPTS - c.attempts;
      throw authError(400, `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`);
    }
    challenges.delete(id);
    if (c.purpose === "signup") return { user: await createUserFromPending(c.pending), remember: true };
    if (c.purpose === "email-change") {
      const u = users[c.userId];
      if (!u) throw authError(410, "This account no longer exists.");
      const taken = findByEmail(c.email);
      if (taken && taken.id !== u.id) throw authError(409, "That email is already used by another account.");
      const oldEmail = u.email;
      u.email = c.email; u.emailVerified = true;
      await writeJsonFile(usersFile, users);
      return { user: publicUser(u), oldEmail };
    }
    const user = users[c.userId];
    if (!user) throw authError(410, "This account no longer exists.");
    if (!user.emailVerified) { user.emailVerified = true; await writeJsonFile(usersFile, users); }
    return { user: publicUser(user), remember: c.remember };
  }
  setInterval(() => { const now = Date.now(); for (const [k, c] of challenges) if (now - c.created > CHALLENGE_LIFETIME) challenges.delete(k); }, 5 * 60 * 1000).unref();

  /* ---------- Trusted devices ("don't ask for a code on this device") ---------- */
  async function trustDevice(userId, meta = {}) {
    const token = randomBytes(32).toString("base64url");
    devices[tokenKey(token)] = { userId, expires: Date.now() + DEVICE_DAYS * 864e5, created: Date.now(), ua: String(meta.ua || "").slice(0, 300) };
    await writeJsonFile(devicesFile, devices);
    return { token, maxAge: DEVICE_DAYS * 86400 };
  }
  function isTrustedDevice(token, userId) {
    if (!token) return false;
    const d = devices[tokenKey(token)];
    return Boolean(d && d.userId === userId && d.expires > Date.now());
  }
  async function revokeDevices(userId) {
    for (const [k, d] of Object.entries(devices)) if (d.userId === userId) delete devices[k];
    await writeJsonFile(devicesFile, devices);
  }
  function listDevices(userId, currentDeviceToken) {
    const cur = currentDeviceToken ? tokenKey(currentDeviceToken) : null;
    return Object.entries(devices).filter(([, d]) => d.userId === userId && d.expires > Date.now())
      .map(([k, d]) => ({ current: k === cur, created: d.created || null, expires: d.expires, device: describeUA(d.ua) }))
      .sort((a, b) => (b.current - a.current) || (b.created || 0) - (a.created || 0));
  }

  async function checkLogin(email, password) {
    const user = findByEmail(email);
    if (!user) { await verifyPassword(password, await DUMMY_HASH); return null; }
    return (await verifyPassword(password, user.passwordHash)) ? publicUser(user) : null;
  }

  async function changePassword(userId, current, next) {
    const user = users[userId];
    if (!user || !(await verifyPassword(current, user.passwordHash))) throw authError(400, "Your current password is incorrect.");
    user.passwordHash = await hashPassword(next);
    await writeJsonFile(usersFile, users);
    return user;
  }
  async function confirmPassword(userId, password) {
    const user = users[userId];
    return Boolean(user && typeof password === "string" && (await verifyPassword(password, user.passwordHash)));
  }
  async function updateName(userId, name) {
    const user = users[userId];
    if (!user) throw authError(404, "Account not found.");
    user.name = String(name).trim();
    await writeJsonFile(usersFile, users);
    return publicUser(user);
  }
  async function deleteUser(userId) {
    delete users[userId];
    for (const [k, s] of Object.entries(sessions)) if (s.userId === userId) delete sessions[k];
    for (const [k, d] of Object.entries(devices)) if (d.userId === userId) delete devices[k];
    for (const [k, c] of challenges) if (c.userId === userId) challenges.delete(k);
    await Promise.all([writeJsonFile(usersFile, users), writeJsonFile(sessionsFile, sessions), writeJsonFile(devicesFile, devices)]);
    await unlink(dataFile(userId)).catch(() => {});
  }

  /* ---------- Sessions ---------- */
  const tokenKey = (token) => createHash("sha256").update(token).digest("hex");

  async function createSession(userId, remember, meta = {}) {
    const token = randomBytes(32).toString("base64url");
    const days = remember ? SESSION_DAYS_REMEMBER : SESSION_DAYS;
    const now = Date.now();
    sessions[tokenKey(token)] = { userId, expires: now + days * 864e5, created: now, lastSeen: now, ua: String(meta.ua || "").slice(0, 300) };
    await writeJsonFile(sessionsFile, sessions);
    return { token, maxAge: days * 86400 };
  }
  function getSessionUser(token) {
    if (!token) return null;
    const s = sessions[tokenKey(token)];
    if (!s) return null;
    if (s.expires < Date.now()) { delete sessions[tokenKey(token)]; writeJsonFile(sessionsFile, sessions); return null; }
    // Track "last active", saving at most every 10 minutes per session.
    if (!s.lastSeen || Date.now() - s.lastSeen > 10 * 60 * 1000) { s.lastSeen = Date.now(); writeJsonFile(sessionsFile, sessions); }
    return publicUser(users[s.userId]);
  }
  function listSessions(userId, currentToken) {
    const cur = currentToken ? tokenKey(currentToken) : null;
    return Object.entries(sessions).filter(([, s]) => s.userId === userId && s.expires > Date.now())
      .map(([k, s]) => ({ id: k.slice(0, 20), current: k === cur, created: s.created || null, lastSeen: s.lastSeen || s.created || null, expires: s.expires, device: describeUA(s.ua) }))
      .sort((a, b) => (b.current - a.current) || (b.lastSeen || 0) - (a.lastSeen || 0));
  }
  async function revokeSession(userId, id, currentToken) {
    const cur = currentToken ? tokenKey(currentToken) : null;
    const key = Object.keys(sessions).find((k) => k.startsWith(String(id)) && String(id).length === 20 && sessions[k].userId === userId);
    if (!key) throw authError(404, "That session has already ended.");
    if (key === cur) throw authError(400, "Use Log out to end this session.");
    delete sessions[key];
    await writeJsonFile(sessionsFile, sessions);
  }
  async function destroySession(token) {
    if (!token) return;
    delete sessions[tokenKey(token)];
    await writeJsonFile(sessionsFile, sessions);
  }
  async function destroyOtherSessions(userId, keepToken) {
    const keep = keepToken ? tokenKey(keepToken) : null;
    for (const [k, s] of Object.entries(sessions)) if (s.userId === userId && k !== keep) delete sessions[k];
    await writeJsonFile(sessionsFile, sessions);
  }
  function pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(sessions)) if (s.expires < now) { delete sessions[k]; changed = true; }
    if (changed) writeJsonFile(sessionsFile, sessions);
    let dChanged = false;
    for (const [k, d] of Object.entries(devices || {})) if (d.expires < now) { delete devices[k]; dChanged = true; }
    if (dChanged) writeJsonFile(devicesFile, devices);
  }
  setInterval(pruneSessions, 60 * 60 * 1000).unref();

  /* ---------- Per-user planner data ---------- */
  const dataFile = (userId) => path.join(userDataDir, `${userId.replace(/[^a-f0-9-]/gi, "")}.json`);
  const getUserData = (userId) => readJsonFile(dataFile(userId), { tasks: [], focus: false, dump: "" });
  const saveUserData = (userId, data) => writeJsonFile(dataFile(userId), { ...data, updatedAt: new Date().toISOString() });
  async function exportData(userId) {
    return { exportedAt: new Date().toISOString(), account: publicUser(users[userId]), planner: await getUserData(userId) };
  }

  return {
    init, emailTaken, preparePendingUser, checkLogin, changePassword,
    startChallenge, resendChallenge, verifyChallenge,
    trustDevice, isTrustedDevice, revokeDevices, listDevices,
    createSession, getSessionUser, destroySession, destroyOtherSessions, listSessions, revokeSession,
    confirmPassword, updateName, deleteUser, exportData,
    getUserData, saveUserData,
  };
}

/* ---------- Device labels ("Chrome on Windows") from a User-Agent ---------- */
export function describeUA(ua = "") {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /node|undici|curl/i.test(ua) ? "Script" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/* ---------- Validation ---------- */
export function validateSignup({ name, email, password }) {
  if (typeof name !== "string" || !name.trim()) return "Enter your name.";
  if (name.trim().length > 60) return "Keep your name under 60 characters.";
  return validateEmail(email) || validatePassword(password);
}
export function validateEmail(email) {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) return "Enter a valid email address.";
  return null;
}
export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) return "Use a password with at least 8 characters.";
  if (password.length > 200) return "Keep your password under 200 characters.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9\W_]/.test(password)) return "Use a mix of letters and numbers or symbols.";
  return null;
}

/* ---------- Rate limiting (in memory) ---------- */
export function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return {
    check(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return { ok: true }; }
      h.count++;
      return h.count > max ? { ok: false, retryAfter: Math.ceil((h.reset - now) / 1000) } : { ok: true };
    },
    reset(key) { hits.delete(key); },
  };
}

/* ---------- Cookies ---------- */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function sessionCookie(token, maxAge, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function deviceCookie(token, maxAge, secure) {
  return `${DEVICE_COOKIE}=${token}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function clearCookie(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function authError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}
