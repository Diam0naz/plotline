import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScoutPhotos, normalizeImages, normalizeImage, parseVerdict, clampConfidence,
  extractOpenAiText, extractGeminiText, classifyConfigured, MAX_IMAGES,
} from './classify.mjs';

const ENV = { OPENAI_API_KEY: 'k-openai', GEMINI_API_KEY: 'k-gemini' };
const IMG = { imageBase64: 'aGVsbG8', mimeType: 'image/jpeg' };
const NOW = () => new Date('2026-11-15T12:00:00.000Z').getTime();

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const openAiBody = (verdict) => ({ output_text: JSON.stringify(verdict) });
const geminiBody = (verdict) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }] });

const GOOD = { label: 'Gray Leaf Spot', confidence: 0.87, severity: 'medium', notes: 'Lesions on the lower canopy.', commonName: 'Maize', botanicalName: 'Zea mays', pathogenName: 'Cercospora zeae-maydis' };

test('classify: an unconfigured deployment says so, honestly, without any network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return response(200, openAiBody(GOOD)); };
  const out = await classifyScoutPhotos({ images: [IMG], env: {}, fetchImpl });
  assert.equal(out.error, 'ai_unconfigured');
  assert.equal(called, false);
  assert.equal(classifyConfigured({}), false);
  assert.equal(classifyConfigured({ OPENAI_API_KEY: 'k' }), true);
});

test('classify: bad payloads are refused before any provider runs', async () => {
  const fetchImpl = async () => { throw new Error('must not be reached'); };
  assert.equal((await classifyScoutPhotos({ images: [], env: ENV, fetchImpl })).error, 'bad_payload');
  const many = Array(MAX_IMAGES + 1).fill(IMG);
  assert.equal((await classifyScoutPhotos({ images: many, env: ENV, fetchImpl })).error, 'bad_payload');
});

test('classify: the primary provider wins and its verdict is clamped', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return response(200, openAiBody({ ...GOOD, confidence: 87, severity: 'catastrophic' })); };
  // `confidence: 87` arrives on the 0–100 scale; `severity` is off-vocabulary.
  const out = await classifyScoutPhotos({ images: [IMG, IMG], env: ENV, fetchImpl });
  assert.equal(urls.length, 1, 'failover must not run behind a success');
  assert.match(urls[0], /api\.openai\.com\/v1\/responses/);
  assert.equal(out.provider, 'openai');
  assert.equal(out.label, 'Gray Leaf Spot');
  assert.equal(out.confidence, 0.87);
  assert.equal(out.severity, 'none');
});

test('classify: the primary provider failing sends the same photos to the fallback', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body });
    if (String(url).includes('openai')) return response(503, { error: 'overloaded' });
    return response(200, geminiBody(GOOD));
  };
  const out = await classifyScoutPhotos({ images: [IMG], env: ENV, fetchImpl });
  assert.equal(out.provider, 'gemini');
  assert.equal(out.label, 'Gray Leaf Spot');
  assert.equal(calls.length, 2, 'exactly one attempt per provider');
  assert.match(calls[1].url, /generativelanguage\.googleapis\.com/);
  // The photos travel to the fallback unchanged.
  assert.match(calls[1].body, /aGVsbG8/);
});

test('classify: a malformed verdict from the primary falls through cleanly', async () => {
  const fetchImpl = async (url) => (String(url).includes('openai')
    ? response(200, openAiBody({ confidence: 0.9 })) // no label
    : response(200, geminiBody(GOOD)));
  const out = await classifyScoutPhotos({ images: [IMG], env: ENV, fetchImpl });
  assert.equal(out.provider, 'gemini');
});

test('classify: a hard auth fault skips the fallback instead of wasting it', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return response(401, { error: 'bad key' }); };
  const out = await classifyScoutPhotos({ images: [IMG], env: { OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'g' }, fetchImpl });
  assert.equal(out.error, 'no_verdict');
  assert.equal(urls.length, 1, 'a 401 is a client fault: failing over cannot help');
  assert.equal(out.faults[0].provider, 'openai');
  assert.equal(out.faults[0].code, 'upstream_401');
});

test('classify: running out of budget is reported with the faults, honestly', async () => {
  const out = await classifyScoutPhotos({ images: [IMG], env: ENV, fetchImpl: async () => response(500, {}), now: NOW, totalBudgetMs: 42_000 });
  assert.equal(out.error, 'no_verdict');
  assert.deepEqual(out.faults.map((f) => f.provider), ['openai', 'gemini']);
});

test('classify: normalisation strips data: prefixes and rejects junk images', () => {
  const one = normalizeImage({ imageBase64: 'data:image/png;base64,Zm9v==', mimeType: 'image/PNG' });
  assert.equal(one.b64, 'Zm9v==');
  assert.equal(one.mimeType, 'image/png');
  assert.equal(normalizeImage({ imageBase64: '' }), null);
  assert.equal(normalizeImage({ imageBase64: 'x'.repeat(900_001) }), null);
  assert.equal(normalizeImage('nope'), null);
  const list = normalizeImages({ imageBase64: 'aGVsbG8' }); // legacy single-photo body
  assert.equal(list.length, 1);
  assert.equal(normalizeImages({ images: ['nope'] }), null);
  assert.equal(normalizeImages({}), null);
});

test('classify: verdict parsing and confidence clamping stay on the contract', () => {
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict({ confidence: 0.5 }), null, 'a verdict without a label is unusable');
  assert.deepEqual(parseVerdict({ label: 'x'.repeat(60), confidence: -2, severity: 'weird', notes: 'y'.repeat(400) }), {
    label: 'x'.repeat(48), confidence: 0, severity: 'none', notes: 'y'.repeat(200), commonName: '', botanicalName: '', pathogenName: '',
  });
  assert.equal(clampConfidence(0.5), 0.5);
  assert.equal(clampConfidence(87), 0.87);
  assert.equal(clampConfidence(100), 1);
  assert.equal(clampConfidence(0), 0);
  assert.equal(clampConfidence('nope'), 0);
});

test('classify: provider response shapes are extracted defensively', () => {
  assert.deepEqual(extractOpenAiText({ output_text: '{"a":1}' }), { a: 1 });
  assert.deepEqual(extractOpenAiText({ output: [{ content: [{ type: 'output_text', text: '{"b":2}' }] }] }), { b: 2 });
  assert.equal(extractOpenAiText({ output: [] }), null);
  assert.equal(extractOpenAiText({ output_text: 'not json { no' }), null);
  assert.deepEqual(extractGeminiText(geminiBody(GOOD)), GOOD);
  assert.equal(extractGeminiText({}), null);
  assert.equal(extractGeminiText({ candidates: [{ content: { parts: [{ text: '<' }] } }] }), null);
});
