# DriveMatch — Personalized Vehicle Finder

A web app that helps users determine the best vehicle purchase for them, built incrementally.

## Recommended backend: Node.js + Express ✅ (implemented)

**Why this stack for DriveMatch:**

- **Same language end-to-end** — the frontend is vanilla JS; Node avoids a second language/runtime. (Python wasn't even installed in this environment; Node 24 is.)
- **One process, zero migration** — Express serves the existing static site *and* the agent API from the same origin, so there are no CORS headaches and the current `index.html` / `styles.css` / `app.js` didn't need a framework rewrite.
- **Right-sized** — a Next.js/Nest migration or a separate FastAPI service would be over-engineering for a hackathon-stage app whose backend job is: hold a secret, proxy one LLM call, validate input, rate-limit.
- **Deploys anywhere** — Render, Railway, Fly.io, a VPS, or split later (static CDN + this API) with no code changes.

Alternatives considered: FastAPI (great, but second language + separate tooling), Cloudflare Workers/Hono (excellent for production edge scaling — a sensible later migration of `server.js`, which is deliberately kept thin for that reason).

## Architecture (v0.3)

```
Browser (index.html + app.js)
  │  POST /api/agent  { message, conversation, profile, topicIndex }
  ▼
DriveMatch backend (server.js, Express)
  │  - validates input, per-IP rate limit (30/min)
  │  - holds LLM_API_KEY in server-side .env  ← token NEVER reaches the browser
  │  - system prompt lives here, not in client code
  │  POST to the configured Muse endpoint (Responses or Chat Completions)
  ▼
Muse models (Meta) — Muse Wonder + Muse Spark, routed per task
  │  returns structured JSON { reply, profile_patch, covered_topic_ids, is_complete, guidelines }
  ▼
Backend validates/parses → frontend merges into the live profile + guidelines
```

### Flexible Muse models: Wonder + Spark

Both Meta Muse models are first-class citizens. Every backend LLM call is tagged with a task, and `LLM_ROUTING` decides which model handles it:

| Routing | Behaviour |
|---|---|
| `balanced` (default) | **Muse Wonder** (`meta/muse-wonder-1.0`) for deep grounded vehicle synthesis/repair; **Muse Spark** (`meta/muse-spark-1.3`) for agent chat, live cache updates, suggestions and dealer research — Spark is faster and ~5× cheaper per token, Wonder is reserved for the hardest reasoning |
| `wonder` | Muse Wonder for every call |
| `spark` | Muse Spark for every call |
| `primary` | Whatever `LLM_MODEL` names, for every call (pin any version, e.g. a Spark contributor variant) |

Model versions are configurable (`LLM_WONDER_MODEL`, `LLM_SPARK_MODEL`, `LLM_MODEL`); callers may also override per call. If the selected model fails, times out or returns empty, the call **automatically falls back once to the other model** (`LLM_FALLBACK_MODEL=true`), and responses report `modelUsed` / `fellBackFrom`. `GET /api/health` exposes the full routing config. Per-call reasoning effort is clamped for Spark contributor variants (which cap below `max`).

- If the backend is down, has no key configured, or the LLM call fails, the API returns `{ fallback: true }` and the browser's **built-in local agent** runs the identical conversation on-device. The chat header pill always shows which mode you're in.
- `config.js` is **gone** — there is no browser-side token anywhere anymore.

### API

| Endpoint | Description |
|---|---|
| `GET /api/health` | `{ ok, mode, models: { routing, profiles, fallbackEnabled }, agentName, vehicleGrounding }` |
| `POST /api/agent` | Body: `{ message, conversation[], profile{}, topicIndex, topicId }`. Returns the LLM's structured agent JSON, or `{ fallback: true, reason }` |
| `GET /*` | Static frontend (`.env`, `server.js`, `package.json` are explicitly blocked) |

## Run it

```powershell
npm install   # once
npm start     # -> http://localhost:5173
```

Then open **http://localhost:5173** (use the server URL, not the `index.html` file, so the API works).

### Enable the Muse models

1. Copy `.env.example` to `.env` (one is already created for you).
2. Fill in your token and endpoint — server-side only:

```ini
LLM_API_KEY=your-muse-token
LLM_BASE_URL=https://<your-endpoint>/v1/responses
LLM_WONDER_MODEL=muse-wonder-1.0
LLM_SPARK_MODEL=muse-spark-1.3
LLM_ROUTING=balanced
LLM_FALLBACK_MODEL=true
```

3. Restart `npm start`. The server logs its routing (`routing=balanced, Wonder=…, Spark=…, fallback=true`) and the chat pill switches to **Muse Wonder + Spark · Live (via backend)**.

`.env` is git-ignored (`.gitignore` also still blocks the old `config.js`, and `node_modules/`).

## The agent experience

- **Maya, your DriveMatch agent**, guides a natural text conversation through: about you → household/experience → main use → daily driving → vehicle style → budget/ownership → priorities. Say "skip" anytime; quick-reply chips offer example answers.
- **Confirm → guidelines → next step:** when the question flow finishes, Maya asks you to **confirm your profile** (or edit it and re-confirm). On confirmation she posts the **full vehicle-selection guidelines right in the chat** and offers three next steps: **suggest vehicles**, **download guidelines as PDF** (printable view → Save as PDF), or **download guidelines as JSON**.
- **Returning users:** download your guidelines JSON before you leave, then on your next visit tap **⬆ Upload guidelines** (hero, chat toolbar, or profile panel). Maya restores your profile + guidelines (sanitised and validated on-device), switches to your market/currency, shows the guidelines in chat, and can immediately make suggestions from them — the uploaded guidelines are passed to the suggestion engine as your criteria alongside your profile. Guidelines-only files (no profile) get a starter profile derived from the guideline text. Note the PDF is the human-readable copy; the **JSON** is the file to upload for a restore.
- **Dynamic market detection** — Maya infers your **country and local currency** from the conversation itself (country/province/state and city names, postal-code formats, currencies you mention, explicit statements like "I just moved to…"), switches to your local postal format and currency, creates that market's own backend cache, and tells you she switched. No market or currency is assumed in the copy: your device locale is only a starting suggestion, Maya confirms from chat, and if she can't tell she asks which country you're in. The market selector in the chat is a manual override — and only an explicit statement in chat overrides a manual choice. Any ISO country can be selected; grounded pricing/sentiment then target that country in its local currency.
- A **live driver-profile panel** fills in beside the chat, and at any point the profile is converted into **vehicle-selection guidelines**: starting categories, powertrain/running-cost rules, space rules, budget guardrails, must-haves, deal-breakers, and how vehicles will be ranked next.
- Chat + profile persist in `localStorage` (`drivematch_agent_v2`); profile + guidelines export as JSON.

## Vehicle analysis (v0.5) — search-grounded, no vehicle database

`vehicleData.js` is **deleted**. There are no preconfigured vehicle entries anymore. Ask in the chat — *"Analyse a Toyota RAV4"*, tap **🔎 Analyse a vehicle**, or click a similar-vehicle card — and the backend grounds a fresh analysis on the live web:

```
POST /api/vehicle-analysis { query, refreshStable? }
  Cache check (one SQLite DB PER MARKET: data/vehicle-cache-<country>.db
  — a new market's cache file is created
  automatically the first time that market is detected/selected, and
  markets never share cached facts):
  ├─ HIT (stable facts < ~30 days old): only variable sections go live —
  │    4 targeted searches (pricing · forum sentiment · social sentiment ·
  │    common issues) + ONE lean LLM synthesis (5k tokens vs 12k) merged
  │    over the cached trims/colours/options/specs. Fewer searches,
  │    fewer LLM tokens, much faster repeat visits for common vehicles.
  └─ MISS / EXPIRED / refreshStable: full research —
       1. 7 targeted searches (trims · colours/options · performance ·
          forum sentiment · social sentiment · common issues · rivals)
       2. Server-side retrieval + full page-text extraction of the best
          sources (Tavily/Brave/Serper with SEARCH_API_KEY, else DuckDuckGo)
       3. The routed Muse model (Wonder for synthesis) synthesises FROM THOSE SOURCES ONLY, with [S#]
          citations, an assumed year/market, and an as-of date
       4. A focused second LLM pass repairs any empty sections
       5. Server-side sanitisation → UI; STABLE facts (identity, trims,
          colours, interiors, options, performance, similar identities)
          are written to the cache DB. Pricing (incl. per-trim prices),
          sentiment and common issues are stripped before storing —
          they are always pulled live at interaction time.
  Monthly refresh: entries expire after VEHICLE_STABLE_CACHE_TTL_MS
  (default 30 days) and the next visit re-researches them in full.
  GET /api/vehicle-cache shows cache stats; health includes them too.
```

- **Sentiment analysis** — score + positive/neutral/negative split (or honestly *unscored* when sources are thin), per-source breakdown (social / forums / long-term reviews), loves & complaints, all cited. **Always pulled live**, never cached.
- **Common issues** — owner-reported problems with severity, how frequently they appear in the sources, years affected, symptoms and sourced detail (plus a pre-purchase-inspection caveat). **Always pulled live**, never cached.
- **Pricing** — vehicle guide price and per-trim prices are likewise **live on every visit**; the monthly cache stores trim names/highlights with prices stripped.
- **Trims, colours & options, performance** — grounded trim pricing, colour swatches, packages/add-ons, and a Performance & Capability section (power, 0–60, economy/range, towing, safety) with source citations.
- **Sources panel** — every source the analysis used, with domain, date and retrieval date, plus a confidence level and what remains unverified.
- **Financing calculator** — currency follows your detected market (and can be changed to any currency in the full picker), enter local price/deposit/trade-in/fees, term and APR slider → monthly payment, amount financed, total interest and total cost. Not auto-converted; estimate only, not financial advice.
- **Similar vehicles** — grounded rivals with why-to-consider and key differences; one tap analyses or builds a profile from any of them.
- **Profile from a vehicle** — *"Build my profile from this vehicle"* drafts a full driver profile (body style, fuel, budget, use case, priorities, must-haves), lists every assumption, keeps your own answers where they conflict, then continues the agentic chat to **edit the draft with you**.

Configuration (server `.env`): `SEARCH_PROVIDER=auto|tavily|brave|serper|duckduckgo|none`, `SEARCH_API_KEY=` (recommended for production — the DuckDuckGo fallback is dev-grade and some fields, e.g. full colour palettes, may be reported unverified), or `LLM_NATIVE_GROUNDING=true` + `LLM_WEB_SEARCH_TOOL=` to use the model provider's own web-search tool instead of backend retrieval. If no sources can be retrieved, the API returns an error rather than an invented analysis. Cold-cache analyses take ~1–3 minutes (search + extraction + two LLM passes).

## Vehicle suggestions + nearby dealers

Once a profile exists (chat-built or vehicle-generated), **🚗 Suggest 3 Vehicles For Me** (profile panel, or just ask Maya *"suggest vehicles for me"*):

- `POST /api/vehicle-suggestions` runs profile-targeted grounded searches (best matches for your body style/fuel/use/budget/priorities in your market), the routed Muse model (Spark) proposes sourced candidates, and the **server re-ranks them deterministically** against your profile — body style, fuel, budget fit, must-have coverage and your ranked priorities — so the ordering is explainable, not just the model's opinion.
- The **Top 3** render as match cards with a match %, indicative grounded pricing, a plain summary of **why each was chosen for you**, its trade-off, one-tap full analysis, and sources. Results persist across reloads and are cached server-side for 15 minutes per profile.

Each card also has **📍 Nearby dealers & offers** (`POST /api/dealer-offers`):

- Searches dealer/offer/inventory/incentive pages around your profile location (Maya asks for your city/postal code if she doesn't have it) and extracts only dealers/offers **actually named in the sources** — every card links its source, distances only appear when a source states them, and nothing is invented when nothing solid surfaces.
- **Pricing flexibility** (high/medium/low/unknown) is an *evidence-based estimate* from public signals only — advertised discounts below list price, manufacturer rebates/incentives, finance offers, competing dealers — with the signals listed and a clear "not a guarantee" disclaimer, plus negotiation tips. It is not inside knowledge of any dealer, and this is public web data, not a live inventory feed: always confirm price, stock and eligibility with the dealer.

> Because grounding is live, results vary as the web changes and are only as good as the retrieved sources — always verify prices/specs against an official local configurator before buying.

## Files

| File | Purpose |
|---|---|
| `server.js` | **Backend** — Express static host + `/api/agent` Muse proxy (Wonder/Spark routing + fallback, Chat Completions + Responses styles) + grounded vehicle analysis |
| `vehicleGrounding.js` | Search-grounding pipeline: targeted searches, source retrieval/page extraction, Muse synthesis + repair pass, live-variable updates, sanitisation |
| `vehicleCacheDb.js` | Per-market SQLite stable-facts caches (Node's built-in `node:sqlite`): one DB file per market, created on first use; aliases, 30-day TTL, hit stats |
| `.env` | **Your server secrets** — paste the Muse token + model routing here (git-ignored, never commit) |
| `.env.example` | Blank environment template |
| `package.json` | `npm start` / `npm run dev` / `npm run check` |
| `index.html` | Landing page + agent chat markup (no config script anymore) |
| `styles.css` | Styling |
| `app.js` | Frontend agent — calls `/api/agent`, local fallback agent, profile + guidelines generation |

## Roadmap

- [x] Landing + get-to-know-you profile
- [x] Agentic chat (LLM-driven with local fallback) + selection guidelines
- [x] Backend with server-side LLM token (Express)
- [x] Vehicle analysis in chat (sentiment, trims/colours/options, financing calculator, similar vehicles, profile-from-vehicle)
- [x] Search-grounded vehicle analysis via LLM (live trims/sentiment/performance, no preconfigured database)
- [x] SQLite stable-facts cache (monthly TTL) + live pricing/sentiment/common-issues on every interaction
- [x] Global markets: conversational country/local-currency auto-detection (no assumed market/currency) and per-market cache DBs
- [x] Profile confirmation with in-chat guidelines, PDF/JSON downloads, and guidelines upload/restore for returning users
- [ ] Add a production search API key (Tavily/Brave/Serper) for stronger grounding coverage
- [x] Top-3 vehicle suggestions ranked against the profile, with why-chosen summaries
- [x] Nearby dealer offers + evidence-based pricing-flexibility estimates (grounded, cited)
- [ ] Live dealer inventory/pricing API integration (replace public-web extraction)
- [ ] Match results with total-cost-of-ownership comparison
- [ ] Auth + server-side profile persistence (move beyond localStorage)
- [ ] Optional: port `server.js` to Hono/Cloudflare Workers for edge deployment
