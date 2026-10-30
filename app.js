// DriveMatch v0.3 — Agentic chat via the DriveMatch backend (server.js)
// The browser NEVER sees the LLM token: it only calls POST /api/agent on
// our own server, which holds the Muse API key in its .env file.
// If the backend is unreachable or has no key configured, the built-in
// local agent below runs the same conversation on-device.
const AGENT_NAME = 'Maya';
const STORAGE_KEY = 'drivematch_agent_v2';
const backend = { checked: false, live: false, providerModel: 'meta/muse-wonder-1.0', agentName: AGENT_NAME };
// Country/currency are inferred from the conversation, not assumed.
// This is a starter map for common markets; any other ISO country code
// still works (region name via Intl, currency chosen in the calculator).
const COUNTRY_INFO = {
  US: { country: 'United States', currency: 'USD', postalLabel: 'ZIP code' },
  CA: { country: 'Canada', currency: 'CAD', postalLabel: 'postal code' },
  GB: { country: 'United Kingdom', currency: 'GBP', postalLabel: 'postcode' },
  AU: { country: 'Australia', currency: 'AUD', postalLabel: 'postcode' },
  NZ: { country: 'New Zealand', currency: 'NZD', postalLabel: 'postcode' },
  ZA: { country: 'South Africa', currency: 'ZAR', postalLabel: 'postal code' },
  DE: { country: 'Germany', currency: 'EUR', postalLabel: 'postal code' },
  FR: { country: 'France', currency: 'EUR', postalLabel: 'postal code' },
  ES: { country: 'Spain', currency: 'EUR', postalLabel: 'postal code' },
  IT: { country: 'Italy', currency: 'EUR', postalLabel: 'postal code' },
  NL: { country: 'Netherlands', currency: 'EUR', postalLabel: 'postcode' },
  IE: { country: 'Ireland', currency: 'EUR', postalLabel: 'Eircode' },
  CH: { country: 'Switzerland', currency: 'CHF', postalLabel: 'postal code' },
  JP: { country: 'Japan', currency: 'JPY', postalLabel: 'postal code' },
  IN: { country: 'India', currency: 'INR', postalLabel: 'PIN code' },
  AE: { country: 'United Arab Emirates', currency: 'AED', postalLabel: 'postal code' },
  SG: { country: 'Singapore', currency: 'SGD', postalLabel: 'postal code' },
  BR: { country: 'Brazil', currency: 'BRL', postalLabel: 'CEP' },
  MX: { country: 'Mexico', currency: 'MXN', postalLabel: 'postal code' },
  KR: { country: 'South Korea', currency: 'KRW', postalLabel: 'postal code' },
  SE: { country: 'Sweden', currency: 'SEK', postalLabel: 'postal code' },
  NO: { country: 'Norway', currency: 'NOK', postalLabel: 'postal code' },
  DK: { country: 'Denmark', currency: 'DKK', postalLabel: 'postal code' },
  PL: { country: 'Poland', currency: 'PLN', postalLabel: 'postal code' },
};
function localeCountryCode() {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const region = locale.split('-').pop();
    return /^[A-Z]{2}$/.test(region) && COUNTRY_INFO[region] ? region : '';
  } catch { return ''; }
}
let selectedMarketCode = localeCountryCode();
let selectedCurrency = selectedMarketCode ? COUNTRY_INFO[selectedMarketCode].currency : '';
let marketSource = selectedMarketCode ? 'locale' : 'default'; // locale | default | chat | manual
let awaitingMarketClarification = false;
const marketCacheInfo = {}; // code -> stats from /api/vehicle-cache/ensure
function countryNameFor(code) {
  if (!code) return 'your country';
  if (COUNTRY_INFO[code]?.country) return COUNTRY_INFO[code].country;
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; }
}
function currentMarket() {
  const code = selectedMarketCode || '';
  const info = COUNTRY_INFO[code] || {};
  return {
    code,
    country: code ? countryNameFor(code) : 'your country',
    currency: selectedCurrency || info.currency || 'USD',
    postalLabel: info.postalLabel || 'postal code',
  };
}
function currentCurrency() { return currentMarket().currency; }

const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function llmIsConfigured() { return backend.live; }
function agentModeLabel() {
  if (!backend.checked) return 'Checking backend…';
  if (backend.live) return backend.models?.routing ? `Muse ${backend.models.routing === 'balanced' ? 'Wonder + Spark' : backend.models.routing} · Live (via backend)` : 'Muse · Live (via backend)';
  return 'Local agent · Backend has no LLM key';
}
async function checkBackend() {
  try {
    const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    backend.live = data.mode === 'live';
    backend.providerModel = data.providerModel || backend.providerModel;
    backend.models = data.models || null;
    backend.agentName = data.agentName || AGENT_NAME;
  } catch { backend.live = false; /* opened via file:// or server down -> local agent */ }
  backend.checked = true;
  updateModePills();
}

// ---------------- Profile ----------------
const PRIORITY_DEFS = [
  { key: 'safety', label: 'Safety', words: ['safety', 'safe', 'crash'] },
  { key: 'reliability', label: 'Reliability', words: ['reliab', 'dependab', 'few repairs', 'lasts'] },
  { key: 'fuelEconomy', label: 'Fuel / energy economy', words: ['fuel economy', 'mpg', 'economy', 'running cost', 'cheap to run', 'efficient'] },
  { key: 'performance', label: 'Performance', words: ['performance', 'fast', 'power', 'fun to drive', 'sporty'] },
  { key: 'comfort', label: 'Comfort & space', words: ['comfort', 'spacious', 'space', 'roomy', 'quiet'] },
  { key: 'technology', label: 'Technology', words: ['tech', 'technology', 'screens', 'gadgets'] },
  { key: 'cargo', label: 'Cargo & practicality', words: ['cargo', 'boot', 'trunk', 'practical', 'storage'] },
  { key: 'style', label: 'Style & image', words: ['style', 'looks', 'design', 'image', 'brand'] },
];
function emptyProfile() {
  return {
    firstName: '', location: '', household: '', experience: '',
    primaryUse: '', dailyMiles: null, passengers: '', cargo: [], terrain: [],
    bodyStyles: [], fuel: '', condition: '', features: [],
    budget: '', monthly: '', payment: '', keepYears: '', tradeIn: '', timeline: '',
    priorities: {}, prioritiesMentioned: [], notes: '',
    interestedVehicle: '', sourceVehicle: '',
    country: '', countryCode: '', postalCode: '',
  };
}
let profile = emptyProfile();
let conversation = []; // {role:'agent'|'user'|'system', content, ts}
let topicIndex = 0;
let isComplete = false;
let guidelines = [];
let started = false;
let busy = false;
let customQuickReplies = null;
let currentVehicleAnalysis = null;
let pendingVehicleQuery = false;
let currentSuggestions = null;
let dealerResults = {}; // "Make Model" -> dealer-offers response
let pendingDealerVehicle = '';
let profileConfirmed = false;
let awaitingConfirmation = false;

const TOPICS = [
  {
    id: 'intro', label: 'About you',
    prompt: () => `Hey there! I'm ${AGENT_NAME}, your DriveMatch agent 👋\n\nI won't make you fill in a form — we'll just chat, and I'll build your driver profile as we go. It takes about 3 minutes, and at the end I'll turn what I learn into guidelines for picking your vehicle.\n\nAlready eyeing something? Just say "Analyse a Toyota RAV4" (or tap 🔎 Analyse a vehicle) and I'll get its sentiment, trims, colours, options, financing and similar models — and I can draft your profile from it.\n\nFirst up: what's your first name, and where do you live? A city plus your postal code — or just your country — is fine: I'll set your market and local currency from what you tell me.`,
    quick: [],
  },
  {
    id: 'household', label: 'Household & experience',
    prompt: () => `Who are we buying for — just you, you and a partner, a family? And how would you describe your driving experience — first-time buyer, or have you owned cars before?`,
    quick: ['Just me', 'Me and my partner', 'Family with kids', "I'm a first-time buyer"],
  },
  {
    id: 'use', label: 'Main use',
    prompt: () => `What's this vehicle mainly for? Daily commuting, family transport, work, adventures, city driving, road trips… — or a mix? Tell me in your own words.`,
    quick: ['Daily commute', 'Family transport', 'Work / business', 'Adventure & outdoors', 'City runabout', 'Long road trips'],
  },
  {
    id: 'daily', label: 'Daily driving',
    prompt: () => `Walk me through a typical day of driving: roughly how many miles, how many passengers at most, what you regularly carry (kids, pets, gear, tools…), and what the roads are like — city, highway, snow, hills, off-road?`,
    quick: ['About 25 miles a day, mostly highway', 'Short city trips, just me', 'Kids and a dog, mostly suburbs', 'Snowy winters where I live'],
  },
  {
    id: 'prefs', label: 'Vehicle style',
    prompt: () => `What kind of vehicle are you picturing? A body style (sedan, SUV, truck, hatchback, minivan…), fuel type (petrol, hybrid, electric…), new or used — and any must-have features like CarPlay, heated seats, AWD, or towing? Not sure is a perfectly good answer too.`,
    quick: ['SUV — hybrid or electric', 'Sedan is fine, keep it efficient', 'Truck, I need to tow', 'Not sure yet — guide me'],
  },
  {
    id: 'budget', label: 'Budget & ownership',
    prompt: () => `Let's talk money, roughly: what's your overall budget (or a monthly payment you’re comfortable with)? Cash, finance, or lease? How long would you keep it, any trade-in, and when are you hoping to buy? Rough numbers are fine.`,
    quick: ['Around $30k, financing it', 'Under $20k, paying cash', 'About $400/month max', 'Not sure on budget yet'],
  },
  {
    id: 'priorities', label: 'Priorities',
    prompt: () => `Last one — what matters most to you in a vehicle? For example: safety, reliability, fuel economy, performance, comfort, technology, cargo space, or style. Name your top few, and mention anything you really don't care about. Anything else I should know?`,
    quick: ['Safety and reliability first', 'Fuel economy matters most', 'Comfort and tech for me', "Performance — I actually enjoy driving"],
  },
];

// The agent system prompt now lives server-side in server.js (AGENT_SYSTEM_PROMPT).

// ---------------- Init ----------------
function populateFinanceCurrencies() {
  const select = $('#finCurrency'); if (!select) return;
  const codes = [...new Set([...CURRENCIES, selectedCurrency].filter(Boolean))];
  select.innerHTML = codes.map((code) => {
    let name = code;
    try { name = `${code} — ${new Intl.DisplayNames(['en'], { type: 'currency' }).of(code)}`; } catch { /* keep code */ }
    return `<option value="${code}">${escapeHtml(name)}</option>`;
  }).join('');
  if (selectedCurrency) select.value = selectedCurrency;
}

document.addEventListener('DOMContentLoaded', () => {
  $('#agentName').textContent = AGENT_NAME;
  populateFinanceCurrencies();
  populateMarketSelect();
  updateModePills();
  checkBackend();
  loadSaved();
  setMarket(profile.countryCode || selectedMarketCode, { updateFinance: false });
  renderTopicProgress();
  renderProfilePanel();

  $$('[data-start]').forEach((btn) => btn.addEventListener('click', (e) => {
    applySeed(btn.dataset.prefill, btn.dataset.prefillFuel);
    startAgent(e);
  }));
  $('#resumeBtn').addEventListener('click', (e) => startAgent(e, true));
  $('#hamburger').addEventListener('click', () => {
    const nav = $('.nav-links'); const open = nav.classList.toggle('open');
    $('#hamburger').setAttribute('aria-expanded', open);
  });
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); submitInput(); });
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInput(); }
  });
  $('#chatInput').addEventListener('input', autoGrow);
  $('#marketSelect').addEventListener('change', (e) => setMarket(e.target.value, { announce: true, source: 'manual' }));
  $('#restartChatBtn').addEventListener('click', confirmRestart);
  $('#restartBtn2').addEventListener('click', confirmRestart);
  $('#analyseVehicleBtn').addEventListener('click', () => {
    if (!started) startAgent();
    pendingVehicleQuery = true;
    addMessage('agent', 'Which make and model should I analyse? For example: Toyota RAV4, Tesla Model Y, Ford F-150, Honda Civic — or any make/model you have in mind.');
    $('#chatInput')?.focus();
  });
  $('#financeToolBtn').addEventListener('click', () => {
    $('#financeBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (currentVehicleAnalysis) addMessage('agent', financeSnapshotText());
  });
  $('#vehicleProfileToolBtn').addEventListener('click', () => { if (currentVehicleAnalysis) applyVehicleProfile(); });
  $('#vehicleContent').addEventListener('click', (e) => {
    const analyseBtn = e.target.closest('[data-sim-analyse]');
    const useBtn = e.target.closest('[data-sim-use]');
    if (analyseBtn) { addMessage('user', `Analyse a ${analyseBtn.dataset.simAnalyse}`); runVehicleAnalysis(analyseBtn.dataset.simAnalyse); }
    if (useBtn) { addMessage('user', `Analyse a ${useBtn.dataset.simUse}`); runVehicleAnalysis(useBtn.dataset.simUse).then((result) => { if (result) applyVehicleProfile(); }); }
  });
  ['finCurrency', 'finPrice', 'finDeposit', 'finTradeIn', 'finFees', 'finTerm', 'finApr'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', renderFinanceResults);
  });
  $('#suggestBtn').addEventListener('click', () => { if (!started) startAgent(); runVehicleSuggestions(); });
  $('#suggestionsContent').addEventListener('click', (e) => {
    const analyseBtn = e.target.closest('[data-suggest-analyse]');
    const dealerBtn = e.target.closest('[data-suggest-dealers]');
    if (analyseBtn) { addMessage('user', `Analyse a ${analyseBtn.dataset.suggestAnalyse}`); runVehicleAnalysis(analyseBtn.dataset.suggestAnalyse); }
    if (dealerBtn) runDealerOffers(dealerBtn.dataset.suggestDealers);
  });
  $('#downloadBtn').addEventListener('click', downloadProfile);
  $('#pdfBtn').addEventListener('click', () => { downloadGuidelinesPdf(); showToast('Choose "Save as PDF" in the print dialog to save your guidelines.'); });
  $$('[data-upload-guidelines]').forEach((btn) => btn.addEventListener('click', () => $('#guidelinesUpload').click()));
  $('#guidelinesUpload').addEventListener('change', (e) => handleGuidelinesUpload(e.target.files?.[0]));
  $('#guidelinesBtn').addEventListener('click', () => {
    guidelines = buildGuidelines(profile);
    renderProfilePanel();
    addMessage('agent', "I've generated your vehicle-selection guidelines from everything so far — they're in the panel beside this chat. Tell me if anything looks off and I'll adjust them.");
    save();
  });
});

function populateMarketSelect() {
  const select = $('#marketSelect'); if (!select) return;
  const current = select.value || selectedMarketCode;
  select.innerHTML = '<option value="">Auto-detect from chat</option>' + Object.entries(COUNTRY_INFO)
    .map(([code, info]) => '<option value="' + code + '">' + info.country + '</option>').join('');
  if (selectedMarketCode && !COUNTRY_INFO[selectedMarketCode]) {
    const opt = document.createElement('option'); opt.value = selectedMarketCode; opt.textContent = countryNameFor(selectedMarketCode); select.appendChild(opt);
  }
  select.value = current && (current === '' || COUNTRY_INFO[current] || current === selectedMarketCode) ? selectedMarketCode : '';
}

function setMarket(code, { announce = false, updateFinance = true, source, currency } = {}) {
  const previousCode = selectedMarketCode;
  selectedMarketCode = code ? String(code).toUpperCase() : '';
  if (source) marketSource = source;
  if (currency) selectedCurrency = currency;
  else if (selectedMarketCode && COUNTRY_INFO[selectedMarketCode]) selectedCurrency = COUNTRY_INFO[selectedMarketCode].currency;
  const market = currentMarket();
  profile.country = selectedMarketCode ? market.country : '';
  profile.countryCode = selectedMarketCode;
  // A postal code from a different country is stale after a switch.
  if (previousCode && previousCode !== selectedMarketCode) profile.postalCode = '';
  populateMarketSelect();
  renderMarketHint();
  const finCurrency = $('#finCurrency');
  if (finCurrency && updateFinance && market.currency) { finCurrency.value = market.currency; renderFinanceResults(); }
  if (selectedMarketCode) ensureMarketCache(selectedMarketCode);
  if (announce && started && selectedMarketCode) {
    addMessage('agent', 'Switched to ' + market.country + ' — I’ll use your local ' + market.postalLabel + ' and price vehicles in your local currency, with ' + market.country + ' trims and pricing. If I already analysed a vehicle, ask me to analyse it again so I pull the ' + market.country + ' version.');
  }
  save();
}
function renderMarketHint() {
  const hint = $('#marketHint'); if (!hint) return;
  const market = currentMarket();
  const sourceText = marketSource === 'chat' ? 'Auto-detected from your chat' : marketSource === 'manual' ? 'Set manually' : marketSource === 'locale' ? 'Suggested by your device locale — not confirmed yet' : 'Not confirmed yet — Maya will detect it from your chat';
  const cache = market.code ? marketCacheInfo[market.code] : null;
  const cacheText = cache ? ' · Cache: ' + cache.dbFile + ' (' + cache.entries + ' vehicle' + (cache.entries === 1 ? '' : 's') + ' cached)' : '';
  hint.textContent = market.code
    ? sourceText + ': ' + market.country + ' — local ' + market.postalLabel + ', vehicles priced in your local currency' + cacheText + '. You can override this anytime.'
    : sourceText + '. Tell Maya your country, city or postal code and she will set your market and local currency automatically.';
}
async function ensureMarketCache(code) {
  try {
    const res = await fetch('/api/vehicle-cache/ensure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market: code }) });
    if (!res.ok) return;
    marketCacheInfo[code] = await res.json();
    if (selectedMarketCode === code) renderMarketHint();
  } catch { /* backend offline / file:// — market still works locally */ }
}

const COUNTRY_SIGNALS = [
  { code: 'CA', names: ['canada', 'canadian'], places: ['ontario', 'quebec', 'québec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick', 'newfoundland', 'prince edward island', 'toronto', 'vancouver', 'montreal', 'montréal', 'calgary', 'ottawa', 'edmonton', 'winnipeg', 'halifax'] },
  { code: 'US', names: ['united states', 'usa', 'america', 'american'], places: ['california', 'texas', 'florida', 'illinois', 'arizona', 'colorado', 'oregon', 'nevada', 'georgia', 'ohio', 'pennsylvania', 'michigan', 'new york city', 'los angeles', 'chicago', 'houston', 'phoenix', 'san diego', 'san francisco', 'seattle', 'denver', 'austin', 'dallas', 'miami'] },
  { code: 'GB', names: ['united kingdom', 'britain', 'british', 'england', 'scotland', 'wales'], places: ['london', 'manchester', 'birmingham', 'glasgow', 'edinburgh', 'liverpool', 'leeds', 'bristol', 'sheffield'] },
  { code: 'AU', names: ['australia', 'australian'], places: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin'] },
  { code: 'NZ', names: ['new zealand'], places: ['auckland', 'wellington', 'christchurch', 'hamilton', 'dunedin'] },
  { code: 'ZA', names: ['south africa', 'south african'], places: ['johannesburg', 'cape town', 'durban', 'pretoria', 'sandton', 'gqeberha', 'bloemfontein'] },
  { code: 'DE', names: ['germany', 'german', 'deutschland'], places: ['berlin', 'munich', 'hamburg', 'cologne', 'frankfurt', 'stuttgart', 'düsseldorf'] },
  { code: 'FR', names: ['france', 'french'], places: ['paris', 'lyon', 'marseille', 'toulouse', 'bordeaux', 'nantes'] },
  { code: 'IN', names: ['india', 'indian'], places: ['mumbai', 'delhi', 'bengaluru', 'bangalore', 'chennai', 'hyderabad', 'pune', 'kolkata', 'ahmedabad'] },
  { code: 'JP', names: ['japan', 'japanese'], places: ['tokyo', 'osaka', 'kyoto', 'nagoya', 'fukuoka', 'sapporo'] },
  { code: 'AE', names: ['united arab emirates', 'uae', 'emirates'], places: ['dubai', 'abu dhabi', 'sharjah'] },
  { code: 'SG', names: ['singapore'], places: ['singapore'] },
  { code: 'BR', names: ['brazil', 'brasil', 'brazilian'], places: ['são paulo', 'rio de janeiro', 'brasília', 'belo horizonte'] },
  { code: 'MX', names: ['mexico', 'mexican'], places: ['mexico city', 'guadalajara', 'monterrey', 'puebla'] },
];
const CURRENCY_COUNTRY = { USD: 'US', CAD: 'CA', GBP: 'GB', AUD: 'AU', NZD: 'NZ', ZAR: 'ZA', JPY: 'JP', INR: 'IN', AED: 'AE', SGD: 'SG', BRL: 'BR', MXN: 'MX', KRW: 'KR', CHF: 'CH', SEK: 'SE', NOK: 'NO', DKK: 'DK', PLN: 'PL' };

// Infer the user's market from what they actually say: country/place
// names, postal-code formats, and currencies. Returns
// { changed, code, reasons, currencyChanged } — only switches country on
// confident residence-style signals, and never overrides a manual
// selection on weak/incidental mentions.
function detectMarketFromText(text) {
  const raw = String(text || '');
  const lower = ' ' + raw.toLowerCase() + ' ';
  const scores = new Map(); const reasons = [];
  const add = (code, points, reason) => { if (!code) return; scores.set(code, (scores.get(code) || 0) + points); if (reason && !reasons.includes(reason)) reasons.push(reason); };
  const residenceContext = /\b(live|living|from|based|located|my (?:address|postal|zip|postcode)|i'?m in|moved to)\b/i.test(raw) || TOPICS[topicIndex]?.id === 'intro';

  if (/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/.test(raw)) add('CA', 6, 'Canadian postal code');
  if (/\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/.test(raw) && !/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/.test(raw)) add('GB', 5, 'UK postcode');
  if (/\bpostal code\b/i.test(raw)) reasons.push('postal code mentioned');
  for (const sig of COUNTRY_SIGNALS) {
    if (sig.names.some((n) => lower.includes(' ' + n + ' ') || lower.includes(' ' + n + ','))) add(sig.code, 5, countryNameFor(sig.code));
    else if (sig.places.some((p) => lower.includes(p))) add(sig.code, 3, countryNameFor(sig.code));
  }
  if (/\b\d{5}(?:-\d{4})?\b/.test(raw) && (residenceContext || /\bzip\b/i.test(raw))) add('US', 5, 'ZIP code');

  let currencyChanged = false;
  const currencyMention = raw.match(/\b(USD|CAD|GBP|EUR|ZAR|AUD|NZD|JPY|CHF|INR|AED|SGD|BRL|MXN|KRW|SEK|NOK|DKK|PLN)\b/i);
  if (currencyMention) {
    const cur = currencyMention[1].toUpperCase();
    if (cur !== selectedCurrency) { selectedCurrency = cur; currencyChanged = true; const fc = $('#finCurrency'); if (fc) { fc.value = cur; renderFinanceResults(); } }
    if (CURRENCY_COUNTRY[cur]) add(CURRENCY_COUNTRY[cur], 4, 'local currency');
  }
  if (/£/.test(raw)) { add('GB', 3, 'pounds sterling'); if (selectedCurrency !== 'GBP') { selectedCurrency = 'GBP'; currencyChanged = true; } }
  if (/₹|\brupees?\b/i.test(raw)) { add('IN', 3, 'rupees'); if (selectedCurrency !== 'INR') { selectedCurrency = 'INR'; currencyChanged = true; } }
  if (/\brand\b/i.test(raw)) { add('ZA', 2, 'rand'); if (selectedCurrency !== 'ZAR') { selectedCurrency = 'ZAR'; currencyChanged = true; } }
  if (residenceContext && scores.size) { const top = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]; if (top) scores.set(top[0], top[1] + 1); }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, winnerScore] = ranked[0] || [null, 0];
  const runnerUp = ranked[1]?.[1] || 0;
  const explicit = ranked.length && (winnerScore >= 5 || (residenceContext && winnerScore >= 4));
  if (!winner || winnerScore < 3 || winnerScore - runnerUp < 2) return { changed: false, code: selectedMarketCode, reasons, currencyChanged };
  if (winner === selectedMarketCode) {
    if (marketSource === 'default' || marketSource === 'locale') marketSource = 'chat';
    return { changed: false, code: winner, reasons, currencyChanged };
  }
  if (marketSource === 'manual' && !explicit) return { changed: false, code: selectedMarketCode, reasons, currencyChanged };
  setMarket(winner, { source: 'chat' });
  return { changed: true, code: winner, reasons, currencyChanged };
}

function updateModePills() {
  const label = agentModeLabel();
  const live = llmIsConfigured();
  [['#agentModePill'], ['#navModePill']].forEach(([sel]) => {
    const el = $(sel); if (!el) return;
    el.textContent = label; el.classList.toggle('live', live); el.classList.toggle('local', !live);
  });
  $('#agentHint').innerHTML = live
    ? `Connected via the DriveMatch backend to <strong>Muse</strong> (${escapeHtml(backend.models?.profiles?.map((p) => p.label).join(' + ') || backend.providerModel)}${backend.models?.routing ? `, routing: ${escapeHtml(backend.models.routing)}` : ''}). Deep research and everyday chat can use different models; the API token stays on the server.`
    : `Running on the built-in local agent. To go live, the server operator adds the Muse Wonder token to the server's <code>.env</code> file (see README) — no key ever belongs in the browser.`;
}

// ---------------- Chat UI ----------------
function startAgent(e, resume = false) {
  if (e) e.preventDefault();
  const sec = $('#agent'); sec.hidden = false;
  started = true;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!conversation.length) {
    const seedNote = profile.bodyStyles.length || profile.fuel
      ? `\n\nI noticed you're already eyeing ${[...profile.bodyStyles, profile.fuel].filter(Boolean).join(' · ')} — I've noted that, and I'll check it against your lifestyle as we talk.`
      : '';
    addMessage('agent', TOPICS[0].prompt() + seedNote, { persist: true });
    renderQuickReplies();
  }
  setTimeout(() => $('#chatInput')?.focus({ preventScroll: true }), 450);
  showToast(resume ? 'Welcome back — your chat is restored.' : `Say hello to ${AGENT_NAME}, your vehicle agent.`);
}

function addMessage(role, content, opts = {}) {
  const msg = { role, content, ts: Date.now() };
  if (opts.persist !== false || role !== 'agent' || !conversation.length) conversation.push(msg);
  else conversation.push(msg);
  renderMessage(msg);
  save();
  return msg;
}
function renderMessage({ role, content }) {
  const box = $('#chatMessages'); if (!box) return;
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const avatar = role === 'agent' ? `<span class="mini-avatar" aria-hidden="true">${escapeHtml(AGENT_NAME[0] || 'M')}</span>` : '';
  wrap.innerHTML = `${avatar}<div class="bubble">${escapeHtml(content).replace(/\n/g, '<br>')}</div>`;
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}
function renderConversation() {
  const box = $('#chatMessages'); box.innerHTML = '';
  conversation.forEach(renderMessage);
  box.scrollTop = box.scrollHeight;
}
function renderQuickReplies(list) {
  const el = $('#quickReplies');
  const items = list || customQuickReplies
    || (awaitingConfirmation ? ['✅ Confirm my profile', '✏️ Edit something', 'Show my guidelines']
      : profileConfirmed ? ['🚗 Suggest vehicles for me', '⬇ Download guidelines (PDF)', '⬇ Download guidelines (JSON)', '✏️ Edit my profile']
      : isComplete ? ['✅ Confirm my profile', '✏️ Edit something', 'Show my guidelines'] : TOPICS[topicIndex]?.quick || []);
  customQuickReplies = null;
  el.innerHTML = '';
  items.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = q;
    b.addEventListener('click', () => { $('#chatInput').value = q; submitInput(); });
    el.appendChild(b);
  });
}
function renderTopicProgress() {
  $('#topicProgress').innerHTML = TOPICS.map((t, i) =>
    `<li class="${i < topicIndex || isComplete ? 'done' : i === topicIndex ? 'active' : ''}">${i < topicIndex || isComplete ? '✓ ' : ''}${escapeHtml(t.label)}</li>`).join('');
}
function setTyping(on) {
  $('#typingIndicator').hidden = !on;
  $('#sendBtn').disabled = on;
  const box = $('#chatMessages'); box.scrollTop = box.scrollHeight;
}
function autoGrow() {
  const ta = $('#chatInput');
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

async function submitInput() {
  const ta = $('#chatInput');
  const text = ta.value.trim();
  if (!text || busy) return;
  ta.value = ''; autoGrow();
  if (!started) startAgent();
  addMessage('user', text);
  busy = true; setTyping(true);
  try {
    // Market first: what the user just said may switch their country
    // (and local currency + create that market's cache) before anything
    // else — including a vehicle analysis in the same message — runs.
    const detected = detectMarketFromText(text);
    if (detected.changed) {
      const m = currentMarket();
      addMessage('agent', `I noticed you're in ${m.country} (${detected.reasons.slice(0, 2).join(', ')}) — I've set your market to ${m.country}: local ${m.postalLabel}, and pricing in your local currency. Your ${m.country} vehicle cache is ready on the backend too. Just say the word if I've got that wrong.`);
    } else if (detected.currencyChanged) {
      addMessage('agent', `Noted — I'll use your chosen currency in the financing calculator from here.`);
    }

    let handled = false;
    if (awaitingMarketClarification) {
      awaitingMarketClarification = false;
      if (detected.code && (detected.changed || marketSource === 'chat') || /^[A-Za-z][A-Za-z .'-]{2,40}$/.test(text.trim())) {
        // A country-name-only answer lands here; detection may already
        // have set it. If not, leave the market unset rather than guess.
        addMessage('agent', `Perfect — ${currentMarket().code ? `${currentMarket().country} it is` : 'thanks, I’ll keep detecting your market as we chat'}. Now, ${TOPICS[1].prompt()}`);
        handled = true;
      }
    }
    if (!handled && pendingDealerVehicle) {
      const vehicle = pendingDealerVehicle; pendingDealerVehicle = '';
      if (!/^(cancel|never ?mind|skip)$/i.test(text.trim())) {
        if (!profile.location && text.trim().length <= 80) profile.location = text.trim();
        extractFromText(text, 'intro');
        await runDealerOffers(vehicle);
        handled = true;
      }
    }
    if (!handled && isComplete) handled = handleConfirmationFlow(text);
    if (!handled && /\b(suggest|recommend|which|what)\b.*\b(vehicle|car|matches|buy)\b|\bvehicles for me\b|\bfind my matches\b/i.test(text) && !/\bsimilar\b/i.test(text)) {
      await runVehicleSuggestions();
      handled = true;
    }
    if (!handled) handled = await handleVehicleFlow(text);
    if (!handled) {
      if (llmIsConfigured()) await handleWithLLM(text);
      else { await sleep(550); handleLocally(text); }
    }
  } catch (err) {
    console.error(err);
    addMessage('system', `Something went wrong talking to the agent (${escapeHtml(err.message || 'unknown error')}). Your message was saved — try again.`);
  } finally {
    busy = false; setTyping(false);
    renderTopicProgress(); renderProfilePanel(); renderQuickReplies(); save();
    $('#chatInput')?.focus({ preventScroll: true });
  }
}

// ---------------- Profile-based suggestions + dealers ----------------
function dealerLocationText() {
  return [profile.location, profile.postalCode, profile.country].filter(Boolean).join(', ');
}
async function runVehicleSuggestions() {
  if (profileCompleteness(profile) < 30 && !profile.interestedVehicle) {
    addMessage('agent', "I'd love to — but I need a little more of your profile first so the suggestions actually fit you. Tell me roughly: what you'll mainly use the vehicle for, your budget ballpark, and anything it must have. Or name a vehicle you like and I'll draft your profile from it.");
    if (!conversation.length) startAgent();
    return null;
  }
  const ownBusy = !busy;
  if (ownBusy) { busy = true; setTyping(true); }
  try {
    const res = await fetch('/api/vehicle-suggestions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ profile, guidelines, market: currentMarket().code, currency: currentCurrency() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data?.candidates)) throw new Error(data?.error || `Suggestions unavailable (HTTP ${res.status})`);
    currentSuggestions = data;
    renderSuggestions();
    addMessage('agent', suggestionsSummaryText(data));
    customQuickReplies = data.candidates.slice(0, 3).map((c) => `Analyse a ${c.make} ${c.model}`);
    save();
    $('#suggestionsPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return data;
  } catch (err) {
    console.warn('Vehicle suggestions failed:', err);
    addMessage('system', `I could not generate suggestions just now (${err.message || 'unknown error'}). Suggestions need the backend running via npm start with an LLM configured — your profile is saved, so we can retry anytime.`);
    return null;
  } finally {
    if (ownBusy) { busy = false; setTyping(false); renderTopicProgress(); renderProfilePanel(); }
  }
}
function suggestionsSummaryText(d) {
  return `Based on your profile, here are your 3 most likely matches 🎯\n\n${d.candidates.map((c, i) => `${i + 1}. ${c.make} ${c.model} — ${c.matchScore}% match. ${c.whySummary}`).join('\n\n')}\n\nThey're in the panel beside this chat with prices and sources. Tap Analyse on any of them for the full sentiment/trims/financing breakdown, or ask me for nearby dealers and offers.`;
}
function renderSuggestions() {
  const d = currentSuggestions;
  const panel = $('#suggestionsPanel');
  if (!d?.candidates?.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#suggestionsBadge').textContent = `Profile-based · ${d.asOf || ''}`;
  $('#suggestionsNote').textContent = d.dataSource;
  $('#suggestionsContent').innerHTML = d.candidates.map((c, i) => {
    const name = `${c.make} ${c.model}`;
    const dealerData = dealerResults[name];
    return `
    <article class="match-card ${i === 0 ? 'top' : ''}">
      <div class="match-head">
        <div><span class="match-rank">#${i + 1} match</span><h4>${escapeHtml(name)}${c.year ? ` <small>(${escapeHtml(c.year)})</small>` : ''}</h4>
        <span class="pill">${escapeHtml(c.category || c.bodyStyle)}</span> <span class="pill">${escapeHtml(c.fuel)}</span> <span class="pill">${c.seating} seats</span></div>
        <div class="match-score"><strong>${c.matchScore}%</strong><small>match</small></div>
      </div>
      ${c.priceGuide?.starting ? `<p><strong>Indicative from:</strong> ${formatMoney(c.priceGuide.starting, c.priceGuide.currency || currentCurrency())}${c.priceGuide.typicalTop ? ` – ${formatMoney(c.priceGuide.typicalTop, c.priceGuide.currency || currentCurrency())}` : ''} <small>(${escapeHtml(c.priceGuide.currency || currentCurrency())}, grounded — verify locally)</small></p>` : '<p><small>No reliable grounded starting price found — the full analysis will dig deeper.</small></p>'}
      <p class="match-why">${escapeHtml(c.whySummary)}</p>
      ${c.reasons?.length ? `<ul class="match-reasons">${c.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
      ${c.tradeoffs?.length ? `<p class="match-tradeoff">⚖️ Trade-off: ${escapeHtml(c.tradeoffs[0])}</p>` : ''}
      <div class="summary-actions">
        <button type="button" class="btn btn-primary btn-sm" data-suggest-analyse="${escapeHtml(name)}">🔎 Analyse this vehicle</button>
        <button type="button" class="btn btn-outline btn-sm" data-suggest-dealers="${escapeHtml(name)}">📍 Nearby dealers &amp; offers</button>
      </div>
      <div class="dealer-box" id="dealers-${escapeHtml(name.replace(/\W+/g, '-'))}">${dealerData ? dealerHtml(dealerData) : ''}</div>
    </article>`;
  }).join('') + (d.sources?.length ? `<p><small>Sources: ${d.sources.slice(0, 6).map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.domain)}</a>`).join(' · ')}${d.sources.length > 6 ? ` · +${d.sources.length - 6} more in the downloaded profile` : ''}</small></p>` : '');
}
function dealerHtml(d) {
  const flex = d.flexibility || {};
  return `
    <h5>📍 Dealers &amp; offers near ${escapeHtml(d.location)} <small style="color:var(--muted)">(found ${escapeHtml(d.asOf)})</small></h5>
    <p><small>${escapeHtml(d.dataSource)}</small></p>
    ${d.dealers?.length ? d.dealers.map((dealer) => `
      <div class="dealer-card"><h5>${escapeHtml(dealer.name)}</h5>
        ${dealer.area || dealer.distanceText ? `<p>📍 ${escapeHtml([dealer.area, dealer.distanceText].filter(Boolean).join(' · '))}</p>` : ''}
        ${dealer.offerTitle ? `<p><strong>Offer:</strong> ${escapeHtml(dealer.offerTitle)}${dealer.priceText ? ` — ${escapeHtml(dealer.priceText)}` : ''}</p>` : ''}
        ${dealer.offerDetails ? `<p>${escapeHtml(dealer.offerDetails)}</p>` : ''}
        <p><a href="${escapeHtml(dealer.url)}" target="_blank" rel="noopener noreferrer">View source (${escapeHtml(dealer.domain)})</a></p>
      </div>`).join('')
    : '<p class="empty-state">No dealers/offers for this vehicle near you appeared in the public sources retrieved — none have been invented. Try a wider location, or check the manufacturer\'s dealer locator.</p>'}
    <p><span class="flex-badge flex-${escapeHtml(flex.level || 'unknown')}">Pricing flexibility: ${escapeHtml(flex.level || 'unknown')}${flex.confidence ? ` (${escapeHtml(flex.confidence)} confidence)` : ''}</span></p>
    ${flex.rationale ? `<p>${escapeHtml(flex.rationale)}</p>` : ''}
    ${flex.signals?.length ? `<ul>${flex.signals.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
    ${d.negotiationTips?.length ? `<p><strong>Negotiation tips:</strong> ${escapeHtml(d.negotiationTips.join(' '))}</p>` : ''}
    <p><small>${escapeHtml(flex.disclaimer || '')}</small></p>`;
}
async function runDealerOffers(vehicleName) {
  const location = dealerLocationText();
  if (!location) {
    pendingDealerVehicle = vehicleName;
    addMessage('agent', `I can look for dealers and public offers for the ${vehicleName} — what city and ${currentMarket().postalLabel} should I search around?`);
    $('#chatInput')?.focus({ preventScroll: true });
    return null;
  }
  const ownBusy = !busy;
  if (ownBusy) { busy = true; setTyping(true); }
  try {
    const res = await fetch('/api/dealer-offers', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ vehicle: vehicleName, location, market: currentMarket().code, currency: currentCurrency() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.error || `Dealer search unavailable (HTTP ${res.status})`);
    dealerResults[vehicleName] = data;
    renderSuggestions();
    addMessage('agent', dealerSummaryText(data));
    save();
    document.getElementById(`dealers-${vehicleName.replace(/\W+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return data;
  } catch (err) {
    console.warn('Dealer search failed:', err);
    addMessage('system', `I could not complete that dealer search (${err.message || 'unknown error'}). It needs the backend running via npm start with an LLM configured.`);
    return null;
  } finally {
    if (ownBusy) { busy = false; setTyping(false); renderTopicProgress(); renderProfilePanel(); }
  }
}
function dealerSummaryText(d) {
  if (!d.dealers?.length) return `I searched public sources for ${d.vehicle} dealers and offers near ${d.location}, but nothing solid surfaced — so I haven't invented any dealers. The panel explains what was checked; a wider location or the manufacturer's dealer locator is the next step. Pricing flexibility here is unknown from public signals.`;
  const first = d.dealers[0];
  return `Dealer search for the ${d.vehicle} near ${d.location} 📍\n\nI found ${d.dealers.length} grounded dealer lead${d.dealers.length === 1 ? '' : 's'} in public sources — for example ${first.name}${first.offerTitle ? ` advertising "${first.offerTitle}"` : ''}. Pricing flexibility looks ${d.flexibility.level} based on public signals (${d.flexibility.rationale})\n\nFull dealer cards, offers, sources and negotiation tips are in the panel. These are public web listings, not live stock — confirm price and availability with the dealer before travelling.`;
}

// ---------------- Vehicle analysis flow ----------------
async function handleVehicleFlow(text) {
  const lower = text.toLowerCase().trim();

  if (pendingVehicleQuery) {
    pendingVehicleQuery = false;
    if (/^(cancel|never ?mind|skip)$/.test(lower)) { addMessage('agent', 'No problem — back to getting to know you. ' + (TOPICS[Math.min(topicIndex, TOPICS.length - 1)]?.prompt() || '')); return true; }
    await runVehicleAnalysis(text);
    return true;
  }

  if (currentVehicleAnalysis) {
    const v = currentVehicleAnalysis.vehicle;
    if (/\b(build|generate|create|use|start).*\bprofile\b|\bprofile from this\b/.test(lower)) { applyVehicleProfile(); return true; }
    if (/\b(similar|alternatives?|rivals?|competitors?|other options)\b/.test(lower)) {
      addMessage('agent', similarSummaryText(currentVehicleAnalysis));
      $('#vehiclePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      customQuickReplies = ['Build my profile from this vehicle', 'What do owners complain about?', 'Open financing calculator'];
      return true;
    }
    if (/\b(sentiment|owners? (say|think|complain)|complain|negative|forums?|social media|reviews?|problems?)\b/.test(lower)) {
      addMessage('agent', sentimentSummaryText(currentVehicleAnalysis, true));
      customQuickReplies = ['Show similar vehicles', 'What trims and options does it have?', 'Build my profile from this vehicle'];
      return true;
    }
    if (/\b(trims?|colours?|colors?|options?|add[- ]?ons?|packages?|features|specs?)\b/.test(lower)) {
      addMessage('agent', optionsSummaryText(currentVehicleAnalysis));
      $('#vehiclePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      customQuickReplies = ['What do owners complain about?', 'Show similar vehicles', 'Open financing calculator'];
      return true;
    }
    if (/\b(financ|monthly|loan|calculator|apr|deposit|afford)\b/.test(lower)) {
      addMessage('agent', financeSnapshotText());
      $('#financeBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      customQuickReplies = ['Build my profile from this vehicle', 'Show similar vehicles'];
      return true;
    }
  }

  const query = detectVehicleQuery(text);
  if (query) { await runVehicleAnalysis(query); return true; }
  return false;
}

function detectVehicleQuery(text) {
  const clean = text.trim().replace(/[?!.]+$/, '');
  const strong = clean.match(/(?:analy[sz]e|analysis of|review of|tell me about|what about|look up|check out)\s+(?:a\s+|an\s+|the\s+)?(.+)/i);
  if (strong && strong[1].trim().length >= 3) return strong[1].trim();
  const soft = clean.match(/(?:thoughts on|your opinion on|interested in|looking at|considering)\s+(?:a\s+|an\s+|the\s+)?(.+)/i);
  // Soft interest phrases only count when a make/model is actually named,
  // so normal answers like "I'm interested in safety" stay in profile flow.
  if (soft && /\b(rav4|rav 4|cr-v|crv|model [y3sx]|f-150|f150|silverado|cx-5|cx5|ioniq|outback|corolla|civic|camry|accord|wrangler|mustang|tacoma|golf|tesla|toyota|honda|ford|mazda|hyundai|subaru|chevrolet|nissan|kia|volkswagen|jeep|bmw|audi)\b/i.test(soft[1])) return soft[1].trim();
  // Short standalone make/model mentions, e.g. "Toyota RAV4" or "What about a Model Y?"
  const knownModel = /\b(rav4|rav 4|cr-v|crv|model y|model 3|f-150|f150|silverado|cx-5|cx5|ioniq 5|outback|corolla|civic)\b/i;
  const knownMake = /^(toyota|honda|ford|tesla|mazda|hyundai|subaru|chevrolet|chevy|nissan|kia|volkswagen|jeep|bmw|audi)\b/i;
  if (clean.split(/\s+/).length <= 7 && (knownModel.test(clean) || (knownMake.test(clean) && /\s/.test(clean)))) return clean;
  return null;
}

async function runVehicleAnalysis(query) {
  const ownBusy = !busy;
  if (ownBusy) { busy = true; setTyping(true); }
  try {
    const res = await fetch('/api/vehicle-analysis', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, market: currentMarket().code, currency: currentMarket().currency }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.vehicle) throw new Error(data?.error || `Vehicle analysis unavailable (HTTP ${res.status})`);
    currentVehicleAnalysis = data;
    profile.interestedVehicle = `${data.vehicle.make} ${data.vehicle.model}`;
    renderVehiclePanel(true);
    addMessage('agent', vehicleSummaryText(data));
    customQuickReplies = ['Build my profile from this vehicle', 'Show similar vehicles', 'What do owners complain about?', 'Open financing calculator'];
    save();
    return data;
  } catch (err) {
    console.warn('Vehicle analysis failed:', err);
    addMessage('system', `I could not complete that grounded vehicle analysis (${err.message || 'unknown error'}). It needs the DriveMatch backend running via npm start with an LLM configured — then try again.`);
    return null;
  } finally {
    if (ownBusy) { busy = false; setTyping(false); renderTopicProgress(); renderProfilePanel(); }
  }
}

function vehicleSummaryText(d) {
  const v = d.vehicle;
  const currency = v.priceGuide?.currency || currentCurrency();
  const price = v.priceGuide?.starting ? `Grounded indicative pricing starts around ${formatMoney(v.priceGuide.starting, currency)} (${currency}, before local taxes/fees, from the cited sources).` : 'The grounded sources did not support a reliable guide price — enter your local price in the financing calculator.';
  const sentiment = d.sentiment && d.sentiment.score !== null
    ? `Owner sentiment (grounded in the social/forum/owner sources retrieved ${d.asOf || 'today'}): ${d.sentiment.score}/100 (${d.sentiment.distribution.positive}% positive / ${d.sentiment.distribution.neutral}% neutral / ${d.sentiment.distribution.negative}% negative). Owners love: ${d.sentiment.loves.join(', ').toLowerCase()}. Common complaints: ${d.sentiment.complaints.join(', ').toLowerCase()}.`
    : 'The retrieved sources were too thin to score sentiment responsibly, so I have left it unscored rather than inventing a number — the panel shows what was and was not verified.';
  const issues = d.commonIssues?.length ? `\nOwner-reported common issues to check: ${d.commonIssues.slice(0, 3).map((i) => i.title).join('; ')}.` : '';
  const cacheNote = d.cache?.stableHit ? `\n(Stable facts like trims/colours came from our monthly backend cache; pricing, sentiment and issues were pulled live just now.)` : '';
  return `Here's my grounded take on the ${v.make} ${v.model}${v.year ? ` (${v.year})` : ''} — ${v.category} 🔎\n\n${sentiment}${issues}\n\n${price}\nI found ${d.trims.length ? `${d.trims.length} trim levels` : 'trim information to verify'}${d.exteriorColours.length ? ` and ${d.exteriorColours.length} colours` : ''}, with ${d.options.length} popular options/add-ons listed. ${d.similar.length ? `Similar vehicles worth a look: ${d.similar.map((s) => `${s.make} ${s.model}`).join(', ')}.` : ''}${cacheNote}\n\nFull details — performance, sentiment by source, common issues, trims, colours, options, similar models, citations and a financing calculator — are in the Vehicle Analysis panel. Want me to build a draft profile from this ${v.model} that we can edit together?`;
}
function sentimentSummaryText(d, complaintsOnly = false) {
  if (!d.sentiment) return `For the ${d.vehicle.make} ${d.vehicle.model}, the sources retrieved for sentiment were too thin to score responsibly, so I won't make one up. The panel lists the sources we did get — it's worth checking owner forums for this exact model/year before buying.`;
  const s = d.sentiment;
  const sources = s.sources.map((x) => `${x.type}: ${x.score === null ? 'not scored' : `${x.score}/100`} (${x.themes.join(', ').toLowerCase()})`).join('\n• ');
  const issues = d.commonIssues?.length ? `\n\nCommon issues owners report: ${d.commonIssues.map((i) => `${i.title} (${i.severity}${i.yearsAffected ? `, ${i.yearsAffected}` : ''})`).join('; ')}.` : '';
  return `${d.vehicle.make} ${d.vehicle.model} sentiment: ${s.score === null ? 'unscored (thin sources)' : `${s.score}/100 overall`}.\n• ${sources}\n\nOwners love: ${s.loves.join(', ')}.\nCommon complaints: ${s.complaints.join(', ')}.${issues}\n\nGrounded in ${d.sources?.length || 0} web source(s) retrieved ${d.asOf || 'today'} — citations are in the panel.`;
}
function optionsSummaryText(d) {
  const v = d.vehicle;
  const trims = d.trims.length ? d.trims.map((t) => `${t.name}${t.priceFrom ? ` (from ~${formatMoney(t.priceFrom, d.vehicle.priceGuide?.currency || currentCurrency())})` : ''}`).join(', ') : 'the grounded sources did not verify a full trim list — check the official configurator for this market/year';
  const colours = d.exteriorColours.length ? d.exteriorColours.map((c) => c.name).join(', ') : 'manufacturer palettes vary by market/year';
  const opts = d.options.map((o) => o.name).join(', ');
  return `${v.make} ${v.model} breakdown:\n\nTrims: ${trims}.\nColours (examples): ${colours}.\nPopular options/add-ons: ${opts}.\n\nThe panel has per-trim highlights, colour swatches and what each add-on gets you.`;
}
function similarSummaryText(d) {
  if (!d.similar.length) return `The comparison sources didn't support confident rivals for the ${d.vehicle.make} ${d.vehicle.model} — tell me a budget and body style and I'll suggest the closest categories instead.`;
  return `Similar to the ${d.vehicle.make} ${d.vehicle.model}, consider:\n\n${d.similar.map((s) => `• ${s.make} ${s.model} — ${s.category}${s.priceGuide?.starting ? `, from ~${formatMoney(s.priceGuide.starting, s.priceGuide.currency || currentCurrency())}` : ''}. Why: ${s.whyConsider.join(', ').toLowerCase()}. Difference: ${s.keyDifference}.`).join('\n')}\n\nTap Analyse on any of them in the panel to dig in, or ask me here.`;
}

// ---------------- Local agent ----------------
function handleLocally(text) {
  const lower = text.toLowerCase().trim();
  const before = JSON.stringify(profile);

  if (/^(skip|pass|not sure|no idea|dunno|skip this)\b/.test(lower) && !isComplete) {
    advanceTopic();
    addMessage('agent', topicIndex >= TOPICS.length
      ? finishConversation("No problem — we'll work with what we have.")
      : `No problem, we'll skip that for now.\n\n${TOPICS[topicIndex].prompt()}`);
    return;
  }
  if (/\bwhy\b/.test(lower) && lower.includes('?')) {
    addMessage('agent', `Good question — I ask because it changes which vehicles actually fit you (running costs, space, safety, budget). There's no wrong answer, and you can say "skip" anytime.\n\nSo: ${TOPICS[Math.min(topicIndex, TOPICS.length - 1)].prompt()}`);
    return;
  }

  extractFromText(text, TOPICS[topicIndex]?.id);
  const changed = diffLabels(before, profile);

  if (isComplete) {
    guidelines = buildGuidelines(profile);
    awaitingConfirmation = true;
    addMessage('agent', changed.length
      ? `Updated — I've noted ${changed.join(', ')} and refreshed your guidelines in the panel. Does the updated profile look right now? Tap Confirm, or tell me what else to change.`
      : `Got it, I've added that to your profile and refreshed your guidelines. Does it look right now? Tap Confirm when you're happy.`);
    return;
  }

  const leavingIntro = TOPICS[topicIndex]?.id === 'intro';
  advanceTopic();
  const ack = changed.length ? `Got it — noted: ${changed.join(' · ')}.\n\n` : `Thanks, noted.\n\n`;
  if (topicIndex >= TOPICS.length) {
    addMessage('agent', ack + finishConversation());
  } else if (leavingIntro && (marketSource === 'default' || marketSource === 'locale') && !profile.location) {
    // We couldn't place them — ask their country naturally instead of
    // silently assuming. Their answer is handled in submitInput.
    awaitingMarketClarification = true;
    addMessage('agent', `${ack}Quick one before we continue: which country are you in? It sets your postal format and the local currency I price vehicles in.\n\nAnd ${TOPICS[topicIndex].prompt().charAt(0).toLowerCase()}${TOPICS[topicIndex].prompt().slice(1)}`);
  } else {
    addMessage('agent', ack + TOPICS[topicIndex].prompt());
  }
}
function advanceTopic() { topicIndex = Math.min(topicIndex + 1, TOPICS.length); }
function finishConversation(prefix = '') {
  isComplete = true;
  profileConfirmed = false;
  awaitingConfirmation = true;
  guidelines = buildGuidelines(profile);
  const persona = inferPersona(profile);
  const tops = topPriorities(profile, 3);
  return `${prefix ? prefix + '\n\n' : ''}That's everything I need — thanks${profile.firstName ? ', ' + profile.firstName : ''}! 🎉\n\nHere's who I'm shopping for: ${persona.name} — ${persona.blurb}\nTop priorities: ${tops.join(', ') || 'balanced across the board'}.\n\nI've built your vehicle-selection guidelines in the panel beside this chat. Before we use them: does this profile look right? Tap "Confirm my profile" and I'll show the full guidelines here and give you download and vehicle-suggestion options — or tell me what to change.`;
}

// ---- Confirmation, in-chat guidelines, downloads ----
function guidelinesToText() {
  if (!guidelines.length) guidelines = buildGuidelines(profile);
  return guidelines.map((g) => `${g.title}\n${g.points.map((p) => `• ${p}`).join('\n')}`).join('\n\n');
}
function confirmProfile() {
  profileConfirmed = true;
  awaitingConfirmation = false;
  isComplete = true;
  guidelines = buildGuidelines(profile);
  renderProfilePanel();
  addMessage('agent', `Profile confirmed${profile.firstName ? ` — thanks, ${profile.firstName}` : ''} ✅\n\n🧭 Here are your vehicle-selection guidelines:\n\n${guidelinesToText()}\n\nWhat would you like to do next?\n• 🚗 Suggest vehicles for me — I'll find your Top 3 matches from this profile\n• ⬇ Download guidelines (PDF) — a printable copy to save\n• ⬇ Download guidelines (JSON) — bring this file back anytime and upload it, and I'll pick up right where we left off\n\nTap an option below, or just type what you'd like.`);
  customQuickReplies = ['🚗 Suggest vehicles for me', '⬇ Download guidelines (PDF)', '⬇ Download guidelines (JSON)', '✏️ Edit my profile'];
  save();
}
function handleConfirmationFlow(text) {
  const lower = text.toLowerCase().trim();
  // Choosing suggestions/downloads while awaiting confirmation counts
  // as confirming — show the guidelines first, then carry on.
  if (awaitingConfirmation && /\b(suggest|recommend)\b.*\b(vehicle|car|match)|\bvehicles for me\b/.test(lower)) { confirmProfile(); return false; }
  if (awaitingConfirmation && /\bdownload\b/.test(lower)) confirmProfile();
  // Download / suggestion actions are available once confirmed.
  if (profileConfirmed) {
    if (/\bdownload\b.*\bpdf\b|\bpdf\b/.test(lower)) { downloadGuidelinesPdf(); addMessage('agent', 'I opened your guidelines as a printable view — choose "Save as PDF" in the print dialog to keep your copy. Anything else: suggest vehicles, or edit your profile?'); customQuickReplies = ['🚗 Suggest vehicles for me', '⬇ Download guidelines (JSON)', '✏️ Edit my profile']; return true; }
    if (/\bdownload\b.*\bjson\b|\bjson\b/.test(lower)) { downloadProfile(); addMessage('agent', 'Your guidelines JSON is downloading. Keep it safe — on your next visit, tap "Upload guidelines" and I\'ll restore this profile and make suggestions from it straight away.'); customQuickReplies = ['🚗 Suggest vehicles for me', '⬇ Download guidelines (PDF)']; return true; }
    if (/\bedit\b|\bchange\b|\bupdate\b/.test(lower) && !/\bsuggest\b/.test(lower)) { profileConfirmed = false; addMessage('agent', 'Of course — tell me what to change and I\'ll update your profile and guidelines, then ask you to confirm again.'); return true; }
    return false; // suggestions & everything else flow normally
  }
  if (!awaitingConfirmation) return false;
  if (/^(✅\s*)?(confirm|confirmed|yes|yeah|yep|looks (right|good|correct)|that'?s (right|correct|good)|perfect|happy|go ahead|proceed)\b/.test(lower)) { confirmProfile(); return true; }
  if (/show.*guidelines|guidelines please/.test(lower)) {
    guidelines = buildGuidelines(profile);
    addMessage('agent', `Here are your current (unconfirmed) guidelines:\n\n${guidelinesToText()}\n\nHappy with them? Tap Confirm, or tell me what to change.`);
    return true;
  }
  if (/edit|change|wrong|update|actually/.test(lower)) {
    awaitingConfirmation = false;
    addMessage('agent', 'No problem — tell me what to change and I\'ll update your profile and guidelines, then ask you to confirm again.');
    return true;
  }
  return false;
}

// --- lightweight extraction (also used as a safety net under the LLM) ---
function extractFromText(text, topicId) {
  const t = ` ${text.trim()} `;
  const lower = t.toLowerCase();

  // Name / location
  let m = t.match(/(?:my name is|i'm|i am|call me|name'?s)\s+([A-Z][a-z]{1,20})\b/i);
  if (m && !profile.firstName) profile.firstName = capitalise(m[1]);
  m = t.match(/(?:live in|from|based in|located in|i'?m in|moved to|relocated to|now in)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2}(?:,\s*[A-Z]{2})?)/);
  if (m) profile.location = cleanPlace(m[1]);

  // Postal-format signals (detection in submitInput usually sets the
  // market first; this keeps the profile fields themselves accurate).
  const postalCa = text.match(/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/);
  const postcodeUk = !postalCa && text.match(/\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/);
  if (postalCa) {
    profile.postalCode = postalCa[0].toUpperCase().replace(/([A-Z]\d[A-Z])(\d[A-Z]\d)/, '$1 $2');
    profile.country = countryNameFor('CA'); profile.countryCode = 'CA';
  } else if (postcodeUk && (selectedMarketCode === 'GB' || /\bpostcode\b/i.test(text))) {
    profile.postalCode = postcodeUk[0].toUpperCase();
    profile.country = countryNameFor('GB'); profile.countryCode = 'GB';
  }
  if (!postalCa && !profile.postalCode && (topicId === 'intro' || /\bzip\b/i.test(text))) {
    const zip = text.match(/\b\d{5}(?:-\d{4})?\b/);
    if (zip) profile.postalCode = zip[0];
  }
  if (topicId === 'intro') {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (!profile.firstName && parts[0] && parts[0].split(/\s+/).length <= 2 && !/\d/.test(parts[0])) profile.firstName = capitalise(parts[0].replace(/^(hi|hey|hello)\s+/i, ''));
    if (!profile.location && parts[1] && parts.length <= 3 && !/\b(live|drive|work|family|buying|looking)\b/i.test(parts[1]) && !/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(parts[1]) && !/^\d{5}(?:-\d{4})?$/.test(parts[1])) profile.location = cleanPlace(parts[1]);
    if (!profile.firstName && /^[A-Z][a-z]{1,20}$/.test(text.trim())) profile.firstName = text.trim();
  }

  // Household / experience
  if (/\bpartner|wife|husband|spouse|boyfriend|girlfriend\b/.test(lower) && !/\bfamily|kids|children\b/.test(lower)) profile.household = '2 people';
  else if (/\bjust me\b|\bonly me\b|\bsingle\b|\blive alone\b/.test(lower)) profile.household = 'Just me';
  else if (/\bfamily|kids?|children|baby|toddler\b/.test(lower)) profile.household = 'Family with kids';
  m = lower.match(/household of (\d)|(\d)\s*(?:people|person|of us)/); if (m) profile.household = `${m[1] || m[2]} people`;
  if (/first[- ]time|first car|never owned|new driver|just (?:passed|got) my (?:licen[cs]e|test)/.test(lower)) profile.experience = 'First-time buyer';
  m = lower.match(/(\d{1,2})\+?\s*years?(?:\s*of)?\s*(?:driving|experience|driving experience)/); if (m) profile.experience = +m[1] >= 10 ? '10+ years / seasoned' : +m[1] >= 3 ? '3–10 years' : '1–3 years';
  if (/seasoned|experienced driver|driving for years/.test(lower)) profile.experience = '10+ years / seasoned';

  // Primary use (family signals win over commute when both appear)
  const useMap = [
    ['Family transport', /family|kids|school run|car seats?/],
    ['Work / business', /work|business|job site|clients|tools|deliver/],
    ['Adventure / outdoors', /adventure|outdoors|camping|hiking|off-?road|trails?/],
    ['Road trips', /road trips?|long trips|touring|travel a lot/],
    ['City runabout', /city|urban|around town|runabout|errands/],
    ['First car / learning', /first car|learn|new driver/],
    ['Daily commute', /commut|office|work commute|daily driver/],
  ];
  for (const [label, re] of useMap) if (re.test(lower)) { profile.primaryUse = label; break; }

  // Daily miles / passengers
  m = lower.match(/(\d+(?:\.\d+)?)\s*k\s*miles a year/) || lower.match(/(\d[\d,]{3,})\s*miles a year/);
  if (m) profile.dailyMiles = Math.round(parseFloat(String(m[1]).replace(/,/g, '')) * (String(m[0]).includes('k') ? 1000 : 1) / 365);
  m = lower.match(/(\d{1,3})\s*(?:miles|mi|km)\b/); if (m) profile.dailyMiles = clamp(+m[1], 0, 300);
  if (/just me|only me|solo/.test(lower) && topicId === 'daily') profile.passengers = 'Just me';
  m = lower.match(/(\d)\s*(?:passengers|people|kids|children|adults)/); if (m) profile.passengers = m[1];
  if (/car seats?|baby seat/.test(lower)) addUnique(profile, 'cargo', 'Kids / car seats');

  addByKeywords(lower, profile, 'cargo', [
    ['Groceries / shopping', /groceries|shopping/], ['Kids / car seats', /kids|children|car seats?/],
    ['Pets', /dog|pet|cat/], ['Sports / outdoor gear', /gear|bikes?|bike|camping|ski|sports|surf/],
    ['Work tools / equipment', /tools|equipment|lumber|work gear/], ['Bikes / large items', /large items|furniture|loads/],
  ]);
  if (/\bbikes?\b/.test(lower)) addUnique(profile, 'cargo', 'Bikes / large items');
  addByKeywords(lower, profile, 'terrain', [
    ['City streets', /city|urban/], ['Highway / motorway', /highway|motorway|freeway/], ['Suburbs', /suburb/],
    ['Rural / country roads', /rural|country roads/], ['Hills / mountains', /hill|mountain/],
    ['Snow / ice', /snow|ice|winter/], ['Off-road / trails', /off-?road|trail|dirt/],
  ]);

  // Vehicle prefs
  addByKeywords(lower, profile, 'bodyStyles', [
    ['SUV / Crossover', /\bsuvs?\b|crossovers?/], ['Sedan', /sedans?|saloon/], ['Hatchback', /hatchbacks?/],
    ['Truck / Pickup', /trucks?|pickups?|pick-ups?/], ['Minivan', /minivans?|mini vans?|\bvans?\b/], ['Wagon', /wagons?|estate/],
    ['Coupe / Convertible', /coupes?|convertibles?|sporty/],
  ]);
  if (/not sure|guide me|no idea|open to (?:anything|suggestions)/.test(lower) && topicId === 'prefs') addUnique(profile, 'bodyStyles', 'Not sure yet');
  if (/plug[- ]?in hybrid|phev/.test(lower)) profile.fuel = 'Plug-in hybrid (PHEV)';
  else if (/hybrid/.test(lower) && (/\belectric\b|\bev\b/.test(lower))) profile.fuel = 'Hybrid or Electric (open to both)';
  else if (/\belectric\b|\bev\b|battery electric/.test(lower)) profile.fuel = 'Electric (EV)';
  else if (/hybrid/.test(lower)) profile.fuel = 'Hybrid';
  else if (/diesel/.test(lower)) profile.fuel = 'Diesel';
  else if (/petrol|gasoline|\bgas\b/.test(lower)) profile.fuel = 'Petrol / Gasoline';
  if (/certified pre|certified used|\bcpo\b/.test(lower)) profile.condition = 'Certified pre-owned';
  else if (/\bused\b|second[- ]hand|pre[- ]owned/.test(lower)) profile.condition = 'Used only';
  else if (/\bnew\b/.test(lower) && topicId === 'prefs') profile.condition = 'New only';
  addByKeywords(lower, profile, 'features', [
    ['Apple CarPlay / Android Auto', /carplay|android auto/], ['Adaptive cruise control', /adaptive cruise|cruise control/],
    ['Blind-spot monitoring', /blind[- ]?spot/], ['Heated seats', /heated seats/], ['Sunroof', /sunroof|panoramic roof/],
    ['All-wheel drive', /all[- ]wheel|awd|4wd|four[- ]wheel/], ['Towing capacity', /\btowing\b|\btow(?:ing)?\s+(?:hitch|a|capacity|rating)|\bcan tow\b/],
    ['Third-row seating', /third[- ]row|3rd row|7 seats|seven seats/], ['Leather seats', /leather/],
    ['Parking sensors / camera', /parking (?:sensors|camera)|reverse camera|backup camera/],
  ]);
  if (/\btowing\b|\btow hitch\b/.test(lower)) addUnique(profile, 'features', 'Towing capacity');

  // Budget & ownership
  const amounts = [...lower.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?/g)].map((x) => ({ raw: x[0], value: parseFloat(x[1].replace(/,/g, '')) * (x[2] ? 1000 : 1), index: x.index }));
  const bareK = lower.match(/(?:around|about|~)?\s?(\d{2})\s*k\b(?!\s*miles)/);
  amounts.forEach((a) => {
    const ctx = lower.slice(Math.max(0, a.index - 20), a.index + a.raw.length + 14);
    if (/\/\s?mo|per month|monthly|a month/.test(ctx)) profile.monthly = monthlyLabel(a.value);
    else if (a.value >= 3000) profile.budget = budgetLabel(a.value);
    else if (a.value >= 100) profile.monthly = monthlyLabel(a.value);
  });
  if (!amounts.length && bareK) profile.budget = budgetLabel(+bareK[1] * 1000);
  if (/not sure (?:on |about )?(?:the )?budget|no (?:idea|budget)/.test(lower) && topicId === 'budget') profile.budget = 'Not sure yet';
  if (/\bcash\b|paying cash|buy outright/.test(lower)) profile.payment = 'Cash';
  else if (/lease|leasing/.test(lower)) profile.payment = 'Lease';
  else if (/financ|loan|monthly payment|borrow/.test(lower)) profile.payment = 'Finance / loan';
  m = lower.match(/keep (?:it |the car )?(?:for )?(\d{1,2})\s*[-–]\s*(\d{1,2})\s*years?/);
  if (m) profile.keepYears = `${m[1]}–${m[2]} years`;
  else { m = lower.match(/keep (?:it |the car )?(?:for )?(\d{1,2})\s*years?/); if (m) profile.keepYears = +m[1] <= 2 ? '1–2 years' : +m[1] <= 5 ? '3–5 years' : +m[1] <= 8 ? '5–8 years' : '8+ years'; }
  if (/trade[- ]?in|trade my/.test(lower) && !/no trade/.test(lower)) profile.tradeIn = 'Yes';
  if (/no trade|nothing to trade/.test(lower)) profile.tradeIn = 'No';
  if (/asap|right away|immediately|within (?:two|2) weeks/.test(lower)) profile.timeline = 'ASAP (within 2 weeks)';
  else if (/this month|within a month|next month/.test(lower)) profile.timeline = 'Within 1 month';
  else if (/research|just looking|no rush|browsing/.test(lower)) profile.timeline = 'Just researching';

  // Priorities (mention = high score; explicit "don't care" = low)
  for (const p of PRIORITY_DEFS) {
    if (p.words.some((w) => lower.includes(w))) {
      const neg = new RegExp(`(?:don'?t care|not (?:important|bothered)|least).{0,24}${p.words[0]}`).test(lower);
      profile.priorities[p.key] = neg ? 1 : (/first|most|top|really|love/.test(lower) ? 5 : 4);
      addUnique(profile, 'prioritiesMentioned', p.key);
    }
  }
  if (topicId === 'priorities' && text.trim().length > 12) profile.notes = text.trim().slice(0, 500);
}
function addUnique(obj, key, val) { if (!obj[key].includes(val)) obj[key].push(val); }
function addByKeywords(lower, obj, key, pairs) { for (const [label, re] of pairs) if (re.test(lower)) addUnique(obj, key, label); }
function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function cleanPlace(s) { return s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().slice(0, 40); }
function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
function budgetLabel(v) {
  const f = (n) => formatMoney(n, currentCurrency());
  if (v < 15000) return `Under ${f(15000)}`;
  if (v <= 25000) return `${f(15000)} – ${f(25000)}`;
  if (v <= 35000) return `${f(25000)} – ${f(35000)}`;
  if (v <= 50000) return `${f(35000)} – ${f(50000)}`;
  if (v <= 75000) return `${f(50000)} – ${f(75000)}`;
  return `${f(75000)}+`;
}
function monthlyLabel(v) {
  const f = (n) => formatMoney(n, currentCurrency());
  if (v < 250) return `Under ${f(250)}/mo`;
  if (v <= 400) return `${f(250)} – ${f(400)}/mo`;
  if (v <= 600) return `${f(400)} – ${f(600)}/mo`;
  if (v <= 850) return `${f(600)} – ${f(850)}/mo`;
  return `${f(850)}+/mo`;
}
const FIELD_LABELS = { firstName: 'name', location: 'location', household: 'household', experience: 'experience', primaryUse: 'main use', dailyMiles: 'daily miles', passengers: 'passengers', fuel: 'fuel preference', condition: 'new/used preference', budget: 'budget', monthly: 'monthly budget', payment: 'payment plan', keepYears: 'how long you’ll keep it', tradeIn: 'trade-in', timeline: 'timeline', notes: 'extra detail' };
function diffLabels(beforeJson, after) {
  const before = JSON.parse(beforeJson); const out = [];
  for (const k of Object.keys(FIELD_LABELS)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k]) && after[k]) out.push(FIELD_LABELS[k]);
  for (const k of ['cargo', 'terrain', 'bodyStyles', 'features']) if (JSON.stringify(before[k]) !== JSON.stringify(after[k]) && after[k].length) out.push(k === 'bodyStyles' ? 'vehicle style' : k);
  if (JSON.stringify(before.priorities) !== JSON.stringify(after.priorities)) out.push('priorities');
  return [...new Set(out)].slice(0, 5);
}

// ---------------- Backend agent (Muse Wonder via server.js) ----------------
async function handleWithLLM(userText) {
  // Local extraction first as a safety net, then let the LLM (via backend) refine it.
  extractFromText(userText, TOPICS[topicIndex]?.id);
  try {
    const data = await callBackend(userText);
    if (!data || data.fallback) throw new Error(data?.reason || 'Backend asked for local fallback');
    if (data.profile_patch) mergeProfilePatch(data.profile_patch);
    if (Array.isArray(data.covered_topic_ids)) {
      const maxCovered = Math.max(-1, ...data.covered_topic_ids.map((id) => TOPICS.findIndex((t) => t.id === id)));
      if (maxCovered >= topicIndex) topicIndex = Math.min(maxCovered + 1, TOPICS.length);
      else advanceTopic();
    } else advanceTopic();

    if (data.is_complete || topicIndex >= TOPICS.length) {
      isComplete = true;
      awaitingConfirmation = !profileConfirmed;
      guidelines = Array.isArray(data.guidelines) && data.guidelines.length ? sanitiseGuidelines(data.guidelines) : buildGuidelines(profile);
    }
    addMessage('agent', (data.reply || '').trim() || 'Thanks — noted. Tell me a bit more.');
    if (Array.isArray(data.quick_replies) && data.quick_replies.length) customQuickReplies = data.quick_replies.slice(0, 4);
  } catch (err) {
    console.warn('Backend agent unavailable, falling back to local agent:', err);
    addMessage('system', 'The Muse models (via the backend) could not be reached — continuing with the local agent so your chat is not interrupted.');
    handleLocally(userText);
  }
}

async function callBackend(userText) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        message: userText,
        conversation: conversation.slice(-14),
        profile,
        topicIndex,
        topicId: TOPICS[topicIndex]?.id || 'done',
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('Bad response from backend');
    if (data.fallback) return data;
    if (!res.ok) throw new Error(data.reason || 'HTTP ' + res.status);
    return data;
  } finally { clearTimeout(timeout); }
}
const PROFILE_KEYS = Object.keys(emptyProfile());
function mergeProfilePatch(patch) {
  for (const key of PROFILE_KEYS) {
    if (!(key in patch)) continue;
    const val = patch[key];
    if (Array.isArray(profile[key])) {
      if (Array.isArray(val)) val.forEach((v) => { if (typeof v === 'string' && v.trim()) addUnique(profile, key, v.trim().slice(0, 60)); });
    } else if (key === 'priorities') {
      if (val && typeof val === 'object') for (const [k, v] of Object.entries(val)) if (PRIORITY_DEFS.some((p) => p.key === k)) profile.priorities[k] = clamp(Number(v) || 3, 1, 5);
    } else if (key === 'dailyMiles') {
      profile.dailyMiles = val === null || val === '' ? profile.dailyMiles : clamp(Number(val) || 0, 0, 400);
    } else if (typeof val === 'string' && val.trim()) {
      profile[key] = val.trim().slice(0, 300);
    }
  }
  if (Array.isArray(patch.prioritiesMentioned)) patch.prioritiesMentioned.forEach((k) => { if (PRIORITY_DEFS.some((p) => p.key === k)) addUnique(profile, 'prioritiesMentioned', k); });
}
function sanitiseGuidelines(list) {
  return list.filter((g) => g && typeof g.title === 'string').slice(0, 8).map((g) => ({
    title: g.title.slice(0, 90),
    type: ['warning', 'dealbreaker'].includes(g.type) ? g.type : 'normal',
    points: Array.isArray(g.points) ? g.points.filter((p) => typeof p === 'string').slice(0, 6).map((p) => p.slice(0, 220)) : [],
  }));
}

// ---------------- Vehicle panel, financing, vehicle -> profile ----------------
const CURRENCIES = ['USD', 'EUR', 'GBP', 'ZAR', 'AUD', 'CAD', 'NZD', 'JPY', 'CHF', 'INR', 'AED', 'SGD', 'BRL', 'MXN', 'KRW', 'SEK', 'NOK', 'DKK', 'PLN'];
function formatMoney(value, currency = currentCurrency()) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value)); }
  catch { return `${currency} ${Math.round(Number(value)).toLocaleString()}`; }
}

function renderVehiclePanel(resetFinance = false) {
  const d = currentVehicleAnalysis;
  const panel = $('#vehiclePanel');
  if (!d) { panel.hidden = true; return; }
  panel.hidden = false;
  const v = d.vehicle;
  $('#vehiclePanelTitle').textContent = `🚗 ${v.make} ${v.model}${v.year ? ` (${escapeHtml(v.year)})` : ''} — Analysis`;
  $('#vehicleDataBadge').textContent = d.cache?.stableHit
    ? `Cached facts ${String(d.cache.stableCachedAt || '').slice(0, 10)} · Live ${d.asOf || 'today'}`
    : `Search-grounded · ${d.asOf || 'today'}`;
  $('#vehicleDataNote').textContent = d.dataSource;
  $('#financeToolBtn').disabled = false;
  $('#vehicleProfileToolBtn').disabled = false;

  const guideCurrency = v.priceGuide?.currency || currentCurrency();
  const priceHtml = v.priceGuide?.starting
    ? `${formatMoney(v.priceGuide.starting, guideCurrency)}${v.priceGuide.typicalTop ? ` – ${formatMoney(v.priceGuide.typicalTop, guideCurrency)}` : ''}<br><small>${escapeHtml(v.priceGuide.note || '')}</small>`
    : escapeHtml(v.priceGuide?.note || 'Enter local pricing in the calculator.');
  const sentimentHtml = d.sentiment ? `
    <div class="vehicle-section"><h4>💬 Sentiment Analysis <small style="color:var(--muted)">(search-grounded, ${escapeHtml(d.asOf || '')})</small></h4>
      <div class="sentiment-score"><strong>${d.sentiment.score === null ? '—' : d.sentiment.score}</strong><div><strong>${d.sentiment.score === null ? 'Unscored — sources too thin' : '/ 100 overall sentiment'}</strong><br><small>${escapeHtml(d.sentiment.note || 'Derived only from the cited social/forum/owner sources.')}</small></div></div>
      <div class="stacked-bar" aria-label="Sentiment distribution">
        <i style="width:${d.sentiment.distribution.positive}%;background:#22c55e"></i>
        <i style="width:${d.sentiment.distribution.neutral}%;background:#facc15"></i>
        <i style="width:${d.sentiment.distribution.negative}%;background:#ef4444"></i>
      </div>
      <div class="sentiment-legend"><span>● ${d.sentiment.distribution.positive}% positive</span><span>● ${d.sentiment.distribution.neutral}% neutral</span><span>● ${d.sentiment.distribution.negative}% negative</span></div>
      <div class="source-grid" style="margin-top:10px">${d.sentiment.sources.map((s) => `
        <div class="source-card"><h5>${escapeHtml(s.type)} — ${s.score === null ? 'not scored' : `${s.score}/100`}</h5>${s.score === null ? '' : `<div class="mini-bar"><i style="width:${s.score}%"></i></div>`}
        <p>Chatter volume: ${escapeHtml(s.volume || 'Not stated')} · Themes: ${escapeHtml(s.themes.join(', '))}</p></div>`).join('')}
      </div>
      <div class="two-col-lists" style="margin-top:10px">
        <div><strong>❤️ Owners love</strong><ul>${d.sentiment.loves.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
        <div><strong>⚠️ Common complaints</strong><ul>${d.sentiment.complaints.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      </div>
    </div>` : `<div class="vehicle-section"><h4>💬 Sentiment Analysis</h4><p class="empty-state">The retrieved sources were too thin to score sentiment for this model responsibly — none has been invented. Check owner forums for this exact model/year, and ask Maya what to look for.</p></div>`;

  const commonIssuesHtml = `
    <div class="vehicle-section"><h4>⚠️ Common Issues <small style="color:var(--muted)">(owner-reported, pulled live ${escapeHtml(d.asOf || '')})</small></h4>
      ${d.commonIssues?.length ? `<div class="option-list">${d.commonIssues.map((i) => `
        <div class="option-item issue-${escapeHtml(i.severity)}"><strong>${escapeHtml(i.title)}</strong>
          <span class="pill severity-${escapeHtml(i.severity)}">${escapeHtml(i.severity)} severity</span>
          ${i.frequency ? `<span class="pill">${escapeHtml(i.frequency)}</span>` : ''}${i.yearsAffected ? `<span class="pill">${escapeHtml(i.yearsAffected)}</span>` : ''}
          ${i.symptoms?.length ? `<p><strong>Symptoms:</strong> ${escapeHtml(i.symptoms.join('; '))}</p>` : ''}
          ${i.description ? `<p>${escapeHtml(i.description)}</p>` : ''}
        </div>`).join('')}</div>
        <p><small style="color:var(--muted)">Reported in the cited owner/forum sources — frequency reflects those sources, not a statistical failure rate. Always get a pre-purchase inspection.</small></p>`
      : '<p class="empty-state">The live sources did not surface well-documented common issues for this model — none have been invented. Check the cited owner forums for this exact year before buying.</p>'}
    </div>`;
  const performanceHtml = (d.performance && (d.performance.summary || d.performance.metrics?.length || d.performance.points?.length)) ? `
    <div class="vehicle-section"><h4>🏎️ Performance &amp; Capability</h4>
      ${d.performance.summary ? `<p>${escapeHtml(d.performance.summary)}</p>` : ''}
      ${d.performance.metrics?.length ? `<div class="vehicle-overview">${d.performance.metrics.map((m) => `<div><small>${escapeHtml(m.label)}</small><strong>${escapeHtml(m.value)}</strong></div>`).join('')}</div>` : ''}
      ${d.performance.points?.length ? `<ul>${d.performance.points.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
    </div>` : '';
  const citationsHtml = d.sources?.length ? `
    <div class="vehicle-section"><h4>🔗 Sources <small style="color:var(--muted)">(${d.sources.length}, retrieved ${escapeHtml(d.asOf || '')}${d.confidence ? ` · confidence: ${escapeHtml(d.confidence.level)}` : ''})</small></h4>
      ${d.confidence?.notes ? `<p><small>${escapeHtml(d.confidence.notes)}</small></p>` : ''}
      <ol class="citation-list">${d.sources.map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">[${escapeHtml(s.id)}] ${escapeHtml(s.title || s.domain)}</a> <small>— ${escapeHtml(s.domain)}${s.publishedDate ? ` · ${escapeHtml(s.publishedDate)}` : ''} · ${escapeHtml(s.queryType || '')}</small></li>`).join('')}</ol>
    </div>` : '';

  $('#vehicleContent').innerHTML = `
    <div class="vehicle-overview">
      <div><small>Category</small><strong>${escapeHtml(v.category)}</strong><br>${escapeHtml(v.bodyStyle)} · ${v.seating} seats</div>
      <div><small>Model year / market assumed</small><strong>${escapeHtml(v.year || 'Latest in sources')}</strong><br>${escapeHtml(v.market || 'As per cited sources')}</div>
      <div><small>Powertrains</small>${escapeHtml(v.powertrains.join(' · ') || 'See sources')}<br><small>Drive: ${escapeHtml(v.drivetrains.join(' / ') || 'See sources')}</small></div>
      <div><small>Economy / range</small>${escapeHtml(v.economy || 'See performance section')}</div>
      <div><small>Indicative price guide (${escapeHtml(guideCurrency)})</small>${priceHtml}</div>
    </div>
    <div class="two-col-lists">
      <div><strong>✅ Strengths</strong><ul>${v.strengths.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div><strong>👀 Watch-outs</strong><ul>${v.watchouts.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    </div>
    ${performanceHtml}
    ${sentimentHtml}
    ${commonIssuesHtml}
    <div class="vehicle-section"><h4>🎚️ Trims &amp; Levels</h4>
      ${d.trims.length ? `<div class="trim-grid">${d.trims.map((t) => `<div class="trim-card"><h5>${escapeHtml(t.name)}${t.priceFrom ? ` <span class="pill">${formatMoney(t.priceFrom, guideCurrency)}+</span>` : ''}</h5><p>${escapeHtml(t.highlights.join(' · '))}</p></div>`).join('')}</div>
      <p><small style="color:var(--muted)">Trim names/equipment are grounded in the cited sources for the assumed year/market above — verify against the official local configurator.</small></p>`
      : '<p class="empty-state">The grounded sources did not verify a full trim list for this model — verify against the official local configurator.</p>'}
    </div>
    <div class="vehicle-section"><h4>🎨 Colours</h4>
      ${d.exteriorColours.length ? `<div class="swatch-grid">${d.exteriorColours.map((c) => `<span class="swatch"><i style="background:${escapeHtml(c.swatch)}"></i>${escapeHtml(c.name)}</span>`).join('')}</div>` : '<p>Exterior palettes vary by market/year for this model.</p>'}
      ${d.interiors.length ? `<p style="margin-top:9px"><strong>Interiors:</strong> ${escapeHtml(d.interiors.join(' · '))}</p>` : ''}
    </div>
    <div class="vehicle-section"><h4>🧩 Options &amp; Add-ons</h4>
      <div class="option-list">${d.options.map((o) => `<div class="option-item"><strong>${escapeHtml(o.name)}</strong> <span class="pill">${escapeHtml(o.note)}</span><p>${escapeHtml(o.description)}</p></div>`).join('')}</div>
    </div>
    <div class="vehicle-section"><h4>🔁 Similar Vehicles</h4>
      ${d.similar.length ? `<div class="similar-grid">${d.similar.map((s) => `
        <div class="similar-card"><h5>${escapeHtml(s.make)} ${escapeHtml(s.model)}</h5>
          <p>${escapeHtml(s.category)}${s.priceGuide?.starting ? ` · from ${formatMoney(s.priceGuide.starting, s.priceGuide.currency || guideCurrency)}` : ''}${s.sentimentScore ? ` · sentiment ${s.sentimentScore}/100` : ''}</p>
          <p><strong>Why consider:</strong> ${escapeHtml(s.whyConsider.join(', '))}</p>
          <p><strong>Key difference:</strong> ${escapeHtml(s.keyDifference)}</p>
          <div class="summary-actions">
            <button type="button" class="btn btn-outline btn-sm" data-sim-analyse="${escapeHtml(s.make)} ${escapeHtml(s.model)}">🔎 Analyse this</button>
            <button type="button" class="btn btn-ghost btn-sm" data-sim-use="${escapeHtml(s.make)} ${escapeHtml(s.model)}">✨ Build profile from this</button>
          </div>
        </div>`).join('')}</div>`
      : '<p class="empty-state">The comparison sources did not support confident rivals for this vehicle.</p>'}
    </div>
    ${citationsHtml}
    <div class="summary-actions">
      <button type="button" class="btn btn-primary" id="vehicleToProfileBtn">✨ Generate a Draft Profile From This Vehicle</button>
    </div>`;
  $('#vehicleToProfileBtn').addEventListener('click', applyVehicleProfile);
  if (resetFinance) setupFinanceDefaults(d);
  renderFinanceResults();
}
function setupFinanceDefaults(d) {
  const priceEl = $('#finPrice');
  if (d.vehicle.priceGuide?.starting) priceEl.value = d.vehicle.priceGuide.starting;
  else if (!priceEl.value) priceEl.value = '';
  const guideCurrency = d.vehicle.priceGuide?.currency;
  $('#finCurrency').value = CURRENCIES.includes(guideCurrency) ? guideCurrency : currentCurrency();
}
function getFinanceInputs() {
  return {
    currency: CURRENCIES.includes($('#finCurrency').value) ? $('#finCurrency').value : currentCurrency(),
    price: Number($('#finPrice').value) || 0,
    deposit: Number($('#finDeposit').value) || 0,
    tradeIn: Number($('#finTradeIn').value) || 0,
    fees: Number($('#finFees').value) || 0,
    termMonths: Number($('#finTerm').value) || 60,
    apr: Number($('#finApr').value) || 0,
  };
}
function calculateFinance({ price, deposit, tradeIn, fees, termMonths, apr }) {
  const principal = Math.max(0, price + fees - deposit - tradeIn);
  const r = apr / 100 / 12;
  const monthly = principal <= 0 ? 0 : (r === 0 ? principal / termMonths : (principal * r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1));
  const totalRepayments = monthly * termMonths;
  return { principal, monthly, totalInterest: Math.max(0, totalRepayments - principal), totalRepayments, totalVehicleCost: price + fees + Math.max(0, totalRepayments - principal), upfront: deposit };
}
function renderFinanceResults() {
  const el = $('#finResults'); if (!el) return;
  const inp = getFinanceInputs();
  $('#finAprOut').textContent = `${inp.apr.toFixed(1)}%`;
  if (!inp.price) { el.innerHTML = '<div><small>Monthly payment</small><strong>Enter a vehicle price</strong><br><small>Use local pricing in your selected currency.</small></div>'; save(); return; }
  const r = calculateFinance(inp);
  el.innerHTML = `
    <div><small>Estimated monthly payment</small><strong>${formatMoney(r.monthly, inp.currency)}</strong><br><small>${inp.termMonths} months @ ${inp.apr.toFixed(1)}% APR</small></div>
    <div><small>Amount financed</small><strong>${formatMoney(r.principal, inp.currency)}</strong><br><small>Price + fees − deposit − trade-in</small></div>
    <div><small>Total interest</small><strong>${formatMoney(r.totalInterest, inp.currency)}</strong></div>
    <div><small>Total vehicle cost incl. interest/fees</small><strong>${formatMoney(r.totalVehicleCost, inp.currency)}</strong><br><small>Excludes insurance, fuel/energy, servicing &amp; taxes unless added to fees.</small></div>`;
  save();
}
function financeSnapshotText() {
  const inp = getFinanceInputs();
  const v = currentVehicleAnalysis?.vehicle;
  if (!inp.price) return `The financing calculator is in the Vehicle Analysis panel — pick your currency and enter the ${v ? `${v.make} ${v.model}'s` : "vehicle's"} local price, deposit, trade-in, term and APR, and I'll estimate the monthly payment. It defaults to the grounded guide price in your market's currency when we have one.`;
  const r = calculateFinance(inp);
  return `Quick financing estimate${v ? ` for the ${v.make} ${v.model}` : ''} in ${inp.currency}: about ${formatMoney(r.monthly, inp.currency)}/month over ${inp.termMonths} months at ${inp.apr.toFixed(1)}% APR, financing ${formatMoney(r.principal, inp.currency)} with ${formatMoney(r.totalInterest, inp.currency)} total interest. Adjust currency, price, deposit or term in the calculator panel — it's an estimate, not financial advice.`;
}

function applyVehicleProfile() {
  const d = currentVehicleAnalysis;
  if (!d) return;
  const patch = d.generatedProfile;
  const v = d.vehicle;
  const applied = []; const conflicts = [];
  const scalarKeys = ['primaryUse', 'passengers', 'fuel', 'budget'];
  profile.interestedVehicle = `${v.make} ${v.model}`;
  profile.sourceVehicle = `${v.make} ${v.model}`;
  scalarKeys.forEach((k) => {
    if (!patch[k]) return;
    if (!profile[k]) { profile[k] = patch[k]; applied.push(k); }
    else if (profile[k] !== patch[k]) conflicts.push(`${k}: keeping your "${profile[k]}" (vehicle suggested "${patch[k]}")`);
  });
  ['cargo', 'terrain', 'features', 'bodyStyles'].forEach((k) => {
    (patch[k] || []).forEach((val) => { if (!profile[k].includes(val)) { profile[k].push(val); applied.push(k); } });
  });
  Object.entries(patch.priorities || {}).forEach(([k, val]) => {
    if (!profile.prioritiesMentioned.includes(k)) { profile.priorities[k] = val; profile.prioritiesMentioned.push(k); applied.push('priorities'); }
  });

  isComplete = false;
  profileConfirmed = false; awaitingConfirmation = false;
  guidelines = buildGuidelines(profile);
  // Pick the first thing we still need from the user, so the chat edits the draft in order.
  topicIndex = !profile.firstName ? 0 : (!profile.household && !profile.experience) ? 1 : (profile.dailyMiles === null || profile.dailyMiles === '') ? 3 : 6;
  renderProfilePanel(); renderTopicProgress();

  const conflictText = conflicts.length ? `\n\nI kept some of your earlier answers where they conflicted — tell me if you'd rather switch: ${conflicts.join('; ')}.` : '';
  addMessage('agent', `Done — I've drafted your profile from the ${v.make} ${v.model} ✨\n\nAssumptions I've made (all editable, just tell me what to change):\n• ${d.profileAssumptions.join('\n• ')}${conflictText}\n\nNow let's edit it together so it sounds like you, not just the car. ${TOPICS[topicIndex].prompt()}`);
  customQuickReplies = TOPICS[topicIndex].quick;
  save();
  $('#chatInput')?.focus({ preventScroll: true });
}

// ---------------- Profile panel + guidelines ----------------
function inferPersona(p) {
  if (p.primaryUse === 'Family transport' || ['5', '6+'].includes(String(p.passengers)) || /family/i.test(p.household)) return { name: 'The Family Anchor', blurb: 'Space, safety, and sanity for everyone on board — every single day.' };
  if (p.primaryUse === 'Adventure / outdoors' || p.terrain.includes('Off-road / trails')) return { name: 'The Weekend Explorer', blurb: 'Weekday practical, weekend unstoppable. Ground clearance is a love language.' };
  if (p.primaryUse === 'Work / business' || p.cargo.includes('Work tools / equipment')) return { name: 'The Hard-Working Pro', blurb: 'Your vehicle is a tool of the trade — capability and uptime come first.' };
  if ((p.dailyMiles ?? 0) >= 40 || p.primaryUse === 'Daily commute') return { name: 'The Mile-Munching Commuter', blurb: 'You live on the road — economy, comfort, and reliability will pay you back daily.' };
  if (p.primaryUse === 'City runabout') return { name: 'The City Navigator', blurb: 'Small footprint, easy parking, low costs — maximum city freedom.' };
  if (p.primaryUse === 'First car / learning' || p.experience === 'First-time buyer') return { name: 'The Confident Starter', blurb: 'Safe, affordable, and forgiving — the perfect first chapter on four wheels.' };
  return { name: 'The Balanced Driver', blurb: 'A bit of everything, done well — versatility is your superpower.' };
}
function topPriorities(p, n = 3) {
  return Object.entries(p.priorities).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k]) => PRIORITY_DEFS.find((d) => d.key === k)?.label || k);
}
function suggestedCategories(p) {
  const out = new Set(p.bodyStyles.filter((b) => b !== 'Not sure yet'));
  if (p.primaryUse === 'Family transport') { out.add('SUV / Crossover'); out.add('Minivan'); }
  if (p.primaryUse === 'Adventure / outdoors') out.add('SUV / Crossover');
  if (p.primaryUse === 'Work / business') out.add('Truck / Pickup');
  if (p.primaryUse === 'City runabout') out.add('Hatchback');
  if (out.size === 0) out.add('SUV / Crossover');
  return [...out].slice(0, 4);
}

function buildGuidelines(p) {
  const blocks = [];
  const cats = suggestedCategories(p);
  const persona = inferPersona(p);
  blocks.push({ title: `🚗 Start here: ${cats.join(' · ')}`, type: 'normal', points: [
    ...(p.interestedVehicle ? [`Vehicle under consideration: ${p.interestedVehicle} — we'll test it against these guidelines and flag where it clashes with your life/budget.`] : []),
    `Driver persona: ${persona.name} — ${persona.blurb}`,
    p.primaryUse ? `Optimised for: ${p.primaryUse.toLowerCase()}.` : 'Primary use not specified yet — categories stay broad until we know more.',
    p.bodyStyles.length && !p.bodyStyles.includes('Not sure yet') ? `You leaned toward: ${p.bodyStyles.join(', ')} — we'll honour that unless it clashes with your lifestyle.` : 'No body-style bias from you, so lifestyle and budget decide the shape.',
  ]});

  const annual = p.dailyMiles ? p.dailyMiles * 365 : null;
  const fuelPoints = [];
  if (p.fuel) fuelPoints.push(`Your stated preference: ${p.fuel}.`);
  if (annual) fuelPoints.push(`At ~${p.dailyMiles} miles/day (~${annual.toLocaleString()}/year), fuel/energy cost is a ${annual > 12000 ? 'major' : 'moderate'} factor in total ownership cost.`);
  if (!p.fuel && annual && annual > 12000) fuelPoints.push('No fuel preference stated: with this mileage we will favour hybrid/EV options for running-cost reasons.');
  if (p.fuel === 'Electric (EV)') fuelPoints.push('EV shortlist only — and we will check home/workplace charging before ranking any EV highly.');
  if (p.terrain.includes('Snow / ice')) fuelPoints.push('Snow/ice driving: AWD or good winter tyres become a requirement, not a nice-to-have.');
  if (p.terrain.includes('Off-road / trails')) fuelPoints.push('Off-road use: ground clearance and drivetrain capability filter the list before anything else.');
  if (!fuelPoints.length) fuelPoints.push('Powertrain stays open (petrol / hybrid / EV) until mileage and charging access are clearer.');
  blocks.push({ title: '⛽ Powertrain & running costs', type: 'normal', points: fuelPoints });

  const spacePoints = [];
  if (p.passengers) spacePoints.push(`Must comfortably carry: ${p.passengers} passenger(s) at most.`);
  if (p.cargo.length) spacePoints.push(`Regular cargo: ${p.cargo.join(', ').toLowerCase()} — cargo space/flexibility is scored accordingly.`);
  if (p.features.includes('Third-row seating')) spacePoints.push('Third-row seating requested — 2-row-only vehicles are excluded.');
  if (p.household) spacePoints.push(`Household context: ${p.household}.`);
  if (!spacePoints.length) spacePoints.push('Space needs look standard — no special seating or cargo constraints captured yet.');
  blocks.push({ title: '🪑 Space & practicality', type: 'normal', points: spacePoints });

  const budgetPoints = [];
  if (p.budget) budgetPoints.push(`Purchase budget guardrail: ${p.budget}. We rank by total cost, not sticker price alone.`);
  if (p.monthly) budgetPoints.push(`Monthly comfort zone: ${p.monthly}${p.payment ? ` (${p.payment.toLowerCase()})` : ''}.`);
  else if (p.payment) budgetPoints.push(`Payment approach: ${p.payment}.`);
  if (p.condition) budgetPoints.push(`Condition: ${p.condition} — the search pool is filtered accordingly.`);
  if (p.keepYears) budgetPoints.push(`Keeping it ${p.keepYears}: reliability and depreciation over that horizon weigh into rankings.`);
  if (p.timeline) budgetPoints.push(`Timing: ${p.timeline}.`);
  if (!budgetPoints.length) budgetPoints.push('No budget captured yet — we will not rank vehicles until a budget guardrail exists.');
  blocks.push({ title: '💰 Budget guardrails', type: p.budget || p.monthly ? 'normal' : 'warning', points: budgetPoints });

  const tops = topPriorities(p, 4);
  const prioPoints = [];
  if (tops.length) prioPoints.push(`Ranking weights — your top priorities: ${tops.join(' > ')}. Matches are scored against these first.`);
  if (p.features.length) prioPoints.push(`Must-have features (absence = penalty): ${p.features.join(', ')}.`);
  if (p.notes) prioPoints.push(`In your words: “${p.notes}”`);
  if (!prioPoints.length) prioPoints.push('Priorities not ranked yet — we will assume safety and reliability lead until you say otherwise.');
  blocks.push({ title: '⭐ Priorities & must-haves', type: 'normal', points: prioPoints });

  const breakers = [];
  if (['5', '6+'].includes(String(p.passengers)) || p.features.includes('Third-row seating')) breakers.push('Exclude small cars and 2-row-only vehicles that cannot carry your passengers.');
  if (p.cargo.includes('Work tools / equipment') || p.features.includes('Towing capacity')) breakers.push('Exclude vehicles without the payload/towing capacity your use demands.');
  if (p.terrain.includes('Snow / ice')) breakers.push('Exclude RWD-only, low-clearance options unless winter-tyre plan is confirmed.');
  if (p.fuel === 'Electric (EV)') breakers.push('Exclude petrol/diesel-only models — and any EV whose range does not cover your daily miles with margin.');
  if (p.primaryUse === 'City runabout') breakers.push('Exclude oversized trucks/large SUVs — parking and city running costs work against you.');
  blocks.push({ title: '⛔ Deal-breakers', type: breakers.length ? 'dealbreaker' : 'normal', points: breakers.length ? breakers : ['No hard deal-breakers captured yet — tell Maya anything you refuse to compromise on.'] });

  blocks.push({ title: '➡️ How we will select your vehicles next', type: 'normal', points: [
    'Step 1: filter by the deal-breakers and budget guardrails above.',
    `Step 2: score what remains against your priorities (${tops.join(', ') || 'safety, reliability'} first).`,
    'Step 3: present a short ranked list with total-cost breakdowns and the trade-offs of each — no black box.',
  ]});
  return blocks;
}

function profileCompleteness(p) {
  const checks = [p.firstName, p.location, p.household || p.experience, p.primaryUse, p.dailyMiles !== null && p.dailyMiles !== '', p.passengers || p.cargo.length, p.bodyStyles.length || p.fuel, p.budget || p.monthly, p.prioritiesMentioned.length || Object.keys(p.priorities).length];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}
function groupHtml(title, items) {
  const clean = items.filter(([, v]) => v && (!Array.isArray(v) || v.length));
  if (!clean.length) return '';
  return `<div class="profile-group"><h4>${escapeHtml(title)}</h4><ul>${clean.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(Array.isArray(v) ? v.join(', ') : v)}</li>`).join('')}</ul></div>`;
}
function renderProfilePanel() {
  const pct = profileCompleteness(profile);
  $('#profileProgress').style.width = pct + '%';
  $('#profileProgressLabel').textContent = isComplete ? 'Profile complete — guidelines are ready below' : `${pct}% complete — ${TOPICS[Math.min(topicIndex, TOPICS.length - 1)]?.label || ''} next`;
  const persona = inferPersona(profile);
  const hasAnything = pct > 0;
  $('#personaPanel').innerHTML = hasAnything ? `<div class="persona-banner"><small style="letter-spacing:.1em;font-weight:800">YOUR DRIVER PERSONA</small><h3>${escapeHtml(persona.name)}${profile.firstName ? ` — hi, ${escapeHtml(profile.firstName)}!` : ''}</h3><p>${escapeHtml(persona.blurb)}</p></div>` : '';
  const tops = topPriorities(profile, 4);
  $('#profilePanel').innerHTML = hasAnything ? [
    groupHtml('About you', [['Name', profile.firstName], ['Location', profile.location], ['Country', profile.country], [currentMarket().postalLabel.charAt(0).toUpperCase() + currentMarket().postalLabel.slice(1), profile.postalCode], ['Household', profile.household], ['Experience', profile.experience]]),
    groupHtml('Driving life', [['Main use', profile.primaryUse], ['Daily miles', profile.dailyMiles !== null && profile.dailyMiles !== '' ? `~${profile.dailyMiles} (${(profile.dailyMiles * 365).toLocaleString()}/yr)` : ''], ['Passengers', profile.passengers], ['Carries', profile.cargo], ['Roads', profile.terrain]]),
    groupHtml('Vehicle leanings', [['Interested in', profile.interestedVehicle], ['Drafted from', profile.sourceVehicle], ['Body styles', profile.bodyStyles], ['Fuel', profile.fuel], ['Condition', profile.condition], ['Must-haves', profile.features]]),
    groupHtml('Budget & ownership', [['Budget', profile.budget], ['Monthly', profile.monthly], ['Payment', profile.payment], ['Keep for', profile.keepYears], ['Trade-in', profile.tradeIn], ['Timeline', profile.timeline]]),
    tops.length ? `<div class="profile-group"><h4>Top priorities</h4><div class="tag-list">${tops.map((t) => `<span class="tag">⭐ ${escapeHtml(t)}</span>`).join('')}</div></div>` : '',
    profile.notes ? `<div class="profile-group"><h4>In your words</h4><p>“${escapeHtml(profile.notes)}”</p></div>` : '',
  ].join('') : '<p class="empty-state">Nothing here yet. As you chat, Maya will fill this in — your lifestyle, budget, must-haves, and priorities.</p>';

  if (!guidelines.length && (isComplete || pct >= 60)) guidelines = buildGuidelines(profile);
  const gp = $('#guidelinesPanel');
  if (guidelines.length && pct > 0) {
    gp.hidden = false;
    $('#guidelinesContent').innerHTML = guidelines.map((g) => `<div class="guideline-block ${g.type}"><h4>${escapeHtml(g.title)}</h4><ul>${g.points.map((pt) => `<li>${escapeHtml(pt)}</li>`).join('')}</ul></div>`).join('');
  } else gp.hidden = true;
  if (profile.firstName) $('#fcName').textContent = `Welcome, ${profile.firstName}!`;
}

// ---------------- Persistence / misc ----------------
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile, market: selectedMarketCode, marketSource, currency: selectedCurrency, conversation, topicIndex, isComplete, profileConfirmed, awaitingConfirmation, guidelines, vehicleAnalysis: currentVehicleAnalysis, suggestions: currentSuggestions, dealerResults, finance: (() => { try { return getFinanceInputs(); } catch { return null; } })(), savedAt: Date.now() }));
      $('#saveNote').textContent = '✓ Saved';
      $('#resumeBtn').hidden = false;
    } catch { $('#saveNote').textContent = 'Could not save'; }
  }, 250);
}
function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return;
    const data = JSON.parse(raw);
    if (data.profile) profile = { ...emptyProfile(), ...data.profile, priorities: data.profile.priorities || {}, prioritiesMentioned: data.profile.prioritiesMentioned || [] };
    setMarket(data.market || profile.countryCode || '', { source: data.marketSource || (data.market ? 'chat' : 'default'), updateFinance: false, currency: data.currency || undefined });
    if (data.currency) selectedCurrency = data.currency;
    if (Array.isArray(data.conversation)) conversation = data.conversation;
    topicIndex = data.topicIndex || 0; isComplete = !!data.isComplete;
    profileConfirmed = !!data.profileConfirmed;
    awaitingConfirmation = typeof data.awaitingConfirmation === 'boolean' ? data.awaitingConfirmation : (isComplete && !profileConfirmed);
    guidelines = Array.isArray(data.guidelines) ? data.guidelines : [];
    if (data.vehicleAnalysis?.vehicle) {
      currentVehicleAnalysis = data.vehicleAnalysis;
      renderVehiclePanel(false);
      if (data.finance) {
        if (data.finance.currency) $('#finCurrency').value = data.finance.currency;
        if (data.finance.price) $('#finPrice').value = data.finance.price;
        if (data.finance.deposit) $('#finDeposit').value = data.finance.deposit;
        if (data.finance.tradeIn) $('#finTradeIn').value = data.finance.tradeIn;
        if (data.finance.fees) $('#finFees').value = data.finance.fees;
        if (data.finance.termMonths) $('#finTerm').value = String(data.finance.termMonths);
        if (data.finance.apr !== undefined) $('#finApr').value = data.finance.apr;
        renderFinanceResults();
      }
    }
    if (data.suggestions?.candidates?.length) { currentSuggestions = data.suggestions; dealerResults = data.dealerResults || {}; renderSuggestions(); }
    if (conversation.length) {
      $('#resumeBtn').hidden = false;
      $('#agent').hidden = false; started = true;
      renderConversation(); renderQuickReplies();
    }
  } catch { /* ignore corrupt storage */ }
}
function applySeed(prefill, prefillFuel) {
  if (prefill) addUnique(profile, 'bodyStyles', prefill);
  if (prefillFuel) profile.fuel = prefillFuel;
  if (prefill || prefillFuel) save();
}
function downloadProfile() {
  if (!guidelines.length) guidelines = buildGuidelines(profile);
  const payload = { format: 'drivematch-profile-guidelines/v1', profile, guidelines, profileConfirmed, market: selectedMarketCode, currency: selectedCurrency, vehicleAnalysis: currentVehicleAnalysis, suggestions: currentSuggestions, dealerResults, finance: (() => { try { return { ...getFinanceInputs(), estimate: calculateFinance(getFinanceInputs()) }; } catch { return null; } })(), persona: inferPersona(profile), exportedAt: new Date().toISOString(), source: llmIsConfigured() ? backend.providerModel : 'local-agent' };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `drivematch-guidelines-${(profile.firstName || 'driver').toLowerCase()}.json`; a.click();
  URL.revokeObjectURL(a.href); showToast('Guidelines downloaded (JSON) — upload this file on your next visit to restore your profile.');
}

function downloadGuidelinesPdf() {
  if (!guidelines.length) guidelines = buildGuidelines(profile);
  const persona = inferPersona(profile);
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const profileRows = [
    ['Name', profile.firstName], ['Location', [profile.location, profile.postalCode, profile.country].filter(Boolean).join(', ')],
    ['Household', profile.household], ['Main use', profile.primaryUse],
    ['Daily driving', profile.dailyMiles !== null && profile.dailyMiles !== '' ? `~${profile.dailyMiles} miles/day` : ''],
    ['Budget', profile.budget], ['Monthly comfort', profile.monthly], ['Fuel preference', profile.fuel],
    ['Body styles', (profile.bodyStyles || []).join(', ')], ['Must-haves', (profile.features || []).join(', ')],
    ['Interested in', profile.interestedVehicle],
  ].filter(([, v]) => v);
  $('#printArea').innerHTML = `
    <h1>DriveMatch — Your Vehicle-Selection Guidelines</h1>
    <p class="print-meta">For ${escapeHtml(profile.firstName || 'you')} · ${escapeHtml(persona.name)} · Generated ${escapeHtml(date)}</p>
    <p>${escapeHtml(persona.blurb)}</p>
    <h2>Your profile at a glance</h2>
    <ul>${profileRows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`).join('')}</ul>
    <h2>Guidelines we'll use to select your vehicles</h2>
    ${guidelines.map((g) => `<div class="print-block"><h3>${escapeHtml(g.title)}</h3><ul>${g.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>`).join('')}
    <p class="print-meta">Keep this file with its JSON companion: upload the JSON at drivematch on your next visit and your agent will restore this profile and suggest vehicles from these guidelines. Prices and offers change — verify before buying.</p>`;
  document.body.classList.add('printing-guidelines');
  const cleanup = () => { document.body.classList.remove('printing-guidelines'); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 1000);
}

// ---- Returning users: upload a previously downloaded guidelines JSON ----
function sanitiseUploadedProfile(input) {
  const clean = emptyProfile();
  if (!input || typeof input !== 'object') return clean;
  for (const key of Object.keys(clean)) {
    if (!(key in input)) continue;
    const val = input[key];
    if (Array.isArray(clean[key])) { if (Array.isArray(val)) clean[key] = val.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 100)); }
    else if (key === 'priorities') {
      if (val && typeof val === 'object') for (const [k, v] of Object.entries(val)) clean.priorities[k] = clamp(Number(v) || 0, 0, 5);
    } else if (key === 'dailyMiles') clean[key] = val === null || val === '' ? null : clamp(Number(val) || 0, 0, 500);
    else if (typeof val === 'string') clean[key] = val.slice(0, 300);
  }
  if (Array.isArray(input.prioritiesMentioned)) clean.prioritiesMentioned = input.prioritiesMentioned.filter((x) => typeof x === 'string').slice(0, 10);
  return clean;
}
async function handleGuidelinesUpload(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const uploadedProfile = parsed.profile || parsed.driverProfile || null;
    const uploadedGuidelines = sanitiseGuidelines(parsed.guidelines || parsed.selectionGuidelines || []);
    if (!uploadedProfile && !uploadedGuidelines.length) throw new Error('That file does not look like a DriveMatch guidelines export (no profile or guidelines found).');

    // Open the chat without the standard greeting if this is a fresh visit.
    const sec = $('#agent'); sec.hidden = false; started = true;
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (uploadedProfile) {
      const keepMarket = { country: profile.country, countryCode: profile.countryCode, postalCode: profile.postalCode };
      profile = { ...sanitiseUploadedProfile(uploadedProfile) };
      if (!profile.country && keepMarket.country) { profile.country = keepMarket.country; profile.countryCode = keepMarket.countryCode; profile.postalCode = profile.postalCode || keepMarket.postalCode; }
    } else {
      // Guidelines-only file: derive a starter profile from the text so
      // suggestions have something to score against.
      profile = emptyProfile();
      extractFromText(uploadedGuidelines.map((g) => `${g.title} ${g.points.join(' ')}`).join(' '), 'priorities');
    }
    if (profile.countryCode) setMarket(profile.countryCode, { source: 'chat', currency: parsed.currency || undefined });
    guidelines = uploadedGuidelines.length ? uploadedGuidelines : buildGuidelines(profile);
    profileConfirmed = true; awaitingConfirmation = false; isComplete = true; topicIndex = TOPICS.length;
    currentSuggestions = null; dealerResults = {};
    renderTopicProgress(); renderProfilePanel(); renderSuggestions();
    addMessage('agent', `Welcome back${profile.firstName ? `, ${profile.firstName}` : ''}! 👋 I've restored your profile and guidelines from your uploaded file.\n\n🧭 Your guidelines are active again:\n\n${guidelinesToText()}\n\nWant me to suggest vehicles from these guidelines right away, or would you like to change anything first?`);
    customQuickReplies = ['🚗 Suggest vehicles for me', '✏️ Edit my profile', '⬇ Download guidelines (PDF)', '⬇ Download guidelines (JSON)'];
    renderQuickReplies();
    showToast('Guidelines restored — welcome back!');
    save();
  } catch (err) {
    console.warn('Guidelines upload failed:', err);
    showToast('Could not read that file — please upload the DriveMatch guidelines JSON you downloaded.');
    if (started) addMessage('system', 'That upload did not look like a DriveMatch guidelines JSON, so nothing was changed. Download your guidelines as JSON from a completed profile, then upload that file.');
  } finally {
    const input = $('#guidelinesUpload'); if (input) input.value = '';
  }
}
function confirmRestart() {
  if (!confirm('Start over? This clears your saved chat and profile on this device.')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}
let toastTimer;
function showToast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
}
