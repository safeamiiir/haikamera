// Haikamera — a zero-dependency Node server.
//
// Two jobs:
//   1. Serve the mobile web app from ./public
//   2. Be the only thing that talks to third-party APIs, so keys stay server-side
//
//   POST /api/poem    photo -> { title, poem[3], objects[], colors[], mood }
//   GET  /api/health  { ok, demo, model, models }
//
// The flow: an open-weight vision model looks at your photo and writes a tiny
// haiku (5-7-5) grounded in the colours and objects that are actually there.
// The picture you see is your own photo — we never invent or fetch another one.
//
// Privacy by construction:
//   - No accounts, no cookies, no analytics, no logs of image content.
//   - The uploaded frame is held in memory only for the duration of the request.
//   - With no AI_API_KEY set, the app runs in DEMO MODE (a canned verse).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

// Minimal .env loader so plain `node server.js` picks up your key (no
// --env-file needed). Anything already set in the real environment wins.
try {
  for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // No .env file — fine, we just run in demo mode.
}

const PORT = Number(process.env.PORT || 8787);
const AI_API_KEY = (process.env.AI_API_KEY || '').trim();

// One config line picks the brains. Each preset pairs a provider's base URL
// with a strong, free, open-weight vision model (plus a same-provider fallback).
// Everything is OpenAI-compatible, so any host works.
const PROVIDERS = {
  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it:free',
    fallbacks:
      'google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,openrouter/free',
  },
  groq: {
    base: 'https://api.groq.com/openai/v1',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    fallbacks: 'meta-llama/llama-4-scout-17b-16e-instruct',
  },
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.2-11b-vision-instruct',
    fallbacks: '',
  },
  hf: {
    base: 'https://router.huggingface.co/v1',
    model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    fallbacks: '',
  },
};

// Infer the provider from the key's prefix so any key "just works" without also
// having to set AI_BASE_URL. Explicit env vars always win.
function detectProvider(key) {
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('nvapi-')) return 'nvidia';
  if (key.startsWith('hf_')) return 'hf';
  return 'openrouter';
}

const AI_PROVIDER = (process.env.AI_PROVIDER || detectProvider(AI_API_KEY)).trim().toLowerCase();
const preset = PROVIDERS[AI_PROVIDER] || PROVIDERS.openrouter;

const AI_BASE_URL = (process.env.AI_BASE_URL || preset.base).replace(/\/+$/, '');
const AI_MODEL = (process.env.AI_MODEL || preset.model).trim();
const AI_FALLBACK_MODELS = (process.env.AI_FALLBACK_MODELS ?? preset.fallbacks)
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m && m !== AI_MODEL);
const AI_MODELS = [AI_MODEL, ...AI_FALLBACK_MODELS];

// OpenRouter asks for these to attribute traffic; harmless elsewhere.
const AI_APP_TITLE = (process.env.AI_APP_TITLE || 'Haikamera').trim();
const AI_APP_URL = (process.env.AI_APP_URL || 'https://github.com/').trim();

const DEMO = !AI_API_KEY;

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB
const REQUEST_TIMEOUT_MS = 60_000; // per model
const TOTAL_BUDGET_MS = 70_000; // across all models before we settle for the fallback verse

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- Small in-memory rate limiter ---------------------------------------
function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (now > entry.reset) hits.delete(ip);
  }, windowMs).unref();
  return (ip) => {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.reset) {
      hits.set(ip, { count: 1, reset: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

const limitedPoem = makeLimiter(30, 10 * 60 * 1000);

// ---- The poet prompt -----------------------------------------------------
const SYSTEM_PROMPT = `You are "Haikamera" — a poet who stops walking, looks at one ordinary thing, and writes a tiny colour-haiku about it.

You are shown ONE photograph. Look before you write: quietly name the colours you can see and the concrete objects in the frame. Then write a haiku from those notes.

Hard rules (follow all of them):
1. Exactly THREE lines, with exactly this many syllables: 5, then 7, then 5.
   - Count the syllables of every word, add them up, and check each line equals its target before you answer.
   - Worked example: "the kettle sings low" -> the(1) ket-tle(2) sings(1) low(1) = 5 syllables.
   - Plain, short words make counting easy; reach for them.
2. Every line must mention something that is really in the photo — a concrete object (mug, railing, leaf, kettle, tiles, wire) and, in most lines, a specific colour (amber, moss, slate, rust, cream, ochre, ash, indigo).
3. Lead with colour and light. Dim light, shadows, reflections and textures are all fair game.
4. Do NOT invent things that are not visible. Do NOT use these clichés: beauty, majestic, breathtaking, nature's embrace, whisper, dance, eternal, serene.
5. Present tense, sensory, calm, kind, family-friendly. No rhyme needed.

After the poem, list the objects you can actually see and the dominant colours.

Reply with STRICT JSON ONLY — no markdown, no code fences, and nothing before or after the braces — in exactly this shape:
{
  "title": "morning window",
  "poem": ["the 5-syllable line", "the 7-syllable line", "the 5-syllable line"],
  "objects": ["mug", "steam", "window light"],
  "colors": [{"name": "amber", "hex": "#c98a3b"}, {"name": "slate", "hex": "#5b6770"}],
  "mood": "one calm lowercase word"
}
Constraints: "title" is a real 2-5 word name for THIS scene (never the words "plain words" or a placeholder); 2-6 objects, 3-6 colours, each hex a valid "#rrggbb". If the photo is unclear, still answer — describe the colours and shapes you can honestly see. Never refuse and never leave a field empty.`;

const POEM_INSTRUCTION =
  'Write the 5-7-5 haiku about this scene now. Count each line\'s syllables and reply with the strict JSON object only.';

function buildProviderRequest(model, imageDataUrl) {
  return {
    model,
    temperature: 0.8,
    max_tokens: 600,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: POEM_INSTRUCTION },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };
}

// Pull the first JSON object out of a model reply, tolerating stray prose/fences.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join(' ');
  return '';
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const asString = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);

// ---- Never give up: a guaranteed verse -----------------------------------
const FALLBACK = {
  title: 'A quiet frame',
  poem: ['Light settles slowly', 'The colours wait to be named', 'The world holds its breath'],
  objects: ['light', 'shadow'],
  colors: [
    { name: 'slate', hex: '#5b6770' },
    { name: 'amber', hex: '#c98a3b' },
    { name: 'cream', hex: '#efe6d2' },
  ],
  mood: 'still',
};

function demoResult() {
  return {
    title: 'Morning kitchen',
    poem: ['Steam climbs from the cup', 'Amber light bends through the glass', 'Grey tiles hold the day'],
    objects: ['ceramic mug', 'steam', 'window light'],
    colors: [
      { name: 'amber', hex: '#c98a3b' },
      { name: 'slate', hex: '#6b7280' },
      { name: 'cream', hex: '#efe6d2' },
    ],
    mood: 'still',
    demo: true,
    model: 'demo',
  };
}

function normalizeColor(input) {
  const name = asString(input?.name).slice(0, 24);
  if (!name) return null;
  let hex = asString(input?.hex).toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(hex)) hex = '#' + hex.slice(1).split('').map((c) => c + c).join('');
  if (!/^#[0-9a-f]{6}$/.test(hex)) hex = '#8a8a8a';
  return { name, hex };
}

function normalizePoem(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lines = asArray(r.poem)
    .filter((l) => typeof l === 'string' && l.trim())
    .map((l) => l.trim().slice(0, 120))
    .slice(0, 3);

  const colors = asArray(r.colors).map(normalizeColor).filter(Boolean).slice(0, 6);
  const objects = asArray(r.objects)
    .filter((o) => typeof o === 'string' && o.trim())
    .map((o) => o.trim().slice(0, 40))
    .slice(0, 6);

  // Models sometimes echo the schema placeholder as the title. Ignore those.
  let title = asString(r.title).trim().slice(0, 60);
  if (/plain words|placeholder|^title$/i.test(title) || /^\d+\s*-\s*\d+$/.test(title)) title = '';

  return {
    title: title || FALLBACK.title,
    poem: lines.length ? lines : FALLBACK.poem.slice(),
    objects: objects.length ? objects : FALLBACK.objects.slice(),
    colors: colors.length ? colors : FALLBACK.colors.map((c) => ({ ...c })),
    mood: asString(r.mood, FALLBACK.mood).slice(0, 24).toLowerCase() || FALLBACK.mood,
  };
}

// ---- Vision model --------------------------------------------------------
async function callVisionModel(model, imageDataUrl) {
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
      // OpenRouter attribution headers — ignored by other hosts.
      'HTTP-Referer': AI_APP_URL,
      'X-Title': AI_APP_TITLE,
    },
    body: JSON.stringify(buildProviderRequest(model, imageDataUrl)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Provider responded ${res.status}`);
    err.status = res.status;
    err.detail = detail.slice(0, 400);
    throw err;
  }
  return extractText(await res.json());
}

// Only auth/credit problems are worth stopping for. A 403 is usually
// model-specific (e.g. a paid model blocked by a $0 key), so keep trying other
// models rather than giving up.
const isFatalProviderError = (status) => status === 401 || status === 402;

async function writePoem(imageDataUrl) {
  if (DEMO) return demoResult();

  const models = AI_MODELS.length ? AI_MODELS : [AI_MODEL];
  let parsed = null;
  let lastErr = null;
  let rawSample = '';
  let usedModel = null;
  const started = Date.now();

  for (const model of models) {
    if (Date.now() - started > TOTAL_BUDGET_MS) break;
    // Retry the SAME model only when it answered but with unparseable JSON
    // (stray prose/fences). Transport errors (429, 5xx) skip straight to the
    // next model — retrying a rate-limited pool immediately is pointless.
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      let text;
      try {
        text = await callVisionModel(model, imageDataUrl);
      } catch (err) {
        lastErr = err;
        break;
      }
      parsed = extractJson(text);
      if (parsed) {
        usedModel = model;
      } else {
        rawSample = String(text || '').slice(0, 200);
      }
    }
    if (parsed) break;
    if (isFatalProviderError(lastErr?.status)) break;
  }

  if (!parsed && isFatalProviderError(lastErr?.status)) throw lastErr;

  const result = normalizePoem(parsed || FALLBACK);
  result.model = usedModel || 'fallback-verse';
  if (!parsed) result.degraded = true;

  const reason = parsed
    ? ''
    : lastErr
      ? ` lastErr=${lastErr.status || ''} ${String(lastErr.detail || lastErr.message || '').slice(0, 120)}`
      : ` unparseable="${rawSample}"`;
  console.log(
    `[poem] model=${result.model} degraded=${Boolean(result.degraded)} ${Date.now() - started}ms${reason}`
  );
  return result;
}

// ---- Loading words: playful gerunds for the "working" screen -------------
// Shown while a photo is being turned into a haiku. The AI invents a fresh
// batch (text-only, cheap, cached for hours); a built-in list is the fallback.
const FALLBACK_PULSES = [
  'Haikoizing',
  'Shakespearing',
  'Poemising',
  'Versifying',
  'Colour-gathering',
  'Scene-reading',
  'Light-measuring',
  'Muse-whispering',
  'Metre-counting',
  'Stanza-crafting',
  'Noticing',
  'Pondering',
  'Beholding',
  'Image-sonneting',
  'Word-gardening',
];

const PULSE_TTL_MS = 3 * 60 * 60 * 1000;
let pulsePool = FALLBACK_PULSES.slice();
let pulseGeneratedAt = 0;
let pulseInFlight = null;

const PULSE_PROMPT = `You invent playful gerund words for the loading screen of an app that turns a photo into a tiny haiku poem.
Return a JSON array of 20 SHORT, original gerunds (single words or hyphenated), each ending in "-ing", describing the act of truly noticing a scene and turning it into a poem.
Be witty and varied; mix the poetic (haikoizing, shakespearing, versifying) with the literal (colour-sipping, light-counting, scene-scanning).
STRICT JSON only — a single array of lowercase strings, no prose, no code fences. Example shape: ["haikoizing","shakespearing","poemising"]`;

async function generatePulsePool() {
  const tried = [];
  for (const model of AI_MODELS) {
    try {
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AI_API_KEY}`,
          'HTTP-Referer': AI_APP_URL,
          'X-Title': AI_APP_TITLE,
        },
        body: JSON.stringify({
          model,
          temperature: 1,
          max_tokens: 300,
          messages: [
            { role: 'system', content: PULSE_PROMPT },
            { role: 'user', content: 'Generate the list now.' },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        tried.push(`${model}:${res.status}`);
        if (isFatalProviderError(res.status)) break; // bad key / no credit
        continue; // 429/5xx — try the next model
      }
      const text = extractText(await res.json());
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end <= start) {
        tried.push(`${model}:no-json`);
        continue;
      }
      const words = JSON.parse(text.slice(start, end + 1))
        .filter((w) => typeof w === 'string')
        .map((w) => w.trim().toLowerCase().replace(/[^a-z-]/g, ''))
        .filter((w) => /ing$/.test(w) && w.length >= 5 && w.length <= 24);

      if (words.length >= 6) {
        pulsePool = [...new Set(words)].slice(0, 30);
        pulseGeneratedAt = Date.now();
        console.log(`[pulse] ${pulsePool.length} words via ${model}`);
        return;
      }
      tried.push(`${model}:${words.length}-words`);
    } catch (err) {
      tried.push(`${model}:${err?.name === 'TimeoutError' ? 'timeout' : 'error'}`);
    }
  }
  console.log(`[pulse] kept the built-in fallback words (tried: ${tried.join(', ')})`);
}

// ---- Tiny helpers --------------------------------------------------------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const info = await stat(filePath);
    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    // The app shell must always be revalidated: a stale app.js running against
    // a newer index.html (or vice-versa) throws errors like setting a property
    // of null. Only genuinely static assets (the icon, images) get cached.
    const isShell = rel === '/index.html' || ['.html', '.js', '.css', '.webmanifest'].includes(ext);
    const cacheControl = isShell ? 'no-cache' : 'public, max-age=3600';
    const lastModified = info.mtime.toUTCString();

    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, { 'Cache-Control': cacheControl, 'Last-Modified': lastModified });
      return res.end();
    }

    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Last-Modified': lastModified,
      'Cache-Control': cacheControl,
    });
    res.end(data);
  } catch {
    if (!extname(rel)) {
      try {
        const shell = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return res.end(shell);
      } catch {
        /* fall through */
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}

// ---- Server --------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // --- write a poem about the photo ---
  if (url.pathname === '/api/poem') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (limitedPoem(clientIp(req))) {
      return sendJson(res, 429, { error: 'Too many verses. Take a breath and try again shortly.' });
    }
    try {
      const body = await readBody(req, MAX_BODY_BYTES);
      const { image } = JSON.parse(body || '{}');
      if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
        return sendJson(res, 400, { error: 'Expected a JPEG/PNG/WebP data URL in "image".' });
      }
      return sendJson(res, 200, await writePoem(image));
    } catch (err) {
      const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      console.error('[poem]', status, err?.message || err);
      return sendJson(res, status, {
        error:
          status === 413
            ? 'That photo is too large. Try again.'
            : 'Could not reach the model right now. Check your API key and try again.',
        demo: DEMO,
      });
    }
  }

  // --- health ---
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      demo: DEMO,
      provider: DEMO ? 'demo' : AI_PROVIDER,
      model: DEMO ? 'demo' : AI_MODEL,
      models: DEMO ? ['demo'] : AI_MODELS,
    });
  }

  // Playful gerunds for the loading screen (AI-generated, cached).
  if (url.pathname === '/api/pulse') {
    if (!DEMO && Date.now() - pulseGeneratedAt > PULSE_TTL_MS && !pulseInFlight) {
      pulseInFlight = generatePulsePool().finally(() => {
        pulseInFlight = null;
      });
    }
    return sendJson(res, 200, { words: pulsePool });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  const mode = DEMO
    ? 'DEMO MODE (no API key — canned verse)'
    : `LIVE — ${AI_PROVIDER} · ${AI_MODEL}${AI_FALLBACK_MODELS.length ? ` (fallbacks: ${AI_FALLBACK_MODELS.join(', ')})` : ''}`;
  console.log(`\n  Haikamera is running.  ${mode}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Phone:   http://<your-computer-LAN-IP>:${PORT}  (same Wi-Fi)\n`);

  // Warm up the AI-generated loading words in the background (non-blocking).
  if (!DEMO) generatePulsePool();
});
