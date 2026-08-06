# Kairon — Project Instructions

Kairon is an AI-powered on-chain intelligence platform that helps users discover the most important crypto opportunities every day through curated news, ecosystem updates, wallet activity, exchange listings, funding news, governance updates, and AI-generated summaries.

Quality bar: Kaito, Nansen, Token Terminal, Linear, Vercel, Raycast, Notion. Premium, clean, modern, trustworthy. **Must not feel AI-generated.**

Always read this file before starting any task.

---

## CLAUDE RULES

- Never regenerate an entire file when only part of it needs changing.
- Always perform the exact find-and-replace automatically.
- Never guess requirements.
- Always ask questions whenever anything is unclear.
- Keep the project modular.
- Keep the codebase clean.
- Avoid unnecessary dependencies.
- Preserve existing code unless explicitly asked to remove it.
- Build production-quality code only.
- Explain what changed after every completed task.
- If this project is connected to Git, automatically commit and push every completed task with a meaningful commit message.
- If GitHub is not connected yet, ask before attempting to push.

---

## TECH STACK

- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Backend:** Node.js, Express
- **Database:** Firebase Firestore
- **Authentication:** Firebase Authentication
- **Hosting:** Railway

---

## FIREBASE

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyCbQhOaiW1BuJfESAfXkHdZzaAb1yg78sU",
  authDomain: "kairon-5f5ef.firebaseapp.com",
  projectId: "kairon-5f5ef",
  storageBucket: "kairon-5f5ef.firebasestorage.app",
  messagingSenderId: "985378760218",
  appId: "1:985378760218:web:c8a0480c3b9f285769d3a3"
};
```

Firebase config lives in a single dedicated file (`public/js/firebase.js`). Never scatter Firebase config across the project. Organize Firebase cleanly for future scalability.

---

## FILE STRUCTURE

```
/
│
├── index.html      → Entire frontend (HTML + CSS + JavaScript in one file)
├── server.js       → Express server, API routes, feed handling,
│                      Telegram bot integration, notifications,
│                      future AI/news collection
├── firebase.js     → Firebase initialization, Authentication, Firestore exports
├── package.json    → Dependencies and scripts
├── CLAUDE.md       → Project rules, coding standards, GitHub workflow
└── .gitignore
```

This flat structure replaces the earlier nested `public/`, `routes/`, `utils/`, `services/` plan. Keep the project to these files unless a new file is clearly necessary — confirm before introducing new top-level structure (e.g. a `routes/` folder) rather than assuming it's wanted.

---

## LOGO

Source: https://i.postimg.cc/1RqXSNB7/file-00000000ba9c8246bc50cdc3b8a6505e.png

- Place logo at the top-left.
- Write **Kairon** beside the logo, bold.
- Follow the logo colour palette.
- Subtle glassmorphism, rounded corners, soft shadows, modern typography, large whitespace, premium appearance.

---

## WEBSITE PHILOSOPHY

Kairon does NOT force account creation. Anyone can, as a guest:

- Browse the website
- Read every intelligence article
- Search
- View categories
- View the latest updates
- Open every Feed page
- Browse notifications
- Share articles

No landing page blocks access. The homepage is the actual product. Visitors immediately experience the value of Kairon. Authentication only unlocks personalization.

---

## AUTHENTICATION

Optional. Only required for personalized features:

- Bookmarking articles
- Linking Telegram
- Saving notification preferences
- Following categories
- Managing profile
- Saving future preferences

If a guest attempts one of these, show a clean modal asking them to sign in. Never redirect users away from what they're reading.

### Login options

- Continue with Google
- Continue with Email (Sign Up, Login, Forgot Password, Logout)

Keep users logged in — don't ask for re-login unnecessarily.

---

## NAVIGATION

Top nav: Home · Feed · Insights · Alerts · Settings

Top-right:
- Guest → "Sign In"
- Logged in → Profile avatar, username, dropdown menu

---

## HOME

Large hero section. Example headline: "Wake up to the market before everyone else." Short description below.

Sections:
- Latest Intelligence
- Trending Narratives
- Smart Money Activity
- Exchange Listings
- Funding Rounds
- Ecosystem Highlights
- AI Market Summary

Should resemble an institutional crypto intelligence platform.

---

## FEED

Replaces "blog." Each Feed item has: Title, Summary, Category, Tags, Published Time, Slug, Read More page, Share button, Bookmark button.

Slugs auto-generated, e.g. `/feed/base-memecoin-rally`, `/feed/ethereum-etf-update`, `/feed/binance-lists-xyz`.

---

## SEARCH

Global search by Title, Summary, Tags, Category.

---

## CATEGORIES

Bitcoin, Ethereum, Solana, Base, DeFi, Stablecoins, Memecoins, AI, Security, Funding, Governance, Macro, Exchanges, NFTs, Airdrops.

---

## ALERTS

Public — anyone can read alerts, no sign-in required. Later: personalized alerts.

---

## SETTINGS

- Guest: message explaining settings require an account.
- Logged in: Profile (username, email, avatar), Telegram, Notification Preferences, Theme.

---

## TELEGRAM

Backend should be prepared for Telegram integration (bot token added later via environment variables).

Settings → "Link Telegram" button flow:

1. User clicks Link Telegram
2. Telegram Bot opens
3. User presses Start
4. Telegram account becomes linked
5. Display "✅ Telegram Connected" with Telegram Name, Username, Chat ID

### Telegram notifications

Every new Feed post can send: Headline, Summary, "Read More" button linking to the exact Feed page via its slug.

---

## FIRESTORE COLLECTIONS

`users`, `feed`, `bookmarks`, `telegram_links`, `settings`, `notification_preferences`

---

## BACKEND API

```
GET    /api/feed
GET    /api/feed/:slug
POST   /api/feed
PATCH  /api/feed/:id
DELETE /api/feed/:id
GET    /api/search
GET    /api/settings
POST   /api/settings
```

---

## FUTURE FEATURES (structure for, do not build yet)

AI news collection · X (Twitter) monitoring · Wallet tracking · AI summarization · Duplicate detection · Scheduled publishing · Browser notifications · Email notifications · Premium subscription.

---

## DESIGN REQUIREMENTS

Feels like a real startup product. No AI-slop, no crypto clichés, no neon gradients, no oversized glowing effects, no clutter.

Use: white space, rounded corners, premium typography, subtle glassmorphism, soft shadows, smooth animations, excellent spacing, mobile-first responsive design. Must look beautiful on phones before desktop.

---

## GITHUB WORKFLOW

If Git is connected: automatically commit after every completed task and push to the connected GitHub repository, using meaningful commit messages, e.g.:

```
feat: initialize Kairon project
feat: add Firebase authentication
feat: create homepage
feat: implement feed page
fix: improve mobile responsiveness
```

If Git is not connected, ask before attempting to push.

**Branching:** work directly on `main` and push there. Do not create or push to feature branches — the user has given standing permission for direct pushes to `main`, and Railway auto-deploys from `main` on every push (see DEPLOYMENT below).

---

## DEPLOYMENT

Hosting is Railway, connected via GitHub integration on this repo — it auto-builds and deploys on every push to `main` (`npm install` then `npm start`). No separate deploy step is needed; pushing to `main` is the deploy.

---

## FINAL INSTRUCTION

Do NOT build the entire project in one pass. Build one major feature at a time. After each completed feature:

1. Explain what was built.
2. Commit the changes.
3. Push to GitHub.
4. Recommend the next feature.
5. Wait for approval before continuing.

Build Kairon incrementally with production-quality code, maintaining a clean architecture that is easy to extend.
