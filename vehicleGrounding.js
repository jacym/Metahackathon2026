// Search-grounded vehicle analysis — replaces the old vehicleData.js catalogue.
//
// Pipeline (no preconfigured vehicle entries anywhere):
//   1. Check the SQLite stable-facts cache (vehicleCacheDb.js) for this
//      vehicle: core identity, trims, colours, interiors, options and
//      performance specs are cached for ~30 days (monthly refresh).
//   2a. CACHE HIT: only the variable sections are researched live —
//       pricing, sentiment and common issues — with a small targeted
//       search + one lean Muse Wonder synthesis. This is the token saver.
//   2b. CACHE MISS/EXPIRED: full targeted web searches (official trims,
//       colours/options, performance, sentiment, common issues, rivals),
//       source retrieval + page extraction server-side (Tavily / Brave /
//       Serper with a key, otherwise a DuckDuckGo HTML dev fallback).
//   3. Muse Wonder synthesises the structured analysis using ONLY the
//      retrieved sources, with [S#] citations and nulls — never
//      inventions — where the sources are insufficient. Stable facts
//      from a full analysis are then written back to the cache DB.
//   4. Sanitise/validate everything server-side before it reaches the UI.
// If no sources can be retrieved and native LLM grounding is not enabled,
// this throws instead of hallucinating an analysis.

const vehicleCache = require('./vehicleCacheDb');

const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 12000);
const inFlight = new Map(); // normalizedQuery -> Promise (dedupes concurrent requests)

const MARKET_CURRENCIES = {
  US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', ZA: 'ZAR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR',
  NL: 'EUR', IE: 'EUR', PT: 'EUR', AT: 'EUR', BE: 'EUR', CH: 'CHF', JP: 'JPY', IN: 'INR', AE: 'AED', SG: 'SGD',
  BR: 'BRL', MX: 'MXN', KR: 'KRW', CN: 'CNY', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', TR: 'TRY', ID: 'IDR', TH: 'THB', MY: 'MYR', PH: 'PHP', VN: 'VND', EG: 'EGP', NG: 'NGN', KE: 'KES', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
};
const MARKET_NAME_TO_CODE = {
  'united states': 'US', usa: 'US', america: 'US', canada: 'CA', 'united kingdom': 'GB', britain: 'GB', england: 'GB',
  australia: 'AU', 'new zealand': 'NZ', 'south africa': 'ZA', germany: 'DE', france: 'FR', spain: 'ES', italy: 'IT',
  netherlands: 'NL', ireland: 'IE', switzerland: 'CH', japan: 'JP', india: 'IN', 'united arab emirates': 'AE', uae: 'AE',
  singapore: 'SG', brazil: 'BR', mexico: 'MX', 'south korea': 'KR', china: 'CN', sweden: 'SE', norway: 'NO', denmark: 'DK', poland: 'PL',
};
const MARKET_POSTAL_LABELS = { US: 'ZIP code', GB: 'postcode', AU: 'postcode', NZ: 'postcode', NL: 'postcode', IN: 'PIN code', BR: 'CEP', IE: 'Eircode' };
function regionName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; }
}
function normalizeMarket(input) {
  const obj = typeof input === 'object' && input ? input : {};
  const raw = String(obj.code || obj.country || obj.market || input || '').trim();
  const requestedCurrency = String(obj.currency || '').trim().toUpperCase();
  let code = '';
  if (/^[A-Za-z]{2}$/.test(raw)) code = raw.toUpperCase();
  else code = MARKET_NAME_TO_CODE[raw.toLowerCase()] || '';
  if (!code) {
    // Unknown/blank market: keep it genuinely unscoped rather than
    // silently pricing another country. Searches run without a country
    // qualifier and the UI keeps the user's chosen currency.
    return { code: '', country: '', currency: /^[A-Z]{3}$/.test(requestedCurrency) ? requestedCurrency : '', postalLabel: 'postal code', searchQualifier: '', officialHint: 'official manufacturer sources for the user\'s market' };
  }
  const country = regionName(code);
  return {
    code, country,
    currency: /^[A-Z]{3}$/.test(requestedCurrency) ? requestedCurrency : (MARKET_CURRENCIES[code] || ''),
    postalLabel: MARKET_POSTAL_LABELS[code] || 'postal code',
    searchQualifier: country,
    officialHint: `official ${country} manufacturer sources`,
  };
}

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = (v, max = 12) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).slice(0, max) : []);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
}
function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

// ---------------- Search retrieval ----------------
function buildSearchQueries(query, mode = 'full', marketInput) {
  const market = normalizeMarket(marketInput);
  const q = query.replace(/\s+/g, ' ').trim();
  const yearHint = /\b(19|20)\d{2}\b/.test(q) ? '' : ' latest model year';
  const place = market.searchQualifier ? ` ${market.searchQualifier}` : '';
  const money = market.currency ? ` ${market.currency} pricing` : ' pricing';
  if (mode === 'live') {
    // Variable sections only — used on a stable-cache hit.
    return [
      { type: 'live-pricing', query: `${q}${yearHint}${place}${money} MSRP deals current price` },
      { type: 'forum-sentiment', query: `${q}${place} owner forum problems complaints reliability real owners experience` },
      { type: 'social-sentiment', query: `${q} owner opinions review ratings sentiment worth buying` },
      { type: 'common-issues', query: `${q} common problems issues recalls owner reported faults reliability` },
    ];
  }
  return [
    { type: 'official-trims', query: `${q}${yearHint}${place} trims trim levels MSRP price official specifications ${market.officialHint}` },
    { type: 'colours-options', query: `${q}${yearHint}${place} exterior colours colors interior options packages accessories configurator` },
    { type: 'performance', query: `${q} performance horsepower torque 0-60 acceleration towing capacity fuel economy range safety rating review` },
    { type: 'forum-sentiment', query: `${q}${place} owner forum problems complaints reliability real owners experience` },
    { type: 'social-sentiment', query: `${q} owner opinions review social media sentiment worth buying` },
    { type: 'common-issues', query: `${q} common problems issues recalls owner reported faults reliability` },
    { type: 'similar', query: `${q}${place} vs competitors similar alternatives comparison best rivals` },
  ];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal, headers: { 'User-Agent': 'DriveMatch/0.5 (grounded vehicle research)', ...(options.headers || {}) } }); }
  finally { clearTimeout(t); }
}

async function searchTavily(query, provider) {
  const base = (process.env.SEARCH_API_BASE_URL || 'https://api.tavily.com').replace(/\/$/, '');
  const res = await fetchWithTimeout(`${base}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SEARCH_API_KEY}` },
    body: JSON.stringify({ query, search_depth: 'advanced', max_results: 4, include_answer: false, include_raw_content: false }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: str(r.title, 180), url: str(r.url, 500), snippet: str(r.content, 1200), publishedDate: str(r.published_date, 40) }));
}
async function searchBrave(query) {
  const base = (process.env.SEARCH_API_BASE_URL || 'https://api.search.brave.com').replace(/\/$/, '');
  const res = await fetchWithTimeout(`${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=4`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.SEARCH_API_KEY },
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map((r) => ({ title: str(r.title, 180), url: str(r.url, 500), snippet: str(r.description, 1200), publishedDate: '' }));
}
async function searchSerper(query) {
  const base = (process.env.SEARCH_API_BASE_URL || 'https://google.serper.dev').replace(/\/$/, '');
  const res = await fetchWithTimeout(`${base}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SEARCH_API_KEY },
    body: JSON.stringify({ q: query, num: 4 }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  return (data.organic || []).map((r) => ({ title: str(r.title, 180), url: str(r.link, 500), snippet: str(r.snippet, 1200), publishedDate: str(r.date, 40) }));
}
async function searchDuckDuckGo(query) {
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const blocks = html.split('result__body').slice(1, 5);
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/td>/);
    if (!link) continue;
    let url = decodeEntities(link[1]);
    try { const u = new URL(url, 'https://duckduckgo.com'); url = u.searchParams.get('uddg') || url; } catch { /* keep raw */ }
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: stripTags(link[2]).slice(0, 180), url: url.slice(0, 500), snippet: stripTags(snip?.[1] || snip?.[2] || '').slice(0, 1200), publishedDate: '' });
  }
  return out;
}

async function runSearches(searches, { idOffset = 0 } = {}) {
  const configured = (process.env.SEARCH_PROVIDER || 'auto').toLowerCase();
  const hasKey = !!(process.env.SEARCH_API_KEY || '').trim();
  let provider = configured;
  if (provider === 'auto') provider = hasKey ? 'tavily' : 'duckduckgo';
  if (provider === 'none') return { provider: 'none', sources: [], warnings: ['Search retrieval disabled (SEARCH_PROVIDER=none).'] };

  const searchFn = provider === 'brave' ? searchBrave : provider === 'serper' ? searchSerper : provider === 'duckduckgo' ? searchDuckDuckGo : searchTavily;
  const settled = await Promise.allSettled(searches.map(async (s) => ({ type: s.type, results: await searchFn(s.query) })));
  const warnings = [];
  const byUrl = new Map();
  for (const item of settled) {
    if (item.status === 'rejected') { warnings.push(`${provider} search failed: ${item.reason.message}`); continue; }
    for (const r of item.value.results) {
      if (!r.url || byUrl.has(r.url)) continue;
      byUrl.set(r.url, { ...r, queryType: item.value.type, domain: domainOf(r.url) });
    }
  }
  // Balance across research types (3 each) so later query types (sentiment,
  // similar) are never crowded out by trim/spec results.
  const all = [...byUrl.values()];
  const balanced = [];
  const types = [...new Set(all.map((s) => s.queryType))];
  for (let round = 0; round < 3; round++) {
    for (const type of types) {
      const item = all.filter((s) => s.queryType === type)[round];
      if (item && !balanced.includes(item)) balanced.push(item);
    }
  }
  const sources = balanced.slice(0, 18).map((s, i) => ({ id: `S${idOffset + i + 1}`, ...s }));
  await enrichSources(sources);
  return { provider, sources, warnings, searchQueries: searches.map((s) => s.query) };
}

async function retrieveSources(query, { mode = 'full', idOffset = 0, market } = {}) {
  return runSearches(buildSearchQueries(query, mode, market), { idOffset });
}

function extractMainText(html) {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|table|footer|header|nav)>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const boiler = /skip to (content|main)|cookie|newsletter|subscribe|sign (in|up)|log ?in|create (an )?account|advertisement|sponsored|all rights reserved|privacy policy|terms of (use|service)|menu|close (panel|menu)|shop now|book a test drive/i;
  const seen = new Set();
  const lines = decodeEntities(cleaned).split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 24 && !boiler.test(l) && !seen.has(l) && seen.add(l));
  // Keyword-dense lines carry the facts (trims, prices, specs, sentiment);
  // surface those first, then fill with remaining context in page order.
  const factLine = /trim|price|\$\s?\d|msrp|horsepower|\bhp\b|torque|0-60|mpg|litres?|liters?|kwh|range|charging|tow|payload|colour|color|interior|seat|owner|complaint|problem|reliab|review|rating|safety|crash|engine|hybrid|electric|warranty|cargo/i;
  const facts = lines.filter((l) => factLine.test(l));
  const rest = lines.filter((l) => !factLine.test(l));
  let out = '';
  for (const l of [...facts, ...rest]) { if ((out + l).length > 6000) break; out += `${l}\n`; }
  return out.trim();
}

// Fetch the actual page text for the most relevant sources whose search
// snippet is thin. This is what turns "search results" into grounding:
// the LLM synthesises from extracted page content, not result titles.
async function enrichSources(sources) {
  const typeRank = { 'official-trims': 0, 'colours-options': 1, performance: 2, 'live-pricing': 2, 'social-sentiment': 3, 'forum-sentiment': 4, 'common-issues': 4, similar: 5 };
  // Guarantee coverage of every research type (especially sentiment and
  // similar-vehicle pages), then fill remaining slots by relevance rank.
  const thin = [...sources].filter((s) => (s.snippet || '').length < 900)
    .sort((a, b) => (typeRank[a.queryType] ?? 9) - (typeRank[b.queryType] ?? 9));
  const candidates = [];
  const perType = { 'official-trims': 2, 'colours-options': 2, performance: 2, 'live-pricing': 2, 'forum-sentiment': 3, 'social-sentiment': 3, 'common-issues': 3, similar: 2 };
  for (const type of Object.keys(typeRank)) {
    for (const s of thin.filter((x) => x.queryType === type).slice(0, perType[type] || 2)) {
      if (!candidates.includes(s) && candidates.length < 14) candidates.push(s);
    }
  }
  for (const s of thin) { if (!candidates.includes(s) && candidates.length < 14) candidates.push(s); }
  await Promise.allSettled(candidates.map(async (s) => {
    try {
      const res = await fetchWithTimeout(s.url, { headers: { Accept: 'text/html' } }, 10000);
      if (!res.ok) return;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('html') && !type.includes('text')) return;
      const html = await res.text();
      const text = extractMainText(html);
      if (text.length > (s.snippet || '').length) { s.snippet = text; s.extracted = true; }
    } catch { /* keep the search snippet */ }
  }));
}

// ---------------- LLM synthesis ----------------
function synthesisPrompt(query, sources, today, marketInput) {
  const market = normalizeMarket(marketInput);
  const sourceText = sources.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}${s.publishedDate ? `, ${s.publishedDate}` : ''}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, s.queryType?.includes('sentiment') ? 2400 : 2000)}`).join('\n\n');
  return {
    system: `You are DriveMatch's grounded vehicle-research analyst. Today is ${today}. Produce an up-to-date analysis of the vehicle the user asked about using ONLY the web sources provided. Rules:
- Every factual claim (trims, prices, colours, options, performance, economy, safety, sentiment themes) must come from the sources; append source citations like [S1] to points where practical.
- NEVER invent trims, colours, prices, specifications or sentiment. If sources are insufficient for a section, return null/empty for it and say what is unverified in confidence.notes.
- ${market.code ? `TARGET MARKET: ${market.country} (${market.code}). Prioritise ${market.officialHint} and ${market.country} pricing in ${market.currency}; do not present another country's prices as ${market.currency} or convert currencies. State the assumed model year in vehicle.year and "${market.country}" in vehicle.market (note in confidence.notes if the sources mixed markets).` : 'TARGET MARKET: not specified by the user. Use the market most evident in the sources, state it in vehicle.market, keep prices in their source currency, and never convert currencies.'}
- Sentiment must be derived from the forum/social/owner sources only: score 0-100, positive/neutral/negative percentages summing to 100, per-source-type breakdown (Social media, Owner forums, Long-term owner reviews) with scores and themes, loves and complaints. If the sources contain ratings or substantive owner-review text, give a best-estimate score/distribution and state in sentiment.note that it is an estimate from the retrieved sources, not a representative statistical sample. Only use score null when there is no sentiment-bearing text at all.
- Performance must cover, where sourced: power/torque, acceleration, top/economy or EV range/charging, towing/payload if relevant, and safety ratings.
- Common issues: from the forum/owner/problem sources, list the issues owners actually report — each with a title, severity (high|medium|low, judged by safety/cost impact described in the sources), how frequently it appears in the sources (e.g. "Frequently reported in the retrieved sources"), model years/generations affected if the sources say so, symptoms, and a short sourced description. Never exaggerate frequency beyond what the sources show; if problem sources are thin, return an empty list and say so in confidence.notes.
- Prices must keep the source currency and be labelled indicative; do not convert currencies.
- Similar vehicles: name real rivals supported by the comparison sources, with why-to-consider and key differences.
- generatedProfile is a DRAFT the user will edit: infer bodyStyles, fuel, budget (a range string in the vehicle's price currency), primaryUse, passengers, cargo, terrain, features, priorities (1-5 map) from the vehicle — clearly reasonable inferences, not facts about the user.
Return ONLY valid JSON in exactly the schema given. No markdown, no commentary outside JSON.`,
    user: `Vehicle requested: "${query}"\n\nWEB SOURCES:\n${sourceText}\n\nReturn JSON with this exact shape:\n{"vehicle":{"make":"","model":"","year":"","market":"","category":"","bodyStyle":"","seating":5,"powertrains":[],"drivetrains":[],"economy":"","priceGuide":{"currency":"${market.currency || 'local currency code'}","starting":null,"typicalTop":null,"note":""},"strengths":[],"watchouts":[]},"performance":{"summary":"","metrics":[{"label":"","value":""}],"points":[]},"trims":[{"name":"","priceFrom":null,"highlights":[]}],"exteriorColours":[{"name":"","swatch":"#888888"}],"interiors":[],"options":[{"name":"","note":"","description":""}],"sentiment":{"score":null,"distribution":{"positive":0,"neutral":0,"negative":0},"sources":[{"type":"Social media","score":null,"volume":"","themes":[]},{"type":"Owner forums","score":null,"volume":"","themes":[]},{"type":"Long-term owner reviews","score":null,"volume":"","themes":[]}],"loves":[],"complaints":[],"note":""},"similar":[{"make":"","model":"","category":"","priceFrom":null,"currency":"${market.currency || 'local currency code'}","sentimentScore":null,"whyConsider":[],"keyDifference":""}],"commonIssues":[{"title":"","severity":"medium","frequency":"","yearsAffected":"","symptoms":[],"description":""}],"generatedProfile":{"primaryUse":"","passengers":"","cargo":[],"terrain":[],"bodyStyles":[],"fuel":"","features":[],"budget":"","priorities":{},"prioritiesMentioned":[]},"profileAssumptions":[],"confidence":{"level":"high|medium|low","notes":""}}`,
  };
}

function budgetLabel(v, currencyCode = '') {
  if (!v) return '';
  const f = (n) => {
    try { return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode, maximumFractionDigits: 0 }).format(n); }
    catch { return `${currencyCode ? `${currencyCode} ` : ''}${n.toLocaleString()}`; }
  };
  if (v < 15000) return `Under ${f(15000)}`;
  if (v <= 25000) return `${f(15000)} – ${f(25000)}`;
  if (v <= 35000) return `${f(25000)} – ${f(35000)}`;
  if (v <= 50000) return `${f(35000)} – ${f(50000)}`;
  if (v <= 75000) return `${f(50000)} – ${f(75000)}`;
  return `${f(75000)}+`;
}
function fuelFromPowertrains(powertrains) {
  const p = (powertrains || []).join(' ').toLowerCase();
  const combustion = /petrol|gasoline|diesel|v8|v6|turbo|engine/.test(p) && !/electric motor/.test(p);
  if (p.includes('electric') && !combustion) return 'Electric (EV)';
  if (p.includes('plug-in') || p.includes('phev')) return 'Plug-in hybrid (PHEV)';
  if (p.includes('hybrid')) return 'Hybrid';
  return 'Petrol / Gasoline';
}

function sanitiseAnalysis(raw, { query, sources, groundingMode, provider, warnings, market: marketInput }) {
  const market = normalizeMarket(marketInput);
  if (!raw || typeof raw !== 'object' || !raw.vehicle) throw Object.assign(new Error('LLM returned an unexpected vehicle-analysis format.'), { status: 502 });
  const v = raw.vehicle;
  const noCites = (s) => s.replace(/\s*\[S\d+\]/gi, '').trim();
  const vehicle = {
    id: null, make: noCites(str(v.make, 60)) || 'Unknown', model: noCites(str(v.model, 80)) || query,
    year: noCites(str(v.year, 40)), market: noCites(str(v.market, 80)),
    category: noCites(str(v.category, 80)) || 'Vehicle', bodyStyle: noCites(str(v.bodyStyle, 60)) || 'SUV / Crossover',
    seating: clamp(Number(v.seating) || 5, 1, 12),
    powertrains: arr(v.powertrains, 6).map((x) => str(x, 120)).filter(Boolean),
    drivetrains: arr(v.drivetrains, 4).map((x) => str(x, 60)).filter(Boolean),
    economy: str(v.economy, 300),
    priceGuide: {
      currency: str(v.priceGuide?.currency, 3).toUpperCase() || market.currency || '',
      starting: num(v.priceGuide?.starting), typicalTop: num(v.priceGuide?.typicalTop),
      note: str(v.priceGuide?.note, 300) || 'Indicative pricing from the cited sources; verify locally.',
    },
    strengths: arr(v.strengths, 6).map((x) => str(x, 180)).filter(Boolean),
    watchouts: arr(v.watchouts, 6).map((x) => str(x, 180)).filter(Boolean),
  };

  let sentiment = null;
  if (raw.sentiment && (num(raw.sentiment.score) !== null || arr(raw.sentiment.loves).length || arr(raw.sentiment.complaints).length)) {
    const d = raw.sentiment.distribution || {};
    let pos = clamp(Number(d.positive) || 0, 0, 100); let neu = clamp(Number(d.neutral) || 0, 0, 100); let neg = clamp(Number(d.negative) || 0, 0, 100);
    const total = pos + neu + neg;
    if (total > 0) { pos = Math.round((pos / total) * 100); neu = Math.round((neu / total) * 100); neg = Math.max(0, 100 - pos - neu); }
    sentiment = {
      score: num(raw.sentiment.score) === null ? null : clamp(Math.round(num(raw.sentiment.score)), 0, 100),
      distribution: { positive: pos, neutral: neu, negative: neg },
      sources: arr(raw.sentiment.sources, 4).map((s) => ({ type: str(s.type, 60) || 'Owner sources', score: num(s.score) === null ? null : clamp(Math.round(num(s.score)), 0, 100), volume: str(s.volume, 40), themes: arr(s.themes, 5).map((x) => str(x, 120)).filter(Boolean) })),
      loves: arr(raw.sentiment.loves, 6).map((x) => str(x, 160)).filter(Boolean),
      complaints: arr(raw.sentiment.complaints, 6).map((x) => str(x, 160)).filter(Boolean),
      note: str(raw.sentiment.note, 400),
    };
  }

  const gp = raw.generatedProfile || {};
  const generatedProfile = {
    primaryUse: str(gp.primaryUse, 80), passengers: str(gp.passengers, 20),
    cargo: arr(gp.cargo, 8).map((x) => str(x, 80)).filter(Boolean),
    terrain: arr(gp.terrain, 8).map((x) => str(x, 80)).filter(Boolean),
    bodyStyles: arr(gp.bodyStyles, 4).map((x) => str(x, 60)).filter(Boolean),
    fuel: str(gp.fuel, 60), features: arr(gp.features, 10).map((x) => str(x, 100)).filter(Boolean),
    budget: str(gp.budget, 80),
    priorities: {}, prioritiesMentioned: arr(gp.prioritiesMentioned, 8).map((x) => str(x, 40)).filter(Boolean),
    interestedVehicle: `${vehicle.make} ${vehicle.model}`, sourceVehicle: `${vehicle.make} ${vehicle.model}`,
  };
  const PRIORITY_ALIASES = { economy: 'fuelEconomy', fuel: 'fuelEconomy', mpg: 'fuelEconomy', tech: 'technology', space: 'comfort', roominess: 'comfort', practicality: 'cargo', looks: 'style', design: 'style', speed: 'performance', power: 'performance' };
  const normPriorityKey = (k) => PRIORITY_ALIASES[String(k).toLowerCase()] || String(k);
  if (gp.priorities && typeof gp.priorities === 'object') for (const [k, val] of Object.entries(gp.priorities)) generatedProfile.priorities[normPriorityKey(k)] = clamp(Number(val) || 3, 1, 5);
  generatedProfile.prioritiesMentioned = [...new Set(generatedProfile.prioritiesMentioned.map(normPriorityKey))];
  // Canonicalise to the frontend's vocabulary so the editable profile reads cleanly.
  const digit = generatedProfile.passengers.match(/\d+/);
  if (digit) generatedProfile.passengers = digit[0];
  generatedProfile.bodyStyles = generatedProfile.bodyStyles.map((b) => {
    const low = b.toLowerCase();
    if (/truck|pickup/.test(low)) return 'Truck / Pickup';
    if (/minivan|van/.test(low)) return 'Minivan';
    if (/hatch/.test(low)) return 'Hatchback';
    if (/wagon|estate/.test(low)) return 'Wagon';
    if (/coupe|convertible|sports/.test(low)) return 'Coupe / Convertible';
    if (/sedan|saloon/.test(low)) return 'Sedan';
    if (/suv|crossover|cuv/.test(low)) return 'SUV / Crossover';
    return b;
  });
  if (!generatedProfile.bodyStyles.length) generatedProfile.bodyStyles = [vehicle.bodyStyle];
  if (!generatedProfile.fuel) generatedProfile.fuel = fuelFromPowertrains(vehicle.powertrains);
  else {
    const f = generatedProfile.fuel.toLowerCase();
    if (/plug|phev/.test(f)) generatedProfile.fuel = 'Plug-in hybrid (PHEV)';
    else if (/^electric|^ev\b|battery electric/.test(f)) generatedProfile.fuel = 'Electric (EV)';
    else if (/hybrid/.test(f)) generatedProfile.fuel = 'Hybrid';
    else if (/gasoline|petrol|^gas$/.test(f)) generatedProfile.fuel = 'Petrol / Gasoline';
    else if (/diesel/.test(f)) generatedProfile.fuel = 'Diesel';
  }
  if (!generatedProfile.budget && vehicle.priceGuide.starting) generatedProfile.budget = budgetLabel(vehicle.priceGuide.starting, vehicle.priceGuide.currency);
  if (!generatedProfile.prioritiesMentioned.length) generatedProfile.prioritiesMentioned = Object.keys(generatedProfile.priorities);

  const profileAssumptions = arr(raw.profileAssumptions, 7).map((x) => str(x, 260)).filter(Boolean);
  if (!profileAssumptions.length) {
    profileAssumptions.push(
      `Body style/fuel drafted from the ${vehicle.make} ${vehicle.model}'s grounded powertrain and category data — confirm or change them.`,
      generatedProfile.budget ? `Budget drafted as ${generatedProfile.budget} from grounded indicative pricing — replace it with your real local budget.` : 'No budget drafted — add your real budget.',
      'Priorities are inferred from this vehicle\'s strengths in the sources — rank what actually matters to you.',
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    query, generic: false, grounded: true, asOf: today,
    dataSource: groundingMode === 'native-llm-grounding'
      ? `Search-grounded by Muse Wonder's web search on ${today}. Sources are cited below; verify prices/specs locally before buying.`
      : `Search-grounded on ${today}: the backend retrieved ${sources.length} web source(s) via ${provider}, then Muse Wonder synthesised this analysis from those sources only, with citations. Verify prices/specs locally before buying.`,
    grounding: { mode: groundingMode, provider: provider || null, retrievedAt: new Date().toISOString(), sourceCount: sources.length, warnings: warnings || [] },
    sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, publishedDate: s.publishedDate || '', queryType: s.queryType || 'native-citation' })),
    confidence: { level: ['high', 'medium', 'low'].includes(raw.confidence?.level) ? raw.confidence.level : (sources.length >= 8 ? 'medium' : 'low'), notes: str(raw.confidence?.notes, 500) },
    vehicle,
    performance: {
      summary: str(raw.performance?.summary, 500),
      metrics: arr(raw.performance?.metrics, 10).map((m) => ({ label: str(m.label, 80), value: str(m.value, 160) })).filter((m) => m.label && m.value),
      points: arr(raw.performance?.points, 8).map((x) => str(x, 220)).filter(Boolean),
    },
    trims: arr(raw.trims, 14).map((t) => ({ name: str(t.name, 80), priceFrom: num(t.priceFrom), highlights: arr(t.highlights, 5).map((x) => str(x, 140)).filter(Boolean) })).filter((t) => t.name),
    exteriorColours: arr(raw.exteriorColours, 16).map((c) => ({ name: str(c.name, 80), swatch: /^#[0-9a-f]{6}$/i.test(c.swatch || '') ? c.swatch : '#cbd5e1' })).filter((c) => c.name),
    interiors: arr(raw.interiors, 6).map((x) => str(x, 140)).filter(Boolean),
    options: arr(raw.options, 14).map((o) => ({ name: str(o.name, 100), note: str(o.note, 80), description: str(o.description, 220) })).filter((o) => o.name),
    sentiment,
    similar: arr(raw.similar, 4).map((s) => ({
      id: null, make: str(s.make, 60), model: str(s.model, 80), category: str(s.category, 80),
      priceGuide: { currency: str(s.currency, 3).toUpperCase() || vehicle.priceGuide.currency, starting: num(s.priceFrom) },
      sentimentScore: num(s.sentimentScore) === null ? null : clamp(Math.round(num(s.sentimentScore)), 0, 100),
      whyConsider: arr(s.whyConsider, 4).map((x) => str(x, 140)).filter(Boolean),
      keyDifference: str(s.keyDifference, 220),
    })).filter((s) => s.make && s.model),
    commonIssues: sanitiseCommonIssues(raw.commonIssues),
    generatedProfile,
    profileAssumptions,
  };
}

function sanitiseSentiment(rawSentiment) {
  if (!rawSentiment || (num(rawSentiment.score) === null && !arr(rawSentiment.loves).length && !arr(rawSentiment.complaints).length)) return null;
  const d = rawSentiment.distribution || {};
  let pos = clamp(Number(d.positive) || 0, 0, 100); let neu = clamp(Number(d.neutral) || 0, 0, 100); let neg = clamp(Number(d.negative) || 0, 0, 100);
  const total = pos + neu + neg;
  if (total > 0) { pos = Math.round((pos / total) * 100); neu = Math.round((neu / total) * 100); neg = Math.max(0, 100 - pos - neu); }
  return {
    score: num(rawSentiment.score) === null ? null : clamp(Math.round(num(rawSentiment.score)), 0, 100),
    distribution: { positive: pos, neutral: neu, negative: neg },
    sources: arr(rawSentiment.sources, 4).map((s) => ({ type: str(s.type, 60) || 'Owner sources', score: num(s.score) === null ? null : clamp(Math.round(num(s.score)), 0, 100), volume: str(s.volume, 40), themes: arr(s.themes, 5).map((x) => str(x, 120)).filter(Boolean) })),
    loves: arr(rawSentiment.loves, 6).map((x) => str(x, 160)).filter(Boolean),
    complaints: arr(rawSentiment.complaints, 6).map((x) => str(x, 160)).filter(Boolean),
    note: str(rawSentiment.note, 400),
  };
}
function sanitiseCommonIssues(list) {
  return arr(list, 8).map((i) => ({
    title: str(i.title, 120),
    severity: ['high', 'medium', 'low'].includes(String(i.severity || '').toLowerCase()) ? String(i.severity).toLowerCase() : 'unknown',
    frequency: str(i.frequency, 120), yearsAffected: str(i.yearsAffected, 80),
    symptoms: arr(i.symptoms, 5).map((x) => str(x, 140)).filter(Boolean),
    description: str(i.description, 320),
  })).filter((i) => i.title);
}

function extractNativeSources(raw, parsed) {
  const out = []; const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || out.length >= 20) return;
    if (typeof node.url === 'string' && /^https?:\/\//.test(node.url) && !seen.has(node.url)) {
      seen.add(node.url);
      out.push({ id: `S${out.length + 1}`, title: str(node.title, 180) || domainOf(node.url), url: node.url.slice(0, 500), domain: domainOf(node.url), publishedDate: '', queryType: 'native-citation', snippet: '' });
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(raw); walk(parsed?.sources);
  return out;
}

async function fullGroundedAnalysis(query, { callLLM, market: marketInput } = {}) {
  const market = normalizeMarket(marketInput);
  const today = new Date().toISOString().slice(0, 10);
  const { provider, sources, warnings, searchQueries } = await retrieveSources(query, { market });
  let raw; let groundingMode = 'search+llm'; let usedSources = sources;

  if (sources.length) {
    const prompt = synthesisPrompt(query, sources, today, market);
    const { text } = await callLLM({
      task: 'vehicle-synthesis',
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      maxTokens: Number(process.env.VEHICLE_MAX_TOKENS || 12000), temperature: 0.2,
      timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
      reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
    });
    raw = parseJson(text);
    if (!raw) {
      // One strict retry with a reduced source set — long grounded prompts
      // occasionally come back as prose or truncated JSON.
      const retry = await callLLM({
        task: 'vehicle-synthesis',
        messages: [
          { role: 'system', content: synthesisPrompt(query, sources.slice(0, 10), today, market).system },
          { role: 'user', content: synthesisPrompt(query, sources.slice(0, 10), today, market).user },
        ],
        maxTokens: Number(process.env.VEHICLE_MAX_TOKENS || 12000), temperature: 0.1,
        timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
        reasoningEffort: 'low',
      });
      raw = parseJson(retry.text);
    }
    if (raw && !raw.vehicle && raw.analysis?.vehicle) raw = raw.analysis;
    if (raw && !raw.vehicle && raw.data?.vehicle) raw = raw.data;
  } else if ((process.env.LLM_NATIVE_GROUNDING || '').toLowerCase() === 'true') {
    // Provider-native search grounding (e.g. a web_search tool on the
    // Responses API). Tool name is configurable because providers differ.
    const toolType = process.env.LLM_WEB_SEARCH_TOOL || 'web_search';
    const result = await callLLM({
      task: 'vehicle-synthesis',
      messages: [
        { role: 'system', content: synthesisPrompt(query, [], today, market).system },
        { role: 'user', content: `Vehicle requested: "${query}" for the ${market.country} market (${market.currency}). Use your web-search grounding to research current ${market.country} trims, colours, options, pricing, performance and owner sentiment, then return the same JSON schema described in the system prompt.` },
      ],
      maxTokens: Number(process.env.VEHICLE_MAX_TOKENS || 12000), temperature: 0.2,
      timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
      reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
      tools: [{ type: toolType }],
    });
    raw = parseJson(result.text);
    usedSources = extractNativeSources(result.raw, raw);
    groundingMode = 'native-llm-grounding';
    if (!usedSources.length) throw Object.assign(new Error('Native LLM grounding returned no citable sources, so the analysis was withheld rather than presented ungrounded.'), { status: 502 });
  } else {
    throw Object.assign(new Error(`Search grounding could not retrieve any sources for "${query}" (${(warnings || []).join('; ') || 'no search provider available'}). Configure a search API key (SEARCH_PROVIDER/SEARCH_API_KEY) or enable LLM_NATIVE_GROUNDING=true.`), { status: 503 });
  }

  if (groundingMode === 'search+llm') raw = await repairMissingSections(raw, { query, sources: usedSources, callLLM, today, market });
  const value = sanitiseAnalysis(raw, { query, sources: usedSources, groundingMode, provider, warnings: [...(warnings || []), ...(searchQueries ? [] : [])], market });
  value.market = market;
  // Persist the stable facts (not pricing/sentiment/common issues) for
  // ~monthly reuse, then report the split to the UI.
  let stableStored = false;
  try {
    const entry = storeStableFacts(value, query, market);
    stableStored = !!entry;
    if (entry) value.cache = { stableHit: false, stableStored: true, stableCachedAt: new Date(entry.storedAt).toISOString(), stableExpiresAt: new Date(entry.expiresAt).toISOString(), liveRetrievedAt: value.grounding.retrievedAt };
  } catch (err) { console.warn('Could not store stable vehicle cache:', err.message); }
  if (!value.cache) value.cache = { stableHit: false, stableStored, liveRetrievedAt: value.grounding.retrievedAt };
  return value;
}

// ---- Stable-cache split / live merge ----
function buildStableEntry(analysis) {
  const clone = JSON.parse(JSON.stringify(analysis));
  const stable = {
    vehicle: { ...clone.vehicle, priceGuide: { currency: clone.vehicle.priceGuide?.currency || '', starting: null, typicalTop: null, note: 'Pricing is fetched live on each visit.' }, watchouts: [] },
    performance: clone.performance, trims: clone.trims.map((t) => ({ ...t, priceFrom: null })),
    exteriorColours: clone.exteriorColours, interiors: clone.interiors, options: clone.options,
    similar: clone.similar.map((s) => ({ ...s, priceGuide: { currency: s.priceGuide?.currency || clone.vehicle.priceGuide?.currency || '', starting: null }, sentimentScore: null })),
    generatedProfile: { ...clone.generatedProfile, budget: '' },
    profileAssumptions: clone.profileAssumptions,
  };
  const stableSources = clone.sources.filter((s) => ['official-trims', 'colours-options', 'performance', 'similar', 'native-citation'].includes(s.queryType));
  return { stable, sources: stableSources };
}
function storeStableFacts(analysis, query, marketInput) {
  const market = normalizeMarket(marketInput || analysis.market);
  const { stable, sources } = buildStableEntry(analysis);
  // Quality gate: never lock a sparse extraction into the monthly cache.
  // A thin result is returned to the user (honestly labelled) but the next
  // visit re-researches in full instead of serving thin facts for a month.
  const stableItems = stable.trims.length + stable.exteriorColours.length + stable.options.length;
  const meaningful = (stable.trims.length >= 3 && stableItems >= 6) || stableItems >= 10;
  if (!meaningful) { console.log(`Stable cache skipped for ${analysis.vehicle.make} ${analysis.vehicle.model}: only ${stableItems} stable fact item(s) grounded.`); return null; }
  return vehicleCache.upsert({ vehicle: analysis.vehicle, stable, sources, alias: query, marketCode: market.code });
}

async function liveVariableUpdate(entry, query, { callLLM, market: marketInput } = {}) {
  const market = normalizeMarket(marketInput || entry.market);
  const today = new Date().toISOString().slice(0, 10);
  const stable = JSON.parse(JSON.stringify(entry.stable));
  const stableSources = entry.sources || [];
  let live = { priceGuide: null, sentiment: null, commonIssues: [], watchouts: [], similarUpdates: [], confidence: null };
  let liveSources = []; let provider = null; let liveError = '';
  try {
    const retrieved = await retrieveSources(query, { mode: 'live', idOffset: stableSources.length, market });
    provider = retrieved.provider; liveSources = retrieved.sources;
    if (!liveSources.length) throw new Error(retrieved.warnings?.join('; ') || 'No live sources retrieved');
    const sourceText = liveSources.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, 2200)}`).join('\n\n');
    const { text } = await callLLM({
      task: 'vehicle-live',
      messages: [
        { role: 'system', content: `You are DriveMatch's grounded vehicle-research analyst. Today is ${today}. TARGET MARKET: ${market.country} (${market.code}) — pricing must be ${market.currency} from ${market.country} sources; never convert currencies. The stable facts for this vehicle (trims, colours, options, specs) are already cached — do NOT redo them. Using ONLY the web sources provided, return the VARIABLE sections that change over time: current indicative pricing, owner sentiment, common owner-reported issues, and current watch-outs. Never invent facts; use null/empty where sources are insufficient. For sentiment, estimate a score/distribution only if sources contain ratings or substantive owner-review text, noting it is an estimate from these sources. For common issues, judge severity by safety/cost impact in the sources and frequency only as it appears in these sources. Return ONLY valid JSON: {"priceGuide":{"currency":"${market.currency}","starting":null,"typicalTop":null,"note":""},"sentiment":{"score":null,"distribution":{"positive":0,"neutral":0,"negative":0},"sources":[],"loves":[],"complaints":[],"note":""},"commonIssues":[{"title":"","severity":"medium","frequency":"","yearsAffected":"","symptoms":[],"description":""}],"watchouts":[],"similarUpdates":[{"make":"","model":"","priceFrom":null,"currency":"${market.currency}","sentimentScore":null}],"confidence":{"level":"high|medium|low","notes":""}}` },
        { role: 'user', content: `Vehicle: "${entry.make} ${entry.model} ${entry.year || ''}" for ${market.country} (cached stable facts as of ${new Date(entry.storedAt).toISOString().slice(0, 10)}). Return the variable sections from these fresh sources:\n\n${sourceText}` },
      ],
      maxTokens: Number(process.env.VEHICLE_LIVE_MAX_TOKENS || 5000), temperature: 0.2,
      timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
      reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
    });
    const rawLive = parseJson(text) || {};
    live = {
      priceGuide: rawLive.priceGuide || rawLive.vehicle?.priceGuide || null,
      sentiment: sanitiseSentiment(rawLive.sentiment),
      commonIssues: sanitiseCommonIssues(rawLive.commonIssues),
      watchouts: arr(rawLive.watchouts, 6).map((x) => str(x, 180)).filter(Boolean),
      similarUpdates: arr(rawLive.similarUpdates, 4),
      confidence: rawLive.confidence || null,
    };
  } catch (err) { liveError = err.message || 'Live update failed'; }

  const vehicle = { ...stable.vehicle };
  if (live.priceGuide?.starting || live.priceGuide?.note) {
    vehicle.priceGuide = { currency: str(live.priceGuide.currency, 3).toUpperCase() || vehicle.priceGuide.currency || market.currency || '', starting: num(live.priceGuide.starting), typicalTop: num(live.priceGuide.typicalTop), note: str(live.priceGuide.note, 300) || 'Live pricing from the cited sources; verify locally.' };
  }
  if (live.watchouts.length) vehicle.watchouts = live.watchouts;
  const similar = (stable.similar || []).map((s) => {
    const upd = live.similarUpdates.find((u) => `${str(u.make, 60)} ${str(u.model, 80)}`.toLowerCase() === `${s.make} ${s.model}`.toLowerCase());
    if (!upd) return s;
    return { ...s, priceGuide: { currency: str(upd.currency, 3).toUpperCase() || s.priceGuide.currency, starting: num(upd.priceFrom) }, sentimentScore: num(upd.sentimentScore) === null ? null : clamp(Math.round(num(upd.sentimentScore)), 0, 100) };
  });
  const generatedProfile = { ...(stable.generatedProfile || {}) };
  if (!generatedProfile.budget && vehicle.priceGuide?.starting) generatedProfile.budget = budgetLabel(vehicle.priceGuide.starting, vehicle.priceGuide.currency);

  return {
    query, generic: false, grounded: true, asOf: today, market,
    dataSource: `Stable vehicle facts (trims, colours, options, specs) come from the backend cache DB, stored ${new Date(entry.storedAt).toISOString().slice(0, 10)} and refreshed monthly. Pricing, sentiment and common issues below were pulled live on ${today} from ${liveSources.length} fresh source(s)${liveError ? ` — live update note: ${liveError}; variable sections may be incomplete` : ''}. Verify prices/specs locally before buying.`,
    grounding: { mode: 'stable-cache+live', provider, retrievedAt: new Date().toISOString(), sourceCount: stableSources.length + liveSources.length, warnings: liveError ? [liveError] : [] },
    sources: [...stableSources, ...liveSources.map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, publishedDate: s.publishedDate || '', queryType: s.queryType }))],
    confidence: live.confidence?.level ? { level: live.confidence.level, notes: str(live.confidence.notes, 500) } : { level: liveSources.length ? 'medium' : 'low', notes: liveError || 'Stable facts are cached; variable sections were refreshed from the cited live sources.' },
    vehicle, performance: stable.performance, trims: stable.trims, exteriorColours: stable.exteriorColours,
    interiors: stable.interiors, options: stable.options, sentiment: live.sentiment, commonIssues: live.commonIssues,
    similar, generatedProfile, profileAssumptions: stable.profileAssumptions || [],
    cache: { stableHit: true, stableStored: true, stableCachedAt: new Date(entry.storedAt).toISOString(), stableExpiresAt: new Date(entry.expiresAt).toISOString(), liveRetrievedAt: new Date().toISOString(), dbHits: (entry.hitCount || 0) + 1 },
  };
}

async function analyseVehicleGrounded(query, { callLLM, refreshStable = false, market: marketInput } = {}) {
  const market = normalizeMarket(marketInput);
  const key = `${market.code}|${query.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const run = (async () => {
    if (!refreshStable) {
      try {
        const entry = vehicleCache.findByQuery(query, market.code);
        if (entry?.fresh) { vehicleCache.recordHit(entry); return await liveVariableUpdate(entry, query, { callLLM, market }); }
        if (entry && !entry.fresh) console.log(`Vehicle stable cache expired for ${entry.make} ${entry.model} (${market.code}) — refreshing (monthly update).`);
      } catch (err) { console.warn('Vehicle cache lookup failed, doing full analysis:', err.message); }
    }
    return fullGroundedAnalysis(query, { callLLM, market });
  })();
  inFlight.set(key, run);
  try { return await run; } finally { inFlight.delete(key); }
}

// Second, focused LLM pass: if the first synthesis left key sections empty
// (trims, colours, sentiment score, rivals, price, performance), re-ask with
// only the sources relevant to the missing sections and merge what it finds.
// Still sources-only — this improves completeness, never invents data.
async function repairMissingSections(raw, { query, sources, callLLM, today, market: marketInput }) {
  const market = normalizeMarket(marketInput);
  if (!raw || typeof raw !== 'object') return raw;
  const missing = [];
  if (!arr(raw.trims).length) missing.push('trims');
  if (!arr(raw.exteriorColours).length) missing.push('exteriorColours');
  if (!arr(raw.options).length) missing.push('options');
  if (!raw.vehicle?.priceGuide?.starting) missing.push('vehicle.priceGuide');
  if (!arr(raw.performance?.metrics).length) missing.push('performance.metrics');
  if (raw.sentiment?.score === null || raw.sentiment?.score === undefined) missing.push('sentiment');
  if (!arr(raw.similar).length) missing.push('similar');
  if (!missing.length) return raw;

  const typeFor = {
    trims: ['official-trims', 'colours-options'], 'vehicle.priceGuide': ['official-trims', 'performance'],
    exteriorColours: ['colours-options', 'official-trims'], options: ['colours-options', 'official-trims'],
    'performance.metrics': ['performance', 'official-trims'],
    sentiment: ['social-sentiment', 'forum-sentiment'],
    similar: ['similar', 'performance'],
  };
  const wanted = new Set(missing.flatMap((m) => typeFor[m] || []));
  // Rank focused sources by how likely they are to carry the missing facts
  // (prices/trim tables/ratings), not by retrieval order.
  const relevance = (s) => {
    const text = `${s.title} ${s.snippet || ''}`;
    let score = s.extracted ? 1 : 0;
    if (/\$\s?\d/.test(text)) score += 3;
    if (/trim|configurator|build your|specifications/i.test(text)) score += 2;
    if (/edmunds|kbb|car and driver|us news|carbuzz|toyota\.|honda\.|ford\.|hyundaiusa|subaru\.|mazdausa/i.test(s.domain || '')) score += 2;
    if (/review|rating|owner/i.test(text)) score += 1;
    return score;
  };
  const focused = sources.filter((s) => wanted.has(s.queryType)).sort((a, b) => relevance(b) - relevance(a)).slice(0, 9);
  if (!focused.length) return raw;
  const sourceText = focused.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, 3400)}`).join('\n\n');
  try {
    const { text } = await callLLM({
      task: 'vehicle-repair',
      messages: [
        { role: 'system', content: `You are DriveMatch's grounded vehicle-research analyst. Today is ${today}. TARGET MARKET: ${market.country} (${market.currency}) — pricing must come from ${market.country} sources in ${market.currency}; never convert currencies. Using ONLY the web sources provided, fill in these missing sections for a vehicle analysis: ${missing.join(', ')}. Never invent facts; if a section still cannot be supported, leave it empty/null. For sentiment, estimate a score/distribution only if the sources contain ratings or substantive owner-review text, and note that it is an estimate from the retrieved sources. Return ONLY valid JSON with the same field names as a full vehicle analysis (vehicle, performance, trims, exteriorColours, options, sentiment, similar) — include only the sections you can support.` },
        { role: 'user', content: `Vehicle: "${query}" for ${market.country}\nMissing sections: ${missing.join(', ')}\n\nWEB SOURCES:\n${sourceText}` },
      ],
      maxTokens: Number(process.env.VEHICLE_MAX_TOKENS || 12000), temperature: 0.2,
      timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
      reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
    });
    const fix = parseJson(text);
    if (!fix) return raw;
    const merged = { ...raw };
    if (missing.includes('trims') && arr(fix.trims).length) merged.trims = fix.trims;
    if (missing.includes('exteriorColours') && arr(fix.exteriorColours).length) merged.exteriorColours = fix.exteriorColours;
    if (missing.includes('options') && arr(fix.options).length) merged.options = fix.options;
    if (missing.includes('similar') && arr(fix.similar).length) merged.similar = fix.similar;
    if (missing.includes('performance.metrics') && arr(fix.performance?.metrics).length) merged.performance = fix.performance;
    if (missing.includes('sentiment') && fix.sentiment && (fix.sentiment.score !== null && fix.sentiment.score !== undefined || arr(fix.sentiment.loves).length)) merged.sentiment = fix.sentiment;
    if (missing.includes('vehicle.priceGuide') && fix.vehicle?.priceGuide?.starting) merged.vehicle = { ...raw.vehicle, priceGuide: fix.vehicle.priceGuide };
    return merged;
  } catch { return raw; /* repair is best-effort; the honest first pass stands */ }
}

// ---------------- Profile-based vehicle suggestions ----------------
const suggestionCache = new Map(); // profileHash -> { at, value } (15 min, in-memory)
const SUGGESTION_TTL_MS = 15 * 60 * 1000;

function parseBudgetRange(text) {
  const amounts = [...String(text || '').replace(/,/g, '').matchAll(/(?:^|\D)(\d{4,7})(?:\D|$)/g)]
    .map((m) => Number(m[1])).filter((n) => n >= 3000 && n <= 500000);
  if (!amounts.length) return null;
  return { min: Math.min(...amounts), max: Math.max(...amounts) };
}
function profilePriorityMap(profile) {
  const out = {};
  const aliases = { economy: 'fuelEconomy', fuel: 'fuelEconomy', tech: 'technology', space: 'comfort', practicality: 'cargo', looks: 'style', design: 'style', power: 'performance', speed: 'performance' };
  for (const [k, v] of Object.entries(profile?.priorities || {})) out[aliases[String(k).toLowerCase()] || k] = clamp(Number(v) || 0, 0, 5);
  return out;
}
function sanitiseCandidate(c, market) {
  if (!c || typeof c !== 'object') return null;
  const make = str(c.make, 60); const model = str(c.model, 80);
  if (!make || !model) return null;
  const priorityFit = {};
  if (c.priorityFit && typeof c.priorityFit === 'object') {
    const aliases = { economy: 'fuelEconomy', fuel: 'fuelEconomy', tech: 'technology', space: 'comfort', practicality: 'cargo', looks: 'style', design: 'style', power: 'performance', speed: 'performance' };
    for (const [k, v] of Object.entries(c.priorityFit)) priorityFit[aliases[String(k).toLowerCase()] || k] = clamp(Number(v) || 0, 0, 5);
  }
  return {
    make, model, year: str(c.year, 40),
    category: str(c.category, 80), bodyStyle: str(c.bodyStyle, 60),
    fuel: str(c.fuel, 60), seating: clamp(Number(c.seating) || 5, 1, 12),
    priceGuide: {
      currency: str(c.priceGuide?.currency, 3).toUpperCase() || market.currency || '',
      starting: num(c.priceGuide?.starting), typicalTop: num(c.priceGuide?.typicalTop),
      note: str(c.priceGuide?.note, 260),
    },
    strengths: arr(c.strengths, 5).map((x) => str(x, 160)).filter(Boolean),
    tradeoffs: arr(c.tradeoffs, 4).map((x) => str(x, 160)).filter(Boolean),
    features: arr(c.features, 8).map((x) => str(x, 100)).filter(Boolean),
    priorityFit,
    llmSuitability: num(c.suitabilityScore) === null ? null : clamp(Math.round(num(c.suitabilityScore)), 0, 100),
  };
}
function scoreCandidate(candidate, profile) {
  const reasons = [];
  let score = (candidate.llmSuitability ?? 55) * 0.35;
  const bodies = (profile.bodyStyles || []).map((x) => String(x).toLowerCase());
  const candBody = candidate.bodyStyle.toLowerCase();
  if (bodies.some((b) => candBody && (b.includes(candBody) || candBody.includes(b)))) { score += 15; reasons.push(`matches your preferred ${candidate.bodyStyle} body style`); }
  const profileFuel = String(profile.fuel || '').toLowerCase();
  const candFuel = candidate.fuel.toLowerCase();
  if (profileFuel && candFuel && (candFuel.includes(profileFuel.split(' ')[0]) || profileFuel.includes(candFuel.split(' ')[0]))) { score += 12; reasons.push(`fits your ${candidate.fuel} preference`); }
  if (profile.primaryUse && `${candidate.category} ${candidate.strengths.join(' ')}`.toLowerCase().includes(String(profile.primaryUse).toLowerCase().split(' ')[0])) { score += 8; reasons.push(`suits your main use (${profile.primaryUse.toLowerCase()})`); }
  const budget = parseBudgetRange(profile.budget);
  const price = candidate.priceGuide.starting;
  if (budget && price) {
    if (price >= budget.min * 0.7 && price <= budget.max) { score += 15; reasons.push(`starting price sits inside your budget (${profile.budget})`); }
    else if (price <= budget.max * 1.1) { score += 7; reasons.push('starting price is close to your budget — watch trim creep'); }
    else if (price > budget.max * 1.25) { score -= 15; }
    else { score += 5; reasons.push('starting price comes in under your budget'); }
  }
  const wantedFeatures = (profile.features || []).map((x) => String(x).toLowerCase());
  const covered = candidate.features.filter((f) => wantedFeatures.some((w) => f.toLowerCase().includes(w) || w.includes(f.toLowerCase())));
  if (covered.length) { score += Math.min(10, covered.length * 3); reasons.push(`offers your must-haves: ${covered.slice(0, 3).join(', ')}`); }
  const priorities = profilePriorityMap(profile);
  const weighted = Object.entries(priorities).filter(([, v]) => v > 0);
  if (weighted.length && Object.keys(candidate.priorityFit).length) {
    const avg = weighted.reduce((acc, [k, v]) => acc + (candidate.priorityFit[k] || 3) * v, 0) / weighted.reduce((acc, [, v]) => acc + v, 0);
    score += (avg / 5) * 12;
    const top = weighted.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    reasons.push(`scores well on what you ranked highest (${top.join(' and ')})`);
  }
  if (profile.interestedVehicle && `${candidate.make} ${candidate.model}`.toLowerCase() === String(profile.interestedVehicle).toLowerCase()) { score += 8; reasons.push('this is the vehicle you told Maya you are already eyeing'); }
  if (!reasons.length && candidate.strengths.length) reasons.push(candidate.strengths[0].toLowerCase());
  const matchScore = clamp(Math.round(score), 5, 98);
  const tradeoffText = candidate.tradeoffs.length ? ` Trade-off to weigh: ${candidate.tradeoffs[0]}` : '';
  return {
    ...candidate, matchScore, reasons: [...new Set(reasons)].slice(0, 4),
    whySummary: `Chosen because it ${reasons.slice(0, 3).join(', ') || 'aligns with your profile'}.${tradeoffText}`,
  };
}

async function suggestVehiclesForProfile({ profile = {}, guidelines = [], market: marketInput, callLLM } = {}) {
  const market = normalizeMarket(marketInput);
  const guidelinesText = JSON.stringify(guidelines || []).slice(0, 4000);
  const cacheKey = JSON.stringify({ p: profile, g: guidelinesText, m: market.code, c: market.currency });
  const hit = suggestionCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SUGGESTION_TTL_MS) return { ...hit.value, cached: true };

  const today = new Date().toISOString().slice(0, 10);
  const bodies = (profile.bodyStyles || []).join(' / ') || 'vehicles';
  const priorities = Object.entries(profilePriorityMap(profile)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ');
  const place = market.country || 'the user\'s market';
  const searches = [
    { type: 'best-matches', query: `best ${bodies} ${profile.fuel || ''} vehicles ${place} ${profile.budget || ''} for ${profile.primaryUse || 'everyday driving'} top picks` },
    { type: 'comparisons', query: `best ${bodies} comparison ${priorities || 'safety reliability'} top rated vehicles ${place}` },
    { type: 'market-pricing', query: `${bodies} prices ${market.currency || ''} ${place} best value ${profile.condition || ''} vehicles` },
    { type: 'use-case', query: `best vehicle for ${profile.primaryUse || 'family'} ${profile.passengers ? `${profile.passengers} passengers` : ''} ${(profile.cargo || []).join(' ')} ${place}` },
  ];
  const { provider, sources, warnings } = await runSearches(searches);
  if (!sources.length) throw Object.assign(new Error(`Vehicle suggestions could not retrieve any sources (${(warnings || []).join('; ') || 'no search provider available'}).`), { status: 503 });
  const sourceText = sources.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, 2000)}`).join('\n\n');
  const { text } = await callLLM({
    task: 'vehicle-suggestions',
    messages: [
      { role: 'system', content: `You are DriveMatch's grounded vehicle-matching analyst. Today is ${today}. Using ONLY the web sources provided, propose up to 6 real candidate vehicles that fit the driver's profile for ${place}${market.currency ? `, priced in ${market.currency} from ${place} sources (never convert currencies)` : ''}. Every candidate must be a specific make/model supported by the sources. Never invent prices or features. Return ONLY valid JSON: {"candidates":[{"make":"","model":"","year":"","category":"","bodyStyle":"","fuel":"","seating":5,"priceGuide":{"currency":"${market.currency || ''}","starting":null,"typicalTop":null,"note":""},"strengths":[],"tradeoffs":[],"features":[],"priorityFit":{"safety":0,"reliability":0,"fuelEconomy":0,"performance":0,"comfort":0,"technology":0,"cargo":0,"style":0},"suitabilityScore":0}]}` },
      { role: 'user', content: `DRIVER PROFILE (JSON): ${JSON.stringify(profile)}\n\nUSER'S CONFIRMED VEHICLE-SELECTION GUIDELINES (treat as their criteria; the profile above is the structured summary of the same): ${guidelinesText || '(none provided)'}\n\nWEB SOURCES:\n${sourceText}` },
    ],
    maxTokens: Number(process.env.VEHICLE_SUGGESTION_MAX_TOKENS || 6000), temperature: 0.2,
    timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
    reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
  });
  const parsed = parseJson(text);
  const rawCandidates = arr(parsed?.candidates, 6).map((c) => sanitiseCandidate(c, market)).filter(Boolean);
  const deduped = [...new Map(rawCandidates.map((c) => [`${c.make} ${c.model}`.toLowerCase(), c])).values()];
  const ranked = deduped.map((c) => scoreCandidate(c, profile)).sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);
  if (!ranked.length) throw Object.assign(new Error('The grounded sources did not support any confident vehicle suggestions for this profile yet.'), { status: 502 });
  const value = {
    asOf: today, market, profileUsed: profile,
    dataSource: `Search-grounded suggestions generated ${today} from ${sources.length} web source(s) via ${provider}, ranked against your profile (body style, fuel, budget, must-haves and priorities scored on the server). Prices are indicative — open a vehicle for a full grounded analysis before relying on them.`,
    sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, publishedDate: s.publishedDate || '', queryType: s.queryType })),
    candidates: ranked,
  };
  suggestionCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ---------------- Nearby dealers & offers ----------------
async function findDealerOffers({ vehicle, location, market: marketInput, callLLM } = {}) {
  const market = normalizeMarket(marketInput);
  const vehicleName = str(typeof vehicle === 'string' ? vehicle : `${vehicle?.make || ''} ${vehicle?.model || ''}`, 120).trim();
  const place = str(location, 120).trim();
  if (!vehicleName) throw Object.assign(new Error('vehicle is required'), { status: 400 });
  if (!place) throw Object.assign(new Error('location is required to find nearby dealers'), { status: 400 });
  const today = new Date().toISOString().slice(0, 10);
  const make = vehicleName.split(/\s+/)[0];
  const searches = [
    { type: 'dealer-offers', query: `${vehicleName} dealer near ${place} offers incentives special offers price` },
    { type: 'dealer-inventory', query: `${make} dealership ${place} new ${vehicleName} inventory deals` },
    { type: 'manufacturer-incentives', query: `${vehicleName} current incentives rebates finance offers ${market.country || ''} ${today.slice(0, 7)}` },
    { type: 'dealer-reviews', query: `best ${make} dealers near ${place} reviews pricing negotiation` },
  ];
  const { provider, sources, warnings } = await runSearches(searches);
  if (!sources.length) throw Object.assign(new Error(`Dealer search could not retrieve any sources (${(warnings || []).join('; ') || 'no search provider available'}).`), { status: 503 });
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  const sourceText = sources.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, 2200)}`).join('\n\n');
  const { text } = await callLLM({
    task: 'dealer-research',
    messages: [
      { role: 'system', content: `You are DriveMatch's grounded dealer-research analyst. Today is ${today}. Using ONLY the web sources provided, extract dealers near the user's location that sell the vehicle, any publicly advertised offers, and an evidence-based estimate of pricing flexibility. Rules: only include dealers/offers actually named in the sources, each with its sourceId; never invent dealer names, distances, prices, discounts or stock — distanceText only if a source states it; an offer only if a source states its terms. Pricing flexibility must be judged ONLY from public signals in the sources (advertised discounts below list price, manufacturer rebates/incentives, clearance/model-year offers, low-rate finance combined with cash offers, multiple competing offers) and labelled an estimate, never a guarantee. Return ONLY valid JSON: {"dealers":[{"name":"","brand":"","area":"","distanceText":"","offerTitle":"","offerDetails":"","priceText":"","sourceId":"S1"}],"flexibility":{"level":"high|medium|low|unknown","rationale":"","signals":[],"confidence":"high|medium|low"},"negotiationTips":[]}` },
      { role: 'user', content: `Vehicle: ${vehicleName}\nNear: ${place}${market.country ? ` (${market.country})` : ''}\n\nWEB SOURCES:\n${sourceText}` },
    ],
    maxTokens: Number(process.env.DEALER_MAX_TOKENS || 5000), temperature: 0.2,
    timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
    reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
  });
  const parsed = parseJson(text) || {};
  const dealers = arr(parsed.dealers, 6).map((d) => {
    const source = byId[str(d.sourceId, 10)];
    if (!source || !str(d.name, 120)) return null;
    return {
      name: str(d.name, 120), brand: str(d.brand, 60), area: str(d.area, 100), distanceText: str(d.distanceText, 60),
      offerTitle: str(d.offerTitle, 140), offerDetails: str(d.offerDetails, 320), priceText: str(d.priceText, 120),
      sourceId: source.id, sourceTitle: source.title, url: source.url, domain: source.domain,
    };
  }).filter(Boolean);
  const flexRaw = parsed.flexibility || {};
  const flexibility = {
    level: ['high', 'medium', 'low'].includes(String(flexRaw.level || '').toLowerCase()) ? String(flexRaw.level).toLowerCase() : 'unknown',
    rationale: str(flexRaw.rationale, 400) || 'The retrieved public sources did not show enough pricing signals to judge flexibility.',
    signals: arr(flexRaw.signals, 6).map((x) => str(x, 160)).filter(Boolean),
    confidence: ['high', 'medium', 'low'].includes(String(flexRaw.confidence || '').toLowerCase()) ? String(flexRaw.confidence).toLowerCase() : 'low',
    disclaimer: 'Estimate from publicly advertised offers/incentives found today — not inside knowledge of any dealer. Actual flexibility depends on stock, timing and the specific car; always get competing out-the-door quotes.',
  };
  return {
    vehicle: vehicleName, location: place, market, asOf: today,
    dataSource: `Public web offers/dealer pages retrieved ${today} via ${provider} (${sources.length} source(s)). This is not a live inventory feed — dealers, stock and offers change; verify everything with the dealer.`,
    dealers, flexibility,
    negotiationTips: arr(parsed.negotiationTips, 4).map((x) => str(x, 200)).filter(Boolean),
    sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, publishedDate: s.publishedDate || '', queryType: s.queryType })),
  };
}

function parseJson(content) {
  try {
    const cleaned = String(content || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return null; }
}

module.exports = { analyseVehicleGrounded, retrieveSources, buildSearchQueries, buildStableEntry, sanitiseCommonIssues, sanitiseSentiment, normalizeMarket, suggestVehiclesForProfile, findDealerOffers, scoreCandidate, parseBudgetRange };
