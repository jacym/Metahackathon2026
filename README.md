# DriveMatch — Personalized Vehicle Finder

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A web app that helps users determine the best vehicle purchase for them, built incrementally.

DriveMatch is **open source** under the [Apache License 2.0](LICENSE) — you are free to use, copy, modify and distribute it (including commercially), subject to the license terms. Contributions are welcome: fork the repo, make your change, run `npm run check`, and open a pull request. See the [Setup guide](#setup-start-here) to get running.

## Setup (start here)

Follow these steps in order. You only need to do steps 1–4 once.

### Prerequisites

- **Node.js 24 or newer** (the backend uses Node's built-in SQLite — no database to install). Check with:
  ```powershell
  node -v    # should print v24.x or newer
  npm -v
  ```
  On macOS/Linux the same commands work in Terminal. If Node is missing or older, install the current LTS from nodejs.org, then re-open your terminal.
- A **Muse API token** from Meta (for Muse Wonder / Muse Spark). Without it the app still runs — see "Running without an LLM token" below — but grounded vehicle research, suggestions, dealers and ModMarket plans need it.
- Optional but recommended: a **web-search API key** (Tavily, Brave Search, or Serper) for reliable search grounding. Without one, the app uses a free DuckDuckGo fallback that works but is less consistent.

### Step 1 — Get the code and install dependencies

```powershell
cd <path-to>\metahackathon2026
npm install
```

This installs the only runtime dependency (Express). There is **no build step**.

### Step 2 — Create your `.env` file

If `.env` does not already exist in the project root, create it from the template:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```
```bash
# macOS / Linux
cp .env.example .env
```

> If `.env` already exists, **do not overwrite it** — it may already contain your token. Just open it and check the values below. `.env` is git-ignored and must never be committed: your token lives only here, on the server.

### Step 3 — Add your Muse token and endpoint (required for live AI)

Open `.env` and set at least these two values:

```ini
LLM_API_KEY=<paste-your-muse-token-here>
LLM_BASE_URL=<your-muse-endpoint>
```

How to fill in `LLM_BASE_URL` — use exactly the shape your provider gave you:

| Your endpoint looks like… | Set `LLM_BASE_URL` to… | Notes |
|---|---|---|
| `https://<host>/v1/responses` | that full URL | Responses-style API (this is what `api.meta.ai` uses) |
| `https://<host>/v1/chat/completions` | that full URL | Chat-Completions-style API |
| just a base like `https://<host>/v1` | that base URL | The app appends the right path; set `LLM_API_STYLE=responses` or `=chat` if auto-detection guesses wrong |

Leave these at their defaults unless you have a reason to change them:

```ini
LLM_WONDER_MODEL=muse-wonder-1.0
LLM_SPARK_MODEL=muse-spark-1.3
LLM_ROUTING=balanced
LLM_FALLBACK_MODEL=true
```

- `LLM_ROUTING` decides which model each agent uses: `balanced` (Wonder for deep research, Spark for everyday chat — recommended), `wonder`, `spark`, or `primary` (pin `LLM_MODEL` for everything). **Every agent, including ModMarket, follows this same setting.**
- To run absolutely everything on one model, set `LLM_ROUTING=spark` (fastest/cheapest) or `LLM_ROUTING=wonder`, restart, and check `/api/health` (Step 5) to confirm.

### Step 4 — (Recommended) Add a search API key

Search grounding powers vehicle analysis, suggestions, dealer search and ModMarket. For reliable results, add one of these to `.env`:

```ini
# Pick ONE provider and paste its key:
SEARCH_PROVIDER=tavily        # or: brave  /  serper
SEARCH_API_KEY=<your-search-api-key>
```

Leave `SEARCH_PROVIDER=auto` and `SEARCH_API_KEY=` empty if you'd rather start with the free DuckDuckGo fallback — expect some vehicles to come back with sparser trims/colours (the app labels unverified sections rather than inventing them, and its quality gate simply won't cache a thin result).

### Step 5 — Start the server

```powershell
npm start
```

You should see a startup line like:

```
DriveMatch running at http://localhost:5173
Agent mode: LIVE — routing=balanced, Wonder=muse-wonder-1.0, Spark=muse-spark-1.3, fallback=true via https://…
```

- If it instead says `Agent mode: LOCAL`, your token/base URL from Step 3 weren't picked up — check the `.env` values and restart (the server only reads `.env` at startup, so **restart after every `.env` change**).
- A Node warning that "SQLite is an experimental feature" is expected and harmless.
- To run on a different port, set `PORT=<port>` in `.env` before starting.
- For auto-restart while developing, use `npm run dev` instead.

### Step 6 — Open the app (use the server URL, not the file)

| Page | URL |
|---|---|
| DriveMatch (find a car) | http://localhost:5173 |
| ModMarket (modify a car) | http://localhost:5173/modmarket.html |

> ⚠️ Do **not** double-click `index.html` / open it as a `file://` page. The pages must be served by the backend or every `/api/...` call fails and you'll silently get the local fallback agent.

The chat header pill tells you which mode you're in:

- **"Muse … · Live (via backend)"** — the LLM is connected.
- **"Local agent · Backend has no LLM key"** — fix Step 3 and restart.

### Step 7 — Verify everything works

1. **Health check** (in a second terminal):
   ```powershell
   Invoke-RestMethod http://localhost:5173/api/health
   ```
   ```bash
   curl http://localhost:5173/api/health
   ```
   You want `"mode":"live"` and a `models` block showing your routing and both model profiles. `"mode":"local"` means the token wasn't loaded.
2. **Chat smoke test:** open http://localhost:5173, start a chat, and say hello — Maya should reply (not the "could not be reached" fallback).
3. **Grounded research smoke test:** in the chat, type `Analyse a Toyota RAV4`. The first (cold-cache) research takes ~30 seconds to a few minutes; the panel should fill with trims, sentiment, common issues and sources.
4. **Suggestions smoke test:** finish (or upload) a profile, confirm it, then choose **Suggest vehicles for me**.
5. **ModMarket smoke test:** open http://localhost:5173/modmarket.html, give it a car, a goal and a budget, and build a plan.

### Running without an LLM token

If `LLM_API_KEY` / `LLM_BASE_URL` are empty, the server starts in **local mode**:

- ✅ Landing pages, the Maya intake chat (built-in local agent), profile building, guidelines, financing calculator and market detection all still work on-device.
- ❌ Search-grounded endpoints return a clear "needs LLM configured" error instead of making anything up: vehicle analysis, Top-3 suggestions, dealer search and ModMarket plans.

### Generated files you can delete safely

| Path | What it is |
|---|---|
| `data/vehicle-cache-<country>.db` | Per-market stable-facts cache (created automatically; delete to force a fresh research pass — it rebuilds itself) |
| Browser `localStorage` keys `drivematch_agent_v2`, `modmarket_build_v1` | Your chat/profile/build on this device (clear via the in-app Restart buttons, or browser dev tools) |

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Pill says "Local agent" / health says `"mode":"local"` | Token/base URL missing, or server started before you edited `.env` | Check `LLM_API_KEY` + `LLM_BASE_URL`, then restart `npm start` |
| `LLM upstream returned HTTP 404` | `LLM_BASE_URL` shape doesn't match the API style (e.g. a `/v1` base with a Responses-only endpoint) | Use the full endpoint URL from the table in Step 3, or set `LLM_API_STYLE=responses` / `=chat` explicitly |
| `LLM returned an empty response (status: incomplete, max_output_tokens)` | The model spent its output budget on hidden reasoning | Already auto-retried with a bigger budget + lower reasoning, then the other model. If it persists, set `VEHICLE_REASONING_EFFORT=low` and/or raise `VEHICLE_MAX_TOKENS` in `.env` and restart |
| Chat replies but vehicle analysis says "needs LLM configured" | You're opening the page as a file, or hitting a different port than the server | Open http://localhost:5173 (Step 6); check `PORT` in `.env` |
| Grounding is sparse (missing trims/colours, "cache skipped" in logs) | Free search fallback returned thin pages | Add a Tavily/Brave/Serper key (Step 4). Thin results are deliberately not cached, so the next visit retries in full |
| `EADDRINUSE` / port already in use on start | Another server (maybe an older terminal) holds the port | Stop the old process, or set a different `PORT=` in `.env` and use that port in the URL |
| Wrong prices/currency for your country | The market was detected from an earlier conversation | Use the Market selector in the chat, or tell Maya your country — she re-targets pricing and uses that market's own cache |
| ModMarket says "Local intake only" | Same as "Local agent" above | Same fix: token in `.env`, restart, open the served URL |

### Before you share or deploy

- Never commit `.env` (already git-ignored) and don't share it — it holds your token. Rotate the token if it has ever been pasted into a shared log/chat.
- The token is only ever used server-side; browsers never see it. For a public deployment, put the server behind HTTPS, keep `SEARCH_API_KEY`/`LLM_API_KEY` in your host's secret store (the same variable names work), and note the built-in rate limit is per-IP and in-memory — put a real gateway in front for anything serious.
- Run `npm run check` after changing backend code — it syntax-checks every JS file.


## Recommended backend: Node.js + Express ✅ (implemented)

**Why this stack for DriveMatch:**

- **Same language end-to-end** — the frontend is vanilla JS; Node avoids a second language/runtime.
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
| `GET /api/health` | `{ ok, mode, models: { routing, profiles, fallbackEnabled }, agentName, vehicleGrounding }` — your Step 7 verification call |
| `POST /api/agent` | Body: `{ message, conversation[], profile{}, topicIndex, topicId }`. Returns the LLM's structured agent JSON, or `{ fallback: true, reason }` |
| `POST /api/vehicle-analysis` | Body: `{ query, market, currency, refreshStable? }`. Search-grounded vehicle analysis (see below) |
| `POST /api/vehicle-suggestions` | Body: `{ profile, guidelines?, market, currency }`. Top-3 profile-matched vehicles |
| `POST /api/dealer-offers` | Body: `{ vehicle, location, market, currency }`. Nearby dealers, public offers, pricing-flexibility estimate |
| `POST /api/mod-suggestions` | Body: `{ vehicle, goalIds[], goalsText, budgetAmount, currency, market, experience, usage, notes }`. ModMarket staged build plan |
| `GET /api/vehicle-cache` · `POST /api/vehicle-cache/ensure` | Per-market cache stats / create a market's cache DB |
| `GET /*` | Static frontend (`.env`, `server.js`, `package.json` are explicitly blocked) |

## Run it (quick reference)

Full instructions are in **[Setup (start here)](#setup-start-here)** above. The short version:

```powershell
npm install   # once
npm start     # -> http://localhost:5173  (ModMarket: http://localhost:5173/modmarket.html)
```

`.env` (created in Setup Step 2) holds your Muse token and model routing, server-side only — it is git-ignored, and there is no browser-side config file.

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

## Selecting a vehicle & buying it

When you **select a vehicle** — the ✅ button on a suggestion card or a full analysis, or just telling Maya *"I like this one"* — she builds a **Purchase Pack** in the panel:

- **Dealerships that have it for sale** — selecting a vehicle (or the 📍 button on any card) runs the grounded dealer search around your location and lists dealers that list/sell that exact vehicle, with for-sale/availability notes only where a source states them, public offers, and source links for every dealer.
- **Salesperson blocker checklist** — the questions that stall purchases (exact trim/colour, new or used, out-the-door budget, how you'll pay, down payment, monthly comfort zone, finance pre-approval, trade-in details, timeline, where you'll buy, best contact) auto-filled from your profile/financing answers, with anything missing flagged amber. Just answer the missing pieces in chat ("$5,000 down, pre-approved, no trade-in, email me at…") and Maya completes them.
- **A ready-to-send dealer message** — drafted from your profile: stock availability for your trim/colour, an *itemised out-the-door* quote with every fee separated, applicable incentives and expiry, confirmation that optional dealer add-ons can be declined, your budget/payment/down-payment/monthly answers, trade-in quoted as a separate number, timeline and contact. Copy it or download it as a `.txt` from the panel, or ask Maya to "draft my dealer message" to get it in chat.
- **Sales-tactics playbook** — how to avoid paying more: negotiate the out-the-door total before monthly payments; what a longer term really does (your actual calculator figures at 48/60/72/84 months compared — same car, more total interest); which packages/add-ons are worth it *for your profile* vs situational vs usually-decline (nitrogen tyres, VIN etching, protection sprays, fitted "protection packages", market adjustments); finance-office tactics (bring pre-approval, separate trade-in numbers, incentive fine print, refundable deposits in writing); and a before-you-sign checklist.

Each suggestion card also has **📍 Nearby dealers & offers** (`POST /api/dealer-offers`):

- Searches dealer/offer/inventory/incentive pages around your profile location (Maya asks for your city/postal code if she doesn't have it) and extracts only dealers/offers **actually named in the sources** — every card links its source, distances only appear when a source states them, and nothing is invented when nothing solid surfaces.
- **Pricing flexibility** (high/medium/low/unknown) is an *evidence-based estimate* from public signals only — advertised discounts below list price, manufacturer rebates/incentives, finance offers, competing dealers — with the signals listed and a clear "not a guarantee" disclaimer, plus negotiation tips. It is not inside knowledge of any dealer, and this is public web data, not a live inventory feed: always confirm price, stock and eligibility with the dealer.

> Because grounding is live, results vary as the web changes and are only as good as the retrieved sources — always verify prices/specs against an official local configurator before buying.

## ModMarket (new page)

**`modmarket.html`** — a separate agentic experience for modifying a car you already have (linked from the main nav). **Max, the ModMarket agent**, asks three things in chat:

1. **Your car** — make/model/year/trim (it also pre-fills from your DriveMatch selected/interested vehicle if you have one)
2. **Your goals + budget** — tap goal chips (carbon fibre & aero dress-up, wheels & tyres, power/tuning, exhaust & sound, suspension, brakes, handling, interior, lighting/wrap, off-road, audio) and/or describe it in your own words ("carbon fibre everywhere and a stage 1 tune"), plus a budget in any currency
3. **Your situation** — stock or modified, daily/weekend/track/show, DIY or shop, warranty concerns

Then `POST /api/mod-suggestions` (planner in `modPlanner.js`, routed like every other agent by `LLM_ROUTING` — a deep task, so Wonder under balanced routing, Spark under `LLM_ROUTING=spark`, with the usual cross-model fallback) runs per-category grounded searches — **forum/Reddit owner sentiment**, best-part discussions, retailer pricing, compatibility/warranty warnings — and builds a **staged plan**: parts in the right order (tyres/brakes before big power; supporting mods with a tune), indicative price ranges, per-part sentiment scores broken down by Reddit/forums/owner reviews with loves and complaints, install difficulty, fitment notes, risks, parts owners say to avoid, and honest warranty/emissions/insurance warnings. Server-side budget maths shows whether the full plan fits or is deliberately staged beyond it. After a plan, "make it cheaper" / "make it safer" re-runs it with adjusted constraints. Plans persist in the browser and download as JSON. As everywhere in DriveMatch, nothing is invented: thin sources come back unscored/unpriced and say so.

**Specific products & priced breakdown:** every mod must name the exact brand and product line/model as sold, with an estimated price per mod. A focused second research pass re-searches any part that came back generic or unpriced and replaces it with a verified specific product + price range (or leaves it honestly labelled "generic — specific product not verified"). The panel shows a **build breakdown**: per-stage parts/install/stage totals, an all-in (parts + install) estimate, and how many of the mods are specific named products vs priced.

**Import & regenerate a saved build:** download any build as JSON, then later use **⬆ Upload a build** (panel or chat chip) to restore the brief and the previous plan exactly as they were. Hit **↻ Regenerate this build** and Max re-runs the whole grounded research with today's specific products, prices and sentiment, replacing the old plan — the chat also accepts "regenerate" after a restore. The upload accepts ModMarket's own export (`{ build, plan }`) or a plan-only JSON, validates/sanitises the brief, and rejects anything else without changing your current build.

### Photo mod identification (`POST /api/mod-vision`)

Upload a photo on the ModMarket page and Max identifies the **make/model** (year range, trim cues, body style, with a confidence and the visible evidence) and **every modification he can actually see** — each with its category, location on the car, visual evidence, factory-vs-aftermarket call, confidence, and an on-photo bounding box. One tap then turns the identified car + mods into build goals and continues into the sentiment-backed planner.

How it works (`modVision.js`):

1. **Optional SAM segmentation** — if `SAM_API_URL` points at a SAM-compatible endpoint (e.g. a hosted/self-hosted **SAM 3.1** service accepting `POST { model, image_base64, prompts[] }` → `{ segments: [{ label, score, box }] }` with normalised boxes), the photo is segmented with prompts for common mod locations and those boxes localise the results. Without it, boxes are labelled honestly as vision-model estimates.
2. **Vision LLM** — the routed Muse model sees the photo and identifies vehicle + mods from visible evidence only. Unidentifiable vehicles come back "unknown" — badges can be swapped and software tunes are invisible, and the response says exactly what couldn't be assessed from that angle.
3. **Your reference photos genuinely help** — you can attach up to 5 *labelled* reference images in the page (e.g. "stock front end", "carbon splitter", "the wheels I want"). They're sent alongside the main photo as comparison examples, which materially improves subtle calls (wrap vs paint, OEM vs aftermarket wheels, stock vs lowered stance). If you have a small set of reference photos for cars you care about, add them there — no need to send them anywhere else. Images are downscaled in the browser before upload; reference thumbnails persist on-device only.

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
| `modmarket.html` + `modmarket.js` | **ModMarket page** — mod-planning agent chat (car → goals → budget → plan) and build-plan panel |
| `modPlanner.js` | ModMarket backend planner — goal classification, per-category grounded search, staged plan synthesis, budget maths |
| `modVision.js` | ModMarket photo identification — optional SAM segmentation adapter + vision-LLM make/model & visible-mods identification with reference photos |

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
- [x] Vehicle selection → Purchase Pack (dealers with it for sale, blocker-question readiness, dealer message draft, sales-tactics playbook)
- [x] ModMarket page — agentic modification planning grounded in forum/Reddit sentiment, staged to budget
- [x] ModMarket photo identification (make/model + visible mods, optional SAM 3.1 segmentation, labelled reference photos)
- [x] ModMarket build import/regenerate from downloaded JSON, with specific brand/product names and per-mod priced breakdown
- [ ] Live dealer inventory/pricing API integration (replace public-web extraction)
- [ ] Match results with total-cost-of-ownership comparison
- [ ] Auth + server-side profile persistence (move beyond localStorage)
- [ ] Optional: port `server.js` to Hono/Cloudflare Workers for edge deployment

## License

DriveMatch is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE) for the full text and [NOTICE](NOTICE) for attribution.

```
Copyright 2026 DriveMatch contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

In short: you may use, modify and redistribute this project, including for commercial purposes, provided you keep the copyright and license notices, note significant changes, and respect the patent/trademark terms in the full license. If you contribute code back, you agree it is provided under the same Apache 2.0 terms (Section 5 of the license).
