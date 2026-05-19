// ══════════════════════════════════════════════════════════════════
//  BRIEF NEWS APP — BACKEND SERVER
//  Node.js + Express | Render-ready | No Anthropic needed
//  - GNews headlines cached in memory (1 call/hour max)
//  BRIEF NEWS APP — BACKEND SERVER v4.0
//  Node.js + Express | Render-ready
//  - 30 feed articles (fresh, last 24h)
//  - 30 catchup articles (last 3 months, hourly refresh)
//  - 5 daily5 articles (refreshed daily)
//  - 6-digit code password reset via Resend
//  - SQLite auth with bcrypt
//  - Resend password reset emails
// ══════════════════════════════════════════════════════════════════

const express = require("express");
@@ -34,10 +36,10 @@ db.exec(`
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reset_tokens (
  CREATE TABLE IF NOT EXISTS reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
@@ -46,56 +48,88 @@ db.exec(`

// ── In-memory news cache ──────────────────────────────────────────
const cache = {
  feed: { articles: [], fetchedAt: 0 },
  feed:    { articles: [], fetchedAt: 0 },
  catchup: { articles: [], fetchedAt: 0 },
  daily5:  { articles: [], fetchedAt: 0, day: '' },
};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const FEED_TTL    = 60 * 60 * 1000;       // 1 hour
const CATCHUP_TTL = 60 * 60 * 1000;       // 1 hour
const DAILY5_TTL  = 24 * 60 * 60 * 1000; // 24 hours

// ── GNews fetcher ─────────────────────────────────────────────────
async function fetchGNews(type) {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // Return cache if still fresh
  if (cache[type].articles.length > 0 && now - cache[type].fetchedAt < CACHE_TTL) {
    console.log(`[${type}] Serving from cache (${Math.round((CACHE_TTL - (now - cache[type].fetchedAt)) / 60000)}m left)`);
    return cache[type].articles;
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

  if (type === "feed") {
    // Top headlines across categories — 5 topics × 6 articles = up to 30
    const topics = ["world", "nation", "technology", "science", "health"];
  if (type === 'feed') {
    // 6 topics × 5 articles = up to 30 fresh articles
    const topics = ["world", "nation", "technology", "science", "health", "entertainment"];
    for (const topic of topics) {
      try {
        const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=6&topic=${topic}&apikey=${GNEWS_KEY}`;
        const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=5&topic=${topic}&apikey=${GNEWS_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
        await new Promise(r => setTimeout(r, 200)); // small delay between calls
        await delay(300);
      } catch (e) {
        console.error(`[GNews feed/${topic}]`, e.message);
      }
    }
  } else {
    // Catchup: past 3 months across different queries
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().split("T")[0];
    const queries = ["world politics", "economy trade", "climate", "technology AI", "conflict"];
  } else if (type === 'catchup') {
    // 6 queries × 5 articles = up to 30 articles from last 3 months
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const queries = [
      "world politics", "economy finance", "climate environment",
      "technology artificial intelligence", "conflict war", "science discovery"
    ];
    for (const q of queries) {
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=6&from=${threeMonthsAgo}T00:00:00Z&sortby=relevance&apikey=${GNEWS_KEY}`;
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=5&from=${threeMonthsAgo}T00:00:00Z&sortby=relevance&apikey=${GNEWS_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
        await new Promise(r => setTimeout(r, 200));
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
@@ -114,10 +148,15 @@ async function fetchGNews(type) {
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
@@ -168,35 +207,37 @@ app.post("/api/auth/signin", async (req, res) => {
  }
});

// ── Send 6-digit reset code ───────────────────────────────────────
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email)
    return res.status(400).json({ error: "Email is required." });

  // Always return success to prevent email enumeration
  res.json({ success: true, message: "If an account exists with that email, a reset link has been sent." });
  res.json({ success: true, message: "If an account exists with that email, a 6-digit code has been sent." });

  // Send email in background (don't await)
  (async () => {
    try {
      const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (!user) return;

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

      // Clean up old tokens for this email
      db.prepare("DELETE FROM reset_tokens WHERE email = ?").run(email);
      db.prepare("INSERT INTO reset_tokens (email, token, expires_at) VALUES (?, ?, ?)").run(email, token, expiresAt);
      // Generate 6-digit code
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

      if (!resend) { console.log(`[ForgotPassword] No Resend key — token for ${email}: ${token}`); return; }
      // Clean up old codes for this email
      db.prepare("DELETE FROM reset_codes WHERE email = ?").run(email);
      db.prepare("INSERT INTO reset_codes (email, code, expires_at) VALUES (?, ?, ?)").run(email, code, expiresAt);

      const resetLink = `briefnews://reset-password?token=${token}&email=${encodeURIComponent(email)}`;
      if (!resend) {
        console.log(`[ForgotPassword] No Resend key — code for ${email}: ${code}`);
        return;
      }

      await resend.emails.send({
        from: "Brief <onboarding@resend.dev>",
        to: email,
        subject: "Reset your Brief password",
        subject: "Your Brief password reset code",
        html: `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
@@ -208,24 +249,17 @@ app.post("/api/auth/forgot-password", async (req, res) => {
    <div style="font-size:13px;color:rgba(255,255,255,0.8);">World news, made clear.</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#f1f5f9;">Reset your password</h2>
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#f1f5f9;">Your reset code</h2>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#94a3b8;">
      We received a request to reset the password for <strong style="color:#f1f5f9;">${email}</strong>.
      Tap the button below to set a new password. This link expires in <strong style="color:#f1f5f9;">1 hour</strong>.
      Enter this 6-digit code in the Brief app to reset your password for
      <strong style="color:#f1f5f9;">${email}</strong>.
      This code expires in <strong style="color:#f1f5f9;">15 minutes</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="padding:0 0 28px;">
        <a href="${resetLink}" style="display:inline-block;background:#D4622A;color:#fff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:50px;">
          Reset Password
        </a>
      </td></tr>
    </table>
    <div style="background:#232938;border-radius:12px;padding:16px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#64748b;letter-spacing:1px;text-transform:uppercase;">Or copy this link</p>
      <p style="margin:0;font-size:12px;color:#94a3b8;word-break:break-all;line-height:18px;">${resetLink}</p>
    <div style="background:#D4622A18;border:2px solid #D4622A44;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:900;color:#D4622A;letter-spacing:12px;">${code}</div>
    </div>
    <p style="margin:0;font-size:13px;color:#64748b;line-height:20px;">
      If you didn't request a password reset, you can safely ignore this email — your account is secure.
      If you didn't request this, you can safely ignore this email.
    </p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #2d3748;text-align:center;">
@@ -237,50 +271,52 @@ app.post("/api/auth/forgot-password", async (req, res) => {
</body>
</html>`,
      });
      console.log(`[ForgotPassword] Reset email sent to ${email}`);
      console.log(`[ForgotPassword] Reset code sent to ${email}`);
    } catch (e) {
      console.error("[ForgotPassword]", e.message);
    }
  })();
});

app.post("/api/auth/verify-reset-token", (req, res) => {
  const { token, email } = req.body || {};
  if (!token || !email)
    return res.status(400).json({ error: "Token and email are required." });
// ── Verify 6-digit code ───────────────────────────────────────────
app.post("/api/auth/verify-reset-code", (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code)
    return res.status(400).json({ error: "Email and code are required." });

  const record = db
    .prepare("SELECT * FROM reset_tokens WHERE token = ? AND email = ? AND used = 0")
    .get(token, email);
    .prepare("SELECT * FROM reset_codes WHERE email = ? AND code = ? AND used = 0")
    .get(email, code);

  if (!record)
    return res.status(400).json({ error: "This reset link is invalid or has already been used." });
    return res.status(400).json({ error: "Invalid code. Please check and try again." });
  if (Date.now() > record.expires_at)
    return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    return res.status(400).json({ error: "This code has expired. Please request a new one." });

  res.json({ success: true });
});

// ── Reset password with verified code ────────────────────────────
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, email, newPassword } = req.body || {};
  if (!token || !email || !newPassword)
    return res.status(400).json({ error: "Token, email, and new password are required." });
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword)
    return res.status(400).json({ error: "Email, code, and new password are required." });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const record = db
      .prepare("SELECT * FROM reset_tokens WHERE token = ? AND email = ? AND used = 0")
      .get(token, email);
      .prepare("SELECT * FROM reset_codes WHERE email = ? AND code = ? AND used = 0")
      .get(email, code);

    if (!record)
      return res.status(400).json({ error: "This reset link is invalid or has already been used." });
      return res.status(400).json({ error: "Invalid code. Please request a new one." });
    if (Date.now() > record.expires_at)
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
      return res.status(400).json({ error: "This code has expired. Please request a new one." });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);
    db.prepare("UPDATE reset_tokens SET used = 1 WHERE id = ?").run(record.id);
    db.prepare("UPDATE reset_codes SET used = 1 WHERE id = ?").run(record.id);

    console.log(`[Auth] Password reset for ${email}`);
    res.json({ success: true, message: "Password updated successfully." });
@@ -345,12 +381,7 @@ app.post("/api/auth/change-password", async (req, res) => {
app.get("/api/news/feed", async (req, res) => {
  try {
    const articles = await fetchGNews("feed");
    res.json({
      articles,
      count: articles.length,
      cachedAt: new Date(cache.feed.fetchedAt).toISOString(),
      nextRefresh: new Date(cache.feed.fetchedAt + CACHE_TTL).toISOString(),
    });
    res.json({ articles, count: articles.length, cachedAt: new Date(cache.feed.fetchedAt).toISOString() });
  } catch (e) {
    console.error("[Feed route]", e.message);
    res.status(500).json({ error: e.message, articles: [] });
@@ -360,39 +391,46 @@ app.get("/api/news/feed", async (req, res) => {
app.get("/api/news/catchup", async (req, res) => {
  try {
    const articles = await fetchGNews("catchup");
    res.json({
      articles,
      count: articles.length,
      cachedAt: new Date(cache.catchup.fetchedAt).toISOString(),
    });
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

app.get("/health", (req, res) => {
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    gNewsConnected: !!GNEWS_KEY,
    resendConnected: !!RESEND_KEY,
    feedCached: cache.feed.articles.length,
    catchupCached: cache.catchup.articles.length,
    feedCachedAt: cache.feed.fetchedAt ? new Date(cache.feed.fetchedAt).toISOString() : null,
    daily5Cached: cache.daily5.articles.length,
    uptime: Math.round(process.uptime()) + "s",
  });
});

app.get("/", (req, res) => res.json({ name: "Brief News API", status: "running" }));
app.get("/health", (req, res) => res.redirect("/api/health"));
app.get("/", (req, res) => res.json({ name: "Brief News API v4", status: "running" }));

// Keep-alive ping every 10 minutes to prevent Render free tier sleep
// Keep-alive ping every 10 minutes
setInterval(async () => {
  try {
    await fetch(`https://teennews-2.onrender.com/health`);
    await fetch(`https://teennews-5.onrender.com/api/health`);
    console.log("[KeepAlive] Pinged");
  } catch (_) {}
}, 10 * 60 * 1000);
@@ -402,13 +440,13 @@ async function warmCache() {
  console.log("[Startup] Pre-warming news cache...");
  try { await fetchGNews("feed"); } catch (e) { console.error("[Startup] Feed warm failed:", e.message); }
  try { await fetchGNews("catchup"); } catch (e) { console.error("[Startup] Catchup warm failed:", e.message); }
  try { await fetchGNews("daily5"); } catch (e) { console.error("[Startup] Daily5 warm failed:", e.message); }
  console.log("[Startup] Cache warm complete.");
}

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Brief backend running on port ${PORT}`);
  if (!GNEWS_KEY) console.warn("⚠️  NEWS_API_KEY not set — news routes will fail");
  if (!RESEND_KEY) console.warn("⚠️  RESEND_API_KEY not set — password reset emails disabled");
  warmCache(); // non-blocking
  warmCache();
});
