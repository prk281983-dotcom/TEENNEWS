// ══════════════════════════════════════════════════════════════════════
//  BRIEF NEWS APP — BACKEND SERVER v4.1
//  Node.js + Express | Render-ready
//  - 30 feed articles (fresh, last 24h)
//  - 30 catchup articles (last 3 months, hourly refresh)
//  - 5 daily5 articles (refreshed daily)
//  - Security question password reset (no email code needed)
//  - SQLite auth with bcrypt
// ══════════════════════════════════════════════════════════════════════

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
const GNEWS_KEY  = process.env.NEWS_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const PORT       = process.env.PORT || 3001;

const resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;

// ── SQLite ────────────────────────────────────────────────────────
const db = new Database(path.join("/tmp", "brief.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    security_question TEXT,
    security_answer TEXT,
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

// Safe migrations for existing DBs (no-op if column already exists)
try { db.exec(`ALTER TABLE users ADD COLUMN security_question TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN security_answer TEXT`); } catch (_) {}

// ── In-memory news cache ──────────────────────────────────────────
const cache = {
  feed:    { articles: [], fetchedAt: 0 },
  catchup: { articles: [], fetchedAt: 0 },
  daily5:  { articles: [], fetchedAt: 0, day: '' },
};
const FEED_TTL    = 60 * 60 * 1000;
const CATCHUP_TTL = 60 * 60 * 1000;
const DAILY5_TTL  = 24 * 60 * 60 * 1000;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── GNews fetcher ─────────────────────────────────────────────────
async function fetchGNews(type) {
  const now   = Date.now();
  const today = new Date().toISOString().split('T')[0];

  if (type === 'feed'    && cache.feed.articles.length    > 0 && now - cache.feed.fetchedAt    < FEED_TTL)    { console.log(`[feed] Serving from cache`);    return cache.feed.articles; }
  if (type === 'catchup' && cache.catchup.articles.length > 0 && now - cache.catchup.fetchedAt < CATCHUP_TTL) { console.log(`[catchup] Serving from cache`); return cache.catchup.articles; }
  if (type === 'daily5'  && cache.daily5.articles.length  > 0 && cache.daily5.day === today)                  { console.log(`[daily5] Serving from cache`);  return cache.daily5.articles; }

  if (!GNEWS_KEY) throw new Error("NEWS_API_KEY not set");
  console.log(`[${type}] Fetching fresh headlines from GNews...`);

  const allArticles = [];

  if (type === 'feed') {
    const topics = ["world", "nation", "technology", "science", "health", "entertainment"];
    for (const topic of topics) {
      try {
        const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=5&topic=${topic}&apikey=${GNEWS_KEY}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
        await delay(300);
      } catch (e) { console.error(`[GNews feed/${topic}]`, e.message); }
    }
  } else if (type === 'catchup') {
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const queries = [
      "world politics", "economy finance", "climate environment",
      "technology artificial intelligence", "conflict war", "science discovery"
    ];
    for (const q of queries) {
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=5&from=${threeMonthsAgo}T00:00:00Z&sortby=relevance&apikey=${GNEWS_KEY}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
        await delay(300);
      } catch (e) { console.error(`[GNews catchup/${q}]`, e.message); }
    }
  } else if (type === 'daily5') {
    try {
      const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=5&topic=world&apikey=${GNEWS_KEY}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.articles) allArticles.push(...data.articles);
    } catch (e) { console.error(`[GNews daily5]`, e.message); }
  }

  const filtered = allArticles
    .filter(a => a.title && a.description && a.title !== "[Removed]" && a.url)
    .map((a, i) => ({
      id:          `${type}-${i}-${Date.now()}`,
      title:       a.title,
      description: a.description,
      content:     a.content || a.description,
      url:         a.url,
      image:       a.image || null,
      publishedAt: a.publishedAt,
      source:      { name: a.source?.name || "News" },
    }));

  cache[type].articles  = filtered;
  cache[type].fetchedAt = now;
  if (type === 'daily5') cache.daily5.day = today;
  console.log(`[${type}] Cached ${filtered.length} articles`);
  return filtered;
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Sign Up ───────────────────────────────────────────────────────
app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)    return res.status(400).json({ error: "Email and password are required." });
  if (!email.includes("@"))   return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8)    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: "An account with this email already exists." });

    const hash = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
    console.log(`[Auth] New user: ${email}`);
    res.json({ success: true, email });
  } catch (e) {
    console.error("[Signup]", e.message);
    res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

// ── Sign In ───────────────────────────────────────────────────────
app.post("/api/auth/signin", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) return res.status(401).json({ error: "No account found with this email." });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Incorrect password." });

    console.log(`[Auth] Sign in: ${email}`);
    res.json({ success: true, email: user.email });
  } catch (e) {
    console.error("[Signin]", e.message);
    res.status(500).json({ error: "Sign in failed. Please try again." });
  }
});

// ── Set Security Question (mandatory during signup) ───────────────
app.post("/api/auth/set-security-question", (req, res) => {
  const { email, question, answer } = req.body || {};
  if (!email || !question || !answer)
    return res.status(400).json({ error: "All fields are required." });

  try {
    const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (!user) return res.status(404).json({ error: "Account not found." });

    db.prepare("UPDATE users SET security_question = ?, security_answer = ? WHERE email = ?")
      .run(question, answer.trim().toLowerCase(), email);

    console.log(`[Auth] Security question set for ${email}`);
    res.json({ success: true });
  } catch (e) {
    console.error("[SetSQ]", e.message);
    res.status(500).json({ error: "Could not save security question." });
  }
});

// ── Get Security Question (for forgot password flow) ──────────────
app.post("/api/auth/get-security-question", (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email is required." });

  try {
    const user = db.prepare("SELECT security_question FROM users WHERE email = ?").get(email);
    if (!user)
      return res.status(404).json({ error: "No account found with that email." });
    if (!user.security_question)
      return res.status(404).json({ error: "No security question set for this account. Contact support." });

    res.json({ question: user.security_question });
  } catch (e) {
    console.error("[GetSQ]", e.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ── Verify Security Question Answer ──────────────────────────────
app.post("/api/auth/verify-security-question", (req, res) => {
  const { email, answer } = req.body || {};
  if (!email || !answer) return res.status(400).json({ error: "All fields are required." });

  try {
    const user = db.prepare("SELECT security_answer FROM users WHERE email = ?").get(email);
    if (!user || !user.security_answer)
      return res.status(404).json({ error: "No security question found for this account." });

    const match = user.security_answer === answer.trim().toLowerCase();
    if (!match) return res.json({ success: false });

    res.json({ success: true });
  } catch (e) {
    console.error("[VerifySQ]", e.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ── Reset Password via Security Question ──────────────────────────
app.post("/api/auth/reset-password-sq", async (req, res) => {
  const { email, newPassword } = req.body || {};
  if (!email || !newPassword)  return res.status(400).json({ error: "All fields are required." });
  if (newPassword.length < 8)  return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (!user) return res.status(404).json({ error: "Account not found." });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);

    console.log(`[Auth] Password reset via security question for ${email}`);
    res.json({ success: true });
  } catch (e) {
    console.error("[ResetPasswordSQ]", e.message);
    res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

// ── Change Email ──────────────────────────────────────────────────
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

// ── Change Password ───────────────────────────────────────────────
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
//  HEALTH & ROOT
// ═══════════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({
    status:         "ok",
    gNewsConnected: !!GNEWS_KEY,
    resendConnected:!!RESEND_KEY,
    feedCached:     cache.feed.articles.length,
    catchupCached:  cache.catchup.articles.length,
    daily5Cached:   cache.daily5.articles.length,
    feedCachedAt:   cache.feed.fetchedAt ? new Date(cache.feed.fetchedAt).toISOString() : null,
    uptime:         Math.round(process.uptime()) + "s",
  });
});

app.get("/health", (req, res) => res.redirect("/api/health"));
app.get("/",       (req, res) => res.json({ name: "Brief News API v4.1", status: "running" }));

// ── Keep-alive ping every 10 minutes (Render free tier) ──────────
setInterval(async () => {
  try {
    await fetch(`https://teennews-6.onrender.com/api/health`);
    console.log("[KeepAlive] Pinged");
  } catch (_) {}
}, 10 * 60 * 1000);

// ── Pre-warm cache on startup ─────────────────────────────────────
async function warmCache() {
  console.log("[Startup] Pre-warming news cache...");
  try { await fetchGNews("feed");    } catch (e) { console.error("[Startup] Feed warm failed:",    e.message); }
  try { await fetchGNews("catchup"); } catch (e) { console.error("[Startup] Catchup warm failed:", e.message); }
  try { await fetchGNews("daily5");  } catch (e) { console.error("[Startup] Daily5 warm failed:",  e.message); }
}

app.listen(PORT, () => {
  console.log(`Brief backend running on port ${PORT}`);
  if (!GNEWS_KEY)  console.warn("⚠️  NEWS_API_KEY not set — news routes will fail");
  if (!RESEND_KEY) console.warn("⚠️  RESEND_API_KEY not set — password reset emails disabled");
  warmCache();
});
