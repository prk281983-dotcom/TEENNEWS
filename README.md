# BRIEF News App — v2.0

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        BRIEF BACKEND                              │
│  (Node.js + Express — deploy on Railway / Render / Fly.io)       │
│                                                                   │
│  Every HOUR   → refreshes /api/articles/feed (30 articles)       │
│  Every DAY    → refreshes /api/articles/daily5 (5 best)          │
│  Every DAY    → adds 30 more to /api/articles/catchup pool       │
│  Catchup pool → ages out articles older than 90 days             │
│  Images       → Pexels API, query-specific, ZERO repeats         │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTP
┌──────────────────────────────────────────────────────────────────┐
│                     EXPO SNACK FRONTEND                           │
│                                                                   │
│  Feed tab:     30 articles, countdown to next update             │
│  Daily 5 tab:  5 most important stories, refreshes at midnight   │
│  Catch-Up tab: Growing pool, category filter, pagination         │
│  Saved tab:    Bookmarked articles                                │
│  Profile tab:  Theme toggle, backend health status               │
│                                                                   │
│  Per article:                                                     │
│    • Hero image (topic-specific, unique)                         │
│    • Body image (different angle, also unique)                   │
│    • 4 sections × 4 bullets (Going On / Details / Quick / Deep)  │
│    • Live poll                                                    │
│    • Ask AI (Claude Haiku)                                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Get API Keys

| Key | Where |
|-----|-------|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| `PEXELS_API_KEY` | https://www.pexels.com/api/ (free) |

### 2. Deploy Backend to Railway (easiest)

```bash
cd brief-backend
npm install -g @railway/cli
railway login
railway init
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set PEXELS_API_KEY=your-pexels-key
railway up
```

Your URL will be: `https://brief-backend-production.up.railway.app`

### 3. Deploy Backend to Render (alternative)

1. Push `brief-backend/` to a GitHub repo
2. New Web Service on https://render.com
3. Build: `npm install` | Start: `node server.js`
4. Add env vars → Deploy

### 4. Run Backend Locally

```bash
cd brief-backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # uses nodemon
```

### 5. Connect Frontend

Open `brief-frontend/App.js` and update line 16:
```js
const BACKEND_URL = "https://YOUR-BACKEND-URL.railway.app";
```

Then paste the entire `App.js` into https://snack.expo.dev

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Backend status + article counts |
| `GET /api/articles/feed` | 30 current feed articles |
| `GET /api/articles/daily5` | 5 best stories of the day |
| `GET /api/articles/catchup?category=Tech&page=1&limit=20` | Paginated catch-up pool |
| `POST /api/ask` | Ask Claude AI about an article |

---

## Article Structure

```json
{
  "id": "feed-1234567890-0",
  "title": "...",
  "category": "World | Tech | Science | Climate | Economy | Culture | Sports | Health",
  "summary": "2-sentence summary",
  "heroImage": "https://images.pexels.com/...",
  "bodyImage": "https://images.pexels.com/...",
  "whatsGoingOn": ["...", "...", "...", "..."],
  "relevantDetails": ["...", "...", "...", "..."],
  "quickExplain": ["...", "...", "...", "..."],
  "deeperAnalysis": ["...", "...", "...", "..."],
  "pollQuestion": "...",
  "pollOptionA": "...",
  "pollOptionB": "...",
  "publishedAt": "2025-01-01T12:00:00Z",
  "readTime": 3
}
```

---

## Notes

- **No image repeats**: All used Pexels image IDs are tracked in memory. Reset on server restart.
- **Image matching**: Each article gets two Pexels searches using article-specific queries (e.g. "United Nations assembly hall" not just "politics").
- **Backend startup**: On first boot, all 3 content pools are generated sequentially (may take 2-3 minutes). The `/health` endpoint shows current counts.
- **Claude model**: Articles use `claude-opus-4-5` for quality; Ask AI uses `claude-haiku-4-5` for speed.
