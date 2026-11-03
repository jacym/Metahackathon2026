// ModMarket — search-grounded modification planning (backend).
//
// The user names a vehicle, what they want to change (looks, power,
// handling...), and a budget. This module:
//   1. Classifies their goals into mod categories.
//   2. Runs targeted web searches per category — forum/Reddit sentiment,
//      best-part discussions, retailer pricing, compatibility warnings.
//   3. Asks the routed Muse model (via the injected callLLM) to build a
//      staged plan ONLY from those sources: parts with indicative price
//      ranges, per-category sentiment (Reddit / forums / owner reviews),
//      install difficulty, risks, and what to avoid.
//   4. Sanitises everything and does the budget maths on the server.
// Nothing is invented: where sources are thin, fields come back empty
// and the plan says so. Power/tuning plans always carry warranty,
// emissions/legality and supporting-mod warnings.
const { runSearches, normalizeMarket } = require('./vehicleGrounding');

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
function moneyNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; }
  return num(v);
}
function moneyRange(v) {
  if (typeof v === 'string') { const nums = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/g); if (nums?.length >= 2) return [parseFloat(nums[0]), parseFloat(nums[1])]; }
  return null;
}
const arr = (v, max = 12) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).slice(0, max) : []);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

const GOAL_CATEGORIES = [
  { id: 'carbon-aero', label: 'Carbon fibre & aero dress-up', search: 'carbon fiber front splitter side skirts rear diffuser spoiler aero kit', words: ['carbon', 'aero', 'splitter', 'spoiler', 'diffuser', 'wing', 'lip', 'dress', 'body kit', 'exterior'] },
  { id: 'wheels-tyres', label: 'Wheels & tyres', search: 'best wheels wheel fitment tyres tire setup offset', words: ['wheel', 'rims', 'tyres', 'tires', 'fitment'] },
  { id: 'suspension', label: 'Suspension & stance', search: 'coilovers lowering springs suspension setup handling stance', words: ['coilover', 'suspension', 'lower', 'stance', 'springs', 'air suspension'] },
  { id: 'power-tune', label: 'Power — tuning & bolt-ons', search: 'stage 1 tune ECU remap intake downpipe intercooler bolt-ons dyno results reliability', words: ['tune', 'tuning', 'remap', 'stage 1', 'stage 2', 'power', 'horsepower', 'hp', 'intake', 'turbo', 'supercharger', 'intercooler', 'downpipe', 'ecu', 'faster'] },
  { id: 'exhaust-sound', label: 'Exhaust & sound', search: 'cat-back exhaust axle-back sound clips drone valved exhaust', words: ['exhaust', 'sound', 'cat-back', 'catback', 'axle-back', 'muffler', 'loud'] },
  { id: 'brakes', label: 'Brakes', search: 'big brake kit brake pads rotors brake upgrade track street', words: ['brake', 'bbk', 'pads', 'rotors', 'stopping'] },
  { id: 'handling', label: 'Handling & chassis', search: 'sway bars anti roll bars alignment chassis bracing handling mods', words: ['handling', 'sway bar', 'anti-roll', 'chassis', 'corner', 'grip'] },
  { id: 'interior', label: 'Interior & comfort', search: 'seats steering wheel interior mods short shifter gauges', words: ['interior', 'seats', 'steering wheel', 'shifter', 'gauges', 'cabin'] },
  { id: 'lighting-wrap', label: 'Lighting, wrap & styling details', search: 'vinyl wrap paint protection lighting headlights styling mods legality', words: ['wrap', 'lighting', 'lights', 'headlights', 'tint', 'styling', 'paint'] },
  { id: 'offroad', label: 'Off-road & overland', search: 'lift kit all terrain tyres skid plates off road overland mods', words: ['off-road', 'offroad', 'overland', 'lift', '4x4', 'trail'] },
  { id: 'audio-tech', label: 'Audio & tech', search: 'audio upgrade speakers subwoofer head unit carplay retrofit', words: ['audio', 'speakers', 'subwoofer', 'stereo', 'carplay', 'tech'] },
];

function classifyGoals(text, selectedIds = []) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  const found = new Map();
  for (const cat of GOAL_CATEGORIES) {
    if (selectedIds.includes(cat.id)) found.set(cat.id, cat);
    else if (cat.words.some((w) => lower.includes(w))) found.set(cat.id, cat);
  }
  return [...found.values()];
}

function parseJson(content) {
  try {
    const cleaned = String(content || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return null; }
}

function sanitiseSentiment(raw) {
  if (!raw || (num(raw.score) === null && !arr(raw.loves).length && !arr(raw.complaints).length)) return null;
  return {
    score: num(raw.score) === null ? null : clamp(Math.round(num(raw.score)), 0, 100),
    sources: arr(raw.sources, 4).map((s) => ({
      type: str(s.type, 50) || 'Owner sources',
      score: num(s.score) === null ? null : clamp(Math.round(num(s.score)), 0, 100),
      themes: arr(s.themes, 5).map((x) => str(x, 120)).filter(Boolean),
    })),
    loves: arr(raw.loves, 5).map((x) => str(x, 150)).filter(Boolean),
    complaints: arr(raw.complaints, 5).map((x) => str(x, 150)).filter(Boolean),
    note: str(raw.note, 360),
  };
}

async function suggestMods({ vehicle, goalsText = '', goalIds = [], budgetAmount, currency, market: marketInput, experience = '', usage = '', notes = '', callLLM } = {}) {
  const market = normalizeMarket(marketInput);
  const vehicleName = str(vehicle, 140);
  if (vehicleName.length < 3) throw Object.assign(new Error('Tell me the make and model first.'), { status: 400 });
  const categories = classifyGoals(`${goalsText} ${(goalIds || []).join(' ')}`, goalIds);
  if (!categories.length) throw Object.assign(new Error('Tell me what you want to change — looks, power, handling, sound...'), { status: 400 });
  const budget = num(budgetAmount);
  const budgetCurrency = str(currency, 3).toUpperCase() || market.currency || '';
  const today = new Date().toISOString().slice(0, 10);

  const searches = [];
  for (const cat of categories.slice(0, 5)) {
    searches.push({ type: `sentiment-${cat.id}`, query: `${vehicleName} ${cat.search} reddit forum owner opinions best brands problems` });
    searches.push({ type: `parts-${cat.id}`, query: `${vehicleName} ${cat.label} best parts price buy ${market.country || ''} ${budgetCurrency}` });
  }
  searches.push({ type: 'warnings', query: `${vehicleName} modifications warranty emissions legality insurance problems to avoid ${categories.some((c) => c.id === 'power-tune') ? 'tune reliability supporting mods' : ''}` });
  searches.push({ type: 'builds', query: `${vehicleName} build guide ${categories.map((c) => c.label).join(' ')} budget build forum` });

  const { provider, sources, warnings } = await runSearches(searches.slice(0, 12));
  if (!sources.length) throw Object.assign(new Error(`Mod research could not retrieve any sources (${(warnings || []).join('; ') || 'no search provider available'}).`), { status: 503 });
  const validSourceIds = new Set(sources.map((s) => s.id));
  const sourceText = sources.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, 2000)}`).join('\n\n');

  const { text, modelUsed, modelTier, fellBackFrom } = await callLLM({
    task: 'mod-research',
    messages: [
      { role: 'system', content: `You are ModMarket's grounded modification planner. Today is ${today}. Build a modification plan for the user's vehicle using ONLY the web sources provided. Rules:
- Every part, price range and sentiment claim must come from the sources; cite source IDs in each part's sourceIds. Never invent specific part prices — use a range only where sources support one, otherwise null with a note.
- Be SPECIFIC: every part must name the exact brand and product line/model as it is sold (e.g. a named manufacturer's named product, not "a stage 1 tune" or "performance tyres"). Put the manufacturer in brand and the full product name in name. If the sources genuinely cannot support a specific retail product, keep the recommendation generic, leave brand empty, and say so in the price note — never attach an invented brand to a generic idea.
- Every part needs an estimated price (min–max in the user's currency where sources allow) and an estimated install cost range (or DIY). A part without any price support must say why in its price note.
- Sentiment per part/category must be derived from Reddit, forum and owner-review sources: give a 0-100 score (estimate from retrieved text, and say so), per-source-type breakdown (Reddit, Forums, Owner reviews), loves and complaints. If sentiment sources are thin, score null.
- Respect the budget: sequence the plan in stages (do the highest-value, best-sentiment items first), keep Stage 1 comfortably inside budget, and put overflow in later stages instead of pretending everything fits.
- Order matters: tyres/brakes/handling before big power; a tune needs its supporting mods (cooling, intake/exhaust, maintenance) — say so. Flag warranty, emissions/legality, insurance and safety implications honestly, especially for tuning and lighting/tint.
- Prefer reversible, well-supported mods for beginners; call out cheap parts with poor forum sentiment as "avoid" alternatives.
Return ONLY valid JSON: {"summary":"","overallWarnings":[],"avoid":[""],"stages":[{"name":"","goal":"","parts":[{"name":"","brand":"","category":"","stage":"","purpose":"","priceEstimate":{"currency":"","min":null,"max":null,"note":""},"install":{"difficulty":"easy|moderate|hard|professional","costMin":null,"costMax":null,"diyPossible":true},"sentiment":{"score":null,"sources":[{"type":"Reddit","score":null,"themes":[]},{"type":"Forums","score":null,"themes":[]},{"type":"Owner reviews","score":null,"themes":[]}],"loves":[],"complaints":[],"note":""},"pros":[],"cons":[],"compatibility":"","risks":[],"sourceIds":[]}]}]}` },
      { role: 'user', content: `Vehicle: ${vehicleName}\nGoals: ${categories.map((c) => c.label).join('; ')}${goalsText ? `\nIn their words: ${goalsText}` : ''}\nBudget: ${budget ? `${budgetCurrency} ${budget}` : 'not stated — propose a sensible staged spend and say what you assumed'}\nMarket: ${market.country || 'not specified'}${market.currency ? ` (${market.currency})` : ''}\nExperience/current state: ${experience || 'not stated'}\nMain use: ${usage || 'not stated'}\nExtra notes: ${notes || '(none)'}\n\nWEB SOURCES:\n${sourceText}` },
    ],
    maxTokens: Number(process.env.MOD_MAX_TOKENS || 9000), temperature: 0.2,
    timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
    reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
  });
  const parsed = parseJson(text);
  if (!parsed || !Array.isArray(parsed.stages)) throw Object.assign(new Error('The mod planner returned an unexpected format.'), { status: 502 });

  const stages = arr(parsed.stages, 4).map((stage) => ({
    name: str(stage.name, 80) || 'Stage',
    goal: str(stage.goal, 200),
    parts: arr(stage.parts, 8).map((p) => ({
      name: str(p.name, 120), brand: str(p.brand, 60), category: str(p.category, 60), stage: str(p.stage, 60),
      purpose: str(p.purpose, 260),
      priceEstimate: {
        currency: str(p.priceEstimate?.currency, 3).toUpperCase() || budgetCurrency,
        min: moneyNum(p.priceEstimate?.min) ?? moneyRange(p.priceEstimate?.min)?.[0] ?? null,
        max: moneyNum(p.priceEstimate?.max) ?? moneyRange(p.priceEstimate?.min)?.[1] ?? moneyRange(p.priceEstimate?.max)?.[0] ?? null, note: str(p.priceEstimate?.note, 220),
      },
      install: {
        difficulty: ['easy', 'moderate', 'hard', 'professional'].includes(String(p.install?.difficulty || '').toLowerCase()) ? String(p.install.difficulty).toLowerCase() : 'moderate',
        costMin: moneyNum(p.install?.costMin), costMax: moneyNum(p.install?.costMax), diyPossible: p.install?.diyPossible !== false,
      },
      sentiment: sanitiseSentiment(p.sentiment),
      pros: arr(p.pros, 5).map((x) => str(x, 150)).filter(Boolean),
      cons: arr(p.cons, 5).map((x) => str(x, 150)).filter(Boolean),
      compatibility: str(p.compatibility, 260), risks: arr(p.risks, 5).map((x) => str(x, 150)).filter(Boolean),
      sourceIds: arr(p.sourceIds, 6).map((x) => str(x, 10)).filter((id) => validSourceIds.has(id)),
      specificity: str(p.brand, 60) ? 'specific' : 'generic',
    })).filter((p) => p.name),
  })).filter((s) => s.parts.length);

  const enrichmentSources = await enrichSpecificParts(stages, { vehicleName, market, budgetCurrency, today, callLLM });
  if (enrichmentSources?.length) sources.push(...enrichmentSources);

  for (const stage of stages) {
    stage.subtotal = {
      partsMin: stage.parts.reduce((a, p) => a + (p.priceEstimate.min || 0), 0),
      partsMax: stage.parts.reduce((a, p) => a + (p.priceEstimate.max || p.priceEstimate.min || 0), 0),
      installMin: stage.parts.reduce((a, p) => a + (p.install.costMin || 0), 0),
      installMax: stage.parts.reduce((a, p) => a + (p.install.costMax || p.install.costMin || 0), 0),
      currency: budgetCurrency,
    };
  }
  const allParts = stages.flatMap((s) => s.parts);
  const totalMin = allParts.reduce((acc, p) => acc + (p.priceEstimate.min || 0), 0);
  const totalMax = allParts.reduce((acc, p) => acc + (p.priceEstimate.max || p.priceEstimate.min || 0), 0);
  const installMin = allParts.reduce((acc, p) => acc + (p.install.costMin || 0), 0);
  const installMax = allParts.reduce((acc, p) => acc + (p.install.costMax || p.install.costMin || 0), 0);
  const hasPower = categories.some((c) => c.id === 'power-tune');
  const overallWarnings = [
    ...arr(parsed.overallWarnings, 6).map((x) => str(x, 220)).filter(Boolean),
    ...(hasPower ? ['Tuning can affect manufacturer warranty and emissions compliance — check your local rules and tell your insurer before you flash anything.'] : []),
    'Prices are indicative ranges from public listings/discussions, not quotes — confirm fitment for your exact year/trim/engine before ordering.',
  ];

  return {
    vehicle: vehicleName, goals: categories.map((c) => ({ id: c.id, label: c.label })),
    model: { used: modelUsed || null, tier: modelTier || null, ...(fellBackFrom ? { fellBackFrom } : {}) },
    budget: budget ? { amount: budget, currency: budgetCurrency } : null,
    asOf: today, market,
    dataSource: `Search-grounded mod research from ${sources.length} web source(s) via ${provider}, retrieved ${today} — including forum/Reddit-style owner sentiment. Sentiment scores are estimates from the retrieved sources, not representative surveys.`,
    sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, publishedDate: s.publishedDate || '', queryType: s.queryType })),
    summary: str(parsed.summary, 700),
    stages, totals: { partsMin: totalMin, partsMax: totalMax, installMin, installMax, grandMin: totalMin + installMin, grandMax: totalMax + installMax, currency: budgetCurrency, partCount: allParts.length, specificCount: allParts.filter((p) => p.specificity === 'specific').length, pricedCount: allParts.filter((p) => p.priceEstimate.min !== null || p.priceEstimate.max !== null).length, withinBudget: budget ? (totalMax + installMax) <= budget : null, stage1Max: stages[0]?.parts.reduce((a, p) => a + (p.priceEstimate.max || p.priceEstimate.min || 0), 0) || 0 },
    avoid: arr(parsed.avoid, 6).map((x) => str(x, 200)).filter(Boolean),
    overallWarnings: [...new Set(overallWarnings)],
  };
}

// Focused second pass: any part that came back generic (no brand) or
// unpriced gets a targeted product search so the final plan names real
// retail products with estimated prices — or honestly stays generic.
async function enrichSpecificParts(stages, { vehicleName, market, budgetCurrency, today, callLLM }) {
  const flat = [];
  stages.forEach((stage, si) => stage.parts.forEach((part, pi) => flat.push({ ref: `s${si}p${pi}`, stage, part })));
  const targets = flat.filter(({ part }) => part.specificity !== 'specific' || (part.priceEstimate.min === null && part.priceEstimate.max === null)).slice(0, 6);
  if (!targets.length) return;
  try {
    const searches = [...new Map(targets.map(({ part }) => [part.category, { type: 'product-specific', query: `${vehicleName} ${part.category} ${part.name} best specific products brands price buy ${market.country || ''} ${budgetCurrency}` }])).values()];
    const { sources } = await runSearches(searches);
    if (!sources.length) return [];
    // Namespace enrichment citations (E1, E2...) so they never collide
    // with the main plan's S1.. source list when merged for display.
    sources.forEach((s, i) => { s.id = `E${i + 1}`; });
    const validIds = new Set(sources.map((s) => s.id));
    const sourceText = sources.map((s) => `[${s.id}] (${s.queryType}) ${s.title} — ${s.domain}\nURL: ${s.url}\n${String(s.snippet || '').slice(0, 2200)}`).join('\n\n');
    const { text } = await callLLM({
      task: 'mod-research',
      messages: [
        { role: 'system', content: `You are ModMarket's product researcher. Today is ${today}. For each referenced draft part below, find the exact retail product(s) the sources actually support for this vehicle: real manufacturer brand + full product line/model name as sold, with an estimated price range in ${budgetCurrency || 'the user\'s currency'} and install cost range where sourced. Never invent a brand, product name or price — if the sources cannot support a specific product for a ref, return that ref with brand "" and a note saying specific products could not be verified. Return ONLY valid JSON: {"parts":[{"ref":"s0p0","brand":"","productName":"","priceEstimate":{"currency":"","min":null,"max":null,"note":""},"install":{"costMin":null,"costMax":null},"sourceIds":[]}]}` },
        { role: 'user', content: `Vehicle: ${vehicleName}\nDraft parts to make specific:\n${targets.map((t) => `${t.ref}: [${t.part.category}] ${t.part.name} (purpose: ${t.part.purpose || 'n/a'})`).join('\n')}\n\nWEB SOURCES:\n${sourceText}` },
      ],
      maxTokens: Number(process.env.MOD_MAX_TOKENS || 9000), temperature: 0.1,
      timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
      reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
    });
    const parsed = parseJson(text);
    if (!parsed?.parts) return;
    const byRef = Object.fromEntries(arr(parsed.parts, 8).map((p) => [str(p.ref, 12), p]));
    for (const t of targets) {
      const fix = byRef[t.ref];
      if (!fix) continue;
      const brand = str(fix.brand, 60);
      const productName = str(fix.productName, 140);
      if (brand && productName) { t.part.brand = brand; t.part.name = productName; t.part.specificity = 'specific'; }
      const min = moneyNum(fix.priceEstimate?.min) ?? moneyRange(fix.priceEstimate?.min)?.[0] ?? null;
      const max = moneyNum(fix.priceEstimate?.max) ?? moneyRange(fix.priceEstimate?.min)?.[1] ?? null;
      if (min !== null || max !== null) t.part.priceEstimate = { currency: str(fix.priceEstimate?.currency, 3).toUpperCase() || budgetCurrency, min, max, note: str(fix.priceEstimate?.note, 220) };
      if (moneyNum(fix.install?.costMin) !== null || moneyNum(fix.install?.costMax) !== null) { t.part.install.costMin = moneyNum(fix.install?.costMin); t.part.install.costMax = moneyNum(fix.install?.costMax); }
      const newIds = arr(fix.sourceIds, 5).map((x) => str(x, 10)).filter((id) => validIds.has(id));
      if (newIds.length) t.part.sourceIds = [...new Set([...t.part.sourceIds, ...newIds])].slice(0, 6);
    }
    return sources;
  } catch (err) { console.warn('Mod product enrichment failed:', err.message); return []; /* generic parts stay honestly generic */ }
}

module.exports = { suggestMods, classifyGoals, GOAL_CATEGORIES };
