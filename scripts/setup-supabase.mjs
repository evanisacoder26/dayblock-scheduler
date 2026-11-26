// One-time Supabase setup for the GitHub Pages version of Dayblock.
//
// Needs in .env:
//   SUPABASE_ACCESS_TOKEN  personal access token (supabase.com/dashboard/account/tokens)
//   SUPABASE_PROJECT_REF   the project's reference id (in its URL: https://<ref>.supabase.co)
//   GEMINI_API_KEY, RESEND_API_KEY, EMAIL_FROM (optional)  copied into the edge function secrets
//
// Run: node --env-file=.env scripts/setup-supabase.mjs
// Safe to run again: it updates everything in place.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = (process.env.SUPABASE_PROJECT_REF || "").replace(/^https?:\/\//, "").replace(/\.supabase\.co.*$/, "").trim();
const API = `https://api.supabase.com/v1/projects/${REF}`;

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
if (!TOKEN) die("SUPABASE_ACCESS_TOKEN is missing from .env");
if (!/^[a-z0-9]{20}$/.test(REF)) die("SUPABASE_PROJECT_REF is missing or doesn't look like a project ref (20 lowercase letters/numbers)");

async function call(method, url, body, { form } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${url.replace(API, "")} → ${res.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}
const step = (label) => process.stdout.write(`• ${label}… `);
const ok = (extra = "") => console.log(`done${extra ? ` (${extra})` : ""}`);

// 1. Access
step("Checking project access");
const project = await call("GET", API).catch((e) => die(`Couldn't open project ${REF}. Check the token and ref.\n  ${e.message}`));
ok(`${project.name}, ${project.region}`);

// 2. Database tables and security rules
step("Creating database tables and access rules");
await call("POST", `${API}/database/query`, { query: await readFile(path.join(root, "supabase", "schema.sql"), "utf8") });
ok();

// 3. Auth settings: no Supabase confirmation emails (Dayblock sends its own codes), 8+ character passwords
step("Configuring sign-in settings");
await call("PATCH", `${API}/config/auth`, { mailer_autoconfirm: true, password_min_length: 8, external_email_enabled: true });
ok();

// 4. Secrets for the edge function
step("Saving API keys as edge function secrets");
const secrets = [["GEMINI_API_KEY", process.env.GEMINI_API_KEY], ["RESEND_API_KEY", process.env.RESEND_API_KEY], ["EMAIL_FROM", process.env.EMAIL_FROM], ["GEMINI_MODEL", process.env.GEMINI_MODEL]]
  .filter(([, v]) => v).map(([name, value]) => ({ name, value }));
if (!secrets.some((s) => s.name === "GEMINI_API_KEY")) console.warn("\n  ! GEMINI_API_KEY not in .env: AI features won't work until it's added.");
if (!secrets.some((s) => s.name === "RESEND_API_KEY")) console.warn("\n  ! RESEND_API_KEY not in .env: sign-in codes can't be emailed until it's added.");
if (secrets.length) await call("POST", `${API}/secrets`, secrets);
ok(secrets.map((s) => s.name).join(", ") || "none");

// 5. Edge function (index.ts + the shared AI prompts)
step("Deploying the dayblock-api edge function");
const form = new FormData();
form.append("metadata", JSON.stringify({ name: "dayblock-api", entrypoint_path: "index.ts", verify_jwt: false })); // the function checks the login token itself
form.append("file", new Blob([await readFile(path.join(root, "supabase", "functions", "dayblock-api", "index.ts"), "utf8")], { type: "application/typescript" }), "index.ts");
form.append("file", new Blob([await readFile(path.join(root, "ai-prompts.mjs"), "utf8")], { type: "application/javascript" }), "ai-prompts.mjs");
const fnInfo = await call("POST", `${API}/functions/deploy?slug=dayblock-api`, undefined, { form });
ok(`version ${fnInfo.version ?? "?"}, status ${fnInfo.status ?? "?"}`);

// 6. Public connection details for the website
step("Fetching the public (anon) key");
const keys = await call("GET", `${API}/api-keys`);
const anon = keys.find((k) => k.name === "anon") || keys.find((k) => k.type === "publishable");
if (!anon || !anon.api_key) die("Couldn't find the project's anon/publishable key.");
const config = { url: `https://${REF}.supabase.co`, anonKey: anon.api_key };
await writeFile(path.join(root, "supabase.config.json"), JSON.stringify(config, null, 2) + "\n");
ok("saved to supabase.config.json");

// 7. Smoke test: the function answers (without a login it must say 401)
step("Checking the edge function responds");
const probe = await fetch(`${config.url}/functions/v1/dayblock-api`, { method: "POST", headers: { apikey: config.anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ action: "status" }) });
ok(`HTTP ${probe.status}${probe.status === 401 ? ", correctly refuses requests without a login" : ""}`);

console.log("\n✓ Supabase is ready. Build and publish the site with: node scripts/build-pages.mjs (GitHub Actions does this on push).\n");
