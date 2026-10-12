// Kakuli Saree — main-site Worker.
// Serves the Opening Soon landing page and the /api/notify endpoint
// (Supabase insert + Resend thank-you email).
//
// Required Workers env/secrets:
//   RESEND_API_KEY   (secret)  — set via Workers Secrets, scope: Send emails
//   Optional:
//   NOTIFY_FROM_EMAIL          — defaults to "Kakuli Saree <hello@kakulisaree.com>"
//   NOTIFY_REPLY_TO            — defaults to NOTIFY_FROM_EMAIL
//
// Supabase config is baked in: the anon key is public-safe (no RLS escape;
// RLS policy only lets anon INSERT, never SELECT).

const SUPABASE_URL = "https://oqoqsxdblqqnijocnmtg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xb3FzeGRibHFxbmlqb2NubXRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2NDU5NTEsImV4cCI6MjEwNzIyMTk1MX0.WrEZ1nzIiLVlQkCSLIGDkFQ_GgnxdOjOApCFXt4FEF4";

const HTML_PAGE = `__HTML__`;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function htmlResponse() {
  return new Response(HTML_PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=600",
      ...SECURITY_HEADERS,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  });
}

async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function insertSignup({ email, userAgent, ipHash }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/notify_signups`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      email,
      source: "opening-soon-landing-cf",
      user_agent: userAgent,
      ip_hash: ipHash,
    }),
  });
  if (res.status === 201 || res.status === 200) return { ok: true, duplicate: false };
  if (res.status === 409) return { ok: true, duplicate: true };
  const text = await res.text();
  return { ok: false, status: res.status, text };
}

async function sendThankYouEmail(email, env) {
  if (!env.RESEND_API_KEY) {
    console.log("notify.email_skipped.no_api_key", { email });
    return { sent: false, reason: "no_api_key" };
  }
  const from = env.NOTIFY_FROM_EMAIL || "Kakuli Saree <hello@kakulisaree.com>";
  const replyTo = env.NOTIFY_REPLY_TO || from.replace(/^.*<|>.*$/g, "");

  const subject = "You're on the list — thank you ✨";
  const text = [
    "Namaskar,",
    "",
    "Thank you for signing up for Kakuli Saree.",
    "We're putting the finishing touches on our collection — handpicked sarees",
    "from the heart of Kolkata — and will send you one note the day we open.",
    "",
    "Until then, follow us on Facebook for live sales and new arrivals.",
    "",
    "— Team Kakuli Saree",
    "Kolkata, India",
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,'Times New Roman',serif;max-width:520px;margin:0 auto;color:#2A1D1D;line-height:1.6">
      <p style="font-size:17px">Namaskar,</p>
      <p>Thank you for signing up for <strong style="color:#8B1538">Kakuli Saree</strong>.</p>
      <p>We're putting the finishing touches on our collection — handpicked sarees from the heart of Kolkata — and will send you one note the day we open.</p>
      <p>Until then, follow us on Facebook for live sales and new arrivals.</p>
      <p style="margin-top:28px;color:#6B5B5B;font-style:italic">— Team Kakuli Saree<br>Kolkata, India</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      reply_to: replyTo,
      subject,
      text,
      html,
    }),
  });
  if (res.ok) {
    const data = await res.json();
    return { sent: true, id: data.id };
  }
  const errText = await res.text().catch(() => "");
  console.log("notify.email_failed", { email, status: res.status, errText });
  return { sent: false, reason: `resend_${res.status}` };
}

async function markThanked(email) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/notify_signups?email=eq.${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({ thanked_at: new Date().toISOString() }),
    },
  ).catch(() => {});
}

async function handleNotify(request, env, ctx) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "Please enter a valid email." }, 400);
  }

  const userAgent = (request.headers.get("user-agent") || "").slice(0, 500);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? await sha256Hex(ip + ":" + email) : null;

  const inserted = await insertSignup({ email, userAgent, ipHash });
  if (!inserted.ok) {
    console.log("notify.insert_failed", inserted);
    return json({ error: "Could not save. Please try again." }, 500);
  }

  // Thank-you email + mark-thanked run in the background. The user gets an
  // immediate OK response; email delivery doesn't block their UI.
  // Only send on first signup (not on duplicates) to avoid spamming them.
  if (!inserted.duplicate) {
    ctx.waitUntil(
      (async () => {
        const result = await sendThankYouEmail(email, env);
        if (result.sent) await markThanked(email);
      })(),
    );
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/notify") {
      return handleNotify(request, env, ctx);
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return htmlResponse();
    }

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain", ...SECURITY_HEADERS },
    });
  },
};
