// Builds the static GitHub Pages demo into ./site:
//   site/index.html    the intro page, with buttons pointing at the planner
//   site/planner.html  the planner in "static demo" mode (browser storage, offline parser)
// Accounts, email sign-in, the dashboard, settings and server AI need the Node server,
// so they are not part of this build.
//
// Run: node scripts/build-pages.mjs

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "site");

// Fail loudly if a page changed in a way this script doesn't expect.
function replaceOnce(html, find, replacement, label) {
  const count = typeof find === "string" ? html.split(find).length - 1 : (html.match(new RegExp(find.source, find.flags.includes("g") ? find.flags : find.flags + "g")) || []).length;
  if (count !== 1) throw new Error(`build-pages: expected exactly one match for "${label}", found ${count}`);
  return html.replace(find, replacement);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/* ---------- Full app (Supabase) or demo? ---------- */
let supa = null;
try { supa = JSON.parse(await readFile(path.join(root, "supabase.config.json"), "utf8")); } catch {}
if (supa && supa.url && supa.anonKey) {
  await buildFull(supa);
  process.exit(0);
}

/* ---------- Planner ---------- */
const planner = await readFile(path.join(root, "index.html"), "utf8");
await writeFile(path.join(out, "planner.html"),
  `<!doctype html><html lang="en" data-static="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${planner}</body></html>`);

/* ---------- Intro page ---------- */
let landing = await readFile(path.join(root, "landing.html"), "utf8");
const tryBtn = (cls, label) => `<a class="btn ${cls}" href="planner.html">${label} <span class="arrow" aria-hidden="true">→</span></a>`;

landing = replaceOnce(landing,
  /<div class="actions" id="headerActions">[\s\S]*?<\/div>/,
  `<div class="actions" id="headerActions">\n      <a class="btn btn-primary" href="planner.html">Try the planner</a>\n    </div>`,
  "header actions");
landing = replaceOnce(landing,
  /<div class="ctas" id="heroCtas">[\s\S]*?<\/div>/,
  `<div class="ctas" id="heroCtas">\n          ${tryBtn("btn-primary btn-lg", "Try the planner")}\n          <a class="btn btn-login btn-lg" href="#features">See features</a>\n        </div>`,
  "hero buttons");
landing = replaceOnce(landing,
  /<div class="ctas" id="footCtas">[\s\S]*?<\/div>/,
  `<div class="ctas" id="footCtas">\n          ${tryBtn("btn-primary btn-lg", "Open the planner")}\n        </div>`,
  "closing buttons");
landing = replaceOnce(landing,
  '<div class="fine"><span>Free to use</span><span>Works on phone and desktop</span><span>Email-verified sign-in</span></div>',
  '<div class="fine"><span>Free to use</span><span>Works on phone and desktop</span><span>No sign-up for the demo</span></div>',
  "hero fine print");
landing = replaceOnce(landing,
  /<a href="\/login">Log in<\/a>\s*<a href="\/signup">Sign up<\/a>/,
  '<a href="planner.html">Planner</a>',
  "footer links");
landing = replaceOnce(landing, "Create a free account and turn your next brain dump into a day that works.",
  "Open the planner and turn your next brain dump into a day that works.", "closing text");
// The logged-in check calls the server's API, which doesn't exist here.
landing = replaceOnce(landing, /\s*\/\/ Already logged in\?[\s\S]*?\}\)\.catch\(\(\) => \{\}\);/, "", "logged-in check");
landing = landing.replaceAll('href="/"', 'href="./"');

// A slim banner under the header explaining what the demo includes.
landing = replaceOnce(landing, "<main>", `<div class="demo-banner" role="note"><div class="wrap">
    <b>Demo version.</b> The planner runs entirely in your browser and saves your plan on this device only. Accounts, email sign-in, the dashboard and the AI assistant are part of the full app.
  </div></div>
<main>`, "main start");
landing = replaceOnce(landing, "</style>", `.demo-banner { background: var(--accent-soft); color: var(--fg); font-size: 14px; border-bottom: 1px solid var(--line); }
.demo-banner .wrap { padding-block: 10px; }
.demo-banner b { color: var(--accent); }
</style>`, "styles end");

await writeFile(path.join(out, "index.html"), landing);
await writeFile(path.join(out, ".nojekyll"), "");

// Guard: the demo must not reference server-only routes.
for (const f of ["index.html"]) {
  const html = await readFile(path.join(out, f), "utf8");
  const bad = html.match(/href="\/(login|signup|dashboard|settings|planner)"/);
  if (bad) throw new Error(`build-pages: ${f} still links to the server route ${bad[0]}`);
}
console.log("Supabase isn't configured (supabase.config.json), so built the browser-only demo into site/ (index.html, planner.html)");

/* ---------- Full app: same pages as localhost, backed by Supabase ---------- */
async function buildFull(cfg) {
  const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  const config = JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey }).replace(/</g, "\\u003c");
  const backendTags = `<script>window.DAYBLOCK_SUPABASE=${config};</script><script src="${SUPABASE_JS}"></script><script src="supabase-backend.js"></script>`;

  // github.io serves the site from /<repo>/, so server-style absolute links become relative files.
  // Each build also stamps its links with ?v=<build>, because GitHub Pages lets browsers reuse a
  // page for 10 minutes: without it, moving between pages right after a deploy can show old ones.
  const BUILD = (process.env.GITHUB_SHA || "").slice(0, 7) || Date.now().toString(36);
  const rewritePaths = (html) => html
    .replace(/(["'`(=])\/(login|signup|dashboard|planner|settings)(?=(["'`?#]))/g, (m, pre, page, next) => `${pre}${page}.html?v=${BUILD}${next === "?" ? "&" : ""}`)
    .replace(/(\.html\?v=[a-z0-9]+)&\?/g, "$1&")
    .replaceAll('href="/"', `href="./?v=${BUILD}"`);
  const withBackend = (html, label) => {
    if (!/<meta charset="utf-8">/i.test(html)) throw new Error(`build-pages: no <meta charset> in ${label}`);
    return html.replace(/<meta charset="utf-8">/i, (m) => m + backendTags);
  };

  const pages = [
    ["landing.html", "index.html"],
    ["auth.html", "login.html"],
    ["auth.html", "signup.html"],
    ["dashboard.html", "dashboard.html"],
    ["settings.html", "settings.html"],
  ];
  for (const [src, dest] of pages) {
    const html = await readFile(path.join(root, src), "utf8");
    await writeFile(path.join(out, dest), withBackend(rewritePaths(html), src));
  }
  const planner = rewritePaths(await readFile(path.join(root, "index.html"), "utf8"));
  await writeFile(path.join(out, "planner.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${backendTags}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${planner}</body></html>`);
  await writeFile(path.join(out, "supabase-backend.js"), await readFile(path.join(root, "web", "supabase-backend.js"), "utf8"));
  await writeFile(path.join(out, ".nojekyll"), "");

  // Guard: nothing may still point at a server-only absolute route.
  for (const f of ["index.html", "login.html", "dashboard.html", "settings.html", "planner.html"]) {
    const html = await readFile(path.join(out, f), "utf8");
    const bad = html.match(/["'`(=]\/(login|signup|dashboard|planner|settings)["'`?#]/);
    if (bad) throw new Error(`build-pages: ${f} still has an absolute link ${bad[0]}`);
  }
  console.log("Built the full app for GitHub Pages into site/ (Supabase: " + cfg.url + ")");
}
