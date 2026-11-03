// ModVision — identify a vehicle and its visible modifications from a photo.
//
// Two cooperating stages:
//   1. (Optional) SAM segmentation: if a SAM-compatible endpoint is
//      configured (SAM_API_URL, e.g. a hosted/self-hosted SAM 3.1
//      service), the photo is sent with text prompts for common mod
//      locations. Returned boxes localise candidate regions.
//   2. Vision LLM (the same routed Muse call as everything else):
//      sees the photo plus any user-provided labelled REFERENCE photos
//      (e.g. "stock front end", "carbon splitter") and identifies the
//      make/model and each visible mod with visual evidence and a
//      confidence. Reference examples materially improve subtle calls
//      (wrap vs paint, OEM+ vs aftermarket wheels, stock vs lowered).
// Without SAM configured, stage 1 is skipped and the vision model still
// returns approximate regions — the response is honest about which
// stage produced the boxes. Nothing is invented: unidentifiable
// vehicles/mods come back as unknown/low-confidence, never guessed.

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = (v, max = 20) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).slice(0, max) : []);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

const SEGMENT_PROMPTS = [
  'wheels and tires', 'front splitter', 'front bumper', 'rear spoiler or wing', 'rear diffuser',
  'side skirts', 'hood', 'roof rack or roof box', 'exhaust tips', 'brake calipers and rotors',
  'fender flares', 'off-road bumper', 'light bar', 'lifted suspension', 'window tint', 'mud flaps',
];

function parseJson(content) {
  try {
    const cleaned = String(content || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return null; }
}
function validateImageDataUrl(dataUrl, label) {
  const m = String(dataUrl || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw Object.assign(new Error(`${label} must be a JPEG, PNG or WebP image.`), { status: 400 });
  const approxBytes = Math.floor((m[2].length * 3) / 4);
  if (approxBytes > 6 * 1024 * 1024) throw Object.assign(new Error(`${label} is too large (max ~6MB after compression).`), { status: 413 });
  return dataUrl;
}
function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x = num(box.x ?? box.x_min); const y = num(box.y ?? box.y_min);
  const w = num(box.w ?? (num(box.x_max) !== null && num(box.x) !== null ? num(box.x_max) - num(box.x) : null));
  const h = num(box.h ?? (num(box.y_max) !== null && num(box.y) !== null ? num(box.y_max) - num(box.y) : null));
  if ([x, y, w, h].some((v) => v === null)) return null;
  // Only normalised 0-1 boxes are supported; pixel boxes are dropped
  // rather than mis-plotted.
  if (x > 1 || y > 1 || w > 1 || h > 1) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: clamp(w, 0.01, 1), h: clamp(h, 0.01, 1) };
}

// Optional SAM adapter. Configure any endpoint that accepts
// POST { image_base64, prompts[] } and returns
// { segments: [{ label, score, box: {x,y,w,h} (normalised 0-1) }] }.
async function runSegmentation(imageDataUrl) {
  const url = (process.env.SAM_API_URL || '').trim();
  if (!url) return { provider: null, segments: [], note: 'SAM segmentation not configured (SAM_API_URL empty) — regions below are vision-model estimates.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SAM_TIMEOUT_MS || 60000));
  try {
    const res = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(process.env.SAM_API_KEY ? { Authorization: `Bearer ${process.env.SAM_API_KEY}` } : {}) },
      body: JSON.stringify({ model: process.env.SAM_MODEL || 'sam3.1', image_base64: imageDataUrl, prompts: SEGMENT_PROMPTS }),
    });
    if (!res.ok) throw new Error(`SAM endpoint returned HTTP ${res.status}`);
    const json = await res.json();
    const rawSegments = json.segments || json.results || json.masks || [];
    const segments = arr(rawSegments, 30).map((s) => ({
      label: str(s.label || s.prompt || s.class, 80),
      score: num(s.score ?? s.confidence) === null ? null : clamp(num(s.score ?? s.confidence), 0, 1),
      box: normalizeBox(s.box || s.bbox || s.bounds),
    })).filter((s) => s.label && s.box);
    return { provider: process.env.SAM_MODEL || 'sam3.1', segments, note: `Localised with ${process.env.SAM_MODEL || 'SAM'} segmentation (${segments.length} region(s)).` };
  } catch (err) {
    return { provider: null, segments: [], note: `SAM segmentation unavailable (${err.name === 'AbortError' ? 'timed out' : err.message}) — regions below are vision-model estimates.` };
  } finally { clearTimeout(timeout); }
}

function matchSegment(mod, segments) {
  const name = `${mod.name} ${mod.category} ${mod.location}`.toLowerCase();
  let best = null;
  for (const seg of segments) {
    const label = seg.label.toLowerCase();
    const words = label.split(/[^a-z]+/).filter((w) => w.length > 3);
    const score = words.filter((w) => name.includes(w)).length + (name.includes(label) ? 2 : 0);
    if (score > 0 && (!best || score > best.score)) best = { seg, score };
  }
  return best?.seg || null;
}

async function identifyVehicleMods({ imageDataUrl, references = [], market, callLLM } = {}) {
  const image = validateImageDataUrl(imageDataUrl, 'Vehicle photo');
  const refs = arr(references, 5).map((r, i) => ({
    label: str(r?.label, 100) || `Reference ${i + 1}`,
    imageDataUrl: validateImageDataUrl(r?.imageDataUrl, `Reference photo ${i + 1}`),
  }));
  const segmentation = await runSegmentation(image);
  const today = new Date().toISOString().slice(0, 10);

  const refText = refs.length
    ? `\nThe user also provided ${refs.length} labelled REFERENCE image(s), attached after the main photo in this order: ${refs.map((r, i) => `Reference ${i + 1}: "${r.label}"`).join('; ')}. Use them as comparison examples (e.g. stock vs modified, or a labelled part) when judging the main photo.`
    : '';
  const segmentText = segmentation.segments.length
    ? `\nA segmentation model proposed these regions in the main photo (normalised boxes): ${segmentation.segments.map((s) => `${s.label} at x=${s.box.x.toFixed(2)},y=${s.box.y.toFixed(2)},w=${s.box.w.toFixed(2)},h=${s.box.h.toFixed(2)}`).join('; ')}. Use them to localise mods where they fit.`
    : '';

  const { text, modelUsed } = await callLLM({
    task: 'mod-vision',
    images: [
      { dataUrl: image, label: 'Main vehicle photo to identify' },
      ...refs.map((r) => ({ dataUrl: r.imageDataUrl, label: `Reference: ${r.label}` })),
    ],
    messages: [
      { role: 'system', content: `You are ModMarket's vehicle-identification analyst. Today is ${today}. Look at the main photo and identify the vehicle and every visible modification. Rules:
- Identify make/model (and year range / trim / engine cues) ONLY from visible evidence — badges, body shape, lights, wheels, interior. State confidence honestly; "unknown" is a correct answer for debadged, partial or low-quality photos. Never guess a specific model from a generic shape.
- For each visible modification: name it, categorise it (Carbon fibre & aero / Wheels & tyres / Suspension & stance / Power & hardware / Exhaust / Brakes / Handling / Interior / Lighting, wrap & styling / Off-road / Audio & tech / Other), say where on the vehicle it is, describe the visual evidence, give a confidence 0-100, and give an approximate normalised bounding box {x,y,w,h} (0-1) around it.
- Distinguish factory/OEM parts from aftermarket where you can, and say when you cannot tell. A part being present is not proof of its brand — only name a brand if a logo/lettering is actually visible.
- Note what cannot be assessed from this angle (engine bay, underbody, interior, tune/software — software tunes are invisible; say so if relevant).
- Do not price parts precisely; a broad "typical market band" note is allowed only as a rough guide labelled as such.
Return ONLY valid JSON: {"vehicle":{"make":"","model":"","yearRange":"","trimCues":"","bodyStyle":"","confidence":0,"evidence":[]},"imageQuality":"","mods":[{"name":"","category":"","location":"","confidence":0,"visualEvidence":"","factoryOrAftermarket":"aftermarket|factory|unsure","visibleBrand":"","bbox":{"x":0,"y":0,"w":0,"h":0},"notes":""}],"notVisible":[],"summary":""}` },
      { role: 'user', content: `Identify this vehicle and its visible modifications.${refText}${segmentText}` },
    ],
    maxTokens: Number(process.env.MOD_VISION_MAX_TOKENS || 6000), temperature: 0.1,
    timeoutMs: Number(process.env.VEHICLE_LLM_TIMEOUT_MS || 180000),
    reasoningEffort: process.env.VEHICLE_REASONING_EFFORT ?? 'low',
  });
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== 'object') throw Object.assign(new Error('The vision model returned an unexpected format.'), { status: 502 });

  const v = parsed.vehicle || {};
  const mods = arr(parsed.mods, 20).map((m) => {
    const mod = {
      name: str(m.name, 120), category: str(m.category, 60), location: str(m.location, 80),
      confidence: num(m.confidence) === null ? null : clamp(Math.round(num(m.confidence)), 0, 100),
      visualEvidence: str(m.visualEvidence, 320),
      factoryOrAftermarket: ['aftermarket', 'factory', 'unsure'].includes(String(m.factoryOrAftermarket || '').toLowerCase()) ? String(m.factoryOrAftermarket).toLowerCase() : 'unsure',
      visibleBrand: str(m.visibleBrand, 60),
      notes: str(m.notes, 260),
      bbox: normalizeBox(m.bbox),
      boxSource: 'vision-estimate',
    };
    const seg = matchSegment(mod, segmentation.segments);
    if (seg) { mod.bbox = seg.box; mod.segmentScore = seg.score; mod.boxSource = segmentation.provider || 'segmentation'; }
    return mod;
  }).filter((m) => m.name);

  return {
    asOf: today, market: market || null, modelUsed: modelUsed || null,
    segmentation: { provider: segmentation.provider, regions: segmentation.segments.length, note: segmentation.note },
    referencesUsed: refs.map((r) => r.label),
    vehicle: {
      make: str(v.make, 60), model: str(v.model, 80), yearRange: str(v.yearRange, 60),
      trimCues: str(v.trimCues, 220), bodyStyle: str(v.bodyStyle, 60),
      confidence: num(v.confidence) === null ? null : clamp(Math.round(num(v.confidence)), 0, 100),
      evidence: arr(v.evidence, 8).map((x) => str(x, 180)).filter(Boolean),
    },
    imageQuality: str(parsed.imageQuality, 300),
    mods,
    notVisible: arr(parsed.notVisible, 8).map((x) => str(x, 180)).filter(Boolean),
    summary: str(parsed.summary, 700),
    disclaimer: 'Identification is from visible evidence in one photo. Badges can be swapped, wraps hide paint, and software tunes are invisible — verify with the VIN/build sheet and closer photos (engine bay, interior, rear three-quarter) before buying parts or valuing the car.',
  };
}

module.exports = { identifyVehicleMods, runSegmentation, SEGMENT_PROMPTS, normalizeBox };
