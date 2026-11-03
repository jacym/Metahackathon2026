// ModMarket agent — intake conversation + grounded build plan.
// Intake (car -> goals -> budget -> details) runs locally; the plan
// itself comes from POST /api/mod-suggestions (search-grounded parts +
// forum/Reddit sentiment, staged against the budget).
const STORAGE_KEY = 'modmarket_build_v1';
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GOALS = [
  { id: 'carbon-aero', label: '✨ Carbon fibre & aero' }, { id: 'wheels-tyres', label: '🛞 Wheels & tyres' },
  { id: 'power-tune', label: '🚀 Power / tuning' }, { id: 'exhaust-sound', label: '🔊 Exhaust & sound' },
  { id: 'suspension', label: '🎯 Suspension & stance' }, { id: 'brakes', label: '🛑 Brakes' },
  { id: 'handling', label: '🧭 Handling & chassis' }, { id: 'interior', label: '🪑 Interior' },
  { id: 'lighting-wrap', label: '💡 Lighting & wrap' }, { id: 'offroad', label: '🏔️ Off-road & overland' },
  { id: 'audio-tech', label: '🎵 Audio & tech' },
];
const STEPS = ['Your car', 'Goals', 'Budget', 'Details', 'Your plan'];

let step = 0; // 0 car, 1 goals, 2 budget, 3 details, 4 planned
let build = { vehicle: '', goalIds: [], goalsText: '', budgetAmount: null, currency: '', experience: '', usage: '', notes: '' };
let plan = null;
let conversation = [];
let busy = false;
let market = { code: '', currency: '' };
let photoDataUrl = '';
let photoAnalysis = null;
let referencePhotos = []; // { label, imageDataUrl }

document.addEventListener('DOMContentLoaded', () => {
  seedFromDriveMatch();
  buildGoalChips();
  loadSaved();
  renderProgress();
  checkBackend();

  if (!conversation.length) {
    addMessage('agent', "Hey! I'm Max, your ModMarket agent ⚙️\n\nTell me what you're driving and I'll build you a staged mod plan from what owners on forums and Reddit actually rate — priced against your budget, in the right order, with the regret-purchases flagged.\n\nFirst: what car are we modifying? Make, model, and year/trim/engine if you know it (e.g. \"2022 Volkswagen Golf GTI\").");
    renderQuick([]);
  } else renderConversation();

  $('#modForm').addEventListener('submit', (e) => { e.preventDefault(); submitInput(); });
  $('#modInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInput(); } });
  $('#modRestartBtn').addEventListener('click', () => { if (confirm('Start a new build? This clears this ModMarket chat and plan.')) { localStorage.removeItem(STORAGE_KEY); location.reload(); } });
  $('#buildPlanBtn').addEventListener('click', () => generatePlan());
  $('#regenBuildBtn').addEventListener('click', () => regenerateBuild());
  $('#downloadBuildBtn').addEventListener('click', downloadPlan);
  $('#uploadBuildBtn').addEventListener('click', () => $('#buildUploadInput').click());
  $('#chatUploadBuildBtn').addEventListener('click', () => $('#buildUploadInput').click());
  $('#buildUploadInput').addEventListener('change', async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await handleBuildUpload(f); });
  $('#photoUploadBtn').addEventListener('click', () => $('#photoInput').click());
  $('#refUploadBtn').addEventListener('click', () => $('#refInput').click());
  $('#photoInput').addEventListener('change', async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await setMainPhoto(f); });
  $('#refInput').addEventListener('change', async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await addReferencePhoto(f); });
  $('#analysePhotoBtn').addEventListener('click', () => analysePhoto());
  $('#researchModsBtn').addEventListener('click', researchIdentifiedMods);
  if (photoDataUrl) renderPhotoPreview();
  renderReferences();
  $('#goalDoneBtn').addEventListener('click', () => { $('#goalPicker').hidden = true; advanceFromGoals(); });
  $$('[data-build]').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.build) build.vehicle = btn.dataset.build;
    (btn.dataset.goals || '').split(',').filter(Boolean).forEach((id) => { if (!build.goalIds.includes(id)) build.goalIds.push(id); });
    syncGoalChips();
    $('#mod-agent').scrollIntoView({ behavior: 'smooth' });
    if (build.vehicle && step === 0) { step = 1; addMessage('agent', `Great starting point — the ${build.vehicle} with ${build.goalIds.map((id) => GOALS.find((g) => g.id === id)?.label.replace(/^\S+\s/, '')).join(' + ')} in mind. Add or remove goals below, then hit Done.`); showGoalPicker(); }
    else if (step === 0) { addMessage('agent', 'Love it — goals noted below. Now, what car are we modifying? Make, model, and year/trim if you know it.'); showGoalPicker(); }
    else showGoalPicker();
    renderProgress(); save();
  }));
});

function seedFromDriveMatch() {
  try {
    const dm = JSON.parse(localStorage.getItem('drivematch_agent_v2') || 'null');
    if (dm?.market) market.code = dm.market;
    if (dm?.currency) { market.currency = dm.currency; build.currency = dm.currency; }
    const liked = dm?.profile?.selectedVehicle || dm?.profile?.interestedVehicle;
    if (liked && !build.vehicle) build.vehicle = liked;
  } catch { /* fresh visit */ }
}
async function checkBackend() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const live = data.mode === 'live';
    const routing = data.models?.routing ? ` (${data.models.routing} routing)` : '';
    $('#modModePill').textContent = live ? `Muse Live${routing}` : 'Local intake only';
    $('#modModePill').classList.toggle('live', live);
    $('#modModePill').classList.toggle('local', !live);
    $('#agentModePill').textContent = $('#modModePill').textContent;
    $('#agentModePill').className = $('#modModePill').className;
    $('#modHint').textContent = live
      ? 'Connected via the DriveMatch backend. Plans are grounded in live web sources (forums, Reddit, parts retailers).'
      : 'The backend LLM is not configured, so Max can take your brief but cannot research a plan yet — the server operator needs to add the Muse token to .env.';
    if (data.vehicleGrounding?.stableCache?.markets?.[market.code]) { /* market cache exists */ }
  } catch {
    $('#modHint').textContent = 'Backend unreachable — open this page via npm start (http://localhost:5173/modmarket.html) so Max can research your plan.';
  }
}

function buildGoalChips() {
  $('#goalChips').innerHTML = GOALS.map((g) => `<button type="button" class="chip" data-goal="${g.id}">${escapeHtml(g.label)}</button>`).join('');
  $('#goalChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-goal]'); if (!chip) return;
    const id = chip.dataset.goal;
    build.goalIds = build.goalIds.includes(id) ? build.goalIds.filter((x) => x !== id) : [...build.goalIds, id];
    syncGoalChips(); save();
  });
}
function syncGoalChips() { $$('#goalChips .chip').forEach((c) => c.classList.toggle('selected', build.goalIds.includes(c.dataset.goal))); }
function showGoalPicker() { $('#goalPicker').hidden = false; syncGoalChips(); }

function renderProgress() {
  $('#modProgress').innerHTML = STEPS.map((label, i) => `<li class="${i < step ? 'done' : i === step ? 'active' : ''}">${i < step ? '✓ ' : ''}${label}</li>`).join('');
}
function addMessage(role, content) {
  const msg = { role, content, ts: Date.now() };
  conversation.push(msg); renderMessage(msg); save();
}
function renderMessage({ role, content }) {
  const box = $('#modMessages');
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `${role === 'agent' ? '<span class="mini-avatar" aria-hidden="true">⚙</span>' : ''}<div class="bubble">${escapeHtml(content).replace(/\n/g, '<br>')}</div>`;
  box.appendChild(wrap); box.scrollTop = box.scrollHeight;
}
function renderConversation() { const box = $('#modMessages'); box.innerHTML = ''; conversation.forEach(renderMessage); }
function renderQuick(list) {
  const el = $('#modQuickReplies'); el.innerHTML = '';
  (list || []).forEach((q) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = q;
    b.addEventListener('click', () => { $('#modInput').value = q; submitInput(); });
    el.appendChild(b);
  });
}
function setTyping(on) { $('#modTyping').hidden = !on; $('#modSendBtn').disabled = on; }

async function submitInput() {
  const ta = $('#modInput');
  const text = ta.value.trim();
  if (!text || busy) return;
  ta.value = '';
  addMessage('user', text);
  busy = true; setTyping(true);
  try { await handleMessage(text); }
  finally { busy = false; setTyping(false); renderProgress(); save(); $('#modInput')?.focus({ preventScroll: true }); }
}

async function handleMessage(text) {
  const lower = text.toLowerCase();
  await sleep(350);

  if (plan && /\b(cheaper|less money|reduce.*budget|cut.*cost)\b/.test(lower)) {
    if (build.budgetAmount) build.budgetAmount = Math.round(build.budgetAmount * 0.75);
    addMessage('agent', `Got it — tightening ${build.budgetAmount ? `the budget to about ${build.budgetAmount}` : 'the spend'} and re-running the plan with cheaper, better-value picks first.`);
    await generatePlan(); return;
  }
  if (plan && /\b(safer|warranty|legal|reliable)\b/.test(lower)) {
    build.notes = `${build.notes} Prioritise warranty-safe, reversible mods; avoid anything that risks reliability or legality.`.trim();
    addMessage('agent', 'Noted — re-running with warranty-safe, reversible, reliability-first picks prioritised.');
    await generatePlan(); return;
  }

  if (step === 0) {
    build.vehicle = text.replace(/^(it's|its|i have|i drive|driving|a|an|the)\s+/i, '').trim();
    step = 1;
    addMessage('agent', `The ${build.vehicle} — great canvas. 🔧\n\nWhat do you want to do to it? Tap everything you're interested in below (carbon dress-up, a tune, exhaust sound, handling…), add anything in your own words, then hit Done.`);
    showGoalPicker(); renderQuick([]);
    return;
  }
  if (step === 1) {
    if (/^(done|that's all|thats all|next|go)$/i.test(text.trim())) { $('#goalPicker').hidden = true; advanceFromGoals(); return; }
    build.goalsText = `${build.goalsText} ${text}`.trim();
    // Let typed goals light up matching chips too.
    for (const g of GOALS) {
      const words = { 'carbon-aero': ['carbon', 'aero', 'splitter', 'spoiler'], 'power-tune': ['tune', 'power', 'stage', 'fast'], 'exhaust-sound': ['exhaust', 'sound'], 'wheels-tyres': ['wheel', 'tyre', 'tire'], suspension: ['coilover', 'suspension', 'lower'], brakes: ['brake'], handling: ['handling', 'sway'], interior: ['interior', 'seat'], 'lighting-wrap': ['wrap', 'light'], offroad: ['off-road', 'offroad', 'lift'], 'audio-tech': ['audio', 'speaker'] }[g.id] || [];
      if (words.some((w) => lower.includes(w)) && !build.goalIds.includes(g.id)) build.goalIds.push(g.id);
    }
    syncGoalChips();
    addMessage('agent', 'Added. Anything else — or hit Done below / type "done" when you\'re ready.');
    return;
  }
  if (step === 2) {
    const amount = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k)?/);
    if (amount) build.budgetAmount = Math.round(parseFloat(amount[1]) * (amount[2] ? 1000 : 1));
    const cur = text.match(/\b(USD|EUR|GBP|ZAR|AUD|CAD|NZD|JPY|CHF|INR|AED|SGD|BRL|MXN|KRW)\b/i) || text.match(/[$€£¥₹]/);
    if (cur) build.currency = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' }[cur[0]] || cur[0].toUpperCase();
    if (!build.currency && market.currency) build.currency = market.currency;
    step = 3;
    addMessage('agent', `${build.budgetAmount ? `Budget noted: about ${build.currency || ''} ${build.budgetAmount.toLocaleString()}.` : 'No fixed budget — I\'ll propose a sensible staged spend and flag what I assumed.'}\n\nLast thing: tell me about the car today and how you use it — is it stock or already modified, daily driver / weekend / track / show, and will you fit parts yourself or use a shop? Anything about warranty you care about?`);
    renderQuick(['Stock, daily driver, shop will fit', 'Stock, I DIY most things', 'Already has a few mods', 'Weekend / track car']);
    return;
  }
  if (step === 3) {
    build.experience = text;
    if (/\b(daily|commut)/.test(lower)) build.usage = 'Daily driver';
    else if (/track/.test(lower)) build.usage = 'Track';
    else if (/weekend/.test(lower)) build.usage = 'Weekend car';
    else if (/show/.test(lower)) build.usage = 'Show car';
    step = 4;
    await generatePlan();
    return;
  }
  // After a plan exists, free text becomes extra notes for a re-run.
  if (/^(rebuild|regenerate)\b/.test(lower)) { await generatePlan(); return; }
  build.notes = `${build.notes} ${text}`.trim();
  addMessage('agent', 'Noted — I\'ve added that to your brief. Tap "Build My Plan" in the panel (or type "regenerate") and I\'ll re-research with it included.');
  renderQuick(['Regenerate this build', 'Make it cheaper', 'Make it safer / warranty-friendly']);
}

function advanceFromGoals() {
  if (!build.goalIds.length && !build.goalsText) {
    addMessage('agent', 'Pick at least one goal (or type what you\'re after) so I research the right parts — looks, power, sound, handling…'); showGoalPicker(); return;
  }
  step = 2;
  const labels = build.goalIds.map((id) => GOALS.find((g) => g.id === id)?.label.replace(/^\S+\s/, '')).filter(Boolean);
  addMessage('agent', `Goals locked in: ${labels.join(' + ') || build.goalsText}. 🎯\n\nNow — what's your budget for this? Give me a number and currency (e.g. "about 3,000" or "R60k"), or say "flexible" and I'll stage it sensibly.`);
  renderQuick(['About 1,500', 'About 3,000', 'About 7,500', 'Flexible — stage it for me']);
}

async function generatePlan() {
  if (!build.vehicle) { addMessage('agent', 'I still need your car first — what make and model are we modifying?'); step = 0; renderProgress(); return; }
  busy = true; setTyping(true);
  try {
    const res = await fetch('/api/mod-suggestions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ vehicle: build.vehicle, goalIds: build.goalIds, goalsText: build.goalsText, budgetAmount: build.budgetAmount, currency: build.currency || market.currency || '', market: market.code, experience: build.experience, usage: build.usage, notes: build.notes }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.stages) throw new Error(data?.error || `Mod research unavailable (HTTP ${res.status})`);
    plan = data; step = 4;
    renderPlan();
    addMessage('agent', planSummaryText(data));
    renderQuick(['Make it cheaper', 'Make it safer / warranty-friendly', 'Rebuild my plan']);
    $('#buildPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.warn('Mod plan failed:', err);
    addMessage('system', `I could not research that plan just now (${err.message || 'unknown error'}). ModMarket needs the backend running via npm start with an LLM configured — your brief is saved, so we can retry anytime.`);
  } finally { busy = false; setTyping(false); renderProgress(); save(); }
}

function money(v, currency) {
  if (v === null || v === undefined || v === '') return 'price on application';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Number(v)); }
  catch { return `${currency || ''} ${Math.round(Number(v)).toLocaleString()}`; }
}
function planSummaryText(d) {
  const stage1 = d.stages[0];
  return `Your ${d.vehicle} build plan is ready 🔧\n\n${d.summary || ''}\n\nStage 1 (${stage1?.name || 'Start here'}): ${stage1?.parts.map((p) => p.name).join(', ') || ''}.\nEstimated parts total: ${money(d.totals.partsMin, d.totals.currency)} – ${money(d.totals.partsMax, d.totals.currency)} across ${d.totals.partCount} parts${d.budget ? ` against your ${money(d.budget.amount, d.budget.currency)} budget` : ''}.\n\nThe full plan — every part with owner sentiment from forums/Reddit, install difficulty, risks and sources — is in the panel. Want it cheaper, safer, or more extreme? Just say so.`;
}
function sentimentHtml(s) {
  if (!s) return '<p><small>Sentiment: sources too thin to score — not invented.</small></p>';
  return `<div class="sentiment-mini"><strong>${s.score === null ? '—' : s.score}</strong><span>/100 owner sentiment (estimate)</span></div>
    ${s.sources?.length ? `<p><small>${s.sources.map((x) => `${escapeHtml(x.type)}: ${x.score === null ? 'unscored' : `${x.score}/100`}${x.themes?.length ? ` (${escapeHtml(x.themes.join(', '))})` : ''}`).join(' · ')}</small></p>` : ''}
    ${s.loves?.length ? `<p>❤️ ${escapeHtml(s.loves.join('; '))}</p>` : ''}${s.complaints?.length ? `<p>⚠️ ${escapeHtml(s.complaints.join('; '))}</p>` : ''}`;
}
function renderPlan() {
  const panel = $('#buildPanel');
  if (!plan) { panel.innerHTML = '<p class="empty-state">Nothing here yet. Tell Max your car, your goals and your budget — your staged parts plan, sentiment and budget breakdown will appear here.</p>'; return; }
  const d = plan;
  panel.innerHTML = `
    ${d.model?.used ? `<p><span class="pill pill-green">Built with ${escapeHtml(d.model.used)}</span></p>` : ''}
    <p><small>${escapeHtml(d.dataSource)}</small></p>
    ${d.summary ? `<p>${escapeHtml(d.summary)}</p>` : ''}
    <div class="budget-summary">
      <div><small>Your budget</small><strong>${d.budget ? money(d.budget.amount, d.budget.currency) : 'Flexible'}</strong></div>
      <div><small>Parts estimate (${d.totals.specificCount ?? 0}/${d.totals.partCount} specific products · ${d.totals.pricedCount ?? 0} priced)</small><strong>${money(d.totals.partsMin, d.totals.currency)} – ${money(d.totals.partsMax, d.totals.currency)}</strong></div>
      <div><small>Estimated install</small><strong>${(d.totals.installMin || d.totals.installMax) ? `${money(d.totals.installMin || 0, d.totals.currency)} – ${money(d.totals.installMax || 0, d.totals.currency)}` : 'Not estimated in sources'}</strong></div>
      <div><small>Estimated all-in total</small><strong>${money(d.totals.grandMin ?? d.totals.partsMin, d.totals.currency)} – ${money(d.totals.grandMax ?? d.totals.partsMax, d.totals.currency)}</strong><br><small>${d.totals.withinBudget === null ? '' : d.totals.withinBudget ? 'Full plan (parts + install) fits the budget' : 'Staged — later stages exceed it, deliberately'}</small></div>
    </div>
    <div class="vehicle-section"><h4>🧾 Build breakdown</h4>
      <div class="option-list">${d.stages.map((stage) => `<div class="option-item"><strong>${escapeHtml(stage.name)}</strong> <span class="pill">${stage.parts.length} mod${stage.parts.length === 1 ? '' : 's'}</span><p>Parts ${money(stage.subtotal?.partsMin || 0, d.totals.currency)} – ${money(stage.subtotal?.partsMax || 0, d.totals.currency)} · Install ${(stage.subtotal?.installMin || stage.subtotal?.installMax) ? `${money(stage.subtotal.installMin || 0, d.totals.currency)} – ${money(stage.subtotal.installMax || 0, d.totals.currency)}` : 'not estimated'} · <strong>Stage total ${money((stage.subtotal?.partsMin || 0) + (stage.subtotal?.installMin || 0), d.totals.currency)} – ${money((stage.subtotal?.partsMax || 0) + (stage.subtotal?.installMax || 0), d.totals.currency)}</strong></p></div>`).join('')}</div>
    </div>
    <div class="summary-actions"><button type="button" class="btn btn-outline btn-sm" id="regenBuildBtn2">↻ Regenerate this build with today's research</button></div>
    ${d.stages.map((stage) => `
      <div class="stage-block"><h4>${escapeHtml(stage.name)}</h4>${stage.goal ? `<p>${escapeHtml(stage.goal)}</p>` : ''}
      ${stage.parts.map((p) => `
        <div class="part-card"><h5>${escapeHtml(p.brand ? `${p.brand} — ` : '')}${escapeHtml(p.name)}</h5>
          <span class="pill">${escapeHtml(p.category || stage.name)}</span> <span class="pill">${escapeHtml(p.install.difficulty)} install${p.install.diyPossible ? ' · DIY possible' : ' · shop recommended'}</span>
          ${p.purpose ? `<p>${escapeHtml(p.purpose)}</p>` : ''}
          <p class="part-price"><strong>Estimated price: ${p.priceEstimate.min !== null || p.priceEstimate.max !== null ? `${money(p.priceEstimate.min ?? p.priceEstimate.max, p.priceEstimate.currency)}${p.priceEstimate.max && p.priceEstimate.min !== null ? ` – ${money(p.priceEstimate.max, p.priceEstimate.currency)}` : ''}` : 'not reliably priced in sources'}</strong>${p.specificity === 'generic' ? ' <span class="pill">generic — specific product not verified</span>' : ''}${p.priceEstimate.note ? `<br><small>${escapeHtml(p.priceEstimate.note)}</small>` : ''}<br><small>Install estimate: ${p.install.costMin !== null || p.install.costMax !== null ? `${money(p.install.costMin || 0, p.priceEstimate.currency)} – ${money(p.install.costMax || p.install.costMin || 0, p.priceEstimate.currency)}` : 'not estimated'} · ${escapeHtml(p.install.difficulty)}${p.install.diyPossible ? ' · DIY possible' : ' · shop recommended'}</small></p>
          ${sentimentHtml(p.sentiment)}
          ${p.pros?.length ? `<p>✅ ${escapeHtml(p.pros.join('; '))}</p>` : ''}${p.cons?.length ? `<p>👀 ${escapeHtml(p.cons.join('; '))}</p>` : ''}
          ${p.compatibility ? `<p><strong>Fitment:</strong> ${escapeHtml(p.compatibility)}</p>` : ''}
          ${p.risks?.length ? `<p><strong>Risks:</strong> ${escapeHtml(p.risks.join('; '))}</p>` : ''}
          ${p.sourceIds?.length ? `<p><small>Sources: ${p.sourceIds.map((id) => { const s = d.sources.find((x) => x.id === id); return s ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">[${escapeHtml(id)}] ${escapeHtml(s.domain)}</a>` : `[${escapeHtml(id)}]`; }).join(' · ')}</small></p>` : ''}
        </div>`).join('')}
      </div>`).join('')}
    ${d.avoid?.length ? `<div class="vehicle-section"><h4>🚫 What owners say to avoid</h4><ul>${d.avoid.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
    ${d.overallWarnings?.length ? `<div class="vehicle-section"><h4>⚠️ Before you order anything</h4><ul>${d.overallWarnings.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
    ${d.sources?.length ? `<div class="vehicle-section"><h4>🔗 Sources (${d.sources.length}, retrieved ${escapeHtml(d.asOf)})</h4><ol class="citation-list">${d.sources.map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">[${escapeHtml(s.id)}] ${escapeHtml(s.title || s.domain)}</a> <small>— ${escapeHtml(s.domain)} · ${escapeHtml(s.queryType)}</small></li>`).join('')}</ol></div>` : ''}
  `;
  const regenBtn = $('#regenBuildBtn'); if (regenBtn) regenBtn.disabled = !build.vehicle;
  $('#regenBuildBtn2')?.addEventListener('click', () => regenerateBuild());
}
// ---- Photo identification (vision LLM + optional SAM segmentation) ----
async function compressImage(file, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}
async function setMainPhoto(file) {
  try {
    photoDataUrl = await compressImage(file, 1280);
    photoAnalysis = null;
    $('#visionPanel').hidden = false;
    renderPhotoPreview();
    addMessage('agent', 'Photo loaded 📷 — tap "Analyse this photo" in the panel and I\'ll identify the car and every mod I can actually see. If you have labelled reference photos (stock vs modded, or a part close-up), add them first — they really help on subtle calls.');
    $('#visionPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    save();
  } catch { showToast('Could not read that image — try a JPEG or PNG.'); }
}
async function addReferencePhoto(file) {
  if (referencePhotos.length >= 5) { showToast('Five reference photos is the limit — remove one first.'); return; }
  const label = $('#refLabel').value.trim() || `Reference ${referencePhotos.length + 1}`;
  try {
    referencePhotos.push({ label, imageDataUrl: await compressImage(file, 640) });
    $('#refLabel').value = '';
    renderReferences();
    addMessage('agent', `Reference added: "${label}" (${referencePhotos.length}/5). I'll compare the main photo against it during analysis.`);
    save();
  } catch { showToast('Could not read that reference image.'); }
}
function renderReferences() {
  const el = $('#refList'); if (!el) return;
  el.innerHTML = referencePhotos.length ? `<div class="ref-thumbs">${referencePhotos.map((r, i) => `<figure><img src="${r.imageDataUrl}" alt="${escapeHtml(r.label)}"><figcaption>${escapeHtml(r.label)}</figcaption><button type="button" data-ref-remove="${i}">Remove</button></figure>`).join('')}</div>` : '';
  el.querySelectorAll('[data-ref-remove]').forEach((b) => b.addEventListener('click', () => { referencePhotos.splice(Number(b.dataset.refRemove), 1); renderReferences(); save(); }));
}
function confClass(v) { return v === null || v === undefined ? '' : v >= 70 ? 'conf-high' : v >= 40 ? 'conf-med' : 'conf-low'; }
function renderPhotoPreview() {
  const wrap = $('#photoWrap'); if (!wrap) return;
  if (!photoDataUrl) { wrap.innerHTML = '<p style="color:#cbd5e1;padding:16px">No photo yet — tap "Identify mods from a photo" above.</p>'; return; }
  const boxes = (photoAnalysis?.mods || []).filter((m) => m.bbox);
  wrap.innerHTML = `<img src="${photoDataUrl}" alt="Uploaded vehicle photo">${boxes.map((m) => `<div class="photo-box" style="left:${m.bbox.x * 100}%;top:${m.bbox.y * 100}%;width:${m.bbox.w * 100}%;height:${m.bbox.h * 100}%"><span>${escapeHtml(m.name)}${m.confidence !== null ? ` · ${m.confidence}%` : ''}</span></div>`).join('')}`;
}
async function analysePhoto() {
  if (!photoDataUrl) { showToast('Upload a vehicle photo first.'); return; }
  busy = true; setTyping(true);
  try {
    const res = await fetch('/api/mod-vision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ imageDataUrl: photoDataUrl, references: referencePhotos, market: market.code, currency: market.currency || build.currency || '' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.vehicle) throw new Error(data?.error || `Photo identification unavailable (HTTP ${res.status})`);
    photoAnalysis = data;
    renderPhotoPreview(); renderVision();
    addMessage('agent', visionSummaryText(data));
    if (data.vehicle.make || data.vehicle.model) {
      build.vehicle = `${data.vehicle.make} ${data.vehicle.model}`.trim();
      if (step === 0 && build.vehicle) step = 1;
    }
    renderProgress(); save();
  } catch (err) {
    console.warn('Photo ID failed:', err);
    addMessage('system', `I could not identify that photo just now (${err.message || 'unknown error'}). Photo ID needs the backend running via npm start with an LLM configured.`);
  } finally { busy = false; setTyping(false); }
}
function visionSummaryText(d) {
  const v = d.vehicle;
  const vehicle = v.make || v.model ? `${v.make} ${v.model}${v.yearRange ? ` (${v.yearRange})` : ''} — ${v.confidence === null ? 'confidence not scored' : `${v.confidence}% confidence`}` : 'I could not confidently identify the make/model from this photo';
  return `Photo identification 📷\n\nVehicle: ${vehicle}.\n${d.summary || ''}\n\nMods I can see (${d.mods.length}): ${d.mods.length ? d.mods.map((m) => `${m.name} (${m.location || 'visible'}, ${m.confidence === null ? 'unscored' : `${m.confidence}%`})`).join('; ') : 'none confidently visible'}.\n\nFull evidence, boxes${d.segmentation?.provider ? ` localised with ${d.segmentation.provider}` : ' (vision-estimated regions — no SAM endpoint configured)'} and what I can't see are in the panel. If you want parts like these, tap "Research these mods" and I'll build a sentiment-backed plan around them.`;
}
function renderVision() {
  const d = photoAnalysis; if (!d) return;
  $('#visionPanel').hidden = false;
  $('#visionBadge').textContent = d.segmentation?.provider ? `SAM: ${d.segmentation.provider}` : 'Vision estimates';
  $('#researchModsBtn').disabled = !d.mods.length;
  const v = d.vehicle;
  $('#visionContent').innerHTML = `
    <div class="mod-id-card"><h5>${escapeHtml(v.make || 'Unknown make')} ${escapeHtml(v.model || '')} ${v.yearRange ? `<small>(${escapeHtml(v.yearRange)})</small>` : ''} <span class="conf-pill ${confClass(v.confidence)}">${v.confidence === null ? 'unscored' : `${v.confidence}% confidence`}</span></h5>
      ${v.trimCues ? `<p><strong>Trim cues:</strong> ${escapeHtml(v.trimCues)}</p>` : ''}${v.bodyStyle ? `<p><strong>Body:</strong> ${escapeHtml(v.bodyStyle)}</p>` : ''}
      ${v.evidence?.length ? `<p><strong>Evidence:</strong> ${escapeHtml(v.evidence.join('; '))}</p>` : ''}
      ${d.imageQuality ? `<p><strong>Photo:</strong> ${escapeHtml(d.imageQuality)}</p>` : ''}
      <p><small>${escapeHtml(d.segmentation?.note || '')}${d.referencesUsed?.length ? ` References used: ${escapeHtml(d.referencesUsed.join(', '))}.` : ''}</small></p>
    </div>
    ${d.mods.length ? d.mods.map((m) => `
      <div class="mod-id-card"><h5>${escapeHtml(m.name)} <span class="conf-pill ${confClass(m.confidence)}">${m.confidence === null ? 'unscored' : `${m.confidence}%`}</span></h5>
        <span class="pill">${escapeHtml(m.category)}</span> <span class="pill">${escapeHtml(m.factoryOrAftermarket)}</span>${m.location ? ` <span class="pill">${escapeHtml(m.location)}</span>` : ''}${m.boxSource && m.bbox ? ` <span class="pill">📍 ${escapeHtml(m.boxSource)}</span>` : ''}
        ${m.visualEvidence ? `<p><strong>Evidence:</strong> ${escapeHtml(m.visualEvidence)}</p>` : ''}
        ${m.visibleBrand ? `<p><strong>Visible brand:</strong> ${escapeHtml(m.visibleBrand)}</p>` : ''}
        ${m.notes ? `<p>${escapeHtml(m.notes)}</p>` : ''}
      </div>`).join('') : '<p class="empty-state">No modifications could be confidently identified in this photo.</p>'}
    ${d.notVisible?.length ? `<p><strong>Can't assess from this photo:</strong> ${escapeHtml(d.notVisible.join('; '))}</p>` : ''}
    <p><small>${escapeHtml(d.disclaimer || '')}</small></p>`;
  renderPhotoPreview();
}
function researchIdentifiedMods() {
  const d = photoAnalysis; if (!d) return;
  if (d.vehicle.make || d.vehicle.model) build.vehicle = `${d.vehicle.make} ${d.vehicle.model}`.trim();
  const catWords = { carbon: 'carbon-aero', wheel: 'wheels-tyres', tyre: 'wheels-tyres', tire: 'wheels-tyres', suspension: 'suspension', lower: 'suspension', tune: 'power-tune', power: 'power-tune', exhaust: 'exhaust-sound', brake: 'brakes', handling: 'handling', interior: 'interior', light: 'lighting-wrap', wrap: 'lighting-wrap', 'off-road': 'offroad', lift: 'offroad', audio: 'audio-tech' };
  for (const mod of d.mods) {
    const text = `${mod.name} ${mod.category}`.toLowerCase();
    for (const [word, id] of Object.entries(catWords)) if (text.includes(word) && !build.goalIds.includes(id)) build.goalIds.push(id);
  }
  build.goalsText = `${build.goalsText} Parts like the ones in my photo: ${d.mods.map((m) => m.name).join(', ')}`.trim();
  syncGoalChips();
  if (step < 2) step = 2;
  renderProgress(); save();
  addMessage('agent', `Done — I've set your car to ${build.vehicle || 'the vehicle in your photo'} and your goals to the mods I identified (${build.goalIds.map((id) => GOALS.find((g) => g.id === id)?.label.replace(/^\S+\s/, '')).join(', ') || 'your photo mods'}).\n\nNow: what's your budget? Give me a number and currency, or say "flexible".`);
  $('#modInput')?.focus({ preventScroll: true });
}

// ---- Import a previously downloaded build, then regenerate it ----
function sanitiseImportedBuild(input) {
  const clean = { vehicle: '', goalIds: [], goalsText: '', budgetAmount: null, currency: '', experience: '', usage: '', notes: '' };
  if (!input || typeof input !== 'object') return clean;
  clean.vehicle = String(input.vehicle || '').slice(0, 140);
  clean.goalsText = String(input.goalsText || '').slice(0, 1000);
  clean.currency = String(input.currency || '').toUpperCase().slice(0, 3);
  clean.experience = String(input.experience || '').slice(0, 500);
  clean.usage = String(input.usage || '').slice(0, 300);
  clean.notes = String(input.notes || '').slice(0, 500);
  clean.budgetAmount = input.budgetAmount === null || input.budgetAmount === '' ? null : Math.max(0, Number(input.budgetAmount) || 0) || null;
  if (Array.isArray(input.goalIds)) clean.goalIds = input.goalIds.filter((id) => GOALS.some((g) => g.id === id));
  return clean;
}
async function handleBuildUpload(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const importedBuild = parsed.build || parsed.brief || null;
    const importedPlan = parsed.plan || (Array.isArray(parsed.stages) ? parsed : null);
    if (!importedBuild && !importedPlan) throw new Error('No build or plan found in that file.');
    if (importedBuild) build = { ...build, ...sanitiseImportedBuild(importedBuild) };
    if (!build.vehicle && importedPlan?.vehicle) build.vehicle = String(importedPlan.vehicle).slice(0, 140);
    if (!build.budgetAmount && importedPlan?.budget?.amount) { build.budgetAmount = importedPlan.budget.amount; build.currency = importedPlan.budget.currency || build.currency; }
    if (!build.goalIds.length && Array.isArray(importedPlan?.goals)) {
      build.goalIds = importedPlan.goals.map((g) => g.id).filter((id) => GOALS.some((g) => g.id === id));
    }
    plan = importedPlan;
    step = plan ? 4 : (build.vehicle ? 1 : 0);
    syncGoalChips(); renderProgress(); renderPlan();
    addMessage('agent', `Build restored 📂 — ${build.vehicle || 'your car'}${build.goalIds.length ? `, goals: ${build.goalIds.map((id) => GOALS.find((g) => g.id === id)?.label.replace(/^\S+\s/, '')).join(', ')}` : ''}${build.budgetAmount ? `, budget about ${build.currency || ''} ${build.budgetAmount.toLocaleString()}` : ''}.\n\n${plan ? `I've reloaded your previous plan (researched ${plan.asOf || 'earlier'}). Prices and sentiment may have moved since then.` : 'I have your brief, but no finished plan in that file.'}\n\nHit **Regenerate this build** in the panel and I'll re-research it fresh — today's specific products, prices and owner sentiment — or tell me what to change first.`);
    showToast('Build imported — hit Regenerate to refresh it.');
    save();
  } catch (err) {
    console.warn('Build upload failed:', err);
    showToast('Could not read that file — upload the ModMarket build JSON you downloaded.');
    addMessage('system', 'That upload did not look like a ModMarket build JSON, so nothing was changed. Use the ⬇ Download plan button on a build to get the right file.');
  }
}
async function regenerateBuild() {
  if (!build.vehicle) { showToast('Import a build or tell Max your car first.'); return; }
  const previousAsOf = plan?.asOf;
  build.notes = `${build.notes} Regenerating a previously planned build — keep the same goals unless today's sources support better specific products or prices.`.trim();
  addMessage('agent', `Regenerating your ${build.vehicle} build with fresh research${previousAsOf ? ` (previous plan was from ${previousAsOf})` : ''} — today's specific brand/product picks, prices and sentiment coming up.`);
  await generatePlan();
}

function downloadPlan() {
  if (!plan) { showToast('Build a plan first — then you can download it.'); return; }
  const blob = new Blob([JSON.stringify({ format: 'modmarket-build-plan/v1', build, plan, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `modmarket-${build.vehicle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`; a.click();
  URL.revokeObjectURL(a.href); showToast('Build plan downloaded.');
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ build, step, plan, conversation, photoDataUrl, photoAnalysis, references: referencePhotos, savedAt: Date.now() })); $('#modSaveNote').textContent = '✓ Saved'; } catch { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ build, step, plan, conversation, photoAnalysis, savedAt: Date.now() })); } catch { /* storage unavailable */ } }
  }, 250);
}
function loadSaved() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!data) return;
    if (data.build) build = { ...build, ...data.build };
    step = data.step || 0; plan = data.plan || null;
    photoAnalysis = data.photoAnalysis || null;
    photoDataUrl = data.photoDataUrl || '';
    if (Array.isArray(data.references)) referencePhotos = data.references.slice(0, 5);
    if (Array.isArray(data.conversation)) conversation = data.conversation;
    if (plan) renderPlan();
    if (photoAnalysis) { $('#visionPanel').hidden = false; renderVision(); }
    syncGoalChips();
  } catch { /* fresh start */ }
}
let toastTimer;
function showToast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3400); }
