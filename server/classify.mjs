// classify.mjs — vision classification for scout photos, with ordered provider failover.
//
// What this does
//   A farmer attaches up to 5 scout photos in the app; `POST /api/classify` runs them
//   through a vision model and returns one structured verdict:
//     { label, confidence, severity, notes, commonName, botanicalName, pathogenName, provider }
//   Farms, records and the hash chain never depend on this verdict: it is a suggestion the
//   scout confirms, and the report still saves offline as "unclassified" when no signal/AI.
//
// Contract notes (carried over from the indorse pipeline):
//   • Providers run in order; the first success wins. Client faults (bad payload,
//     unconfigured key) short-circuit the whole chain.
//   • One shared system prompt and one JSON schema for every provider, so identical
//     inputs give comparable verdicts across providers.
//   • Per-attempt deadlines plus one total budget: the request always answers in
//     at most CLASSIFY_TOTAL_BUDGET_MS (default 42 s).
//   • The verdict is clamped on this side (label length, confidence 0–1, severity
//     vocabulary) so a chatty model can never break the app or the record.
//   • Tests inject `fetchImpl` — no real API call ever leaves this repo.

export const MAX_IMAGES = 5;
// Server-side body guard: flips a 413 through jsonBody before the handler sees it.
export const CLASSIFY_MAX_BODY = 4_500_000;
export const PER_IMAGE_CHAR_LIMIT = 900_000;
export const CLASSIFY_TOTAL_BUDGET_MS = Number(process.env.CLASSIFY_TOTAL_BUDGET_MS) || 42_000;
export const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 20_000;
export const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20_000;
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-6-astra';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const LABEL_MAX = 48;
const NOTES_MAX = 200;
const SEVERITIES = new Set(['high', 'medium', 'low', 'none']);

export const VISION_PROMPT = `You are an agronomy vision classifier for field crops.
Given one or more field photographs of the same plant, identify the most likely disease, pest or stress issue
and return the structured verdict described by the response schema.

Rules:
- When several photos are provided they are shots of one plant — weigh every angle together and
  answer for that plant as a whole, not per photo.
- "label" is short and free-form but at most ${LABEL_MAX} characters, for example: "Gray Leaf Spot", "Fall Armyworm", "Aphid Infestation", "Powdery Mildew", "Leaf Rust", "Nutrient Deficiency", "Drought Stress", "Weed Pressure", "Unknown".
- When no crop is visible use "No Crop Detected"; when the photo is too blurry, dark or close to judge use "Unclear Image"; when the plant looks unaffected use "Healthy".
- "confidence" is an honest, calibrated probability between 0 and 1. Reserve above 0.85 for textbook symptoms, 0.5 to 0.7 for plausible but ambiguous evidence, and below 0.4 when the image or the symptom is largely uncertain. Never inflate it to sound sure.
- "severity" is how urgent the finding is: "high" for severe or fast-spreading damage, "medium" for established damage, "low" for mild, early or uncertain symptoms, and "none" when there is nothing to act on (healthy, no crop, or an unclear photo).
- "notes" is one or two plain sentences, at most ${NOTES_MAX} characters, that a field scout can act on: what is visible and where. Do not name pesticide, fungicide or fertilizer products, brands or dosages — describe the symptom and its extent only.
- "commonName" is the plant the photo shows, in plain English (e.g. "Maize", "Tomato"), and "botanicalName" its Latin binomial (e.g. "Zea mays", "Solanum lycopersicum"). Return "" for both when the plant cannot be identified or no plant is visible.
- "pathogenName" is the scientific name of the causal agent behind the diagnosis — fungus, bacterium, virus or pest — e.g. "Ustilago maydis" for Corn Smut or "Cercospora zeae-maydis" for Gray Leaf Spot. Return "" when the finding is abiotic (drought, nutrient deficiency, physical damage) or the agent itself cannot be identified.
- Return only the structured verdict; no prose, no markdown.`;

export const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'confidence', 'severity', 'notes', 'commonName', 'botanicalName', 'pathogenName'],
  properties: {
    label: { type: 'string', description: `Short diagnosis, at most ${LABEL_MAX} characters` },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Calibrated probability between 0 and 1' },
    severity: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    notes: { type: 'string', description: `One or two actionable sentences, at most ${NOTES_MAX} characters` },
    commonName: { type: 'string' },
    botanicalName: { type: 'string' },
    pathogenName: { type: 'string' },
  },
};

// ---------- verdict clamping ----------
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function parseVerdict(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const confidence = clampConfidence(raw.confidence);
  const severity = SEVERITIES.has(raw.severity) ? raw.severity : 'none';
  const label = text(raw.label, LABEL_MAX);
  if (!label) return null; // a verdict without a label is worthless to the scout
  return {
    label,
    confidence,
    severity,
    notes: text(raw.notes, NOTES_MAX),
    commonName: text(raw.commonName, 60),
    botanicalName: text(raw.botanicalName, 80),
    pathogenName: text(raw.pathogenName, 80),
  };
}

export function clampConfidence(c) {
  const n = Number(c);
  // Models occasionally answer 0–100; scale it instead of clamping to 1.
  if (!(n > 0)) return 0;
  return Math.round(Math.min(1, n > 1 && n <= 100 ? n / 100 : n) * 100) / 100;
}

// ---------- input normalisation ----------
const MIME = new Set(['image/jpeg', 'image/png']);
export function normalizeImage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let b64 = typeof entry.imageBase64 === 'string' ? entry.imageBase64 : (typeof entry.b64 === 'string' ? entry.b64 : '');
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma !== -1) b64 = b64.slice(comma + 1);
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64 || b64.length > PER_IMAGE_CHAR_LIMIT) return null;
  let mimeType = typeof entry.mimeType === 'string' ? entry.mimeType.toLowerCase() : 'image/jpeg';
  if (mimeType.startsWith('image/')) mimeType = mimeType.slice(6);
  mimeType = `image/${mimeType === 'png' ? 'png' : 'jpeg'}`;
  return { b64, mimeType: MIME.has(mimeType) ? mimeType : 'image/jpeg' };
}

export function normalizeImages(data) {
  // Legacy single-photo body: { imageBase64, mimeType } — treat as a 1-element array.
  const list = Array.isArray(data?.images) ? data.images : (data?.imageBase64 ? [data] : null);
  if (!list || !list.length || list.length > MAX_IMAGES) return null;
  const images = list.map(normalizeImage);
  if (images.some((i) => i === null)) return null;
  return images;
}

export function classifyConfigured(env = process.env) {
  return !!(env.OPENAI_API_KEY || env.GEMINI_API_KEY);
}

// ---------- providers ----------
async function classifyWithOpenAI(images, { env = process.env, fetchImpl = fetch, timeoutMs = OPENAI_TIMEOUT_MS } = {}) {
  if (!env.OPENAI_API_KEY) throw Object.assign(new Error('no OPENAI_API_KEY'), { code: 'ai_unconfigured' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_VISION_MODEL || OPENAI_MODEL,
        max_output_tokens: 600,
        input: [
          { role: 'system', content: VISION_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Classify these field photos of one plant and answer with the structured verdict.' },
              ...images.map((i) => ({ type: 'input_image', image_url: `data:${i.mimeType};base64,${i.b64}` })),
            ],
          },
        ],
        text: { format: { type: 'json_schema', name: 'diagnosis', strict: true, schema: DIAGNOSIS_SCHEMA } },
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`openai ${res.status}`), { code: `upstream_${res.status}`, retryable: res.status >= 500 || res.status === 429 });
    const data = await res.json().catch(() => null);
    return parseVerdict(extractOpenAiText(data));
  } finally { clearTimeout(timer); }
}

export function extractOpenAiText(data) {
  if (typeof data?.output_text === 'string') return safeJson(data.output_text);
  for (const item of data?.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) return safeJson(part.text);
    }
  }
  return null;
}

async function classifyWithGemini(images, { env = process.env, fetchImpl = fetch, timeoutMs = GEMINI_TIMEOUT_MS } = {}) {
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error('no GEMINI_API_KEY'), { code: 'ai_unconfigured' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: VISION_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [
            { text: 'Classify these field photos of one plant and answer with the structured verdict.' },
            ...images.map((i) => ({ inline_data: { mime_type: i.mimeType, data: i.b64 } })),
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: DIAGNOSIS_SCHEMA, temperature: 0 },
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`gemini ${res.status}`), { code: `upstream_${res.status}`, retryable: res.status >= 500 || res.status === 429 });
    const data = await res.json().catch(() => null);
    return parseVerdict(extractGeminiText(data));
  } finally { clearTimeout(timer); }
}

export function extractGeminiText(data) {
  const out = data?.candidates?.[0]?.content?.parts || [];
  for (const part of out) if (part.text) return safeJson(part.text);
  return null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const PROVIDERS = { openai: classifyWithOpenAI, gemini: classifyWithGemini };

// ---------- the ordered, budget-aware chain ----------
export async function classifyScoutPhotos({ images, order = ['openai', 'gemini'], env = process.env, fetchImpl = fetch, now = Date.now(), totalBudgetMs = CLASSIFY_TOTAL_BUDGET_MS } = {}) {
  if (!classifyConfigured(env)) return { error: 'ai_unconfigured' };
  // Accept raw provider-shape entries (the server route may pass them through).
  images = (Array.isArray(images) ? images.map(normalizeImage) : [null]);
  if (!images.length || images.length > MAX_IMAGES || images.some((i) => i === null)) return { error: 'bad_payload' };
  const deadline = now + totalBudgetMs;
  const faults = [];
  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 500) break; // nothing useful can still be attempted
    try {
      const verdict = await provider(images, { env, fetchImpl, timeoutMs: Math.min(name === 'openai' ? OPENAI_TIMEOUT_MS : GEMINI_TIMEOUT_MS, remaining) });
      if (verdict) return { ...verdict, provider: name };
      faults.push({ provider: name, code: 'bad_verdict' });
    } catch (err) {
      faults.push({ provider: name, code: err.code || 'upstream_error' });
      if (err.code === 'ai_unconfigured') continue;
      if (!err.retryable) break; // auth or validation fault: failover won't save this request
    }
  }
  return { error: 'no_verdict', faults, waitMs: Math.max(0, deadline - Date.now()) };
}
