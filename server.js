// server.js
// Express server for Kairon: static frontend, REST API, feed handling,
// Telegram bot integration, notifications, and a placeholder for future
// AI/news collection.

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json());

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

let feedItems = [
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
    title: "Binance lists XYZ with a Launchpool campaign",
    summary:
      "Binance added XYZ to its Launchpool program ahead of spot trading, giving BNB holders early access to farming rewards.",
    category: "Exchanges",
    tags: ["Binance", "Exchanges", "Listings"],
    trending: false,
  },
  {
    title: "Solana DeFi TVL crosses $6B as lending protocols surge",
    summary:
      "Lending markets led the gains as Solana DeFi TVL hit a new yearly high, outpacing growth across most L1 ecosystems.",
    category: "DeFi",
    tags: ["Solana", "DeFi"],
    trending: true,
  },
  {
    title: "a16z leads $40M round for a new restaking protocol",
    summary:
      "The new protocol aims to bring restaking-secured infrastructure to app-specific rollups, with a mainnet launch planned for Q1.",
    category: "Funding",
    tags: ["Funding", "Ethereum"],
    trending: false,
  },
  {
    title: "New governance proposal aims to cut Arbitrum sequencer fees",
    summary:
      "The proposal would reduce sequencer fees by roughly 30%, with the DAO vote expected to close within the next week.",
    category: "Governance",
    tags: ["Governance", "Ethereum"],
    trending: false,
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
].map((item, index) => ({
  id: crypto.randomUUID(),
  slug: slugify(item.title),
  publishedAt: new Date(Date.now() - index * 1000 * 60 * 47).toISOString(),
  ...item,
}));

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

function isTelegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_USERNAME);
}

async function callTelegramApi(method, payload) {
  if (!isTelegramConfigured()) return null;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
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

// Telegram webhook: receives updates once the bot is configured with
// setWebhook. Handles "/start <token>" to complete account linking.
app.post("/api/telegram/webhook", async (req, res) => {
  const message = req.body && req.body.message;
  const text = message && message.text;

  if (text && text.startsWith("/start")) {
    const token = text.split(" ")[1];
    const pending = token && telegramLinkTokens.get(token);

    if (pending) {
      telegramLinkTokens.delete(token);
      telegramLinks = telegramLinks.filter((l) => l.userId !== pending.userId);
      telegramLinks.push({
        userId: pending.userId,
        chatId: message.chat.id,
        telegramName: [message.from.first_name, message.from.last_name]
          .filter(Boolean)
          .join(" "),
        username: message.from.username || "",
        linkedAt: new Date().toISOString(),
      });

      await callTelegramApi("sendMessage", {
        chat_id: message.chat.id,
        text: "✅ Your Telegram account is now linked to Kairon.",
      });
    }
  }

  res.sendStatus(200);
});

app.get("/api/telegram/status", (req, res) => {
  const userId = String(req.query.userId || "");
  const link = telegramLinks.find((l) => l.userId === userId);
  res.json({ configured: isTelegramConfigured(), linked: Boolean(link), link: link || null });
});

// ---------------------------------------------------------------------------
// Future: AI news collection, X (Twitter) monitoring, wallet tracking,
// AI summarization, duplicate detection, and scheduled publishing.
//
// Intentionally not implemented yet — see CLAUDE.md → FUTURE FEATURES.
// This is where a scheduled job would pull from sources, dedupe, summarize
// via an LLM, and push results into the feed store above (and eventually
// Firestore) before calling notifyNewFeedItem().
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
});
