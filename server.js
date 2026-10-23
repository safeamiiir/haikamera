// Haikamera — a zero-dependency Node server.
//
// Two jobs:
//   1. Serve the mobile web app from ./public
//   2. Be the only thing that talks to third-party APIs, so keys stay server-side
//
//   POST /api/poem    photo + mode -> { title, poem[3] | story, objects[], colors[] }
//   GET  /api/health  { ok, demo, model, models, modes }
//
// The flow: an open-weight vision model looks at your photo and writes either a
// tiny haiku (5-7-5) or a one-paragraph short story, grounded in the colours and
// objects that are actually there. The picture you see is your own photo — we
// never invent or fetch another one.
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

// One config line picks the brains. Each preset pairs a provider's base URL
// with a strong, free, open-weight vision model (plus a same-provider fallback).
// Everything is OpenAI-compatible, so any host works.
const PROVIDERS = {
  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    // Gemma leads: it's the best writer of the free set. The shared pool does
    // rate-limit it often, so the chain falls through to the models that answer
    // most dependably — and since a 429 comes back in ~300ms, leading with Gemma
    // costs almost nothing. `openrouter/free` is deliberately NOT here: it can
    // route to a content-safety classifier instead of a poet.
    model: 'google/gemma-4-31b-it:free',
    fallbacks:
      'google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,dots-studio/dots-3-note-preview:free',
    // OpenRouter's unified switch. Models that don't reason simply ignore it.
    noThink: { reasoning: { enabled: false } },
  },
  groq: {
    base: 'https://api.groq.com/openai/v1',
    // Groq retired its Llama 4 vision models (Maverick in March 2026, Scout in
    // July) and the advertised replacements are text-only — so for a while a
    // Groq key couldn't read a photo at all. Qwen 3.8 27B is now its one
    // multimodal model. It's a *preview* model, so treat it as a moving target.
    model: 'qwen/qwen3.8-27b',
    fallbacks: '',
    // Groq's own spelling. Qwen 3.8 27B reasons by default; "none" switches it
    // off. (`reasoning_format` is left alone — "raw" + JSON mode would 400.)
    noThink: { reasoning_effort: 'none' },
    // Groq deprecated `max_tokens` in favour of this name.
    maxTokensParam: 'max_completion_tokens',
  },
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.2-11b-vision-instruct',
    fallbacks: '',
    noThink: {},
  },
  hf: {
    base: 'https://router.huggingface.co/v1',
    model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    fallbacks: '',
    noThink: {},
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

// OpenRouter asks for these to attribute traffic; harmless elsewhere.
const AI_APP_TITLE = (process.env.AI_APP_TITLE || 'Haikamera').trim();
const AI_APP_URL = (process.env.AI_APP_URL || 'https://github.com/safeamiiir/haikamera').trim();

// You can run more than one provider at once. AI_API_KEY holds a single key
// (the usual case). AI_API_KEYS takes a comma-separated list, each auto-detected
// from its prefix and tried in the order written:
//
//   AI_API_KEYS=gsk_...,sk-or-v1-...
//
// so a Groq key leads (fast, 1,000/day) and OpenRouter free picks up the slack.
const API_KEYS = (process.env.AI_API_KEYS || process.env.AI_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

// AI_PROVIDER / AI_BASE_URL / AI_MODEL / AI_FALLBACK_MODELS describe ONE
// provider, so they only apply when a single key is configured. With several
// keys each keeps its own provider's defaults — otherwise you'd be asking Groq
// for an OpenRouter model.
const SINGLE_KEY = API_KEYS.length === 1;

function endpointFor(apiKey) {
  const name = (SINGLE_KEY && process.env.AI_PROVIDER
    ? process.env.AI_PROVIDER
    : detectProvider(apiKey)
  )
    .trim()
    .toLowerCase();
  const preset = PROVIDERS[name] || PROVIDERS.openrouter;

  const base = ((SINGLE_KEY && process.env.AI_BASE_URL) || preset.base).replace(/\/+$/, '');
  const model = ((SINGLE_KEY && process.env.AI_MODEL) || preset.model).trim();
  const fallbacks = ((SINGLE_KEY ? process.env.AI_FALLBACK_MODELS : undefined) ?? preset.fallbacks)
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== model);

  // Reasoning models think before they answer, which for a three-line haiku is
  // waste — and the thinking often eats the whole output budget so `content`
  // comes back empty (see MAX_TOKENS below). Each host spells "don't think"
  // differently, so the exact params live on the preset. We only send them to
  // the preset's own base URL: point AI_BASE_URL at some other host and it gets
  // the plain OpenAI body unless you set AI_REASONING=off yourself.
  const onPresetBase = base === preset.base.replace(/\/+$/, '');
  const thinkOff =
    (process.env.AI_REASONING || (onPresetBase ? 'off' : 'on')) === 'on'
      ? {}
      : { ...(preset.noThink || {}) };

  return {
    name,
    base,
    key: apiKey,
    thinkOff,
    maxTokensParam: preset.maxTokensParam || 'max_tokens',
    models: [model, ...fallbacks],
  };
}

const AI_ENDPOINTS = API_KEYS.map(endpointFor);

// The flat list writePoem walks: every model of every provider, in order.
const AI_TRIES = AI_ENDPOINTS.flatMap((ep) =>
  ep.models.map((model) => ({
    provider: ep.name,
    base: ep.base,
    key: ep.key,
    model,
    thinkOff: ep.thinkOff,
    maxTokensParam: ep.maxTokensParam,
  }))
);
const AI_MODELS = AI_TRIES.map((t) => t.model);

const DEMO = AI_TRIES.length === 0;

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB

// Most free vision models available today are *reasoning* models: they think in
// a `reasoning` channel before they answer. For a three-line haiku that is pure
// waste — and worse, the thinking eats the output budget, so `content` comes
// back empty and the JSON never arrives. That is the single biggest cause of the
// "fallback verse" card. So give the reply room. Whether to also switch thinking
// off is per-endpoint, because each host spells it differently — see `noThink`
// and `thinkOff` in the provider presets above.
const MAX_TOKENS = Math.max(300, Number(process.env.AI_MAX_TOKENS) || 2000);

const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.AI_REQUEST_TIMEOUT_MS) || 30_000);
const TOTAL_BUDGET_MS = Math.max(2000, Number(process.env.AI_TOTAL_BUDGET_MS) || 60_000);
// Don't start an attempt there's no time to finish, and don't let the guard
// swallow a deliberately tiny test budget.
const MIN_ATTEMPT_MS = Math.min(4000, Math.max(250, Math.floor(TOTAL_BUDGET_MS / 10)));
// Kept low on purpose: a free OpenRouter account is capped per DAY (50 requests,
// or 1,000 with a one-off $10 credit), and every attempt that comes back with
// prose instead of JSON spends one. Failing fast beats burning the day's budget.
const MAX_ATTEMPTS = Math.max(1, Number(process.env.AI_MAX_ATTEMPTS) || 2);

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

// ---- The writer prompt ---------------------------------------------------
// Two forms share the same act of looking: a haiku (three counted lines) and a
// one-paragraph short story. Both are grounded in the colours and objects that
// are really in the frame; only the shape of the writing changes.
const MODES = new Set(['haiku', 'story']);

const SCENE_PROMPT = `You are "Haikamera" — a poet and storyteller who stops walking, looks at one ordinary thing, and writes about it.

You are shown ONE photograph. Look before you write: quietly name the colours you can see and the concrete objects in the frame. Then write from those notes.

Grounding rules (follow them in both forms):
- Every object and colour you name must really be in the photo. Do NOT invent things that are not visible.
- Lead with colour and light. Dim light, shadows, reflections and textures are all fair game.
- Keep it sensory, calm, kind and family-friendly.
- Do NOT use these clichés: beauty, majestic, breathtaking, nature's embrace, whisper, dance, eternal, serene.
- If the photo is unclear, still answer — describe the colours and shapes you can honestly see. Never refuse and never leave a field empty.`;

const HAIKU_RULES = `Write a HAIKU — a tiny three-line colour poem.

Hard rules (follow all of them):
1. Exactly THREE lines, with exactly this many syllables: 5, then 7, then 5.
   - Count the syllables of every word, add them up, and check each line equals its target before you answer.
   - Worked example: "the kettle sings low" -> the(1) ket-tle(2) sings(1) low(1) = 5 syllables.
   - Plain, short words make counting easy; reach for them.
2. Every line must mention something that is really in the photo — a concrete object (mug, railing, leaf, kettle, tiles, wire) and, in most lines, a specific colour (amber, moss, slate, rust, cream, ochre, ash, indigo).
3. Lead with colour and light. Dim light, shadows, reflections and textures are all fair game.
4. Present tense, sensory, calm, kind, family-friendly. No rhyme needed.`;

const STORY_RULES = `Write a SHORT STORY — exactly ONE paragraph, about 80-120 words.

Follow the craft of a tiny story:
1. GROUND IT IN THE FRAME. Set the story in the place the photo shows. Name at least three concrete objects that are actually visible and at least two of its dominant colours.
2. GIVE SOMEONE A SMALL WANT. Put one ordinary character at the centre — a person the frame hints at (a hand, a coat, an empty chair), an animal that is actually there, or even the light itself. If the frame shows no one, do not invent a stranger; let an object, an animal, or the light carry the moment. In the opening sentence, show where they are and what they are doing or hoping for.
3. TURN THE MOMENT. In the middle, let something small shift: a sound, a change in the light, a thing noticed, a tiny obstacle. Keep the stakes small and real; no drama the frame cannot hold.
4. END QUIETLY. Finish on a concrete image or gesture that shows the change, not a lesson or a moral. Leave a little space for the reader.
5. SHOW, DON'T TELL. Use plain, specific, sensory words. No summary of feelings, no moralising, no twist that needs more room than one paragraph.
6. ONE PARAGRAPH ONLY. 80-120 words, 4-7 sentences. No line breaks. Do not rhyme or write in verse.

You may imagine a small moment around the scene, but keep every physical detail consistent with the photo. Do not name a famous person, brand, or real event. Do not give the story a second paragraph.`;

function outputRulesFor(mode) {
  const header = `Reply with STRICT JSON ONLY — no markdown, no code fences, and nothing before or after the braces — in exactly this shape:`;
  if (mode === 'story') {
    return `${header}
{
  "title": "morning window",
  "story": "the one-paragraph story",
  "objects": ["mug", "steam", "window light"],
  "colors": [{"name": "amber", "hex": "#c98a3b"}, {"name": "slate", "hex": "#5b6770"}]
}
Constraints: "title" is a real 2-5 word name for THIS scene (never the words "plain words" or a placeholder); "story" is ONE paragraph of 80-120 words that follows the craft rules above; 2-6 objects, 3-6 colours, each hex a valid "#rrggbb". If the photo is unclear, still answer — describe the colours and shapes you can honestly see. Never refuse and never leave a field empty. Output the JSON object immediately: no preamble, no step-by-step reasoning, nothing after the closing brace.`;
  }
  return `${header}
{
  "title": "morning window",
  "poem": ["the 5-syllable line", "the 7-syllable line", "the 5-syllable line"],
  "objects": ["mug", "steam", "window light"],
  "colors": [{"name": "amber", "hex": "#c98a3b"}, {"name": "slate", "hex": "#5b6770"}]
}
Constraints: "title" is a real 2-5 word name for THIS scene (never the words "plain words" or a placeholder); exactly three poem lines with 5, 7 and 5 syllables; 2-6 objects, 3-6 colours, each hex a valid "#rrggbb". If the photo is unclear, still answer — describe the colours and shapes you can honestly see. Never refuse and never leave a field empty. Output the JSON object immediately: no preamble, no step-by-step reasoning, nothing after the closing brace.`;
}

// ---- Language ------------------------------------------------------------
// The app writes in English by default. Ask for "fa" and the model answers in
// Persian (Farsi) instead, so a Farsi speaker reads the poem or story in their
// own script rather than a translation of ours. The JSON *keys* never change —
// only the values do.
const LANGUAGES = new Set(['en', 'fa']);

function languageClause(language, mode = 'haiku') {
  if (language !== 'fa') return '';
  const textField = mode === 'story' ? 'the "story" paragraph' : 'all three poem lines';
  const formRule =
    mode === 'story'
      ? 'Write the story as ONE paragraph of about 80-120 Persian words, with the same craft: a place, a small want, a turn, and a quiet resolution.'
      : 'Persian does not count syllables the way English or Japanese does, so ignore the 5-7-5 syllable rule above: just write three short, calm lines that notice the scene.';
  return `

LANGUAGE: Write EVERYTHING in Persian (Farsi) using the Persian script — the "title", ${textField}, the object names and the colour names. Never use Latin transliteration or English words.
- ${formRule}
- Keep the JSON keys in English exactly as specified; only the values are in Persian.`;
}

function systemPromptFor(language, mode = 'haiku') {
  const form = mode === 'story' ? STORY_RULES : HAIKU_RULES;
  return [SCENE_PROMPT, form, outputRulesFor(mode)].join('\n\n') + languageClause(language, mode);
}

const HAIKU_INSTRUCTION =
  'Write the 5-7-5 haiku about this scene now. Count each line\'s syllables, then reply with the strict JSON object only — no explanation before or after it.';
const STORY_INSTRUCTION =
  'Write the one-paragraph short story about this scene now — 80-120 words, one paragraph. Then reply with the strict JSON object only — no explanation before or after it.';

function writeInstructionFor(language, mode = 'haiku') {
  if (mode === 'story') {
    return language === 'fa'
      ? 'Write the one-paragraph Persian (Farsi) short story about this scene now, then reply with the strict JSON object only — no explanation before or after it.'
      : STORY_INSTRUCTION;
  }
  return language === 'fa'
    ? 'Write the three-line Persian (Farsi) poem about this scene now, then reply with the strict JSON object only — no explanation before or after it.'
    : HAIKU_INSTRUCTION;
}

function buildProviderRequest(target, imageDataUrl, language = 'en', mode = 'haiku') {
  const { model, thinkOff = {}, maxTokensParam = 'max_tokens' } = target;
  return {
    model,
    temperature: 0.8,
    [maxTokensParam]: MAX_TOKENS,
    ...thinkOff,
    messages: [
      { role: 'system', content: systemPromptFor(language, mode) },
      {
        role: 'user',
        content: [
          { type: 'text', text: writeInstructionFor(language, mode) },
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

// The usable text of a reply, in priority order. Reasoning models emit the
// answer in `content` once they finish thinking — but when they run into the
// output cap mid-thought, `content` is empty and the JSON only exists in the
// `reasoning` channel. So hand back every channel worth scanning.
function messageTexts(data) {
  const msg = data?.choices?.[0]?.message || {};
  const texts = [];
  const push = (value) => {
    if (typeof value === 'string') {
      if (value.trim()) texts.push(value);
    } else if (Array.isArray(value)) {
      const joined = value.map((part) => part?.text || '').join(' ');
      if (joined.trim()) texts.push(joined);
    }
  };
  push(msg.content);
  push(msg.reasoning);
  push(msg.reasoning_content);
  return texts;
}

// First JSON array inside some text, tolerating stray prose/fences.
function extractJsonArray(text) {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const asString = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);

// ---- Never give up: a guaranteed verse -----------------------------------
const FALLBACK_HAIKU = {
  title: 'A quiet frame',
  poem: ['Light settles slowly', 'The colours wait to be named', 'The world holds its breath'],
  objects: ['light', 'shadow'],
  colors: [
    { name: 'slate', hex: '#5b6770' },
    { name: 'amber', hex: '#c98a3b' },
    { name: 'cream', hex: '#efe6d2' },
  ],
};

const FALLBACK_STORY = {
  title: 'A quiet frame',
  story:
    'Light crosses the windowsill and settles on the floor. A cup has gone cold beside the wall, and a grey shadow stretches across the tiles. No one is in the room, but something has just begun: dust turns in the amber air, the curtain shifts, and the morning goes quietly about its work.',
  objects: ['light', 'cup', 'shadow', 'tiles'],
  colors: [
    { name: 'slate', hex: '#5b6770' },
    { name: 'amber', hex: '#c98a3b' },
    { name: 'cream', hex: '#efe6d2' },
  ],
};

// The same "never give up" writing in Persian, so a failed Farsi request still
// comes back in the language the reader asked for.
const FALLBACK_HAIKU_FA = {
  title: 'قاب آرام',
  poem: ['نور آرام مینشیند', 'رنگها در انتظارند', 'جهان نفس میکشد'],
  objects: ['نور', 'سایه'],
  colors: [
    { name: 'خاکستری', hex: '#5b6770' },
    { name: 'کهربایی', hex: '#c98a3b' },
    { name: 'کرم', hex: '#efe6d2' },
  ],
};

const FALLBACK_STORY_FA = {
  title: 'پنجره‌ی آرام',
  story:
    'نور از لبه‌ی پنجره می‌گذرد و آرام روی زمین می‌نشیند. فنجانی سرد کنار دیوار مانده و سایه‌ای خاکستری روی کاشی‌ها کشیده شده است. کسی در اتاق نیست، اما چیزی تازه شروع شده: گرد و غبار در هوای کهربایی می‌چرخد، پرده تکان می‌خورد و صبح بی‌صدا کارش را ادامه می‌دهد.',
  objects: ['نور', 'فنجان', 'سایه', 'کاشی'],
  colors: [
    { name: 'خاکستری', hex: '#5b6770' },
    { name: 'کهربایی', hex: '#c98a3b' },
    { name: 'کرم', hex: '#efe6d2' },
  ],
};

function fallbackFor(language, mode = 'haiku') {
  if (mode === 'story') return language === 'fa' ? FALLBACK_STORY_FA : FALLBACK_STORY;
  return language === 'fa' ? FALLBACK_HAIKU_FA : FALLBACK_HAIKU;
}

function demoHaikuResult(language = 'en') {
  if (language === 'fa') {
    return {
      title: 'آشپزخانهی صبح',
      poem: ['بخار از فنجان بالا میرود', 'نور کهربایی از شیشه میگذرد', 'کاشیهای خاکستری روز را نگه میدارند'],
      objects: ['فنجان سرامیکی', 'بخار', 'نور پنجره'],
      colors: [
        { name: 'کهربایی', hex: '#c98a3b' },
        { name: 'خاکستری', hex: '#6b7280' },
        { name: 'کرم', hex: '#efe6d2' },
      ],
      demo: true,
      model: 'demo',
    };
  }
  return {
    title: 'Morning kitchen',
    poem: ['Steam climbs from the cup', 'Amber light bends through the glass', 'Grey tiles hold the day'],
    objects: ['ceramic mug', 'steam', 'window light'],
    colors: [
      { name: 'amber', hex: '#c98a3b' },
      { name: 'slate', hex: '#6b7280' },
      { name: 'cream', hex: '#efe6d2' },
    ],
    demo: true,
    model: 'demo',
  };
}

function demoStoryResult(language = 'en') {
  if (language === 'fa') {
    return {
      title: 'ساعت کهربایی',
      story:
        'فنجان روی طاقچه‌ی پنجره سرد شده، اما مینا هنوز هر دو دستش را دور آن نگه داشته است. بخار دیگر بالا نمی‌رود و آشپزخانه آن‌قدر ساکت است که صدای تیک‌تیک یخچال را می‌شنود. از پشت شیشه، پشت‌بام‌های خاکستری رنگِ کاغذ خیس شده‌اند و نواری کهربایی از نور از روی کاشی‌های کرم می‌گذرد و روی انگشتانش می‌ایستد. می‌خواست ده دقیقه پیش راه افتاده باشد. به‌جایش، تماشا می‌کند که نور از دیوار بالا می‌رود تا به فنجان ترک‌خورده‌ی روی قفسه می‌رسد؛ شانه‌هایش پایین می‌آید. کلیدها را برمی‌دارد، فنجان را همان‌جا می‌گذارد و به صبح قدم می‌گذارد.',
      objects: ['فنجان سرامیکی', 'نور پنجره', 'پشت‌بام', 'کاشی'],
      colors: [
        { name: 'کهربایی', hex: '#c98a3b' },
        { name: 'خاکستری', hex: '#6b7280' },
        { name: 'کرم', hex: '#efe6d2' },
      ],
      demo: true,
      mode: 'story',
      model: 'demo',
    };
  }
  return {
    title: 'The amber hour',
    story:
      'The mug has gone cool on the windowsill, but Mira keeps both hands around it anyway. The steam has stopped rising, and the kitchen is still enough to hear the refrigerator ticking. Through the glass, slate rooftops turn the colour of wet paper, and a single amber band of light slides across the cream tiles and stops at her knuckles. She meant to leave ten minutes ago. Instead she watches the light climb the wall until it reaches the chipped cup on the shelf; her shoulders come down. She picks up her keys, leaves the mug where it is, and steps into the morning.',
    objects: ['ceramic mug', 'window light', 'rooftops', 'tiles'],
    colors: [
      { name: 'amber', hex: '#c98a3b' },
      { name: 'slate', hex: '#6b7280' },
      { name: 'cream', hex: '#efe6d2' },
    ],
    demo: true,
    mode: 'story',
    model: 'demo',
  };
}

function demoResult(language = 'en', mode = 'haiku') {
  if (mode === 'story') return demoStoryResult(language);
  return { ...demoHaikuResult(language), mode: 'haiku' };
}

function normalizeColor(input) {
  const name = asString(input?.name).slice(0, 24);
  if (!name) return null;
  let hex = asString(input?.hex).toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(hex)) hex = '#' + hex.slice(1).split('').map((c) => c + c).join('');
  if (!/^#[0-9a-f]{6}$/.test(hex)) hex = '#8a8a8a';
  return { name, hex };
}

function normalizePoem(raw, language = 'en', mode = 'haiku') {
  const fb = fallbackFor(language, mode);
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

  if (mode === 'story') {
    // Accept a paragraph from "story" (or, if a model slips, a poem-shaped
    // array) and flatten it to one paragraph — the brief is a single paragraph.
    const rawStory =
      asString(r.story) ||
      asArray(r.story).join(' ') ||
      asArray(r.poem).join(' ');
    let story = rawStory.replace(/\s+/g, ' ').trim().slice(0, 1400);
    // Reject an echoed schema placeholder, or a reply too short to be a story.
    if (/^(the\s+)?(one-paragraph\s+)?story\.?$/i.test(story)) story = '';
    if (story && story.split(/\s+/).length < 20) story = '';
    return {
      title: title || fb.title,
      story: story || fb.story,
      objects: objects.length ? objects : fb.objects.slice(),
      colors: colors.length ? colors : fb.colors.map((c) => ({ ...c })),
      mode: 'story',
    };
  }

  return {
    title: title || fb.title,
    poem: lines.length ? lines : fb.poem.slice(),
    objects: objects.length ? objects : fb.objects.slice(),
    colors: colors.length ? colors : fb.colors.map((c) => ({ ...c })),
    mode: 'haiku',
  };
}

// ---- Vision model --------------------------------------------------------
// `target` is one entry from AI_TRIES: { provider, base, key, model, thinkOff, maxTokensParam }.
async function callVisionModel(target, imageDataUrl, timeoutMs = REQUEST_TIMEOUT_MS, language = 'en', mode = 'haiku') {
  const { base, key } = target;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      // OpenRouter attribution headers — ignored by other hosts.
      'HTTP-Referer': AI_APP_URL,
      'X-Title': AI_APP_TITLE,
    },
    body: JSON.stringify(buildProviderRequest(target, imageDataUrl, language, mode)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Provider responded ${res.status}`);
    err.status = res.status;
    err.detail = detail.slice(0, 400);
    throw err;
  }
  return res.json();
}

// Only a bad key is worth stopping for. Everything else is model-specific:
// a 402 just means *this* model costs money your $0 key can't cover, and a
// 403 usually means the same — so keep trying the models behind it (a free
// fallback may still work). A 401 means the key itself is wrong.
const isFatalProviderError = (status) => status === 401;

// The daily free-model cap is different in kind: once it's gone, EVERY free
// model on the account 429s, so walking the rest of the chain only adds
// latency. Stop at the first one and say so plainly.
const isDailyQuotaError = (err) =>
  err?.status === 429 && /per-day|per day|free-models/i.test(err.detail || '');

const isFatalError = (err) => isFatalProviderError(err?.status) || isDailyQuotaError(err);

async function writePoem(imageDataUrl, language = 'en', mode = 'haiku') {
  const lang = LANGUAGES.has(language) ? language : 'en';
  const form = MODES.has(mode) ? mode : 'haiku';
  if (DEMO) return { ...demoResult(lang, form), language: lang };

  const tries = AI_TRIES;
  let parsed = null;
  let lastErr = null;
  let fatalErr = null;
  let rawSample = '';
  let usedModel = null;
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  // No single model may eat the whole budget: each gets a fair share, so one
  // that hangs can't starve the models behind it. (The old code let the first
  // model sit through its full timeout twice and left nothing for the rest,
  // which is how a slow model turned into the fallback verse.)
  const share = Math.max(MIN_ATTEMPT_MS, Math.floor(TOTAL_BUDGET_MS / tries.length));
  // A bad key or an exhausted daily quota kills every model behind that key —
  // but not the models behind a *different* key. So retire that key's chain and
  // carry on to the next provider instead of giving up on the whole request.
  const deadKeys = new Set();

  for (const target of tries) {
    if (deadKeys.has(target.key)) continue;
    const modelDeadline = Math.min(deadline, Date.now() + share);

    // Retry the SAME model only when it answered but with unparseable text
    // (stray prose/fences, or one of the empty 200s these free pools emit).
    // Transport errors (429, 5xx) skip straight to the next model — retrying a
    // rate-limited pool immediately is pointless.
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !parsed; attempt += 1) {
      const remaining = modelDeadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) break;

      let data;
      try {
        data = await callVisionModel(target, imageDataUrl, Math.min(REQUEST_TIMEOUT_MS, remaining), lang, form);
      } catch (err) {
        lastErr = err;
        break;
      }

      const texts = messageTexts(data);
      for (const text of texts) {
        parsed = extractJson(text);
        if (parsed) break;
      }
      if (parsed) {
        usedModel = target.model;
      } else {
        const last = texts[texts.length - 1];
        rawSample = last ? String(last).slice(0, 200) : 'empty reply (no content or reasoning)';
        lastErr = null; // answered, just not parseable — not a transport error
      }
    }

    if (parsed) break;
    if (isFatalError(lastErr)) {
      deadKeys.add(target.key);
      fatalErr = lastErr;
      continue; // another provider's key may still work
    }
    if (Date.now() >= deadline) break;
  }

  // Only give up outright when *every* configured key is unusable (wrong key, no
  // credit, or the day's free quota spent). If a key was left, the honest answer
  // is still the labelled fallback verse.
  const everyKeyDead = deadKeys.size >= new Set(tries.map((t) => t.key)).size;
  if (!parsed && fatalErr && everyKeyDead) {
    if (isDailyQuotaError(fatalErr)) fatalErr.quota = true;
    throw fatalErr;
  }

  const result = normalizePoem(parsed || fallbackFor(lang, form), lang, form);
  result.model = usedModel || 'fallback-verse';
  if (!parsed) result.degraded = true;
  result.language = lang;

  const reason = parsed
    ? ''
    : lastErr
      ? ` lastErr=${lastErr.status || ''} ${String(lastErr.detail || lastErr.message || '').slice(0, 120)}`
      : ` unparseable="${rawSample}"`;
  console.log(
    `[poem] mode=${result.mode} model=${result.model} lang=${result.language} degraded=${Boolean(result.degraded)} ${Date.now() - started}ms${reason}`
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
  'Story-weaving',
  'Tale-spinning',
  'Plot-tending',
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

const PULSE_PROMPT = `You invent playful gerund words for the loading screen of an app that turns a photo into a tiny haiku or a one-paragraph short story.
Return a JSON array of 20 SHORT, original gerunds (single words or hyphenated), each ending in "-ing", describing the act of truly noticing a scene and turning it into a poem or story.
Be witty and varied; mix the poetic (haikoizing, shakespearing, versifying) with the narrative (story-weaving, tale-spinning, plot-tending) and the literal (colour-sipping, light-counting, scene-scanning).
STRICT JSON only — a single array of lowercase strings, no prose, no code fences. Example shape: ["haikoizing","story-weaving","poemising"]`;

async function generatePulsePool() {
  const tried = [];
  for (const { base, key, model, thinkOff, maxTokensParam } of AI_TRIES) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': AI_APP_URL,
          'X-Title': AI_APP_TITLE,
        },
        body: JSON.stringify({
          model,
          temperature: 1,
          [maxTokensParam]: MAX_TOKENS,
          ...thinkOff,
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
      const texts = messageTexts(await res.json());
      let list = null;
      for (const text of texts) {
        list = extractJsonArray(text);
        if (list) break;
      }
      if (!list) {
        tried.push(`${model}:no-json`);
        continue;
      }
      const words = list
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

  // --- write a poem or short story about the photo ---
  if (url.pathname === '/api/poem') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (limitedPoem(clientIp(req))) {
      return sendJson(res, 429, { error: 'Too many verses. Take a breath and try again shortly.' });
    }
    try {
      const body = await readBody(req, MAX_BODY_BYTES);
      const { image, language, mode } = JSON.parse(body || '{}');
      if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
        return sendJson(res, 400, { error: 'Expected a JPEG/PNG/WebP data URL in "image".' });
      }
      const lang = LANGUAGES.has(language) ? language : 'en';
      const form = MODES.has(mode) ? mode : 'haiku';
      return sendJson(res, 200, await writePoem(image, lang, form));
    } catch (err) {
      const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      console.error('[poem]', status, err?.message || err);
      return sendJson(res, status, {
        error:
          status === 413
            ? 'That photo is too large. Try again.'
            : err?.quota
              ? AI_ENDPOINTS.length > 1
                ? "Every free key is out for the day. Free tiers reset daily — add OpenRouter credit or another provider's key to keep going now."
                : "Today's free model requests are used up. A free OpenRouter account gets 50 a day (1,000 with a one-off $10 credit), and it resets daily — or add a second key (e.g. Groq) and the app will use that instead."
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
      // With several keys this reads e.g. "groq+openrouter".
      provider: DEMO ? 'demo' : AI_ENDPOINTS.map((ep) => ep.name).join('+'),
      model: DEMO ? 'demo' : AI_TRIES[0].model,
      models: DEMO ? ['demo'] : AI_MODELS,
      modes: [...MODES],
      // Handy when a verse comes back marked "fallback verse": which key each
      // model sits behind, and whether its thinking is switched off.
      providers: DEMO
        ? []
        : AI_ENDPOINTS.map((ep) => ({
            provider: ep.name,
            models: ep.models,
            reasoning: Object.keys(ep.thinkOff).length ? 'off' : 'on',
          })),
      reasoning: DEMO
        ? 'demo'
        : AI_ENDPOINTS.every((ep) => Object.keys(ep.thinkOff).length)
          ? 'off'
          : AI_ENDPOINTS.some((ep) => Object.keys(ep.thinkOff).length)
            ? 'mixed'
            : 'on',
      max_tokens: MAX_TOKENS,
      total_budget_ms: TOTAL_BUDGET_MS,
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
  // One line per key, so mixed providers are obvious in the banner.
  const chain = AI_ENDPOINTS.map(
    (ep) => `${ep.name}: ${ep.models.join(' → ')}`
  ).join('\n              ');
  const mode = DEMO ? 'DEMO MODE (no API key — canned writing)' : `LIVE — ${chain}`;
  console.log(`\n  Haikamera is running.  ${mode}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Phone:   http://<your-computer-LAN-IP>:${PORT}  (same Wi-Fi)\n`);

  // Warm up the AI-generated loading words in the background (non-blocking).
  if (!DEMO) generatePulsePool();
});
