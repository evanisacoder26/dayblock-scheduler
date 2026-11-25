// Sends Dayblock's verification-code emails.
//
// Pick one in .env:
//   Resend:  RESEND_API_KEY=re_...                 EMAIL_FROM="Dayblock <codes@yourdomain.com>"
//   SMTP:    SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USER=you@gmail.com SMTP_PASS=<app password>
//            EMAIL_FROM="Dayblock <you@gmail.com>"   (optional; defaults to SMTP_USER)
// With neither set, the server runs in development mode and prints codes to its console.

export function createMailer(env = process.env) {
  const mode = env.RESEND_API_KEY ? "resend" : env.SMTP_HOST ? "smtp" : "dev";
  const from = env.EMAIL_FROM || env.SMTP_USER || "Dayblock <onboarding@resend.dev>";
  let transport = null;

  async function smtpTransport() {
    if (transport) return transport;
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    return transport;
  }

  function compose({ code, purpose, name }) {
    const action = purpose === "signup" ? "finish creating your Dayblock account"
      : purpose === "email-change" ? "confirm this as the new email for your Dayblock account" : "log in to Dayblock";
    const footer = purpose === "signup" ? "If you didn't try to create an account, you can ignore this email."
      : purpose === "email-change" ? "If you didn't ask to change your email, you can ignore this email. Nothing will change."
      : "If this wasn't you, someone knows your password. Log in and change it from your account settings.";
    const subject = `${code} is your Dayblock code`;
    const text = [
      `Hi${name ? ` ${name}` : ""},`,
      "",
      `Use this code to ${action}:`,
      "",
      `    ${code}`,
      "",
      "It expires in 10 minutes.",
      "",
      footer,
    ].join("\n");
    const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:700">Dayblock</td></tr>
<tr><td style="padding:8px 28px;font-size:15px;line-height:1.5">Hi${name ? ` ${escapeHtml(name)}` : ""}, use this code to ${action}:</td></tr>
<tr><td style="padding:16px 28px"><div style="font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;background:#eef2ff;color:#3730a3;border-radius:10px;padding:16px;text-align:center">${code}</div></td></tr>
<tr><td style="padding:0 28px 8px;font-size:13px;color:#475569">It expires in 10 minutes.</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:13px;color:#64748b">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
    return { subject, text, html };
  }

  async function sendCode({ to, code, purpose, name }) {
    const msg = compose({ code, purpose, name });
    if (mode === "dev") {
      console.log(`\n[dev email] To: ${to}\n[dev email] ${msg.subject}\n`);
      return;
    }
    if (mode === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`Resend ${res.status}: ${j.message || j.name || "send failed"}`);
      }
      return;
    }
    const t = await smtpTransport();
    await t.sendMail({ from, to, subject: msg.subject, text: msg.text, html: msg.html });
  }

  // Plain security notices (e.g. "your email was changed"), sent to a different address than the code.
  async function sendNotice({ to, subject, lines }) {
    const text = lines.join("\n\n");
    const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:700">Dayblock</td></tr>
${lines.map((l) => `<tr><td style="padding:8px 28px;font-size:14px;line-height:1.55">${escapeHtml(l)}</td></tr>`).join("")}
<tr><td style="padding:0 0 20px"></td></tr></table></td></tr></table></body></html>`;
    if (mode === "dev") { console.log(`\n[dev email] To: ${to}\n[dev email] ${subject}\n${text}\n`); return; }
    if (mode === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}`);
      return;
    }
    const t = await smtpTransport();
    await t.sendMail({ from, to, subject, text, html });
  }

  return { mode, sendCode, sendNotice };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return email;
  const shown = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(2, Math.min(6, user.length - shown.length)))}@${domain}`;
}
