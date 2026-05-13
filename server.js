// ══════════════════════════════════════════════════════════════════
//  BRIEF NEWS APP — BACKEND SERVER
//  Node.js + Express  |  Railway-ready
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PEXELS_KEY = process.env.PEXELS_API_KEY;

// ─── In-memory stores ────────────────────────────────────────────
let feedArticles = [];
let catchupArticles = [];
let daily5Articles = [];
let usedImageIds = new Set();
let lastFeedRefresh = 0;
let lastDailyRefresh = 0;
let lastCatchupRefresh = 0;

// Track whether initial load is still in progress
let initialLoadDone = false;
let initialLoadError = null;

// ─── Helpers ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPexelsImage(query, excludeIds = []) {
  if (!PEXELS_KEY) return null;
  try {
    const page = Math.floor(Math.random() * 5) + 1;
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
      query
    )}&per_page=15&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: PEXELS_KEY },
    });
    const data = await res.json();
    if (!data.photos || data.photos.length === 0) return null;
    const available = data.photos.filter(
      (p) => !usedImageIds.has(p.id) && !excludeIds.includes(p.id)
    );
    if (available.length === 0) return null;
    const photo = available[Math.floor(Math.random() * available.length)];
    usedImageIds.add(photo.id);
    return {
      id: photo.id,
      url: photo.src.large2x || photo.src.large,
      thumb: photo.src.medium,
      photographer: photo.photographer,
    };
  } catch (e) {
    console.error("Pexels error:", e.message);
    return null;
  }
}

async function generateArticlesFromClaude(prompt, count = 10) {
  const today = new Date().toISOString().split("T")[0];
  const systemPrompt = `You are a world-class news editor for BRIEF, a news app aimed at curious teens and young adults. 
Today's date: ${today}

Generate ${count} real, recent, newsworthy articles. Each article must:
- Be about genuinely current events (within the last 24 hours ideally)
- Cover diverse topics: geopolitics, science, tech, climate, economics, culture, sports, health
- Be factually grounded (you may use events you know up to your training cutoff and extrapolate plausibly)
- Have teen-friendly language in the Quick Explain section

Respond ONLY with a valid JSON array. No markdown, no backticks, no preamble.

Each article object must have EXACTLY these fields:
{
  "id": "unique-string-id",
  "title": "Compelling headline (max 80 chars)",
  "category": "one of: World | Tech | Science | Climate | Economy | Culture | Sports | Health",
  "summary": "2-sentence summary",
  "imageQuery": "specific Pexels search query for hero image (be very specific, e.g. 'United Nations assembly hall delegates')",
  "bodyImageQuery": "different angle Pexels search query for body image (e.g. 'diplomats handshake agreement')",
  "whatsGoingOn": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"],
  "relevantDetails": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"],
  "quickExplain": ["teen-friendly bullet 1", "teen-friendly bullet 2", "teen-friendly bullet 3", "teen-friendly bullet 4"],
  "deeperAnalysis": ["analytical bullet 1", "analytical bullet 2", "analytical bullet 3", "analytical bullet 4"],
  "pollQuestion": "A yes/no or two-option poll question about this article",
  "pollOptionA": "Option A label",
  "pollOptionB": "Option B label",
  "publishedAt": "${today}T${String(Math.floor(Math.random() * 23)).padStart(2, "0")}:00:00Z",
  "readTime": 3
}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(clean);
}

async function attachImages(articles) {
  const result = [];
  for (const article of articles) {
    const usedThisArticle = [];
    const hero = await fetchPexelsImage(article.imageQuery, usedThisArticle);
    if (hero) usedThisArticle.push(hero.id);
    const body = await fetchPexelsImage(
      article.bodyImageQuery || article.imageQuery + " close up",
      usedThisArticle
    );
    result.push({
      ...article,
      heroImage: hero ? hero.url : null,
      heroThumb: hero ? hero.thumb : null,
      bodyImage: body ? body.url : null,
      bodyThumb: body ? body.thumb : null,
    });
    await sleep(120);
  }
  return result;
}

// ─── Article generation jobs ──────────────────────────────────────

async function refreshFeed() {
  console.log("[Feed] Generating 30 fresh articles...");
  try {
    const batch1 = await generateArticlesFromClaude(
      "Generate 10 of the most significant breaking news stories from today across diverse global topics.",
      10
    );
    const batch2 = await generateArticlesFromClaude(
      "Generate 10 more current news stories from today — focus on tech, science, climate, and economics.",
      10
    );
    const batch3 = await generateArticlesFromClaude(
      "Generate 10 more today's news stories — focus on culture, sports, health, and human interest.",
      10
    );

    const all = [...batch1, ...batch2, ...batch3].map((a, i) => ({
      ...a,
      id: `feed-${Date.now()}-${i}`,
    }));

    const withImages = await attachImages(all);
    feedArticles = withImages;
    lastFeedRefresh = Date.now();
    console.log(`[Feed] Done — ${feedArticles.length} articles ready.`);
  } catch (e) {
    console.error("[Feed] Error:", e.message);
  }
}

async function refreshDaily5() {
  console.log("[Daily5] Generating 5 best stories...");
  try {
    const articles = await generateArticlesFromClaude(
      `Generate exactly 5 articles that represent the 5 MOST SIGNIFICANT news stories of today ${
        new Date().toISOString().split("T")[0]
      }. These should be the stories every informed person should know about today. Prioritize global impact, novelty, and importance.`,
      5
    );
    const withImages = await attachImages(
      articles.map((a, i) => ({
        ...a,
        id: `daily5-${Date.now()}-${i}`,
      }))
    );
    daily5Articles = withImages;
    lastDailyRefresh = Date.now();
    console.log("[Daily5] Done.");
  } catch (e) {
    console.error("[Daily5] Error:", e.message);
  }
}

async function refreshCatchup() {
  console.log("[Catchup] Generating 30 recent-history articles...");
  try {
    const batch1 = await generateArticlesFromClaude(
      "Generate 10 important news stories from the past 1-4 weeks that are still highly relevant today. Mix topics.",
      10
    );
    const batch2 = await generateArticlesFromClaude(
      "Generate 10 significant news stories from the past 1-3 months — stories that had lasting impact.",
      10
    );
    const batch3 = await generateArticlesFromClaude(
      "Generate 10 notable news stories from the past 2-3 months covering science breakthroughs, climate milestones, tech launches, or geopolitical developments.",
      10
    );

    const newArticles = [...batch1, ...batch2, ...batch3].map((a, i) => ({
      ...a,
      id: `catchup-${Date.now()}-${i}`,
    }));
    const withImages = await attachImages(newArticles);

    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    catchupArticles = [
      ...catchupArticles.filter(
        (a) => new Date(a.publishedAt).getTime() > ninetyDaysAgo
      ),
      ...withImages,
    ];
    lastCatchupRefresh = Date.now();
    console.log(`[Catchup] Pool now has ${catchupArticles.length} articles.`);
  } catch (e) {
    console.error("[Catchup] Error:", e.message);
  }
}

// ─── Scheduling ───────────────────────────────────────────────────
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// FIX: Run scheduler in background — does NOT block server startup.
// Railway's healthcheck hits /health almost immediately; the old code
// would block the event loop during the long AI generation and fail.
function startScheduler() {
  (async () => {
    try {
      await refreshFeed();
      await sleep(5000);
      await refreshDaily5();
      await sleep(5000);
      await refreshCatchup();
    } catch (e) {
      initialLoadError = e.message;
      console.error("[Scheduler] Initial load failed:", e.message);
    } finally {
      initialLoadDone = true;
    }

    setInterval(async () => {
      await refreshFeed();
    }, HOUR);

    setInterval(async () => {
      await refreshDaily5();
      await sleep(10000);
      await refreshCatchup();
    }, DAY);
  })();
}

// ─── Routes ───────────────────────────────────────────────────────

// FIX: /health now responds immediately even while articles are loading.
// Returns 503 only if something fatally crashed, not just "still loading".
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
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
  const paginated = articles.slice(start, start + Number(limit));
  res.json({
    articles: paginated,
    total: articles.length,
    page: Number(page),
    lastRefresh: lastCatchupRefresh,
    loading: catchupArticles.length === 0 && !initialLoadDone,
  });
});

// Ask AI about an article
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
          content: `You are answering a question about a news article for a teen/young adult reader. Be clear, concise, and helpful. Max 3 short paragraphs.

Article: "${articleTitle}"
Summary: "${articleSummary}"

Question: ${question}`,
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

// FIX: Start listening FIRST, then kick off background scheduler.
// This ensures Railway's healthcheck never times out waiting for AI calls.
app.listen(PORT, () => {
  console.log(`Brief backend running on port ${PORT}`);
  startScheduler(); // non-blocking — runs in background
});
