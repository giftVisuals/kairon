// server.js
// Express server for Kairon: static frontend, REST API, feed handling,
// Telegram bot integration, notifications, and a placeholder for future
// AI/news collection.

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || "https://kairon-production-79a5.up.railway.app";

// ---------------------------------------------------------------------------
// Firestore (Firebase Admin)
//
// Persists what used to be in-memory-only: Telegram links/preferences and
// the daily intelligence snapshot (feed, summary, insights, funding,
// listings) — so a redeploy no longer wipes them, and boot doesn't have to
// regenerate the daily data from scratch. Requires FIREBASE_SERVICE_ACCOUNT_KEY
// (the full JSON key file content, from Firebase Console → Project Settings
// → Service Accounts → Generate new private key). Everything below degrades
// gracefully to in-memory-only behavior if that isn't set, same pattern as
// Telegram/Groq/ImgBB elsewhere in this file.
// ---------------------------------------------------------------------------

let firestoreDb = null;
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestoreDb = admin.firestore();
    console.log("[firestore] initialized");
  } else {
    console.log("[firestore] FIREBASE_SERVICE_ACCOUNT_KEY not set — running in-memory only, data will not survive a redeploy");
  }
} catch (err) {
  console.error("[firestore] failed to initialize:", err.message);
}

function isFirestoreConfigured() {
  return Boolean(firestoreDb);
}

// Verifies the Firebase ID token clients send as `Authorization: Bearer
// <token>` and attaches the verified uid to req.uid. Used by routes that
// need to know who's calling (bookmarks) rather than trusting a client-
// supplied userId, unlike the older Telegram-linking routes below.
async function verifyAuth(req, res, next) {
  if (!isFirestoreConfigured()) {
    return res.status(503).json({ error: "Accounts aren't configured yet." });
  }
  const authHeader = req.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const IMGBB_API_KEY = process.env.IMGBB_API_KEY || "";

const app = express();
// Bumped from Express's 100kb default to fit base64-encoded profile photos
// (the client downsizes images before upload, but base64 still inflates size ~33%).
app.use(express.json({ limit: "6mb" }));

// ---------------------------------------------------------------------------
// In-memory data store (placeholder)
//
// Firestore is the system of record long-term (see CLAUDE.md → FIRESTORE
// COLLECTIONS). Wiring real Firestore reads/writes here requires a Firebase
// Admin service account, which hasn't been provided yet. Until then, the API
// below runs against seeded in-memory data so the frontend has real content
// to render. Swapping this for Firestore Admin later should only require
// replacing the functions in this section — the route handlers already treat
// it like a data-access layer.
// ---------------------------------------------------------------------------

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function toFeedRecords(items) {
  return items.map((item, index) => ({
    id: crypto.randomUUID(),
    slug: slugify(item.title),
    publishedAt: item.publishedAt || new Date(Date.now() - index * 1000 * 60 * 47).toISOString(),
    ...item,
  }));
}

// Used only until the real data pipeline (CoinGecko + Groq, further below)
// completes its first run, or if that pipeline fails entirely (e.g. market
// data API unreachable). generateDailyIntelligence() overwrites this with
// live data on startup and every day at 06:00 UTC — this is not shown in
// normal operation.
const FALLBACK_FEED_SEED = [
  {
    title: "Base memecoin rally sends volumes to a 3-month high",
    summary:
      "Daily DEX volume on Base climbed past $1.2B as a wave of new memecoin launches drew retail attention back to the network.",
    category: "Memecoins",
    tags: ["Base", "Memecoins", "DeFi"],
    trending: true,
  },
  {
    title: "Ethereum ETF update: inflows accelerate for a fourth straight week",
    summary:
      "Spot Ethereum ETFs recorded $310M in net inflows this week, the strongest streak since launch, as institutional demand builds.",
    category: "Ethereum",
    tags: ["Ethereum", "ETF", "Macro"],
    trending: true,
  },
  {
    title: "Bitcoin dominance holds above 54% amid muted alt season signals",
    summary:
      "Bitcoin's market share has held steady for three weeks, a sign traders are still favoring majors over altcoins.",
    category: "Bitcoin",
    tags: ["Bitcoin", "Macro"],
    trending: false,
  },
  {
    title: "Stablecoin supply on Tron hits a new all-time high",
    summary:
      "USDT circulating supply on Tron surpassed its previous record, reinforcing the network's role in stablecoin settlement.",
    category: "Stablecoins",
    tags: ["Stablecoins", "Macro"],
    trending: false,
  },
];

let feedItems = toFeedRecords(FALLBACK_FEED_SEED);

function findFeedIndexById(id) {
  return feedItems.findIndex((item) => item.id === id);
}

// telegram_links: in-memory placeholder for the `telegram_links` Firestore collection.
// Shape: { userId, chatId, telegramName, username, linkedAt }
let telegramLinks = [];

// Short-lived tokens used to connect a "Link Telegram" click to the /start deep link.
let telegramLinkTokens = new Map(); // token -> { userId, createdAt }

// ---------------------------------------------------------------------------
// Feed API
// ---------------------------------------------------------------------------

app.get("/api/feed", (req, res) => {
  const { category, limit } = req.query;

  let results = [...feedItems].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  if (category) {
    results = results.filter(
      (item) => item.category.toLowerCase() === String(category).toLowerCase()
    );
  }

  if (limit) {
    results = results.slice(0, Number(limit));
  }

  res.json({ items: results, total: results.length });
});

app.get("/api/feed/:slug", (req, res) => {
  const item = feedItems.find((f) => f.slug === req.params.slug);
  if (!item) {
    return res.status(404).json({ error: "Feed item not found" });
  }
  res.json(item);
});

app.post("/api/feed", (req, res) => {
  const { title, summary, category, tags } = req.body || {};

  if (!title || !summary || !category) {
    return res
      .status(400)
      .json({ error: "title, summary, and category are required" });
  }

  const newItem = {
    id: crypto.randomUUID(),
    title,
    summary,
    category,
    tags: Array.isArray(tags) ? tags : [],
    slug: slugify(title),
    publishedAt: new Date().toISOString(),
    trending: false,
  };

  feedItems.unshift(newItem);
  notifyNewFeedItem(newItem);

  res.status(201).json(newItem);
});

app.patch("/api/feed/:id", (req, res) => {
  const index = findFeedIndexById(req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "Feed item not found" });
  }

  const allowedFields = ["title", "summary", "category", "tags", "trending"];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body && field in req.body) {
      updates[field] = req.body[field];
    }
  }
  if (updates.title) {
    updates.slug = slugify(updates.title);
  }

  feedItems[index] = { ...feedItems[index], ...updates };
  res.json(feedItems[index]);
});

app.delete("/api/feed/:id", (req, res) => {
  const index = findFeedIndexById(req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "Feed item not found" });
  }

  const [removed] = feedItems.splice(index, 1);
  res.json(removed);
});

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------

app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();

  if (!q) {
    return res.json({ items: [], total: 0 });
  }

  const results = feedItems.filter((item) => {
    return (
      item.title.toLowerCase().includes(q) ||
      item.summary.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });

  res.json({ items: results, total: results.length });
});

// ---------------------------------------------------------------------------
// Bookmarks API
//
// Requires sign-in (verifyAuth) and Firestore (bookmarks are meaningless
// without persistence — no in-memory fallback here, unlike the rest of the
// app, since a bookmark that vanishes on redeploy isn't useful at all).
// ---------------------------------------------------------------------------

app.get("/api/bookmarks", verifyAuth, async (req, res) => {
  try {
    const snapshot = await firestoreDb.collection("bookmarks").where("uid", "==", req.uid).get();
    res.json({ itemIds: snapshot.docs.map((d) => d.data().itemId) });
  } catch (err) {
    console.error("[bookmarks] failed to load:", err.message);
    res.status(500).json({ error: "Failed to load bookmarks." });
  }
});

app.post("/api/bookmarks", verifyAuth, async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    await firestoreDb
      .collection("bookmarks")
      .doc(`${req.uid}_${itemId}`)
      .set({ uid: req.uid, itemId, bookmarkedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error("[bookmarks] failed to save:", err.message);
    res.status(500).json({ error: "Failed to save bookmark." });
  }
});

app.delete("/api/bookmarks/:itemId", verifyAuth, async (req, res) => {
  try {
    await firestoreDb.collection("bookmarks").doc(`${req.uid}_${req.params.itemId}`).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("[bookmarks] failed to remove:", err.message);
    res.status(500).json({ error: "Failed to remove bookmark." });
  }
});

// ---------------------------------------------------------------------------
// Daily intelligence pipeline (real data)
//
// Replaces the feed and AI summary with real market data once a day (and
// once immediately on boot). Market data comes from CoinGecko's public API
// (no key required). The AI Market Summary is written by Groq from that
// same real data — the model is instructed to only use the numbers it's
// given, never invent facts, so per-item titles/summaries are built
// deterministically from the raw numbers (no hallucination risk) and Groq
// is used specifically for the narrative synthesis in the summary.
// ---------------------------------------------------------------------------

const CATEGORY_BY_ID = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  solana: "Solana",
};
const STABLECOIN_SYMBOLS = new Set(["usdt", "usdc", "dai", "busd", "tusd", "usde", "fdusd", "usdd", "pyusd"]);
const MEME_SYMBOLS = new Set(["doge", "shib", "pepe", "floki", "bonk", "wif", "brett", "popcat", "mog", "turbo", "myro", "wojak", "trump"]);
const DEFI_SYMBOLS = new Set(["uni", "aave", "crv", "mkr", "ldo", "cake", "comp", "snx", "sushi", "1inch", "dydx", "gmx", "pendle"]);
const EXCHANGE_SYMBOLS = new Set(["bnb", "okb", "cro", "ht", "gt"]);

function inferCategory(id, symbol) {
  if (CATEGORY_BY_ID[id]) return CATEGORY_BY_ID[id];
  const s = (symbol || "").toLowerCase();
  if (STABLECOIN_SYMBOLS.has(s)) return "Stablecoins";
  if (MEME_SYMBOLS.has(s)) return "Memecoins";
  if (DEFI_SYMBOLS.has(s)) return "DeFi";
  if (EXCHANGE_SYMBOLS.has(s)) return "Exchanges";
  return "Macro";
}

function formatUsd(n) {
  if (typeof n !== "number") return "N/A";
  if (n > 0 && n < 1) return `$${n.toPrecision(3)}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatCompactUsd(n) {
  if (typeof n !== "number") return "N/A";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)}`;
}

async function fetchTopMarketMovers() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h";
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko markets error: ${res.status}`);
  return res.json();
}

async function fetchTrendingSearch() {
  const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/search/trending", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko trending error: ${res.status}`);
  return res.json();
}

function buildFeedItemsFromMarketData(movers, trendingResp) {
  const trendingCoins = (trendingResp.coins || []).map((c) => c.item);
  const trendingIds = new Set(trendingCoins.map((c) => c.id));

  const significantMovers = movers
    .filter((m) => typeof m.price_change_percentage_24h === "number")
    .sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h))
    .slice(0, 6);

  const items = [];
  const seen = new Set();

  for (const m of significantMovers) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const pct = m.price_change_percentage_24h;
    const direction = pct >= 0 ? "up" : "down";
    const category = inferCategory(m.id, m.symbol);
    items.push({
      title: `${m.name} (${m.symbol.toUpperCase()}) is ${direction} ${Math.abs(pct).toFixed(1)}% in the last 24 hours`,
      summary: `${m.name} is trading at ${formatUsd(m.current_price)} with a market cap of ${formatCompactUsd(
        m.market_cap
      )}, ranked #${m.market_cap_rank} by market cap.${trendingIds.has(m.id) ? " It's also currently trending on CoinGecko." : ""}`,
      category,
      tags: [m.symbol.toUpperCase(), category],
      trending: trendingIds.has(m.id) || Math.abs(pct) >= 8,
    });
  }

  for (const t of trendingCoins.slice(0, 5)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const category = inferCategory(t.id, t.symbol);
    const change = t.data && t.data.price_change_percentage_24h && t.data.price_change_percentage_24h.usd;
    items.push({
      title: `${t.name} (${(t.symbol || "").toUpperCase()}) is trending on CoinGecko today`,
      summary: `${t.name} has climbed among the most-searched coins on CoinGecko in the past 24 hours${
        typeof change === "number" ? `, with price ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% over the same period` : ""
      }.`,
      category,
      tags: [(t.symbol || "").toUpperCase(), category, "Trending"],
      trending: true,
    });
  }

  return items;
}

async function generateAiSummary(movers, trendingResp) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const trendingCoins = (trendingResp.coins || []).map((c) => c.item);
  const valid = movers.filter((m) => typeof m.price_change_percentage_24h === "number");
  const topGainers = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 5);
  const topLosers = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 5);

  const dataForPrompt = {
    topGainers: topGainers.map((m) => ({ name: m.name, symbol: m.symbol.toUpperCase(), change24h: Number(m.price_change_percentage_24h.toFixed(2)) })),
    topLosers: topLosers.map((m) => ({ name: m.name, symbol: m.symbol.toUpperCase(), change24h: Number(m.price_change_percentage_24h.toFixed(2)) })),
    trending: trendingCoins.slice(0, 7).map((t) => ({ name: t.name, symbol: (t.symbol || "").toUpperCase() })),
  };

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You are a crypto market analyst writing a concise daily briefing for an on-chain intelligence product called Kairon. Only use the numeric facts provided in the user message — never invent coins, numbers, or events not present in the data. Return strict JSON of the shape {"points": ["...", "...", "...", "..."]}. Write 4-5 bullets, each a single sentence under 28 words, focused on what is notable or connects the dots — not just repeating raw numbers.',
          },
          { role: "user", content: JSON.stringify(dataForPrompt) },
        ],
      }),
    },
    15000
  );

  if (!response.ok) {
    throw new Error(`Groq API error: ${response.status}`);
  }

  const data = await response.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message.content) || "{}";
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.points) || parsed.points.length === 0) {
    throw new Error("Groq returned no summary points");
  }
  return parsed.points;
}

function buildFallbackSummary(movers, trendingResp) {
  const valid = movers.filter((m) => typeof m.price_change_percentage_24h === "number");
  const topGainer = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h)[0];
  const topLoser = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h)[0];
  const trendingTop = (trendingResp.coins || [])[0] && trendingResp.coins[0].item;
  const positiveCount = valid.filter((m) => m.price_change_percentage_24h > 0).length;

  const points = [];
  if (topGainer) points.push(`${topGainer.name} led the top 100 today, up ${topGainer.price_change_percentage_24h.toFixed(1)}% in 24 hours.`);
  if (topLoser) points.push(`${topLoser.name} was the biggest decliner, down ${Math.abs(topLoser.price_change_percentage_24h).toFixed(1)}%.`);
  if (trendingTop) points.push(`${trendingTop.name} is today's most-searched coin on CoinGecko.`);
  points.push(`${positiveCount} of the top 100 coins by market cap are in the green today.`);
  return points;
}

let latestSummary = { points: ["Today's briefing is being generated — check back shortly."], generatedAt: null };

// Raw market data behind the feed/summary, kept around so the Insights and
// Alerts pages can show it directly instead of needing their own data source.
let latestMarketSnapshot = { topGainers: [], topLosers: [], trending: [], updatedAt: null };

app.get("/api/summary", (req, res) => {
  res.json(latestSummary);
});

app.get("/api/insights", (req, res) => {
  res.json(latestMarketSnapshot);
});

// "Alerts" are the subset of today's feed that's notable enough to flag —
// currently: items tagged trending by the daily pipeline (big movers or
// currently trending on CoinGecko). No separate alerts data source exists
// yet, so this reuses the same real feed data rather than fabricate one.
app.get("/api/alerts", (req, res) => {
  const items = feedItems.filter((item) => item.trending);
  res.json({ items, total: items.length, updatedAt: latestSummary.generatedAt });
});

function buildMarketSnapshot(movers, trendingResp) {
  const valid = movers.filter((m) => typeof m.price_change_percentage_24h === "number");
  const toRow = (m) => ({
    id: m.id,
    name: m.name,
    symbol: m.symbol.toUpperCase(),
    price: m.current_price,
    change24h: Number(m.price_change_percentage_24h.toFixed(2)),
    marketCapRank: m.market_cap_rank,
  });

  const topGainers = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 10).map(toRow);
  const topLosers = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 10).map(toRow);
  const trending = ((trendingResp && trendingResp.coins) || []).slice(0, 10).map((c) => ({
    id: c.item.id,
    name: c.item.name,
    symbol: (c.item.symbol || "").toUpperCase(),
    marketCapRank: c.item.market_cap_rank || null,
    change24h:
      c.item.data && c.item.data.price_change_percentage_24h && typeof c.item.data.price_change_percentage_24h.usd === "number"
        ? Number(c.item.data.price_change_percentage_24h.usd.toFixed(2))
        : null,
  }));

  return { topGainers, topLosers, trending, updatedAt: new Date().toISOString() };
}

// Funding Rounds — DefiLlama's public "raises" endpoint (free, no key).
let latestFundingRounds = [];

app.get("/api/funding", (req, res) => {
  res.json({ items: latestFundingRounds });
});

async function fetchFundingRounds() {
  const res = await fetchWithTimeout("https://api.llama.fi/raises", { headers: { Accept: "application/json" } }, 10000);
  if (!res.ok) throw new Error(`DefiLlama raises error: ${res.status}`);
  return res.json();
}

function buildFundingRows(raisesResp) {
  const raises = (raisesResp && raisesResp.raises) || [];
  return [...raises]
    .filter((r) => r && r.name && r.date)
    .sort((a, b) => b.date - a.date)
    .slice(0, 8)
    .map((r) => {
      const investors = [...(r.leadInvestors || []), ...(r.otherInvestors || [])].filter(Boolean);
      return {
        project: r.name,
        amount: typeof r.amount === "number" && r.amount > 0 ? `$${r.amount}M` : "Undisclosed",
        round: r.round || "Funding round",
        investors: investors.length > 0 ? investors.slice(0, 4).join(", ") : "Undisclosed",
        date: new Date(r.date * 1000).toISOString(),
      };
    });
}

// Exchange Listings — CoinGecko's public status_updates feed, filtered to
// the exchange_listing category (free, no key). These are project-submitted
// announcements, not a curated "just landed on Binance" feed, so quality
// varies — but it's real, live data rather than another fabricated section.
let latestExchangeListings = [];

app.get("/api/listings", (req, res) => {
  res.json({ items: latestExchangeListings });
});

async function fetchExchangeListingUpdates() {
  const res = await fetchWithTimeout(
    "https://api.coingecko.com/api/v3/status_updates?category=exchange_listing&per_page=10&page=1",
    { headers: { Accept: "application/json" } },
    10000
  );
  if (!res.ok) throw new Error(`CoinGecko status_updates error: ${res.status}`);
  return res.json();
}

function buildListingRows(statusResp) {
  const updates = (statusResp && statusResp.status_updates) || [];
  return updates
    .filter((u) => u && u.project)
    .slice(0, 8)
    .map((u) => ({
      project: u.project.name || u.project.symbol || "Unknown project",
      symbol: (u.project.symbol || "").toUpperCase(),
      description: (u.description || "").slice(0, 160),
      date: u.created_at || new Date().toISOString(),
    }));
}

// Persists the current in-memory snapshot to Firestore's feed/latest doc.
// Called after every regeneration so the next boot can load real data
// instead of falling back to the tiny seed or re-fetching immediately.
async function saveIntelligenceSnapshot() {
  if (!isFirestoreConfigured()) return;
  try {
    await firestoreDb.collection("feed").doc("latest").set({
      feedItems,
      summary: latestSummary,
      marketSnapshot: latestMarketSnapshot,
      fundingRounds: latestFundingRounds,
      exchangeListings: latestExchangeListings,
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[firestore] failed to save intelligence snapshot:", err.message);
  }
}

// Loads the last saved snapshot on boot. Returns true if real data was
// found and loaded, so the caller knows whether a fresh generation is
// still needed (e.g. first-ever boot, or Firestore not configured).
async function loadIntelligenceSnapshot() {
  if (!isFirestoreConfigured()) return false;
  try {
    const doc = await firestoreDb.collection("feed").doc("latest").get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (Array.isArray(data.feedItems) && data.feedItems.length > 0) feedItems = data.feedItems;
    if (data.summary) latestSummary = data.summary;
    if (data.marketSnapshot) latestMarketSnapshot = data.marketSnapshot;
    if (Array.isArray(data.fundingRounds)) latestFundingRounds = data.fundingRounds;
    if (Array.isArray(data.exchangeListings)) latestExchangeListings = data.exchangeListings;
    console.log(`[firestore] loaded cached intelligence snapshot from ${data.savedAt}`);
    return true;
  } catch (err) {
    console.error("[firestore] failed to load intelligence snapshot:", err.message);
    return false;
  }
}

async function generateDailyIntelligence() {
  try {
    const [movers, trendingResp] = await Promise.all([fetchTopMarketMovers(), fetchTrendingSearch()]);
    const built = buildFeedItemsFromMarketData(movers, trendingResp);
    if (built.length === 0) throw new Error("No feed items generated from market data");

    feedItems = toFeedRecords(built);
    latestMarketSnapshot = buildMarketSnapshot(movers, trendingResp);

    let points;
    try {
      points = await generateAiSummary(movers, trendingResp);
    } catch (err) {
      console.error("[intelligence] Groq summary failed, using fallback summary:", err.message);
      points = buildFallbackSummary(movers, trendingResp);
    }
    latestSummary = { points, generatedAt: new Date().toISOString() };

    console.log(`[intelligence] refreshed ${feedItems.length} feed items at ${latestSummary.generatedAt}`);
  } catch (err) {
    console.error("[intelligence] generateDailyIntelligence failed, keeping previous data:", err.message);
  }

  // Independent of the block above: a DefiLlama or CoinGecko hiccup here
  // shouldn't affect the main feed/summary that already succeeded.
  try {
    latestFundingRounds = buildFundingRows(await fetchFundingRounds());
    console.log(`[intelligence] refreshed ${latestFundingRounds.length} funding rounds`);
  } catch (err) {
    console.error("[intelligence] funding rounds refresh failed, keeping previous data:", err.message);
  }

  try {
    latestExchangeListings = buildListingRows(await fetchExchangeListingUpdates());
    console.log(`[intelligence] refreshed ${latestExchangeListings.length} exchange listing updates`);
  } catch (err) {
    console.error("[intelligence] exchange listings refresh failed, keeping previous data:", err.message);
  }

  await saveIntelligenceSnapshot();
}

function msUntilNextUtcHour(hourUtc) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Data refresh and Telegram notification are deliberately separate calls.
// generateDailyIntelligence() runs on every boot (so the site never shows
// stale/empty data after a deploy) and would otherwise re-send the digest
// on every redeploy — this ties the actual user-facing send to only the
// scheduled 06:00 UTC tick (plus the once-per-day guard inside
// sendDailyDigest() itself as a second line of defense).
async function runScheduledDailyTick() {
  await generateDailyIntelligence();
  await sendDailyDigest();
}

function scheduleDailyIntelligence() {
  const delay = msUntilNextUtcHour(6);
  console.log(`[intelligence] next scheduled refresh in ${Math.round(delay / 60000)} minutes`);
  setTimeout(() => {
    runScheduledDailyTick();
    setInterval(runScheduledDailyTick, 24 * 60 * 60 * 1000);
  }, delay);
}

// ---------------------------------------------------------------------------
// Avatar upload (ImgBB proxy)
//
// The client downsizes the image and sends it as a base64 data URL. The
// upload is proxied through the server so IMGBB_API_KEY never reaches the
// browser. The resulting hosted URL is handed back to the client, which
// then calls Firebase Auth's updateProfile({ photoURL }) itself — no
// Firestore involved, profile photos live on the Firebase Auth user record.
// ---------------------------------------------------------------------------

app.post("/api/upload/avatar", async (req, res) => {
  if (!IMGBB_API_KEY) {
    return res.status(503).json({ error: "Image uploads aren't configured yet." });
  }

  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 is required" });
  }

  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
  // Rough size guard: base64 is ~33% larger than the original binary.
  if (base64Data.length > 5_000_000) {
    return res.status(413).json({ error: "Image is too large." });
  }

  try {
    const params = new URLSearchParams();
    params.set("key", IMGBB_API_KEY);
    params.set("image", base64Data);

    const uploadRes = await fetchWithTimeout(
      "https://api.imgbb.com/1/upload",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() },
      15000
    );
    const data = await uploadRes.json();

    if (!uploadRes.ok || !data.success) {
      throw new Error((data.error && data.error.message) || `ImgBB error: ${uploadRes.status}`);
    }

    res.json({ url: data.data.url });
  } catch (err) {
    console.error("[avatar] upload failed:", err.message);
    res.status(502).json({ error: "Image upload failed. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Settings API (placeholder)
//
// Real per-user settings require verifying a Firebase ID token server-side
// (via firebase-admin), which isn't wired up yet. These routes are structured
// so that a verifyAuth middleware can be dropped in later without changing
// the route shape.
// ---------------------------------------------------------------------------

app.get("/api/settings", (req, res) => {
  res.json({
    theme: "dark",
    notificationPreferences: { telegram: false, email: false, browser: false },
    followedCategories: [],
  });
});

app.post("/api/settings", (req, res) => {
  // TODO: persist to Firestore `settings` collection once Admin SDK is wired up.
  res.json({ ok: true, received: req.body || {} });
});

// ---------------------------------------------------------------------------
// Telegram integration
//
// The bot token isn't configured yet — it will be provided later via the
// TELEGRAM_BOT_TOKEN environment variable. Everything below degrades
// gracefully (returns "not configured") until it is set, so the rest of the
// app can be built and deployed without it.
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "";

// Verifies incoming webhook calls actually come from Telegram (Telegram
// echoes this back in the X-Telegram-Bot-Api-Secret-Token header on every
// request once set via setWebhook). Generated fresh on boot.
const TELEGRAM_WEBHOOK_SECRET = crypto.randomBytes(24).toString("hex");

function isTelegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_USERNAME);
}

// Firestore persistence for telegram_links — doc ID is the chatId, since
// that's always present and unique (unlike userId, which is a synthetic
// `tg:<chatId>` for chats that subscribed without a Kairon account).
async function loadTelegramLinks() {
  if (!isFirestoreConfigured()) return;
  try {
    const snapshot = await firestoreDb.collection("telegram_links").get();
    telegramLinks = snapshot.docs.map((d) => d.data());
    console.log(`[firestore] loaded ${telegramLinks.length} telegram links`);
  } catch (err) {
    console.error("[firestore] failed to load telegram_links:", err.message);
  }
}

async function saveTelegramLink(link) {
  if (!isFirestoreConfigured()) return;
  try {
    await firestoreDb.collection("telegram_links").doc(String(link.chatId)).set(link);
  } catch (err) {
    console.error("[firestore] failed to save telegram_link:", err.message);
  }
}

async function deleteTelegramLink(chatId) {
  if (!isFirestoreConfigured()) return;
  try {
    await firestoreDb.collection("telegram_links").doc(String(chatId)).delete();
  } catch (err) {
    console.error("[firestore] failed to delete telegram_link:", err.message);
  }
}

// Firestore persistence for notification_preferences — doc ID is also the
// chatId, one doc per Telegram chat holding its selected categories.
async function loadTelegramPreferences() {
  if (!isFirestoreConfigured()) return;
  try {
    const snapshot = await firestoreDb.collection("notification_preferences").get();
    telegramPreferences = new Map();
    snapshot.docs.forEach((d) => {
      telegramPreferences.set(Number(d.id), new Set(d.data().categories || []));
    });
    console.log(`[firestore] loaded ${telegramPreferences.size} notification preferences`);
  } catch (err) {
    console.error("[firestore] failed to load notification_preferences:", err.message);
  }
}

async function saveTelegramPreferences(chatId, categoriesSet) {
  if (!isFirestoreConfigured()) return;
  try {
    await firestoreDb
      .collection("notification_preferences")
      .doc(String(chatId))
      .set({ categories: [...categoriesSet], updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[firestore] failed to save notification_preferences:", err.message);
  }
}

async function deleteTelegramPreferences(chatId) {
  if (!isFirestoreConfigured()) return;
  try {
    await firestoreDb.collection("notification_preferences").doc(String(chatId)).delete();
  } catch (err) {
    console.error("[firestore] failed to delete notification_preferences:", err.message);
  }
}

async function callTelegramApi(method, payload) {
  if (!isTelegramConfigured()) return null;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function ensureTelegramWebhook() {
  if (!isTelegramConfigured()) return;
  try {
    await callTelegramApi("setWebhook", {
      url: `${PUBLIC_URL}/api/telegram/webhook`,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
    });
    console.log("[telegram] webhook registered at", `${PUBLIC_URL}/api/telegram/webhook`);
  } catch (err) {
    console.error("[telegram] failed to set webhook:", err.message);
  }
}

// Per-chat category preferences for the daily digest. Empty/missing set
// means "no filter — send everything." Same 15 categories as the site.
const ALL_CATEGORIES = [
  "Bitcoin", "Ethereum", "Solana", "Base", "DeFi", "Stablecoins", "Memecoins", "AI",
  "Security", "Funding", "Governance", "Macro", "Exchanges", "NFTs", "Airdrops",
];
let telegramPreferences = new Map(); // chatId -> Set<category>

function buildPreferencesKeyboard(selected) {
  const rows = [];
  for (let i = 0; i < ALL_CATEGORIES.length; i += 3) {
    rows.push(
      ALL_CATEGORIES.slice(i, i + 3).map((cat) => ({
        text: `${selected.has(cat) ? "✅ " : ""}${cat}`,
        callback_data: `pref:${cat}`,
      }))
    );
  }
  rows.push([{ text: "🔄 Reset (all categories)", callback_data: "pref_reset" }]);
  rows.push([{ text: "✅ Done", callback_data: "pref_done" }]);
  return { inline_keyboard: rows };
}

function welcomeText(firstName) {
  const greeting = firstName ? `, ${firstName}` : "";
  return [
    `Welcome to Kairon${greeting}! 👋`,
    "",
    "I'm your daily on-chain intelligence briefing. Every morning at 06:00 UTC I'll send you one focused message covering the strongest, most interesting crypto signals — big market movers, trending coins, and an AI-written summary of what actually matters. One briefing a day, never more.",
    "",
    "Here's what you can do:",
    "📋 /preferences — choose which categories you want in your briefing",
    "🔕 /unsubscribe — stop receiving messages anytime",
    "❓ /help — see this message again",
  ].join("\n");
}

async function sendWelcomeMessage(chatId, from) {
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: welcomeText(from && from.first_name),
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Set Preferences", callback_data: "open_prefs" }],
        [{ text: "🌐 Open Kairon", url: PUBLIC_URL }],
      ],
    },
  });
}

// Sends one consolidated daily digest (today's summary + top signals) to
// everyone who has messaged the bot, respecting each chat's category
// preferences. Only ever called from the scheduled 06:00 UTC tick — never
// from a data refresh — plus this date guard as a second safeguard against
// double-sends (e.g. if the interval and a redeploy's boot run were to
// somehow overlap). Note: this guard lives in memory, so it does not
// survive a restart/redeploy on its own — the split from
// generateDailyIntelligence() above is the primary protection.
let lastDigestSentDateUTC = null;

async function sendDailyDigest() {
  if (!isTelegramConfigured() || telegramLinks.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  if (lastDigestSentDateUTC === today) {
    console.log("[telegram] daily digest already sent today, skipping");
    return;
  }

  for (const link of telegramLinks) {
    const prefs = telegramPreferences.get(link.chatId);
    const relevant = prefs && prefs.size > 0 ? feedItems.filter((i) => prefs.has(i.category)) : feedItems;
    if (relevant.length === 0) continue; // nothing matches their filter today — skip rather than send an empty digest

    const lines = [
      "*Kairon Daily Briefing*",
      "",
      ...latestSummary.points.map((p) => `• ${p}`),
      "",
      "*Top signals today:*",
      ...relevant.slice(0, 3).map((i) => `— ${i.title}`),
    ];

    try {
      await callTelegramApi("sendMessage", {
        chat_id: link.chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Open Kairon", url: PUBLIC_URL }],
            [{ text: "📋 Preferences", callback_data: "open_prefs" }, { text: "🔕 Unsubscribe", callback_data: "ask_unsubscribe" }],
          ],
        },
      });
    } catch (err) {
      console.error("[telegram] failed to send daily digest to", link.chatId, err.message);
    }
  }

  lastDigestSentDateUTC = today;
}

async function sendFeedNotification(chatId, feedItem) {
  return callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: `*${feedItem.title}*\n\n${feedItem.summary}`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Read More", url: `${PUBLIC_URL}/feed/${feedItem.slug}` }],
      ],
    },
  });
}

function notifyNewFeedItem(feedItem) {
  if (!isTelegramConfigured() || telegramLinks.length === 0) return;
  for (const link of telegramLinks) {
    sendFeedNotification(link.chatId, feedItem).catch((err) => {
      console.error("Telegram notification failed:", err.message);
    });
  }
}

// Generates a one-time token the frontend turns into a t.me deep link, e.g.
// https://t.me/<bot_username>?start=<token>
app.get("/api/telegram/link", (req, res) => {
  if (!isTelegramConfigured()) {
    return res.json({ configured: false });
  }

  // TODO: replace with the authenticated user's uid once verifyAuth middleware exists.
  const userId = String(req.query.userId || "");
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const token = crypto.randomBytes(16).toString("hex");
  telegramLinkTokens.set(token, { userId, createdAt: Date.now() });

  res.json({
    configured: true,
    linkUrl: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}`,
  });
});

async function handleTelegramStart(message) {
  const text = message.text || "";
  const token = text.split(" ")[1];
  const pending = token && telegramLinkTokens.get(token);
  const chatId = message.chat.id;
  const userId = pending ? pending.userId : `tg:${chatId}`;

  if (pending) telegramLinkTokens.delete(token);

  telegramLinks = telegramLinks.filter((l) => l.chatId !== chatId);
  const link = {
    userId,
    chatId,
    telegramName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" "),
    username: message.from.username || "",
    linkedAt: new Date().toISOString(),
  };
  telegramLinks.push(link);
  await saveTelegramLink(link);

  await sendWelcomeMessage(chatId, message.from);
}

async function handleUnsubscribePrompt(chatId) {
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: "Are you sure you want to unsubscribe from Kairon's daily briefing? You'll stop receiving messages until you send /start again.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Yes, unsubscribe", callback_data: "unsub_confirm" }],
        [{ text: "❌ No, stay subscribed", callback_data: "unsub_cancel" }],
      ],
    },
  });
}

async function handlePreferencesCommand(chatId) {
  const selected = telegramPreferences.get(chatId) || new Set();
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: "Which categories do you want in your daily briefing? Tap to select or deselect — pick as many as you like.",
    reply_markup: buildPreferencesKeyboard(selected),
  });
}

async function handleTelegramCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Always acknowledge first so Telegram stops showing a loading spinner
  // on the button, even if something below fails.
  callTelegramApi("answerCallbackQuery", { callback_query_id: callbackQuery.id }).catch(() => {});

  if (data === "open_prefs") {
    await handlePreferencesCommand(chatId);
    return;
  }

  if (data === "ask_unsubscribe") {
    await handleUnsubscribePrompt(chatId);
    return;
  }

  if (data.startsWith("pref:")) {
    const category = data.slice(5);
    const selected = telegramPreferences.get(chatId) || new Set();
    if (selected.has(category)) selected.delete(category);
    else selected.add(category);
    telegramPreferences.set(chatId, selected);
    await saveTelegramPreferences(chatId, selected);

    await callTelegramApi("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildPreferencesKeyboard(selected),
    });
    return;
  }

  if (data === "pref_reset") {
    telegramPreferences.delete(chatId);
    await deleteTelegramPreferences(chatId);
    await callTelegramApi("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildPreferencesKeyboard(new Set()),
    });
    return;
  }

  if (data === "pref_done") {
    const selected = telegramPreferences.get(chatId) || new Set();
    const summary = selected.size > 0 ? [...selected].join(", ") : "All categories";
    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `Saved! You'll get briefings for: ${summary}`,
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (data === "unsub_confirm") {
    telegramLinks = telegramLinks.filter((l) => l.chatId !== chatId);
    telegramPreferences.delete(chatId);
    await Promise.all([deleteTelegramLink(chatId), deleteTelegramPreferences(chatId)]);
    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "You've been unsubscribed from Kairon's daily briefing. Send /start anytime to rejoin.",
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (data === "unsub_cancel") {
    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "No worries — you're still subscribed to Kairon's daily briefing. 👍",
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }
}

// Telegram webhook: receives updates once the bot is configured with
// setWebhook. Handles "/start <token>" to complete account linking to a
// signed-in Kairon user, or a bare "/start" to subscribe the chat to the
// daily digest directly (no Kairon account needed yet — this is how
// standalone subscribers, e.g. before the Settings/Link-Telegram UI is
// built, start receiving the daily briefing). Also handles /unsubscribe,
// /preferences, /help, and the inline button taps those send.
app.post("/api/telegram/webhook", async (req, res) => {
  if (isTelegramConfigured() && req.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const update = req.body || {};

  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return res.sendStatus(200);
  }

  const message = update.message;
  const text = message && message.text;

  if (text && text.startsWith("/start")) {
    await handleTelegramStart(message);
  } else if (text && text.startsWith("/unsubscribe")) {
    await handleUnsubscribePrompt(message.chat.id);
  } else if (text && (text.startsWith("/preferences") || text.startsWith("/preference"))) {
    await handlePreferencesCommand(message.chat.id);
  } else if (text && text.startsWith("/help")) {
    await sendWelcomeMessage(message.chat.id, message.from);
  }

  res.sendStatus(200);
});

app.get("/api/telegram/status", (req, res) => {
  const userId = String(req.query.userId || "");
  const link = telegramLinks.find((l) => l.userId === userId);
  res.json({ configured: isTelegramConfigured(), linked: Boolean(link), link: link || null });
});

// Manually forces a refresh of the daily intelligence pipeline — useful for
// testing without waiting for the 06:00 UTC schedule. Disabled unless
// ADMIN_SECRET is set in the environment. Does NOT send the Telegram digest
// unless ?notify=true is also passed — and even then, sendDailyDigest()'s
// own once-per-day guard still applies, so this can't be used to spam
// subscribers by hitting it repeatedly.
app.post("/api/admin/refresh", async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.sendStatus(404);
  }
  await generateDailyIntelligence();
  if (req.query.notify === "true") {
    await sendDailyDigest();
  }
  res.json({ ok: true, items: feedItems.length, summary: latestSummary, digestSentDate: lastDigestSentDateUTC });
});

// ---------------------------------------------------------------------------
// Still on the roadmap (not built yet — see CLAUDE.md → FUTURE FEATURES):
// X (Twitter) monitoring, wallet/smart-money tracking, exchange listing and
// funding-round data, duplicate detection, scheduled publishing beyond the
// daily cycle above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/firebase.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "firebase.js"));
});

// Client-side routes (e.g. /feed/:slug) fall back to index.html so the
// frontend's own router can render them.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Kairon server running on http://localhost:${PORT}`);

  // Non-blocking: the server starts serving immediately with fallback feed
  // data, then swaps in real/cached data as soon as this completes. Boot
  // loads from Firestore rather than regenerating, so a redeploy doesn't
  // burn API calls or show a momentary reset — the 06:00 UTC schedule is
  // the only thing that regenerates going forward.
  (async () => {
    ensureTelegramWebhook();
    await Promise.all([loadTelegramLinks(), loadTelegramPreferences()]);

    const hadCachedSnapshot = await loadIntelligenceSnapshot();
    if (!hadCachedSnapshot) {
      console.log("[intelligence] no cached snapshot found, generating now");
      await generateDailyIntelligence();
    }
    scheduleDailyIntelligence();
  })();
});
