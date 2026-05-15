// ══════════════════════════════════════════════════════════════════
//  BRIEF NEWS APP — BACKEND SERVER
//  Node.js + Express  |  Render-ready
//  Real auth: SQLite + Resend email password reset
//  Real news: GNews API
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Resend } = require("resend");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PEXELS_KEY = process.env.PEXELS_API_KEY;
const GNEWS_KEY = process.env.NEWS_API_KEY; // same env var name, just GNews key now
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── SQLite Database Setup ────────────────────────────────────────
const db = new Database(path.join("/tmp", "brief.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── In-memory article stores ─────────────────────────────────────
let feedArticles = [];
let catchupArticles = [];
let daily5Articles = [];
let usedImageIds = new Set();
let lastFeedRefresh = 0;
let lastDailyRefresh = 0;
let lastCatchupRefresh = 0;
let initialLoadDone = false;
let initialLoadError = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Auth Routes ──────────────────────────────────────────────────

app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required." });
  if (!email.includes("@"))
    return res.status(400).json({ error: "Invalid email address." });
  if (password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing)
      return res.status(409).json({ error: "An account with this email already exists." });

    const hash = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
    res.json({ success: true, message: "Account created successfully." });
  } catch (e) {
    console.error("[Signup] Error:", e.message);
    res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required." });

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user)
      return res.status(401).json({ error: "No account found with this email." });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ error: "Incorrect password." });

    res.json({ success: true, email: user.email });
  } catch (e) {
    console.error("[Signin] Error:", e.message);
    res.status(500).json({ error: "Sign in failed. Please try again." });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required." });

  try {
    const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (!user) {
      return res.json({ success: true, message: "If an account exists, a reset email has been sent." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 60 * 60 * 1000;

    db.prepare(
      "INSERT INTO reset_tokens (email, token, expires_at) VALUES (?, ?, ?)"
    ).run(email, token, expiresAt);

    const resetLink = `briefnews://reset-password?token=${token}&email=${encodeURIComponent(email)}`;

    await resend.emails.send({
      from: "Brief <onboarding@resend.dev>",
      to: email,
      subject: "Reset your Brief password",
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
            <tr><td align="center">
              <table width="100%" style="max-width:480px;background:#1a1f2e;border-radius:20px;overflow:hidden;">
                <tr>
                  <td style="background:#D4622A;padding:32px;text-align:center;">
                    <div style="font-size:52px;font-weight:900;color:#fff;line-height:1;margin-bottom:10px;">B</div>
                    <div style="font-size:26px;font-weight:900;color:#fff;">Brief</div>
                    <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;">World news, made clear.</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 32px;">
                    <h2 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#f1f5f9;">Reset your password</h2>
                    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#94a3b8;">
                      We received a request to reset the password for <strong style="color:#f1f5f9;">${email}</strong>.
                      Tap the button below to set a new password. This link expires in 1 hour.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="padding:8px 0 28px;">
                          <a href="${resetLink}" style="display:inline-block;background:#D4622A;color:#fff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:50px;">
                            Reset Password
                          </a>
                        </td>
                      </tr>
                    </table>
                    <div style="background:#232938;border-radius:12px;padding:16px;margin-bottom:24px;">
                      <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#64748b;letter-spacing:1px;text-transform:uppercase;">Or copy this link</p>
                      <p style="margin:0;font-size:12px;color:#94a3b8;word-break:break-all;line-height:18px;">${resetLink}</p>
                    </div>
                    <p style="margin:0;font-size:13px;color:#64748b;line-height:20px;">
                      If you didn't request this, you can safely ignore this email — your account is still secure.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 32px;border-top:1px solid #2d3748;text-align:center;">
                    <p style="margin:0;font-size:12px;color:#64748b;">© ${new Date().getFullYear()} Brief · World news, made clear</p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });

    res.json({ success: true, message: "If an account exists, a reset email has been sent." });
  } catch (e) {
    console.error("[ForgotPassword] Error:", e.message);
    res.status(500).json({ error: "Could not send reset email. Please try again." });
  }
});

app.post("/api/auth/verify-reset-token", (req, res) => {
  const { token, email } = req.body;
  if (!token || !email)
    return res.status(400).json({ error: "Token and email required." });

  const record = db
    .prepare("SELECT * FROM reset_tokens WHERE token = ? AND email = ? AND used = 0")
    .get(token, email);

  if (!record)
    return res.status(400).json({ error: "Invalid or already used reset link." });
  if (Date.now() > record.expires_at)
    return res.status(400).json({ error: "This reset link has expired. Please request a new one." });

  res.json({ success: true, valid: true });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, email, newPassword } = req.body;
  if (!token || !email || !newPassword)
    return res.status(400).json({ error: "Token, email, and new password required." });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const record = db
      .prepare("SELECT * FROM reset_tokens WHERE token = ? AND email = ? AND used = 0")
      .get(token, email);

    if (!record)
      return res.status(400).json({ error: "Invalid or already used reset link." });
    if (Date.now() > record.expires_at)
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);
    db.prepare("UPDATE reset_tokens SET used = 1 WHERE id = ?").run(record.id);

    res.json({ success: true, message: "Password updated successfully." });
  } catch (e) {
    console.error("[ResetPassword] Error:", e.message);
    res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

app.post("/api/auth/change-email", async (req, res) => {
  const { currentEmail, newEmail, password } = req.body;
  if (!currentEmail || !newEmail || !password)
    return res.status(400).json({ error: "All fields required." });

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(currentEmail);
    if (!user) return res.status(404).json({ error: "Account not found." });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Incorrect password." });

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(newEmail);
    if (existing) return res.status(409).json({ error: "That email is already in use." });

    db.prepare("UPDATE users SET email = ? WHERE email = ?").run(newEmail, currentEmail);
    res.json({ success: true, email: newEmail });
  } catch (e) {
    res.status(500).json({ error: "Could not update email." });
  }
});

app.post("/api/auth/change-password", async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (!email || !currentPassword || !newPassword)
    return res.status(400).json({ error: "All fields required." });
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
    res.status(500).json({ error: "Could not update password." });
  }
});

// ─── GNews fetchers ───────────────────────────────────────────────

async function fetchRealHeadlines() {
  if (!GNEWS_KEY) throw new Error("No GNews key");

  // Fetch from multiple categories for variety
  const categories = ["world", "nation", "technology", "science", "health"];
  const allArticles = [];

  for (const cat of categories) {
    try {
      const url =
        `https://gnews.io/api/v4/top-headlines?` +
        `lang=en&max=6&topic=${cat}&apikey=${GNEWS_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.articles) allArticles.push(...data.articles);
      await sleep(300); // respect rate limits
    } catch (e) {
      console.error(`[GNews] category ${cat} error:`, e.message);
    }
  }

  return allArticles
    .filter((a) => a.title && a.description)
    .slice(0, 30);
}

async function fetchCatchupHeadlines() {
  if (!GNEWS_KEY) throw new Error("No GNews key");

  const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const queries = [
    "world politics",
    "economy trade",
    "climate energy",
    "technology artificial intelligence",
    "international conflict",
  ];

  const allArticles = [];

  for (const q of queries) {
    try {
      const url =
        `https://gnews.io/api/v4/search?` +
        `q=${encodeURIComponent(q)}&lang=en&max=6` +
        `&from=${threeMonthsAgo}T00:00:00Z&apikey=${GNEWS_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.articles) allArticles.push(...data.articles);
      await sleep(300);
    } catch (e) {
      console.error(`[GNews Catchup] query "${q}" error:`, e.message);
    }
  }

  return allArticles
    .filter((a) => a.title && a.description)
    .slice(0, 30);
}

// ─── Claude article formatter ─────────────────────────────────────

async function formatHeadlinesWithClaude(rawArticles, type = "feed") {
  const today = new Date().toISOString().split("T")[0];
  const headlinesList = rawArticles
    .map(
      (a, i) =>
        `${i + 1}. [${a.source?.name || "News"}] ${a.title} — ${a.description || ""} (published: ${a.publishedAt || today})`
    )
    .join("\n");

  const typeInstructions =
    type === "catchup"
      ? "These are stories from the past 1-3 months. Note they are recent but not today's news."
      : "These are today's top headlines. Treat as breaking or very recent news.";

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 12000,
    messages: [
      {
        role: "user",
        content: `Format these REAL news headlines for Brief, a teen news app. ${typeInstructions}
DO NOT invent events. Base everything only on what these headlines describe.
Return ONLY a valid JSON array, no markdown, no backticks.

HEADLINES:
${headlinesList}

Each object EXACTLY:
{
  "id": "unique-string",
  "title": "Teen-friendly headline max 80 chars",
  "category": "World|Tech|Science|Climate|Economy|Culture|Sports|Health",
  "summary": "2-sentence summary of what actually happened",
  "region": "North America|Europe|Asia|Middle East|Africa|Latin America|Global",
  "country": "main country involved",
  "tag": "TOP 5 for the 5 most important, FRESH for the rest",
  "em": "one relevant emoji",
  "source": "original source name",
  "imageQuery": "specific 4-5 word Pexels hero image search matching the topic",
  "bodyImageQuery": "different 4-5 word Pexels search, different angle from imageQuery",
  "whatsGoingOn": ["4 factual bullet strings based on the real story"],
  "relevantDetails": ["4 factual context strings"],
  "quickExplain": ["4 teen-friendly bullet strings"],
  "deeperAnalysis": ["4 analytical bullet strings"],
  "pollQuestion": "A two-option poll question about this story",
  "pollOptionA": "First option",
  "pollOptionB": "Second option",
  "publishedAt": "use the real publishedAt date from the headline",
  "readTime": 3
}`,
      },
    ],
  });

  const text = response.content[0].text.trim();
  const fi = text.indexOf("[");
  const li = text.lastIndexOf("]");
  if (fi === -1 || li === -1) throw new Error("No JSON array in Claude response");
  return JSON.parse(text.slice(fi, li + 1));
}

// ─── Pexels ───────────────────────────────────────────────────────

async function fetchPexelsImage(query, excludeIds = []) {
  if (!PEXELS_KEY) return null;
  try {
    const page = Math.floor(Math.random() * 5) + 1;
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
      query
    )}&per_page=15&page=${page}&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    const data = await res.json();
    if (!data.photos?.length) return null;
    const available = data.photos.filter(
      (p) => !usedImageIds.has(p.id) && !excludeIds.includes(p.id)
    );
    if (!available.length) return null;
    const photo = available[Math.floor(Math.random() * available.length)];
    usedImageIds.add(photo.id);
    return {
      id: photo.id,
      url: photo.src.large2x || photo.src.large,
      thumb: photo.src.medium,
    };
  } catch (e) {
    console.error("Pexels error:", e.message);
    return null;
  }
}

async function attachImages(articles) {
  const result = [];
  for (const article of articles) {
    const usedThisArticle = [];
    const hero = await fetchPexelsImage(article.imageQuery, usedThisArticle);
    if (hero) usedThisArticle.push(hero.id);
    const body = await fetchPexelsImage(
      article.bodyImageQuery || article.imageQuery + " detail",
      usedThisArticle
    );
    result.push({
      ...article,
      heroImage: hero?.url || null,
      heroThumb: hero?.thumb || null,
      bodyImage: body?.url || null,
      bodyThumb: body?.thumb || null,
    });
    await sleep(120);
  }
  return result;
}

// ─── Article refresh jobs ─────────────────────────────────────────

async function refreshFeed() {
  console.log("[Feed] Fetching real headlines from GNews...");
  try {
    let rawArticles = GNEWS_KEY ? await fetchRealHeadlines() : [];
    if (!rawArticles.length) {
      await refreshFeedFallback();
      return;
    }
    console.log(`[Feed] Got ${rawArticles.length} real headlines — formatting with Claude...`);
    const formatted = await formatHeadlinesWithClaude(rawArticles, "feed");
    feedArticles = await attachImages(
      formatted.map((a, i) => ({ ...a, id: `feed-${Date.now()}-${i}` }))
    );
    lastFeedRefresh = Date.now();
    console.log(`[Feed] Done — ${feedArticles.length} articles ready.`);
  } catch (e) {
    console.error("[Feed] Error:", e.message);
    await refreshFeedFallback();
  }
}

async function refreshFeedFallback() {
  console.log("[Feed Fallback] Generating with Claude...");
  try {
    const today = new Date().toISOString().split("T")[0];
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 12000,
      messages: [
        {
          role: "user",
          content: `Generate 30 current world news articles for today ${today} for a teen news app called Brief. Cover diverse global topics. Tag 5 as "TOP 5" (most important), rest as "FRESH". Return ONLY a valid JSON array. Each object: id, title, category, summary, region, country, tag, em, source, imageQuery, bodyImageQuery, whatsGoingOn (4 bullets), relevantDetails (4 bullets), quickExplain (4 teen-friendly bullets), deeperAnalysis (4 bullets), pollQuestion, pollOptionA, pollOptionB, publishedAt (today ISO), readTime (3).`,
        },
      ],
    });
    const text = response.content[0].text.trim();
    const fi = text.indexOf("[");
    const li = text.lastIndexOf("]");
    if (fi === -1 || li === -1) throw new Error("No array");
    const parsed = JSON.parse(text.slice(fi, li + 1));
    feedArticles = await attachImages(
      parsed.map((a, i) => ({ ...a, id: `feed-${Date.now()}-${i}` }))
    );
    lastFeedRefresh = Date.now();
    console.log(`[Feed Fallback] Done — ${feedArticles.length} articles.`);
  } catch (e) {
    console.error("[Feed Fallback] Error:", e.message);
  }
}

async function refreshDaily5() {
  console.log("[Daily5] Building top 5...");
  try {
    const top5 = feedArticles.filter((a) => a.tag === "TOP 5").slice(0, 5);
    if (top5.length >= 5) {
      daily5Articles = top5;
      lastDailyRefresh = Date.now();
      console.log("[Daily5] Done — picked from feed.");
      return;
    }
    const today = new Date().toISOString().split("T")[0];
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 5000,
      messages: [
        {
          role: "user",
          content: `Generate the 5 most significant world news stories of today ${today} for a teen news app. Return ONLY a JSON array of 5 objects: id, title, category, summary, region, country, tag ("TOP 5"), em, source, imageQuery, bodyImageQuery, whatsGoingOn (4), relevantDetails (4), quickExplain (4), deeperAnalysis (4), pollQuestion, pollOptionA, pollOptionB, publishedAt, readTime.`,
        },
      ],
    });
    const text = response.content[0].text.trim();
    const fi = text.indexOf("[");
    const li = text.lastIndexOf("]");
    if (fi === -1 || li === -1) throw new Error("No array");
    const parsed = JSON.parse(text.slice(fi, li + 1));
    daily5Articles = await attachImages(
      parsed.map((a, i) => ({ ...a, id: `daily5-${Date.now()}-${i}`, tag: "TOP 5" }))
    );
    lastDailyRefresh = Date.now();
    console.log("[Daily5] Done.");
  } catch (e) {
    console.error("[Daily5] Error:", e.message);
  }
}

async function refreshCatchup() {
  console.log("[Catchup] Fetching historical headlines from GNews...");
  try {
    let rawArticles = GNEWS_KEY ? await fetchCatchupHeadlines() : [];
    let newArticles = [];

    if (rawArticles.length > 0) {
      console.log(`[Catchup] Got ${rawArticles.length} historical headlines — formatting...`);
      const formatted = await formatHeadlinesWithClaude(rawArticles, "catchup");
      newArticles = formatted.map((a, i) => ({
        ...a,
        id: `catchup-${Date.now()}-${i}`,
      }));
    } else {
      console.log("[Catchup] Falling back to Claude generation...");
      const response = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 8000,
        messages: [
          {
            role: "user",
            content: `Generate 20 important news stories from the past 1-3 months still relevant today. Mix topics: geopolitics, economy, tech, climate, science, culture. Return ONLY a valid JSON array. Each: id, title, category, summary, region, country, tag ("FRESH"), em, source, imageQuery, bodyImageQuery, whatsGoingOn (4), relevantDetails (4), quickExplain (4), deeperAnalysis (4), pollQuestion, pollOptionA, pollOptionB, publishedAt (ISO date 1-90 days ago), readTime (3).`,
          },
        ],
      });
      const text = response.content[0].text.trim();
      const fi = text.indexOf("[");
      const li = text.lastIndexOf("]");
      if (fi !== -1 && li !== -1) {
        const parsed = JSON.parse(text.slice(fi, li + 1));
        newArticles = parsed.map((a, i) => ({
          ...a,
          id: `catchup-${Date.now()}-${i}`,
        }));
      }
    }

    const withImages = await attachImages(newArticles);
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    catchupArticles = [
      ...catchupArticles.filter(
        (a) => new Date(a.publishedAt).getTime() > ninetyDaysAgo
      ),
      ...withImages,
    ];
    lastCatchupRefresh = Date.now();
    console.log(`[Catchup] Pool: ${catchupArticles.length} articles.`);
  } catch (e) {
    console.error("[Catchup] Error:", e.message);
  }
}

// ─── Scheduling ───────────────────────────────────────────────────
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function startScheduler() {
  (async () => {
    try {
      await refreshFeed();
      await sleep(3000);
      await refreshDaily5();
      await sleep(3000);
      await refreshCatchup();
    } catch (e) {
      initialLoadError = e.message;
      console.error("[Scheduler] Initial load failed:", e.message);
    } finally {
      initialLoadDone = true;
    }

    // Feed refreshes every hour with fresh real headlines
    setInterval(async () => {
      usedImageIds = new Set();
      await refreshFeed();
    }, HOUR);

    // Daily 5 + catchup refresh once per day
    setInterval(async () => {
      await refreshDaily5();
      await sleep(10000);
      await refreshCatchup();
    }, DAY);

    // Keep-alive ping every 10 minutes to prevent Render free tier sleep
    setInterval(async () => {
      try {
        await fetch(`https://teennews-2.onrender.com/health`);
        console.log('[KeepAlive] Pinged');
      } catch (e) {}
    }, 10 * 60 * 1000);
  })();
}

// ─── Article Routes ───────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    gNewsConnected: !!GNEWS_KEY,
    resendConnected: !!process.env.RESEND_API_KEY,
    initialLoadDone,
    initialLoadError,
    feedCount: feedArticles.length,
    daily5Count: daily5Articles.length,
    catchupCount: catchupArticles.length,
    lastFeedRefresh: lastFeedRefresh
      ? new Date(lastFeedRefresh).toISOString()
      : null,
    lastDailyRefresh: lastDailyRefresh
      ? new Date(lastDailyRefresh).toISOString()
      : null,
    usedImages: usedImageIds.size,
  });
});

app.get("/api/articles/feed", (req, res) => {
  res.json({
    articles: feedArticles,
    lastRefresh: lastFeedRefresh,
    nextRefresh: lastFeedRefresh + HOUR,
    loading: feedArticles.length === 0 && !initialLoadDone,
  });
});

app.get("/api/articles/daily5", (req, res) => {
  res.json({
    articles: daily5Articles,
    lastRefresh: lastDailyRefresh,
    nextRefresh: lastDailyRefresh + DAY,
    loading: daily5Articles.length === 0 && !initialLoadDone,
  });
});

app.get("/api/articles/catchup", (req, res) => {
  const { category, page = 1, limit = 20 } = req.query;
  let articles = [...catchupArticles].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  if (category && category !== "All") {
    articles = articles.filter((a) => a.category === category);
  }
  const start = (Number(page) - 1) * Number(limit);
  res.json({
    articles: articles.slice(start, start + Number(limit)),
    total: articles.length,
    page: Number(page),
    lastRefresh: lastCatchupRefresh,
    loading: catchupArticles.length === 0 && !initialLoadDone,
  });
});

app.post("/api/ask", async (req, res) => {
  const { question, articleTitle, articleSummary } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: `Answer this question about a news article for a teen reader. Max 3 short paragraphs.\n\nArticle: "${articleTitle}"\nSummary: "${articleSummary}"\n\nQuestion: ${question}`,
        },
      ],
    });
    res.json({ answer: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Brief backend running on port ${PORT}`);
  if (!GNEWS_KEY) console.warn("⚠️  NEWS_API_KEY (GNews) not set");
  if (!process.env.RESEND_API_KEY) console.warn("⚠️  RESEND_API_KEY not set");
  startScheduler();
});
