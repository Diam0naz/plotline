// One-off: generate the 5 brag-video narration clips with ElevenLabs.
// Run: node --env-file=.env.local scripts/brag-vo.mjs
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { createWriteStream, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George (warm, narrative)
const MODEL_ID = 'eleven_v4';
const OUT_DIR = join('brag-output-2026-11-14-055831', 'composition', 'assets', 'vo');

const LINES = [
  'Amina kept two hundred and twelve trees alive for three years. Six hundred and thirty-six tree-years of climate work, and she was paid nothing.',
  'Money moves on evidence. So Plotline turns her living trees into proof.',
  'She walks the plot offline. An independent verifier signs it against satellite data. A credit is issued.',
  'Anyone can trace that credit, with no login, and the payment lands on her phone.',
  'Plotline. Proven climate work, paid to the farmer.',
];

if (!process.env.ELEVENLABS_API_KEY) {
  console.error('ELEVENLABS_API_KEY not set. Run through: node --env-file=.env.local scripts/brag-vo.mjs');
  process.exit(1);
}

const client = new ElevenLabsClient();
mkdirSync(OUT_DIR, { recursive: true });

for (let i = 0; i < LINES.length; i++) {
  const file = join(OUT_DIR, `${String(i + 1).padStart(2, '0')}.mp3`);
  const audio = await client.textToSpeech.convert(VOICE_ID, {
    text: LINES[i],
    modelId: MODEL_ID,
    outputFormat: 'mp3_44100_128',
    previousText: i > 0 ? LINES[i - 1] : undefined,
    nextText: i < LINES.length - 1 ? LINES[i + 1] : undefined,
  });
  await pipeline(Readable.fromWeb(audio), createWriteStream(file));
  console.log('wrote', file);
}
