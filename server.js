// ══════════════════════════════════════════════════════════════════
//  BRIEF NEWS APP — BACKEND SERVER v4.0
//  Node.js + Express | Render-ready
//  - 30 feed articles (fresh, last 24h)
//  - 30 catchup articles (last 3 months, hourly refresh)
//  - 5 daily5 articles (refreshed daily)
//  - 6-digit code password reset via Resend
//  - SQLite auth with bcrypt
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Resend } = require("resend");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ── Env vars ──────────────────────────────────────────────────────
const GNEWS_KEY = process.env.NEWS_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const PORT = process.env.PORT || 3001;

const resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;

// ── SQLite ────────────────────────────────────────────────────────
const db = new Database(path.join("/tmp", "brief.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── In-memory news cache ──────────────────────────────────────────
const cache = {
  feed:    { articles: [], fetchedAt: 0 },
  catchup: { articles: [], fetchedAt: 0 },
  daily5:  { articles: [], fetchedAt: 0, day: '' },
};
const FEED_TTL    = 60 * 60 * 1000;       // 1 hour
const CATCHUP_TTL = 60 * 60 * 1000;       // 1 hour
const DAILY5_TTL  = 24 * 60 * 60 * 1000; // 24 hours

// ── GNews fetcher ─────────────────────────────────────────────────
async function fetchGNews(type) {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // Return cache if still fresh
  if (type === 'feed' && cache.feed.articles.length > 0 && now - cache.feed.fetchedAt < FEED_TTL) {
    console.log(`[feed] Serving from cache`);
    return cache.feed.articles;
  }
  if (type === 'catchup' && cache.catchup.articles.length > 0 && now - cache.catchup.fetchedAt < CATCHUP_TTL) {
    console.log(`[catchup] Serving from cache`);
    return cache.catchup.articles;
  }
  if (type === 'daily5' && cache.daily5.articles.length > 0 && cache.daily5.day === today) {
    console.log(`[daily5] Serving from cache (today's stories)`);
    return cache.daily5.articles;
  }

  if (!GNEWS_KEY) throw new Error("NEWS_API_KEY not set");

  console.log(`[${type}] Fetching fresh headlines from GNews...`);
  const allArticles = [];

  if (type === 'feed') {
    // 6 topics × 5 articles = up to 30 fresh articles
    const topics = ["world", "nation", "technology", "science", "health", "entertainment"];
    for (const topic of topics) {
      try {
        const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=5&topic=${topic}&apikey=${GNEWS_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
        await delay(300);
      } catch (e) {
        console.error(`[GNews feed/${topic}]`, e.message);
      }
    }
  } else if (type === 'catchup') {
    // 6 queries × 5 articles = up to 30 articles from last 3 months
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const queries = [
      "world politics", "economy finance", "climate environment",
      "technology artificial intelligence", "conflict war", "science discovery"
    ];
    for (const q of queries) {
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=5&from=${threeMonthsAgo}T00:00:00Z&sortby=relevance&apikey=${GNEWS_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
        await delay(300);
      } catch (e) {
        console.error(`[GNews catchup/${q}]`, e.message);
      }
    }
  } else if (type === 'daily5') {
    // Top 5 most important stories of the day
    try {
      const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=5&topic=breaking-news&apikey=${GNEWS_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.articles) allArticles.push(...data.articles);
    } catch (e) {
      // Fallback to world headlines
      try {
        const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=5&topic=world&apikey=${GNEWS_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
      } catch (e2) {
        console.error(`[GNews daily5]`, e2.message);
      }
    }
  }

  const filtered = allArticles
    .filter(a => a.title && a.description && a.title !== "[Removed]" && a.url)
    .map((a, i) => ({
      id: `${type}-${i}-${Date.now()}`,
      title: a.title,
      description: a.description,
      content: a.content || a.description,
      url: a.url,
      image: a.image || null,
      publishedAt: a.publishedAt,
      source: { name: a.source?.name || "News" },
    }));

  // Update cache
  cache[type].articles = filtered;
  cache[type].fetchedAt = now;
  if (type === 'daily5') cache.daily5.day = today;
  console.log(`[${type}] Cached ${filtered.length} articles`);
  return filtered;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required." });
  if (!email.includes("@"))
    return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing)
      return res.status(409).json({ error: "An account with this email already exists." });

    const hash = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
    console.log(`[Auth] New user: ${email}`);
    res.json({ success: true, email });
  } catch (e) {
    console.error("[Signup]", e.message);
    res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required." });

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user)
      return res.status(401).json({ error: "No account found with this email." });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ error: "Incorrect password." });

    console.log(`[Auth] Sign in: ${email}`);
    res.json({ success: true, email: user.email });
  } catch (e) {
    console.error("[Signin]", e.message);
    res.status(500).json({ error: "Sign in failed. Please try again." });
  }
});

// ── Send 6-digit reset code ───────────────────────────────────────
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email)
    return res.status(400).json({ error: "Email is required." });

  // Always return success to prevent email enumeration
  res.json({ success: true, message: "If an account exists with that email, a 6-digit code has been sent." });

  (async () => {
    try {
      const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (!user) return;

      // Generate 6-digit code
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

      // Clean up old codes for this email
      db.prepare("DELETE FROM reset_codes WHERE email = ?").run(email);
      db.prepare("INSERT INTO reset_codes (email, code, expires_at) VALUES (?, ?, ?)").run(email, code, expiresAt);

      if (!resend) {
        console.log(`[ForgotPassword] No Resend key — code for ${email}: ${code}`);
        return;
      }

      await resend.emails.send({
        from: "Brief <onboarding@resend.dev>",
        to: email,
        subject: "Your Brief password reset code",
        html: `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:480px;background:#1a1f2e;border-radius:20px;overflow:hidden;">
  <tr><td style="background:#D4622A;padding:32px;text-align:center;">
    <div style="font-size:32px;font-weight:900;color:#fff;margin-bottom:6px;">Brief</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.8);">World news, made clear.</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#f1f5f9;">Your reset code</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#94a3b8;">
      Enter this 6-digit code in the Brief app to reset your password for
      <strong style="color:#f1f5f9;">${email}</strong>.
      This code expires in <strong style="color:#f1f5f9;">15 minutes</strong>.
    </p>
    <div style="background:#D4622A18;border:2px solid #D4622A44;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:900;color:#D4622A;letter-spacing:12px;">${code}</div>
    </div>
    <p style="margin:0;font-size:13px;color:#64748b;line-height:20px;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #2d3748;text-align:center;">
    <p style="margin:0;font-size:12px;color:#64748b;">© ${new Date().getFullYear()} Brief · World news, made clear</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
      });
      console.log(`[ForgotPassword] Reset code sent to ${email}`);
    } catch (e) {
      console.error("[ForgotPassword]", e.message);
    }
  })();
});

// ── Verify 6-digit code ───────────────────────────────────────────
app.post("/api/auth/verify-reset-code", (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code)
    return res.status(400).json({ error: "Email and code are required." });

  const record = db
    .prepare("SELECT * FROM reset_codes WHERE email = ? AND code = ? AND used = 0")
    .get(email, code);

  if (!record)
    return res.status(400).json({ error: "Invalid code. Please check and try again." });
  if (Date.now() > record.expires_at)
    return res.status(400).json({ error: "This code has expired. Please request a new one." });

  res.json({ success: true });
});

// ── Reset password with verified code ────────────────────────────
app.post("/api/auth/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword)
    return res.status(400).json({ error: "Email, code, and new password are required." });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const record = db
      .prepare("SELECT * FROM reset_codes WHERE email = ? AND code = ? AND used = 0")
      .get(email, code);

    if (!record)
      return res.status(400).json({ error: "Invalid code. Please request a new one." });
    if (Date.now() > record.expires_at)
      return res.status(400).json({ error: "This code has expired. Please request a new one." });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);
    db.prepare("UPDATE reset_codes SET used = 1 WHERE id = ?").run(record.id);

    console.log(`[Auth] Password reset for ${email}`);
    res.json({ success: true, message: "Password updated successfully." });
  } catch (e) {
    console.error("[ResetPassword]", e.message);
    res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

app.post("/api/auth/change-email", async (req, res) => {
  const { currentEmail, newEmail, password } = req.body || {};
  if (!currentEmail || !newEmail || !password)
    return res.status(400).json({ error: "All fields are required." });
  if (!newEmail.includes("@"))
    return res.status(400).json({ error: "Please enter a valid email address." });

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(currentEmail);
    if (!user) return res.status(404).json({ error: "Account not found." });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Incorrect password." });

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(newEmail);
    if (existing) return res.status(409).json({ error: "That email address is already in use." });

    db.prepare("UPDATE users SET email = ? WHERE email = ?").run(newEmail, currentEmail);
    res.json({ success: true, email: newEmail });
  } catch (e) {
    console.error("[ChangeEmail]", e.message);
    res.status(500).json({ error: "Could not update email." });
  }
});

app.post("/api/auth/change-password", async (req, res) => {
  const { email, currentPassword, newPassword } = req.body || {};
  if (!email || !currentPassword || !newPassword)
    return res.status(400).json({ error: "All fields are required." });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "New password must be at least 8 characters." });

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) return res.status(404).json({ error: "Account not found." });

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(401).json({ error: "Current password is incorrect." });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);
    res.json({ success: true });
  } catch (e) {
    console.error("[ChangePassword]", e.message);
    res.status(500).json({ error: "Could not update password." });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  NEWS ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get("/api/news/feed", async (req, res) => {
  try {
    const articles = await fetchGNews("feed");
    res.json({ articles, count: articles.length, cachedAt: new Date(cache.feed.fetchedAt).toISOString() });
  } catch (e) {
    console.error("[Feed route]", e.message);
    res.status(500).json({ error: e.message, articles: [] });
  }
});

app.get("/api/news/catchup", async (req, res) => {
  try {
    const articles = await fetchGNews("catchup");
    res.json({ articles, count: articles.length, cachedAt: new Date(cache.catchup.fetchedAt).toISOString() });
  } catch (e) {
    console.error("[Catchup route]", e.message);
    res.status(500).json({ error: e.message, articles: [] });
  }
});

app.get("/api/news/daily5", async (req, res) => {
  try {
    const articles = await fetchGNews("daily5");
    res.json({ articles, count: articles.length, cachedAt: new Date(cache.daily5.fetchedAt).toISOString() });
  } catch (e) {
    console.error("[Daily5 route]", e.message);
    res.status(500).json({ error: e.message, articles: [] });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  HEALTH + KEEP-ALIVE
// ═══════════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    gNewsConnected: !!GNEWS_KEY,
    resendConnected: !!RESEND_KEY,
    feedCached: cache.feed.articles.length,
    catchupCached: cache.catchup.articles.length,
    daily5Cached: cache.daily5.articles.length,
    uptime: Math.round(process.uptime()) + "s",
  });
});

app.get("/health", (req, res) => res.redirect("/api/health"));
app.get("/", (req, res) => res.json({ name: "Brief News API v4", status: "running" }));

// Keep-alive ping every 10 minutes
setInterval(async () => {
  try {
    await fetch(`https://teennews-5.onrender.com/api/health`);
    console.log("[KeepAlive] Pinged");
  } catch (_) {}
}, 10 * 60 * 1000);

// Pre-warm cache on startup
async function warmCache() {
  console.log("[Startup] Pre-warming news cache...");
  try { await fetchGNews("feed"); } catch (e) { console.error("[Startup] Feed warm failed:", e.message); }
  try { await fetchGNews("catchup"); } catch (e) { console.error("[Startup] Catchup warm failed:", e.message); }
  try { await fetchGNews("daily5"); } catch (e) { console.error("[Startup] Daily5 warm failed:", e.message); }
  console.log("[Startup] Cache warm complete.");
}

app.listen(PORT, () => {
  console.log(`Brief backend running on port ${PORT}`);
  if (!GNEWS_KEY) console.warn("⚠️  NEWS_API_KEY not set — news routes will fail");
  if (!RESEND_KEY) console.warn("⚠️  RESEND_API_KEY not set — password reset emails disabled");
  warmCache();
});
