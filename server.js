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
// the daily intelligence snapshot (feed, summary, insights, coin analyses)
// — so a redeploy no longer wipes them, and boot doesn't have to regenerate
// the daily data from scratch. Requires FIREBASE_SERVICE_ACCOUNT_KEY
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
// live data on startup and once daily at the scheduled digest hour — this is not shown in
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
//
// Stores a full snapshot of the feed item, not just its id — feedItems is
// fully replaced every day, so an item bookmarked yesterday won't exist in
// today's in-memory feed to look up. The snapshot is what the Bookmarks
// page renders directly.
// ---------------------------------------------------------------------------

app.get("/api/bookmarks", verifyAuth, async (req, res) => {
  try {
    const snapshot = await firestoreDb.collection("bookmarks").where("uid", "==", req.uid).get();
    const items = snapshot.docs
      .map((d) => d.data())
      .sort((a, b) => new Date(b.bookmarkedAt) - new Date(a.bookmarkedAt))
      .map((d) => ({ ...d.item, id: d.itemId, bookmarkedAt: d.bookmarkedAt }));
    res.json({ items });
  } catch (err) {
    console.error("[bookmarks] failed to load:", err.message);
    res.status(500).json({ error: "Failed to load bookmarks." });
  }
});

app.post("/api/bookmarks", verifyAuth, async (req, res) => {
  const { item } = req.body || {};
  if (!item || !item.id) return res.status(400).json({ error: "item (with an id) is required" });
  try {
    const { id, ...rest } = item;
    await firestoreDb
      .collection("bookmarks")
      .doc(`${req.uid}_${id}`)
      .set({ uid: req.uid, itemId: id, item: rest, bookmarkedAt: new Date().toISOString() });
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

// Trending: GeckoTerminal first — real organic trending pools (ranked by
// actual trading activity), Solana network. We used DexScreener's boosted-
// tokens endpoint here before, but that's PAID PROMOTION (projects pay to
// appear there), not organic trending — actively misleading to label as
// "trending" for someone comparing it against what he actually sees moving
// on Axiom/DexScreener. Falls back to CoinGecko's trending search if
// GeckoTerminal fails. Neither call is verifiable from local dev
// (geckoterminal.com is blocked from this sandbox the same way
// coingecko.com is) — confirm via Railway logs after deploy.
async function fetchGeckoTerminalTrending() {
  const res = await fetchWithTimeout(
    "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools",
    { headers: { Accept: "application/json" } },
    10000
  );
  if (!res.ok) throw new Error(`GeckoTerminal trending_pools error: ${res.status}`);
  const data = await res.json();

  const pools = Array.isArray(data.data) ? data.data : [];
  const included = Array.isArray(data.included) ? data.included : [];
  const tokensById = new Map(included.filter((i) => i.type === "token").map((t) => [t.id, t]));

  const results = [];
  const seenTokenIds = new Set();
  for (const pool of pools) {
    const attrs = pool.attributes || {};
    const baseTokenRel = pool.relationships && pool.relationships.base_token && pool.relationships.base_token.data;
    const token = baseTokenRel && tokensById.get(baseTokenRel.id);
    if (!token || seenTokenIds.has(token.id)) continue;
    seenTokenIds.add(token.id);

    const tokenAttrs = token.attributes || {};
    const change24h = attrs.price_change_percentage && attrs.price_change_percentage.h24;

    results.push({
      id: tokenAttrs.address || token.id,
      name: tokenAttrs.name || tokenAttrs.symbol || "Unknown",
      symbol: (tokenAttrs.symbol || "").toUpperCase(),
      marketCapRank: null,
      change24h: change24h !== undefined && change24h !== null ? Number(change24h) : null,
      volumeUsd24h: attrs.volume_usd && attrs.volume_usd.h24 ? Number(attrs.volume_usd.h24) : null,
      source: "geckoterminal",
    });
    if (results.length >= 15) break;
  }

  if (results.length === 0) throw new Error("No trending pools resolved to token data");
  return results;
}

async function fetchCoinGeckoTrendingNormalized() {
  const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/search/trending", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko trending error: ${res.status}`);
  const data = await res.json();
  return (data.coins || []).map((c) => c.item).map((t) => ({
    id: t.id,
    name: t.name,
    symbol: (t.symbol || "").toUpperCase(),
    marketCapRank: t.market_cap_rank || null,
    change24h:
      t.data && t.data.price_change_percentage_24h && typeof t.data.price_change_percentage_24h.usd === "number"
        ? t.data.price_change_percentage_24h.usd
        : null,
    source: "coingecko",
  }));
}

async function fetchTrendingCoins() {
  try {
    const trending = await fetchGeckoTerminalTrending();
    console.log(`[intelligence] using GeckoTerminal trending (${trending.length} Solana tokens)`);
    return trending;
  } catch (err) {
    console.error("[intelligence] GeckoTerminal trending failed, falling back to CoinGecko trending:", err.message);
    return fetchCoinGeckoTrendingNormalized();
  }
}

// Robinhood ($HOOD) stock tracking — 0xRiver called this "very very
// important." It's a stock, not a coin, so it comes from Finnhub rather
// than CoinGecko/GeckoTerminal, and is layered into the feed and coin
// breakdown as its own independent step (never blocks the rest of the
// pipeline if it fails). FINNHUB_API_KEY: sign up free at finnhub.io, the
// key is on the dashboard. Not verifiable from this sandbox (finnhub.io is
// blocked here the same way the other market APIs are) — confirm via
// Railway logs after deploy.
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";

async function fetchRobinhoodStock() {
  if (!FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY not configured");
  const res = await fetchWithTimeout(
    `https://finnhub.io/api/v1/quote?symbol=HOOD&token=${FINNHUB_API_KEY}`,
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Finnhub quote error: ${res.status}`);
  const data = await res.json();
  // Finnhub returns all-zero fields for an invalid symbol/key rather than an error status.
  if (typeof data.c !== "number" || data.c === 0) throw new Error("Finnhub returned no quote data");
  return data; // { c: current, d: change, dp: percent change, h, l, o, pc: prevClose }
}

function buildRobinhoodFeedItem(quote) {
  const pct = typeof quote.dp === "number" ? quote.dp : 0;
  const direction = pct >= 0 ? "up" : "down";
  return {
    title: `Robinhood (HOOD) is ${direction} ${Math.abs(pct).toFixed(1)}% today`,
    summary: `Robinhood Markets (HOOD) is trading at ${formatUsd(quote.c)}, ${direction} ${Math.abs(pct).toFixed(1)}% from yesterday's close of ${formatUsd(
      quote.pc
    )}.`,
    category: "Robinhood",
    tags: ["HOOD", "Robinhood", "Stocks"],
    trending: Math.abs(pct) >= 3,
  };
}

// Real on-chain activity (not price data) for Solana tokens, via Helius's
// Enhanced Transactions API. This is the actual "on-chain" part of "on-chain
// intelligence" — a count of real, recent transactions/swaps involving the
// token's mint address, as opposed to CoinGecko/GeckoTerminal price and
// volume stats. Solana-only (Helius doesn't cover Bitcoin/Ethereum), and
// only applied to GeckoTerminal-sourced trending picks, since those are the
// only ones we have a real mint address for. HELIUS_API_KEY: already added
// to Railway (it was originally provisioned for a smart-money feature we
// decided to cut — reused here for a lighter-weight signal instead). Not
// verifiable from this sandbox (helius.xyz is blocked here too) — confirm
// via Railway logs after deploy.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

async function fetchOnChainActivity(mintAddress) {
  if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const res = await fetchWithTimeout(
    `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`,
    { headers: { Accept: "application/json" } },
    10000
  );
  if (!res.ok) throw new Error(`Helius transactions error: ${res.status}`);
  const txs = await res.json();
  if (!Array.isArray(txs)) throw new Error("Helius returned an unexpected response shape");

  const oneHourAgoSec = Date.now() / 1000 - 3600;
  const recent = txs.filter((t) => typeof t.timestamp === "number" && t.timestamp >= oneHourAgoSec);
  const swapCount = recent.filter((t) => t.type === "SWAP").length;

  return { transactionCount: recent.length, swapCount };
}

// Adds a real on-chain activity stat to any coin in the list that has a
// Solana mint address (only GeckoTerminal-sourced trending picks do).
// Independent per-coin — one Helius failure doesn't drop the others.
async function enrichWithOnChainActivity(coins) {
  return Promise.all(
    coins.map(async (c) => {
      if (c.trendingSource !== "organic DEX trading activity") return c;
      try {
        const onChainActivity = await fetchOnChainActivity(c.id);
        return { ...c, onChainActivity };
      } catch (err) {
        console.error(`[intelligence] on-chain activity fetch failed for ${c.symbol}:`, err.message);
        return c;
      }
    })
  );
}

// BTC/ETH/SOL always appear in the feed and Insights regardless of whether
// they're among the biggest movers — they're the reference points every
// trader checks first, and a pure "sorted by % change" list tends to bury
// them under far more volatile small-caps.
const MAJOR_IDS = ["bitcoin", "ethereum", "solana"];

function buildFeedItemsFromMarketData(movers, trending) {
  const trendingIds = new Set(trending.map((t) => t.id));
  const items = [];
  const seen = new Set();

  for (const majorId of MAJOR_IDS) {
    const m = movers.find((x) => x.id === majorId);
    if (!m || typeof m.price_change_percentage_24h !== "number") continue;
    seen.add(m.id);
    const pct = m.price_change_percentage_24h;
    const direction = pct >= 0 ? "up" : "down";
    const category = inferCategory(m.id, m.symbol);
    items.push({
      title: `${m.name} (${m.symbol.toUpperCase()}) is ${direction} ${Math.abs(pct).toFixed(1)}% in the last 24 hours`,
      summary: `${m.name} is trading at ${formatUsd(m.current_price)} with a market cap of ${formatCompactUsd(
        m.market_cap
      )}, ranked #${m.market_cap_rank} by market cap.${trendingIds.has(m.id) ? " It's also currently trending." : ""}`,
      category,
      tags: [m.symbol.toUpperCase(), category, "Majors"],
      trending: trendingIds.has(m.id) || Math.abs(pct) >= 8,
    });
  }

  // Memecoins first, then by size of move — this audience trades
  // memecoins, so a 6% BNB move shouldn't bury a 40% PEPE move.
  const significantMovers = movers
    .filter((m) => typeof m.price_change_percentage_24h === "number" && !seen.has(m.id))
    .sort((a, b) => {
      const aMeme = MEME_SYMBOLS.has((a.symbol || "").toLowerCase()) ? 1 : 0;
      const bMeme = MEME_SYMBOLS.has((b.symbol || "").toLowerCase()) ? 1 : 0;
      if (aMeme !== bMeme) return bMeme - aMeme;
      return Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h);
    })
    .slice(0, 12);

  for (const m of significantMovers) {
    seen.add(m.id);
    const pct = m.price_change_percentage_24h;
    const direction = pct >= 0 ? "up" : "down";
    const category = inferCategory(m.id, m.symbol);
    items.push({
      title: `${m.name} (${m.symbol.toUpperCase()}) is ${direction} ${Math.abs(pct).toFixed(1)}% in the last 24 hours`,
      summary: `${m.name} is trading at ${formatUsd(m.current_price)} with a market cap of ${formatCompactUsd(
        m.market_cap
      )}, ranked #${m.market_cap_rank} by market cap.${trendingIds.has(m.id) ? " It's also currently trending." : ""}`,
      category,
      tags: [m.symbol.toUpperCase(), category],
      trending: trendingIds.has(m.id) || Math.abs(pct) >= 8,
    });
  }

  for (const t of trending.slice(0, 8)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    let category = inferCategory(t.id, t.symbol.toLowerCase());
    // GeckoTerminal's Solana trending pools are, in practice, almost always
    // degen memecoins, not L1-ecosystem news — tagging them "Memecoins"
    // (not "Solana") is what makes the category filter actually useful for
    // a memecoin trader, instead of burying them under a generic label.
    if (category === "Macro" && t.source === "geckoterminal") category = "Memecoins";
    // volumeUsd24h is real on-chain DEX trading volume from GeckoTerminal
    // (not a CoinGecko price stat) — surfacing it is the difference between
    // "this token's price moved" and "here's the on-chain activity behind
    // it," so it's worth stating explicitly rather than folding it into a
    // generic trending blurb.
    const onChainLabel = t.source === "geckoterminal" ? "on-chain DEX trading" : "search interest";
    const sourceLabel = t.source === "geckoterminal" ? "GeckoTerminal" : "CoinGecko";
    const change = t.change24h;
    items.push({
      title: `${t.name} (${t.symbol}) is trending on ${sourceLabel} today`,
      summary: `${t.name} is trending on ${sourceLabel}, driven by real ${onChainLabel} activity${
        typeof change === "number" ? `. Price is ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% over the last 24 hours` : ""
      }${
        typeof t.volumeUsd24h === "number" ? `, with ${formatCompactUsd(t.volumeUsd24h)} in on-chain trading volume in that time` : ""
      }.`,
      category,
      tags: [t.symbol, category, "Trending"],
      trending: true,
    });
  }

  return items;
}

async function generateAiSummary(movers, trending) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const valid = movers.filter((m) => typeof m.price_change_percentage_24h === "number");
  const topGainers = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 5);
  const topLosers = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 5);
  const memecoins = valid
    .filter((m) => MEME_SYMBOLS.has((m.symbol || "").toLowerCase()))
    .sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h))
    .slice(0, 6);

  const dataForPrompt = {
    // trending is GeckoTerminal's Solana trending pools — almost entirely
    // degen memecoins — plus memecoins is the top-100 memecoin movers by
    // name. Listed first/separately since this audience trades memecoins.
    trending: trending.slice(0, 8).map((t) => ({ name: t.name, symbol: t.symbol, change24h: t.change24h })),
    memecoins: memecoins.map((m) => ({ name: m.name, symbol: m.symbol.toUpperCase(), change24h: Number(m.price_change_percentage_24h.toFixed(2)) })),
    topGainers: topGainers.map((m) => ({ name: m.name, symbol: m.symbol.toUpperCase(), change24h: Number(m.price_change_percentage_24h.toFixed(2)) })),
    topLosers: topLosers.map((m) => ({ name: m.name, symbol: m.symbol.toUpperCase(), change24h: Number(m.price_change_percentage_24h.toFixed(2)) })),
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
              'You are a crypto market analyst writing a concise daily briefing for an on-chain intelligence product called Kairon, for an audience of memecoin and degen traders. Only use the numeric facts provided in the user message — never invent coins, numbers, or events not present in the data. Return strict JSON of the shape {"points": ["...", "...", "...", "..."]}. Write 4-5 bullets, each a single sentence under 28 words. Prioritize the "trending" and "memecoins" data first — at least 3 of the bullets must be about specific memecoins/trending tokens, naming the coin and its move. Only use "topGainers"/"topLosers" (mostly large-cap coins) for at most 1 bullet of brief context. Never write a tautology that is trivially true by construction (e.g. "gainers outpaced losers" on a green day, or "the market was mixed") — every bullet must state a specific fact (a name, a number, a comparison) that a reader could not have guessed without seeing the data. If a bullet does not name at least one specific coin or number, rewrite it.',
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

function buildFallbackSummary(movers, trending) {
  const valid = movers.filter((m) => typeof m.price_change_percentage_24h === "number");
  const topGainer = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h)[0];
  const topLoser = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h)[0];
  const trendingTop = trending[0];
  const trendingSecond = trending[1];
  const positiveCount = valid.filter((m) => m.price_change_percentage_24h > 0).length;

  const points = [];
  if (trendingTop) {
    const changeText = typeof trendingTop.change24h === "number" ? `, ${trendingTop.change24h >= 0 ? "up" : "down"} ${Math.abs(trendingTop.change24h).toFixed(1)}%` : "";
    points.push(`${trendingTop.name} (${trendingTop.symbol}) is today's top trending memecoin${changeText}.`);
  }
  if (trendingSecond) points.push(`${trendingSecond.name} (${trendingSecond.symbol}) is also seeing a real pickup in on-chain trading activity.`);
  if (topGainer) points.push(`${topGainer.name} led the top 100 today, up ${topGainer.price_change_percentage_24h.toFixed(1)}% in 24 hours.`);
  if (topLoser) points.push(`${topLoser.name} was the biggest decliner, down ${Math.abs(topLoser.price_change_percentage_24h).toFixed(1)}%.`);
  points.push(`${positiveCount} of the top 100 coins by market cap are in the green today.`);
  return points;
}

// Deterministic fallback for the AI Coin Breakdown if Groq is unavailable —
// mirrors buildFallbackSummary's role for the market summary. Without this,
// a single failed Groq call leaves latestCoinAnalyses at [] indefinitely
// (it's only ever overwritten on a successful generation), which is exactly
// the "being generated, check back shortly" empty state that's the single
// biggest thing wrong with showing this site to a paying customer.
function buildFallbackCoinAnalyses(coins) {
  return coins.map((c) => {
    const changeKnown = typeof c.change24h === "number";
    const moveText = changeKnown ? `${c.change24h >= 0 ? "up" : "down"} ${Math.abs(c.change24h).toFixed(1)}%` : "moving";
    const reasonText = c.trendingSource
      ? `alongside a pickup in ${c.trendingSource}`
      : "alongside broader market movement";
    const onChainText = c.onChainActivity
      ? ` On-chain, it saw ${c.onChainActivity.transactionCount} transactions (${c.onChainActivity.swapCount} swaps) in the last hour.`
      : "";
    return {
      id: c.id,
      name: c.name,
      symbol: c.symbol,
      change24h: c.change24h,
      category: c.category,
      onChainActivity: c.onChainActivity || null,
      whyItMoved: `${c.name} is ${moveText} today, ${reasonText}.${onChainText} We don't have a confirmed news catalyst for this move — this is what the data shows, not a specific story.`,
      whatCouldHappenNext:
        "Watch whether trading activity keeps up — moves that fade in volume tend to fade in price too, while sustained activity is more likely to hold.",
      howToApproachIt:
        "Treat this as high-risk, especially on a fast or large move — size accordingly, expect thin liquidity on smaller-cap names, and be cautious about chasing a candle that's already extended.",
    };
  });
}

// ---------------------------------------------------------------------------
// AI Coin Breakdown — a plain-language "why did this move, what could
// happen next, how should I think about it" explanation for the day's most
// interesting coins. This is the direct answer to "highlights the
// strongest/most interesting coins of the day" — not just a number, actual
// reasoning about it.
// ---------------------------------------------------------------------------

// Picks the coins worth explaining: biggest movers (excluding majors, which
// don't need a "why did it pump" writeup) plus whatever's genuinely
// trending, deduped, capped at 4 so it's one Groq call, not four.
function selectTopInterestingCoins(movers, trending) {
  const significantMovers = movers
    .filter((m) => typeof m.price_change_percentage_24h === "number" && !MAJOR_IDS.includes(m.id))
    .sort((a, b) => {
      const aMeme = MEME_SYMBOLS.has((a.symbol || "").toLowerCase()) ? 1 : 0;
      const bMeme = MEME_SYMBOLS.has((b.symbol || "").toLowerCase()) ? 1 : 0;
      if (aMeme !== bMeme) return bMeme - aMeme;
      return Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h);
    })
    .slice(0, 4)
    .map((m) => ({
      id: m.id,
      name: m.name,
      symbol: m.symbol.toUpperCase(),
      change24h: Number(m.price_change_percentage_24h.toFixed(2)),
      category: inferCategory(m.id, m.symbol),
      marketCapRank: m.market_cap_rank,
      trendingSource: null,
    }));

  const trendingTop = trending.slice(0, 3).map((t) => {
    let category = inferCategory(t.id, t.symbol.toLowerCase());
    // GeckoTerminal's Solana trending pools are, in practice, almost always
    // degen memecoins, not L1-ecosystem news — tagging them "Memecoins"
    // (not "Solana") is what makes the category filter actually useful for
    // a memecoin trader, instead of burying them under a generic label.
    if (category === "Macro" && t.source === "geckoterminal") category = "Memecoins";
    return {
      id: t.id,
      name: t.name,
      symbol: t.symbol,
      change24h: typeof t.change24h === "number" ? Number(t.change24h.toFixed(2)) : null,
      category,
      marketCapRank: t.marketCapRank,
      trendingSource: t.source === "geckoterminal" ? "organic DEX trading activity" : "CoinGecko search interest",
    };
  });

  // trendingTop first — it's almost entirely real degen memecoin activity
  // (GeckoTerminal), which is what this audience actually wants explained.
  // Putting it after significantMovers risked it getting sliced off.
  const seen = new Set();
  const combined = [];
  for (const c of [...trendingTop, ...significantMovers]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    combined.push(c);
  }
  return combined.slice(0, 6);
}

async function generateCoinAnalyses(coins) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");
  if (coins.length === 0) throw new Error("No coins selected to analyze");

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.5,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You write short, beginner-friendly breakdowns of individual crypto tokens for an on-chain intelligence product called Kairon.",
              "You are given each token's name, symbol, category, 24h price change, market cap rank (if known), why it was flagged (a big price move, or trending, and if trending, whether that's from organic DEX trading activity or CoinGecko search interest), and sometimes an onChainActivity field with real Solana transaction counts from the last hour (transactionCount, swapCount) — that field is real on-chain data, not a price stat, so when it's present, reference it naturally as supporting evidence.",
              "You do NOT have real news or on-chain event data beyond what's given. Never invent a specific catalyst, headline, listing, or event you were not given, and never state a number that isn't in the data you were given — if you don't actually know the cause, describe it honestly in terms of the signal you do have (e.g. 'this lines up with a burst of trading activity' rather than fabricating a reason).",
              "This is educational context, not financial advice. Never tell the reader to buy or sell, and never give a price target. For 'howToApproachIt', focus on: what would confirm the move is continuing vs fading, and real risk considerations (volatility, thin liquidity on small/micro caps, chasing a move that's already extended).",
              'Return strict JSON of the shape: {"analyses": [{"id": "...", "whyItMoved": "...", "whatCouldHappenNext": "...", "howToApproachIt": "..."}]}. One object per coin given, in the same order. Each field 1-2 short sentences, plain simple language, explain any jargon you use.',
            ].join(" "),
          },
          { role: "user", content: JSON.stringify(coins) },
        ],
      }),
    },
    15000
  );

  if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

  const data = await response.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message.content) || "{}";
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.analyses) || parsed.analyses.length === 0) {
    throw new Error("Groq returned no coin analyses");
  }

  const byId = new Map(parsed.analyses.map((a) => [a.id, a]));
  return coins
    .map((c) => {
      const a = byId.get(c.id);
      if (!a || !a.whyItMoved) return null;
      return {
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        change24h: c.change24h,
        category: c.category,
        // Echoed straight from our own fetch, not from the model — Groq may
        // reference it in prose, but the number shown on the card is real,
        // not an LLM restatement of it.
        onChainActivity: c.onChainActivity || null,
        whyItMoved: a.whyItMoved,
        whatCouldHappenNext: a.whatCouldHappenNext || null,
        howToApproachIt: a.howToApproachIt || null,
      };
    })
    .filter(Boolean);
}

let latestCoinAnalyses = [];

app.get("/api/analysis", (req, res) => {
  res.json({ items: latestCoinAnalyses });
});

let latestSummary = { points: ["Today's briefing is being generated — check back shortly."], generatedAt: null };

// Raw market data behind the feed/summary, kept around so the Insights and
// Alerts pages can show it directly instead of needing their own data source.
let latestMarketSnapshot = { majors: [], topGainers: [], topLosers: [], trending: [], updatedAt: null };

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

function buildMarketSnapshot(movers, trending) {
  const valid = movers.filter((m) => typeof m.price_change_percentage_24h === "number");
  const toRow = (m) => ({
    id: m.id,
    name: m.name,
    symbol: m.symbol.toUpperCase(),
    price: m.current_price,
    change24h: Number(m.price_change_percentage_24h.toFixed(2)),
    marketCapRank: m.market_cap_rank,
  });

  const majors = MAJOR_IDS.map((id) => valid.find((m) => m.id === id)).filter(Boolean).map(toRow);
  const topGainers = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 10).map(toRow);
  const topLosers = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 10).map(toRow);
  const trendingRows = trending.slice(0, 10).map((t) => ({
    id: t.id,
    name: t.name,
    symbol: t.symbol,
    marketCapRank: t.marketCapRank,
    change24h: typeof t.change24h === "number" ? Number(t.change24h.toFixed(2)) : null,
    source: t.source,
  }));

  return { majors, topGainers, topLosers, trending: trendingRows, updatedAt: new Date().toISOString() };
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
      coinAnalyses: latestCoinAnalyses,
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
    if (Array.isArray(data.coinAnalyses)) latestCoinAnalyses = data.coinAnalyses;
    console.log(`[firestore] loaded cached intelligence snapshot from ${data.savedAt}`);
    return true;
  } catch (err) {
    console.error("[firestore] failed to load intelligence snapshot:", err.message);
    return false;
  }
}

async function generateDailyIntelligence() {
  try {
    const [movers, trending] = await Promise.all([fetchTopMarketMovers(), fetchTrendingCoins()]);
    const built = buildFeedItemsFromMarketData(movers, trending);
    if (built.length === 0) throw new Error("No feed items generated from market data");

    let robinhoodQuote = null;
    try {
      robinhoodQuote = await fetchRobinhoodStock();
      built.push(buildRobinhoodFeedItem(robinhoodQuote));
      console.log("[intelligence] added Robinhood (HOOD) stock update");
    } catch (err) {
      console.error("[intelligence] Robinhood stock fetch failed, skipping:", err.message);
    }

    feedItems = toFeedRecords(built);
    latestMarketSnapshot = buildMarketSnapshot(movers, trending);

    let points;
    try {
      points = await generateAiSummary(movers, trending);
    } catch (err) {
      console.error("[intelligence] Groq summary failed, using fallback summary:", err.message);
      points = buildFallbackSummary(movers, trending);
    }
    latestSummary = { points, generatedAt: new Date().toISOString() };

    try {
      const topCoins = await enrichWithOnChainActivity(selectTopInterestingCoins(movers, trending));

      let analyses;
      try {
        analyses = await generateCoinAnalyses(topCoins);
      } catch (err) {
        // No fallback here means "being generated, check back shortly"
        // forever if Groq has a bad day — this is what a paying customer
        // would actually see, so it always resolves to real content.
        console.error("[intelligence] Groq coin analysis failed, using fallback analyses:", err.message);
        analyses = buildFallbackCoinAnalyses(topCoins);
      }

      if (robinhoodQuote) {
        const robinhoodCoin = {
          id: "robinhood-hood",
          name: "Robinhood",
          symbol: "HOOD",
          change24h: Number((robinhoodQuote.dp || 0).toFixed(2)),
          category: "Robinhood",
          marketCapRank: null,
          trendingSource: null,
        };
        let robinhoodAnalysis;
        try {
          [robinhoodAnalysis] = await generateCoinAnalyses([robinhoodCoin]);
        } catch (err) {
          console.error("[intelligence] Robinhood coin analysis failed, using fallback:", err.message);
          [robinhoodAnalysis] = buildFallbackCoinAnalyses([robinhoodCoin]);
        }
        // Prepended, not appended — 0xRiver flagged Robinhood as "very very important."
        if (robinhoodAnalysis) analyses = [robinhoodAnalysis, ...analyses];
      }

      latestCoinAnalyses = analyses;
      console.log(`[intelligence] generated ${latestCoinAnalyses.length} coin analyses`);
    } catch (err) {
      console.error("[intelligence] coin analysis generation failed, keeping previous data:", err.message);
    }

    console.log(`[intelligence] refreshed ${feedItems.length} feed items at ${latestSummary.generatedAt}`);
  } catch (err) {
    console.error("[intelligence] generateDailyIntelligence failed, keeping previous data:", err.message);
    await sendAdminAlert(`⚠️ Kairon daily intelligence generation failed: ${err.message}\n\nThe site may be showing stale data.`);
  }

  await saveIntelligenceSnapshot();
}

// Digest timing — 0xRiver (and presumably most subscribers) is US-based, so
// the daily send is anchored to a local wall-clock hour in a real timezone
// rather than a fixed UTC hour, and stays correct across DST transitions.
// Configurable in case a future subscriber base skews to a different region.
const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE || "America/New_York";
const DIGEST_HOUR_LOCAL = Number(process.env.DIGEST_HOUR_LOCAL || 7);

// Converts a local wall-clock date/time in `timeZone` to the UTC instant it
// represents. There's no Date constructor for "this time, in that zone," so
// this iterates: guess a UTC instant, check what that instant reads as in
// the target zone, and correct the guess by the difference. Two passes is
// enough in practice and correctly lands on either side of a DST transition
// because the offset is re-derived from the corrected guess each time.
function zonedTimeToUtcMs(year, month, day, hour, minute, second, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(guess));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const readAsUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      map.hour === "24" ? 0 : Number(map.hour),
      Number(map.minute),
      Number(map.second)
    );
    guess += desired - readAsUtc;
  }
  return guess;
}

function localDatePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

// Ms until the next occurrence of `hourLocal` (0-23) local time in
// `timeZone`. DST-aware — re-derives the zone's offset for the actual
// candidate date rather than assuming today's offset still applies tomorrow.
function msUntilNextLocalHour(timeZone, hourLocal) {
  const now = new Date();
  const today = localDatePartsInZone(now, timeZone);
  let target = zonedTimeToUtcMs(today.year, today.month, today.day, hourLocal, 0, 0, timeZone);

  if (target <= now.getTime()) {
    const tomorrow = localDatePartsInZone(new Date(target + 24 * 60 * 60 * 1000), timeZone);
    target = zonedTimeToUtcMs(tomorrow.year, tomorrow.month, tomorrow.day, hourLocal, 0, 0, timeZone);
  }

  return target - now.getTime();
}

// A friendly label for the current send time, e.g. "7:00 AM EDT" — computed
// fresh (not hardcoded) so it reflects DST correctly whenever it's read.
function digestScheduleLabel() {
  const hour12 = ((DIGEST_HOUR_LOCAL + 11) % 12) + 1;
  const ampm = DIGEST_HOUR_LOCAL < 12 ? "AM" : "PM";
  const zonePart = new Intl.DateTimeFormat("en-US", { timeZone: DIGEST_TIMEZONE, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return `${hour12}:00 ${ampm}${zonePart ? ` ${zonePart.value}` : ""}`;
}

// Data refresh and Telegram notification are deliberately separate calls.
// generateDailyIntelligence() runs on every boot (so the site never shows
// stale/empty data after a deploy) and would otherwise re-send the digest
// on every redeploy — this ties the actual user-facing send to only the
// scheduled tick (plus the once-per-day guard inside sendDailyDigest()
// itself as a second line of defense).
async function runScheduledDailyTick() {
  await generateDailyIntelligence();
  await sendDailyDigest();
}

function scheduleDailyIntelligence() {
  const delay = msUntilNextLocalHour(DIGEST_TIMEZONE, DIGEST_HOUR_LOCAL);
  console.log(`[intelligence] next scheduled refresh in ${Math.round(delay / 60000)} minutes (${digestScheduleLabel()}, ${DIGEST_TIMEZONE})`);
  setTimeout(async () => {
    await runScheduledDailyTick();
    // Reschedule from scratch rather than setInterval(24h) — a fixed 24h
    // interval would drift off the target local hour on DST transition days.
    scheduleDailyIntelligence();
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
// Support / payment
//
// No subscription system — just a wallet address to send crypto to.
// Reconciling who paid is manual for now (informal, matches how this
// audience actually transacts). Returns not-configured until the env var
// is set, same pattern as everything else here.
// ---------------------------------------------------------------------------

const PAYMENT_WALLET_ADDRESS = process.env.PAYMENT_WALLET_ADDRESS || "";

app.get("/api/support", (req, res) => {
  res.json({ configured: Boolean(PAYMENT_WALLET_ADDRESS), address: PAYMENT_WALLET_ADDRESS || null });
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

// Where operational alerts go (e.g. the daily pipeline breaking) — a
// person, not the public bot. Get your own chat id by messaging
// @userinfobot on Telegram.
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID || "";

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

// Operational alert to the admin only — not subscribers. Called when the
// daily pipeline fails outright, so a broken/stale product doesn't go
// unnoticed until a paying customer complains.
async function sendAdminAlert(message) {
  if (!isTelegramConfigured() || !ADMIN_TELEGRAM_CHAT_ID) return;
  try {
    await callTelegramApi("sendMessage", { chat_id: ADMIN_TELEGRAM_CHAT_ID, text: message });
  } catch (err) {
    console.error("[admin-alert] failed to send:", err.message);
  }
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
// means "no filter — send everything." Same 16 categories as the site.
const ALL_CATEGORIES = [
  "Bitcoin", "Ethereum", "Solana", "Base", "DeFi", "Stablecoins", "Memecoins", "AI",
  "Security", "Funding", "Governance", "Macro", "Exchanges", "NFTs", "Airdrops", "Robinhood",
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
    `I'm your daily on-chain intelligence briefing. Every morning around ${digestScheduleLabel()} I'll send you one focused message covering the strongest, most interesting crypto signals — big market movers, trending coins, and an AI-written summary of what actually matters. One briefing a day, never more.`,
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
// preferences. Only ever called from the scheduled daily tick — never
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
    let relevant = prefs && prefs.size > 0 ? feedItems.filter((i) => prefs.has(i.category)) : feedItems;
    let usedFallback = false;
    if (relevant.length === 0) {
      // Nothing matched their categories today — send the day's top movers
      // anyway rather than silently skipping them for the day.
      relevant = feedItems;
      usedFallback = true;
    }
    if (relevant.length === 0) continue; // pipeline itself produced nothing — truly nothing to send

    const spotlight = latestCoinAnalyses[0];
    const lines = [
      "*Kairon Daily Briefing*",
      "",
      ...latestSummary.points.map((p) => `• ${p}`),
      "",
      usedFallback ? "*Nothing matched your categories today — here's what's moving instead:*" : "*Top signals today:*",
      ...relevant.slice(0, 3).map((i) => `— ${i.title}`),
      ...(spotlight
        ? ["", `*Spotlight: ${spotlight.name} (${spotlight.symbol})*`, spotlight.whyItMoved]
        : []),
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
// testing without waiting for the daily schedule. Disabled unless
// ADMIN_SECRET is set in the environment. Does NOT send the Telegram digest
// unless ?notify=true is also passed — and even then, sendDailyDigest()'s
// own once-per-day guard still applies, so this can't be used to spam
// subscribers by hitting it repeatedly.
// Accepts GET too (not just POST) so this can be triggered by just opening
// the URL in a browser (e.g. from a phone) — still gated by ADMIN_SECRET,
// and this only refreshes data, it doesn't delete or change anything.
app.all("/api/admin/refresh", async (req, res) => {
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
  // burn API calls or show a momentary reset — the daily schedule is
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
