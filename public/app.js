// Haikamera — client logic.
//
// Flow: tap "Snap a poem" -> a small menu: take a photo (camera) or upload one
// -> the frame is downscaled and re-encoded on the device (this strips
// EXIF/GPS) -> our server asks a free, open-weight vision model to read the
// scene's colours and objects and write a short haiku or story -> we show YOUR
// photo with the writing. We never invent or fetch another image.

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'),
  startBtn: $('startBtn'),
  captureMenu: $('captureMenu'),
  takePhotoBtn: $('takePhotoBtn'),
  uploadBtn: $('uploadBtn'),
  cancelCapture: $('cancelCapture'),
  cameraView: $('cameraView'),
  cameraVideo: $('cameraVideo'),
  cameraSelect: $('cameraSelect'),
  cameraHint: $('cameraHint'),
  switchCamera: $('switchCamera'),
  captureFrame: $('captureFrame'),
  cancelCamera: $('cancelCamera'),
  cameraInput: $('cameraInput'),
  uploadInput: $('uploadInput'),
  loading: $('loading'),
  loadingText: $('loadingText'),
  previewImg: $('previewImg'),
  result: $('result'),
  sceneImg: $('sceneImg'),
  poemTitle: $('poemTitle'),
  poemLines: $('poemLines'),
  resSource: $('resSource'),
  makerRow: $('makerRow'),
  howBadge: $('howBadge'),
  colorsBlock: $('colorsBlock'),
  objectsBlock: $('objectsBlock'),
  colorSwatches: $('colorSwatches'),
  objectChips: $('objectChips'),
  errorBox: $('errorBox'),
  errorText: $('errorText'),
  againBtn: $('againBtn'),
  saveBtn: $('saveBtn'),
  shareBtn: $('shareBtn'),
  retryBtn: $('retryBtn'),
  journalBtn: $('journalBtn'),
  journalCount: $('journalCount'),
  journalDialog: $('journalDialog'),
  journalList: $('journalList'),
  clearJournal: $('clearJournal'),
  closeJournal: $('closeJournal'),
  offlineBanner: $('offlineBanner'),
  privacyLine: $('privacyLine'),
  langSelect: $('langSelect'),
  startLabel: $('startLabel'),
  toast: $('toast'),
};

const JOURNAL_KEY = 'haikamera.journal.v1';
const LEGACY_JOURNAL_KEY = 'touchgrass.journal.v4'; // pre-rename key, migrated once
const JOURNAL_DB = 'haikamera-journal';
const JOURNAL_PHOTO_STORE = 'photos';
const LANG_KEY = 'haikamera.lang';
const MODE_KEY = 'haikamera.mode';

// Languages the server can write a poem in, and which of them read
// right-to-left. Only the poem flips direction — the rest of the UI is English
// and stays LTR.
const RTL_LANGS = new Set(['fa']);

function getLang() {
  try {
    return localStorage.getItem(LANG_KEY) === 'fa' ? 'fa' : 'en';
  } catch {
    return 'en';
  }
}

function setLang(lang) {
  const next = lang === 'fa' ? 'fa' : 'en';
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* private mode — the choice just won't persist */
  }
  if (els.langSelect) els.langSelect.value = next;
}

// ---- What the model writes: a haiku or a one-paragraph short story --------
const MODES = new Set(['haiku', 'story']);

function getMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'story' ? 'story' : 'haiku';
  } catch {
    return 'haiku';
  }
}

function setMode(mode) {
  const next = MODES.has(mode) ? mode : 'haiku';
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    /* private mode — the choice just won't persist */
  }

  const isStory = next === 'story';
  if (els.startLabel) els.startLabel.textContent = isStory ? 'Snap a story' : 'Snap a poem';

  document.querySelectorAll('.mode-option').forEach((btn) => {
    const active = btn.dataset.mode === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

// Three encodings come out of one captured frame:
//   display — what you see on screen (a saved journal entry keeps this in
//             IndexedDB so it can draw the same share card later)
//   payload — what the model sees. A poem or story needs the gist of the scene, not a
//             forensic read, so this is small: it keeps image tokens (and cost,
//             and latency, and rate-limit pressure) down to a fraction. At 512px
//             a typical frame is ~330 image tokens.
//   thumb   — tiny, for the on-device journal list
const MAX_EDGE = 1024;        // px — the photo shown on screen
const JPEG_QUALITY = 0.82;
const MODEL_EDGE = 512;       // px — sent to the model
const MODEL_QUALITY = 0.6;
const THUMB_EDGE = 160;       // px — journal thumbnail

// Playful gerunds for the "writing" screen. Filled from /api/pulse (the server
// asks the AI to invent fresh ones); this list is the always-available fallback.
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
  'Pondering',
];
const STORY_PULSES = [
  'Story-weaving',
  'Tale-spinning',
  'Plot-tending',
  'Character-finding',
  'Scene-setting',
  'Colour-gathering',
  'Light-measuring',
  'Noticing',
  'Pondering',
];
// The server invents a fresh mixed batch; until it arrives (or if it fails),
// use the list that matches the form the reader chose.
let pulsePool = [];
let pulseTimer = null;

function pickPulse() {
  const pool = pulsePool.length
    ? pulsePool
    : getMode() === 'story'
      ? STORY_PULSES
      : FALLBACK_PULSES;
  const w = pool[Math.floor(Math.random() * pool.length)] || 'Pondering';
  return w.charAt(0).toUpperCase() + w.slice(1) + '…';
}

async function refreshPulses() {
  try {
    const res = await fetch('/api/pulse');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.words) && data.words.length) pulsePool = data.words;
  } catch {
    /* keep the fallback list */
  }
}

function startPulses() {
  stopPulses();
  els.loadingText.textContent = pickPulse();
  // Free models can take a while — keep the words changing so it stays fun.
  pulseTimer = setInterval(() => {
    els.loadingText.textContent = pickPulse();
  }, 2500);
}

function stopPulses() {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

let lastResult = null;
let lastThumb = null;          // small data URL for the on-device journal
let lastPhoto = null;          // the display data URL, for the share card

// ---- Views ---------------------------------------------------------------
function show(view) {
  if (view !== 'camera') closeLiveCamera();
  if (view !== 'stage') closeCaptureMenu();
  els.stage.classList.toggle('hidden', view !== 'stage');
  els.cameraView.classList.toggle('hidden', view !== 'camera');
  els.loading.classList.toggle('hidden', view !== 'loading');
  els.result.classList.toggle('hidden', view !== 'result');
  els.errorBox.classList.toggle('hidden', view !== 'error');
}

function showError(message) {
  els.errorText.textContent = message;
  show('error');
}

// ---- Capture chooser: camera or upload -----------------------------------
// Tapping "Snap a poem" ALWAYS opens this chooser — we never jump straight to
// the camera, so the user always gets to pick.
function openCaptureMenu() {
  els.captureMenu.classList.remove('hidden');
  els.startBtn.setAttribute('aria-expanded', 'true');
  // Move focus into the sheet so it is obvious and keyboard-friendly.
  els.takePhotoBtn.focus({ preventScroll: true });
}

function closeCaptureMenu() {
  els.captureMenu.classList.add('hidden');
  els.startBtn.setAttribute('aria-expanded', 'false');
}

// "Take a photo": phones/tablets open the OS camera app; desktops open the
// in-app webcam (on a Mac, preferring the iPhone via Continuity Camera).
function chooseCamera() {
  if (useLiveWebcam) openLiveCamera();
  else els.cameraInput.click();
}

// ---- Image handling ------------------------------------------------------
// Downscale + re-encode via canvas. Drawing to a canvas and exporting drops all
// metadata, including GPS EXIF — so location never leaves the phone.
function encode(canvas, edge, quality) {
  const scale = Math.min(1, edge / Math.max(canvas.width, canvas.height));
  if (scale === 1) return canvas.toDataURL('image/jpeg', quality);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(canvas.width * scale));
  small.height = Math.max(1, Math.round(canvas.height * scale));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL('image/jpeg', quality);
}

function withThumb(canvas) {
  return {
    display: encode(canvas, MAX_EDGE, JPEG_QUALITY), // what you see
    payload: encode(canvas, MODEL_EDGE, MODEL_QUALITY), // what the model sees
    thumb: encode(canvas, THUMB_EDGE, 0.7), // journal thumbnail
  };
}

function processImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(withThumb(canvas));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

// ---- Native phone camera vs. in-app webcam -------------------------------
// Phones/tablets open the OS camera app via the file input's `capture`
// attribute (the rear camera). Desktops open the in-app webcam instead of a
// file picker. Uploading an image works the same on every device.
//
// On a Mac we also "follow Apple's instructions" automatically: if the iPhone
// is set up as a Continuity Camera, macOS exposes it as an ordinary system
// camera, so we detect it (enumerateDevices, whose labels appear only after we
// have permission) and switch to it. If it isn't there, we keep the built-in
// webcam and show a short tip.
//
// Gotcha: iPhone/iPad user agents contain the words "like Mac OS X", so a plain
// UA check mistakes them for a Mac. We therefore treat anything touch-capable
// or mobile-looking as a phone, and only real desktops get the webcam.
const device = (() => {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || '';
  const mobileUA = /iPhone|iPod|iPad|Android|Mobile|Tablet|Silk|Kindle|webOS|BlackBerry/i.test(ua);
  const macUA = /Macintosh|Mac OS X/i.test(ua) || platform === 'macOS';
  const touchPoints = navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0;
  const touchCapable = touchPoints > 0 || 'ontouchstart' in window;
  const isMobile = mobileUA || touchCapable; // touch => it's a phone/tablet, not a desktop
  return { isMobile, isMac: !isMobile && macUA };
})();

// Phones/tablets -> native camera app. Any desktop -> in-app webcam.
const useLiveWebcam = !device.isMobile;

const APPLE_CONTINUITY_URL =
  'https://support.apple.com/guide/mac-help/use-iphone-as-a-webcam-mchl77879b8a/mac';

// A Continuity Camera shows up as a normal video input whose label names the
// iPhone. Desk View is a separate, zoomed-out feed, so we skip it here.
function isIphoneCamera(label) {
  return /iphone|continuity/i.test(label || '') && !/desk view/i.test(label || '');
}

let liveStream = null;
let videoDevices = [];

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(
      (d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'
    );
  } catch {
    return [];
  }
}

function currentCameraId() {
  return liveStream?.getVideoTracks?.()[0]?.getSettings?.().deviceId || '';
}

async function startStream(deviceId) {
  const video = {
    width: { ideal: 1280 },
    height: { ideal: 960 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
  };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

async function openLiveCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return els.cameraInput.click();
  try {
    // First grab a stream — permission is required before device labels exist.
    liveStream = await startStream(null);
    els.cameraVideo.srcObject = liveStream;
    await els.cameraVideo.play().catch(() => {});
    show('camera');

    // Now we can read real labels. On a Mac, prefer the iPhone if it's set up.
    videoDevices = await listCameras();
    const preferred = device.isMac ? videoDevices.find((d) => isIphoneCamera(d.label)) : null;
    if (preferred && preferred.deviceId !== currentCameraId()) {
      await switchCamera(preferred.deviceId);
    }
    renderCameraControls(preferred);
  } catch {
    closeLiveCamera();
    els.cameraInput.click();
  }
}

async function switchCamera(deviceId) {
  const previous = liveStream;
  if (previous) previous.getTracks().forEach((track) => track.stop());
  try {
    liveStream = await startStream(deviceId);
    els.cameraVideo.srcObject = liveStream;
    await els.cameraVideo.play().catch(() => {});
    if (els.cameraSelect && deviceId) els.cameraSelect.value = deviceId;
  } catch {
    // Couldn't open that one — try to restore a usable camera, else bail out.
    try {
      liveStream = await startStream(null);
      els.cameraVideo.srcObject = liveStream;
      await els.cameraVideo.play().catch(() => {});
    } catch {
      closeLiveCamera();
      els.cameraInput.click();
    }
  }
}

// The ⇄ button: step to the next available camera, wrapping around.
function cycleCamera() {
  if (videoDevices.length < 2) return;
  const idx = videoDevices.findIndex((d) => d.deviceId === currentCameraId());
  const next = videoDevices[(idx + 1) % videoDevices.length];
  if (next) switchCamera(next.deviceId);
}

function renderCameraControls(preferred) {
  const multiple = videoDevices.length > 1;

  // A picker, but only when there's actually a choice.
  if (multiple) {
    els.cameraSelect.innerHTML = '';
    videoDevices.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Camera';
      els.cameraSelect.appendChild(opt);
    });
    const current = currentCameraId();
    if (current) els.cameraSelect.value = current;
    els.cameraSelect.classList.remove('hidden');
  } else {
    els.cameraSelect.classList.add('hidden');
  }

  // Quick "switch camera" button, next to Capture — shown only if there's a choice.
  els.switchCamera.classList.toggle('hidden', !multiple);

  // Mac tip: how to turn on the iPhone camera (Apple's own steps), shown only
  // when no Continuity Camera was found.
  if (device.isMac && !preferred) {
    els.cameraHint.innerHTML =
      'Want to use your iPhone as this camera? On your iPhone open ' +
      '<strong>Settings → General → AirPlay &amp; Continuity</strong> and turn on ' +
      '<strong>Continuity Camera</strong>, then come back. ' +
      `<a href="${APPLE_CONTINUITY_URL}" target="_blank" rel="noopener noreferrer">Apple’s guide</a>`;
    els.cameraHint.classList.remove('hidden');
  } else {
    els.cameraHint.classList.add('hidden');
  }
}

function closeLiveCamera() {
  if (liveStream) {
    liveStream.getTracks().forEach((track) => track.stop());
    liveStream = null;
  }
  if (els.cameraVideo) els.cameraVideo.srcObject = null;
  videoDevices = [];
  if (els.cameraSelect) els.cameraSelect.classList.add('hidden');
  if (els.cameraHint) els.cameraHint.classList.add('hidden');
  if (els.switchCamera) els.switchCamera.classList.add('hidden');
}

function captureFrame() {
  const video = els.cameraVideo;
  if (!video || !video.videoWidth) return;
  const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  identify(withThumb(canvas)); // show('loading') inside identify stops the stream
}

// ---- Write the poem ------------------------------------------------------
async function identify({ display, payload, thumb }) {
  lastThumb = thumb;
  els.previewImg.src = thumb || display;
  startPulses();
  show('loading');

  try {
    const res = await fetch('/api/poem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: payload, language: getLang(), mode: getMode() }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status}).`);
    }

    renderResult(await res.json(), display);
  } catch (err) {
    if (!navigator.onLine) {
      showError("You're offline. Writing needs a connection, but everything else runs on your phone.");
    } else {
      showError(err.message || 'Could not read that scene. Try another angle.');
    }
  } finally {
    stopPulses();
    refreshPulses(); // pull a fresh set of AI-made words for next time
  }
}

// ---- Render --------------------------------------------------------------
// What wrote a piece, described two ways. `modelShort` names it for tight spots
// ("google/gemma-4-31b-it:free" -> "gemma-4-31b-it"); `modelFull` is the exact
// id for attribution. Both work on a live result and on a saved journal entry,
// since each carries `model`, `degraded` and `demo`.
function modelShort(r) {
  if (!r) return '';
  if (r.demo) return 'demo sample';
  if (r.degraded) return r.mode === 'story' ? 'fallback story' : 'fallback verse';
  return r.model ? String(r.model).split('/').pop().replace(/:free$/, '') : '';
}
function modelFull(r) {
  if (!r) return '';
  if (r.demo) return 'demo sample';
  if (r.degraded) return r.mode === 'story' ? 'fallback story' : 'fallback verse';
  return r.model ? String(r.model) : '';
}

function renderResult(r, photo) {
  lastResult = r;

  els.sceneImg.src = photo;

  // The writing carries its own direction: a Persian poem or story reads
  // right-to-left even though the page around it is English and LTR.
  const rtl = RTL_LANGS.has(r.language);
  const storyMode = r.mode === 'story';
  const isStory = storyMode && !!r.story;
  els.poemTitle.dir = rtl ? 'rtl' : 'ltr';
  els.poemTitle.lang = rtl ? 'fa' : '';
  els.poemLines.dir = rtl ? 'rtl' : 'ltr';
  els.poemLines.lang = rtl ? 'fa' : '';
  els.poemLines.classList.toggle('story', storyMode);

  els.poemTitle.textContent = r.title || '';

  els.poemLines.innerHTML = '';
  if (isStory) {
    const p = document.createElement('p');
    p.className = 'story-text';
    p.textContent = r.story;
    els.poemLines.appendChild(p);
  } else {
    (r.poem || []).forEach((line) => {
      const p = document.createElement('p');
      p.className = 'poem-line';
      p.textContent = line;
      els.poemLines.appendChild(p);
    });
  }

  // "See how this was made": the model that read the frame, behind the
  // disclosure. A demo or fallback poem has no model to name, so the state
  // stays on the badge and the "Made by" row instead of repeating here.
  const makerText = modelFull(r);
  els.resSource.textContent = makerText;
  els.resSource.title = r.model || '';
  els.resSource.classList.toggle('model-id', !r.demo && !r.degraded && !!r.model);
  els.makerRow.classList.toggle('hidden', !makerText);

  // A tiny badge on the summary so state is clear even when collapsed.
  const fallbackLabel = storyMode ? 'fallback story' : 'fallback verse';
  const badgeText = r.demo ? 'demo' : r.degraded ? fallbackLabel : '';
  els.howBadge.textContent = badgeText;
  els.howBadge.classList.toggle('hidden', !badgeText);

  // Colour swatches — tap to copy the hex.
  els.colorSwatches.innerHTML = '';
  (r.colors || []).forEach((c) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.title = `Copy ${c.hex}`;
    swatch.setAttribute('aria-label', `${c.name} ${c.hex} — copy`);

    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.style.background = c.hex;

    const label = document.createElement('span');
    label.className = 'swatch-name';
    label.textContent = c.name;

    swatch.append(dot, label);
    swatch.addEventListener('click', () => copyHex(swatch, label, c));
    els.colorSwatches.appendChild(swatch);
  });
  els.colorsBlock.classList.toggle('hidden', !(r.colors || []).length);

  // Objects found in the scene.
  els.objectChips.innerHTML = '';
  (r.objects || []).forEach((o) => {
    const li = document.createElement('li');
    li.textContent = o;
    els.objectChips.appendChild(li);
  });
  els.objectsBlock.classList.toggle('hidden', !(r.objects || []).length);

  els.saveBtn.textContent = 'Save to journal';
  els.saveBtn.disabled = false;

  // Draw the share card now, in the background, so tapping Share is instant and
  // the tap stays a genuine user gesture (mobile browsers require one before
  // they'll open the share sheet).
  lastPhoto = photo;
  resetShareCard(r, photo);

  show('result');
}

function copyHex(swatch, label, color) {
  const done = () => {
    swatch.classList.add('copied');
    const original = color.name;
    label.textContent = 'copied ✓';
    setTimeout(() => {
      swatch.classList.remove('copied');
      label.textContent = original;
    }, 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(color.hex).then(done).catch(done);
  } else {
    done();
  }
}

// ---- Share: the photo, the writing, the model, and where to find the app --
// The share card carries the photo, the poem or story it earned, the model
// that wrote it, and the app's address. The colours and objects stay in
// the app. We draw it here on a canvas so it can travel as one image through
// the Web Share API; where the browser can't share files, it downloads instead.
// A result and an entry reopened from the journal share this exact card.

const SHARE_WIDTH = 1080;      // px — a clean size for chat apps and feeds
const SHARE_PAD = 64;
const SHARE_PAPER = '#fffdf8';
const SHARE_INK = '#1b241d';
const SHARE_SOFT = '#8a8a8a';
const SHARE_GREEN = '#1f5c39';
const SHARE_ACCENT = '#e2703a';

// The public home of the app: printed on the card, and appended to the caption
// so a shared poem always points back to where it came from.
const APP_HOME = 'haikamera.onrender.com';
const APP_HOME_URL = `https://${APP_HOME}`;

// Telegram and WhatsApp both cap a photo caption at 1024 characters. Keep the
// text inside that limit so a long story still travels as a caption instead of
// being dropped or split into a second message.
const CAPTION_LIMIT = 1024;

let shareCardBlob = null;      // ready-to-share PNG, drawn after each result
let shareCardPromise = null;
let toastTimer = null;
let toastRemaining = 0;
let toastDeadline = 0;
let captionTipShown = false;

// Canvas can't take a font stack with quotes in the same way CSS can, but a
// plain comma list works. Persian needs an Arabic-script face, so keep the same
// fallbacks the stylesheet uses.
const SHARE_SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const SHARE_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SHARE_PERSIAN = '"Vazirmatn", "Noto Naskh Arabic", "Geeza Pro", Tahoma, serif';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the photo.'));
    img.src = src;
  });
}

// Greedy word wrap against the measured width. Works for Persian too, since it
// is still space-separated.
function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const test = `${line} ${words[i]}`;
    if (ctx.measureText(test).width <= maxWidth) line = test;
    else {
      lines.push(line);
      line = words[i];
    }
  }
  lines.push(line);
  return lines;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No image produced.'))), 'image/png');
  });
}

// Compose the share card. Returns a Promise<Blob> (a PNG).
async function composeShareCard(r, photo) {
  const img = await loadImage(photo);
  const W = SHARE_WIDTH;
  const P = SHARE_PAD;
  const contentW = W - P * 2;
  const rtl = RTL_LANGS.has(r.language);

  // Photo: full width, keeping its own shape, but never taller than 1.25× the
  // width — a very tall portrait gets a gentle centre crop rather than a card
  // that is mostly photo.
  const ratio = img.naturalHeight / img.naturalWidth;
  let photoH = Math.round(W * ratio);
  let sy = 0;
  let sh = img.naturalHeight;
  const maxPhotoH = Math.round(W * 1.25);
  if (photoH > maxPhotoH) {
    photoH = maxPhotoH;
    sh = Math.round(img.naturalWidth * (maxPhotoH / W));
    sy = Math.round((img.naturalHeight - sh) / 2);
  }

  // A haiku sets like verse; a short story sets like prose, in a smaller face
  // with more generous leading so one paragraph still reads comfortably.
  const isStory = r.mode === 'story' && !!r.story;
  const titleFont = rtl ? `26px ${SHARE_PERSIAN}` : `600 25px ${SHARE_SANS}`;
  const haikuFont = rtl ? `50px ${SHARE_PERSIAN}` : `50px ${SHARE_SERIF}`;
  const storyFont = rtl ? `34px ${SHARE_PERSIAN}` : `34px ${SHARE_SERIF}`;
  const bodyFont = isStory ? storyFont : haikuFont;
  const modelFont = `24px ${SHARE_SANS}`;
  const brandFont = `600 24px ${SHARE_SANS}`;

  // Measure first (on a scratch context) so the card's height fits its content.
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = titleFont;
  const title = (r.title || '').trim();
  const titleLines = title ? wrapText(measure, rtl ? title : title.toUpperCase(), contentW) : [];

  measure.font = bodyFont;
  const bodyLines = [];
  if (isStory) {
    bodyLines.push(...wrapText(measure, r.story, contentW));
  } else {
    for (const line of (r.poem || []).slice(0, 3)) {
      bodyLines.push(...wrapText(measure, line, contentW));
    }
  }
  if (!bodyLines.length) bodyLines.push('');

  const titleLH = 40;
  const bodyLH = isStory ? 52 : 76;
  const baselineGap = isStory ? 12 : 16;
  const topGap = 56;        // photo -> title
  const titleGap = 30;      // title -> body
  const footerGap = 56;     // body -> footer
  const footerLH = 44;      // footer line height
  const bottom = 56;

  const titleBlock = titleLines.length * titleLH;
  const bodyBlock = bodyLines.length * bodyLH;
  const H = photoH + topGap + titleBlock + (titleLines.length ? titleGap : 0) + bodyBlock + footerGap + footerLH + bottom;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = SHARE_PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, 0, W, photoH);

  // A hairline in the app's green keeps the paper from floating.
  ctx.fillStyle = SHARE_GREEN;
  ctx.fillRect(0, photoH, W, 6);

  ctx.textBaseline = 'alphabetic';
  const anchorX = rtl ? W - P : P;
  let cursor = photoH + topGap; // top edge of the text block

  if (titleLines.length) {
    ctx.font = titleFont;
    ctx.fillStyle = SHARE_ACCENT;
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    if ('letterSpacing' in ctx) ctx.letterSpacing = rtl ? '0px' : '3px';
    for (let i = 0; i < titleLines.length; i += 1) {
      ctx.fillText(titleLines[i], anchorX, cursor + (i + 1) * titleLH - 12);
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    cursor += titleBlock + titleGap;
  }

  ctx.font = bodyFont;
  ctx.fillStyle = SHARE_INK;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = rtl ? 'right' : 'left';
  for (let i = 0; i < bodyLines.length; i += 1) {
    ctx.fillText(bodyLines[i], anchorX, cursor + (i + 1) * bodyLH - baselineGap);
  }
  cursor += bodyBlock;

  // Footer: the model that wrote it on the left, the app's address on the right.
  // Model ids and URLs are Latin, so the footer stays LTR under a Persian poem.
  const maker = modelFull(r);
  const siteText = `🪷 ${APP_HOME}`;
  const footerY = cursor + footerGap;

  ctx.font = brandFont;
  const siteW = ctx.measureText(siteText).width;

  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.font = modelFont;
  ctx.fillStyle = SHARE_GREEN;
  let makerText = maker ? `made by ${maker}` : 'Haikamera';
  // Never let the model name run into the site address.
  while (ctx.measureText(makerText).width > contentW - siteW - 40 && makerText.length > 12) {
    makerText = makerText.slice(0, -2);
  }
  ctx.fillText(makerText, P, footerY);

  ctx.font = brandFont;
  ctx.fillStyle = SHARE_SOFT;
  ctx.textAlign = 'right';
  ctx.fillText(siteText, W - P, footerY);

  return canvasToBlob(canvas);
}

function shareFilename(r) {
  const slug = (r?.title || 'poem').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `haikamera-${slug || 'poem'}.png`;
}

// The caption that travels with the image where the platform supports text.
// Keep the attribution and the app address intact, and shorten the writing if a
// very long story would otherwise push the caption past a chat app's limit.
function shareCaption(r) {
  const body = r.mode === 'story' && r.story ? [r.story] : r.poem || [];
  const head = [r.title, ...body].filter(Boolean).join('\n');
  const maker = modelFull(r);
  const footer = [maker ? `— ${maker}` : '', `Haikamera 🪷📸\n${APP_HOME_URL}`]
    .filter(Boolean)
    .join('\n\n');
  const gap = head && footer ? '\n\n' : '';
  const room = CAPTION_LIMIT - footer.length - gap.length;
  let text = head;
  if (text.length > room) {
    text = text.slice(0, Math.max(0, room - 1)).trimEnd();
    if (text) text += '…';
  }
  return [text, footer].filter(Boolean).join('\n\n').slice(0, CAPTION_LIMIT);
}

function resetShareCard(r, photo) {
  shareCardBlob = null;
  shareCardPromise = composeShareCard(r, photo)
    .then((blob) => {
      shareCardBlob = blob;
      return blob;
    })
    .catch(() => null);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Copy without waiting: this stays inside the tap that opened the share sheet.
// It is the safety net for targets such as Telegram that can drop the text from
// a file share even though WhatsApp shows it as the image caption.
function copyTextNow(text) {
  if (!text) return false;
  const previous = document.activeElement;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    if (typeof area.setSelectionRange === 'function') {
      area.setSelectionRange(0, area.value.length);
    }
    const copied =
      typeof document.execCommand === 'function' && document.execCommand('copy');
    area.remove?.();
    previous?.focus?.();
    return !!copied;
  } catch {
    area?.remove?.();
    return false;
  }
}

// Clipboard API for an explicit "Copy" tap, with the same synchronous fallback.
async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to execCommand */
    }
  }
  return copyTextNow(text);
}

// Fixed elements track the layout viewport, which on a phone can be taller
// than the part you can actually see (the browser chrome overlays the rest).
// Anchor the toast to the visual viewport so its action never hides below the
// screen, and keep it clear of the home-indicator safe area.
function positionToast() {
  const toast = els.toast;
  if (!toast || toast.classList.contains('hidden')) return;

  const safe = parseFloat(getComputedStyle(toast).getPropertyValue('--sab')) || 0;
  const gap = 18 + safe;
  const viewport = window.visualViewport;
  if (!viewport) {
    toast.style.bottom = `${gap}px`;
    return;
  }

  const chromeOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  toast.style.bottom = `${gap + chromeOffset}px`;
  if (viewport.width) {
    toast.style.left = `${viewport.offsetLeft + viewport.width / 2}px`;
    toast.style.maxWidth = `${Math.min(460, Math.max(160, viewport.width - 24))}px`;
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', positionToast);
  window.visualViewport.addEventListener('scroll', positionToast);
}
window.addEventListener('resize', positionToast);

function openToast() {
  const toast = els.toast;
  if (!toast) return;

  // Show the toast inside the journal dialog while it is open. A modal <dialog>
  // owns the top layer, so a toast left in <body> would sit behind its backdrop.
  const host = els.journalDialog?.open ? els.journalDialog : document.body;
  if (toast.parentElement !== host) host.appendChild(toast);
  toast.classList.remove('hidden');
  positionToast();
}

function stopToastTimer() {
  if (!toastTimer) return;
  clearTimeout(toastTimer);
  toastTimer = null;
}

function scheduleToastHide(duration) {
  stopToastTimer();
  toastRemaining = duration;
  toastDeadline = 0;
  // The share sheet may hand us to another app. Do not burn the toast's short
  // life while the page is in the background — start the clock on return.
  if (document.visibilityState !== 'visible') return;
  toastDeadline = Date.now() + duration;
  toastTimer = setTimeout(hideToast, duration);
}

function pauseToastTimer() {
  if (!toastTimer) return;
  stopToastTimer();
  toastRemaining = Math.max(0, toastDeadline - Date.now());
  if (!toastRemaining) hideToast();
}

function resumeToastTimer() {
  if (!toastRemaining || toastTimer) return;
  toastDeadline = Date.now() + toastRemaining;
  toastTimer = setTimeout(hideToast, toastRemaining);
}

function hideToast() {
  const toast = els.toast;
  if (!toast) return;
  stopToastTimer();
  toastRemaining = 0;
  toastDeadline = 0;
  toast.classList.add('hidden');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    positionToast();
    resumeToastTimer();
  } else {
    pauseToastTimer();
  }
});

function showToast(message, { actionLabel = '', onAction = null, duration = 6500 } = {}) {
  const toast = els.toast;
  if (!toast) return;

  stopToastTimer();
  toastRemaining = 0;
  toastDeadline = 0;
  toast.innerHTML = '';

  const messageEl = document.createElement('span');
  messageEl.textContent = message;
  toast.appendChild(messageEl);

  if (actionLabel && onAction) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', async () => {
      stopToastTimer();
      toastRemaining = 0;
      toastDeadline = 0;
      action.disabled = true;
      const copied = await onAction();
      if (copied) {
        messageEl.textContent = 'Caption copied ✓';
        action.remove?.();
        scheduleToastHide(2200);
      } else {
        action.disabled = false;
        messageEl.textContent = 'Could not copy. Try again.';
        scheduleToastHide(4000);
      }
    });
    toast.appendChild(action);
  }

  openToast();
  scheduleToastHide(duration);
}

// Telegram can ignore the text that rides with a shared image, so a copy is
// already waiting on the clipboard when the share sheet closes. Explain that
// once, and leave a Copy button for browsers where the automatic copy is
// blocked (or for anyone who dismissed the toast too quickly).
function showCaptionTip(caption, copied, saved) {
  if (!caption) return;
  if (copied && captionTipShown) return;
  if (copied) captionTipShown = true;

  const message = copied
    ? saved
      ? 'Image saved. Caption copied too.'
      : 'Shared. If the caption is missing, it is on your clipboard.'
    : saved
      ? 'Image saved. You can copy the caption.'
      : 'Shared. If the caption is missing, copy it here.';

  showToast(message, {
    actionLabel: copied ? 'Copy again' : 'Copy caption',
    onAction: () => copyText(caption),
    duration: copied ? 6000 : 9000,
  });
}

// Ask the OS share sheet to take our file. 'shared' means the sheet finished,
// 'cancelled' means the user dismissed it, and false means file sharing is not
// available here, so the caller should download instead.
async function tryNativeShare(file, caption, title) {
  if (!navigator.share || !file) return false;

  let canShareFiles = false;
  try {
    canShareFiles = !!navigator.canShare?.({ files: [file] });
  } catch {
    canShareFiles = false;
  }
  if (!canShareFiles) return false;

  try {
    await navigator.share({ files: [file], text: caption, title });
    return 'shared';
  } catch (err) {
    // The user dismissed the sheet — that's a finished action, not a failure.
    if (err?.name === 'AbortError') return 'cancelled';
    return false;
  }
}

function flashButton(button, text) {
  if (!button) return;
  const original = button.dataset.idleLabel || button.textContent;
  button.dataset.idleLabel = original;
  button.textContent = text;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = button.dataset.idleLabel || original;
    button.disabled = false;
  }, 1600);
}

// One share path for a fresh result and for anything reopened from the journal.
// A ready blob takes the quick route, keeping the tap inside the browser's user
// gesture when the OS share sheet opens. A still-drawing card can wait, then
// shares (or downloads) as soon as it is ready.
async function sharePiece({ item, photo, blob = null, promise = null, button = null }) {
  const filename = shareFilename(item);
  const caption = shareCaption(item);
  const title = item.title || 'Haikamera';
  // Do this before the first await, while the tap still counts as a gesture.
  const captionCopied = copyTextNow(caption);

  if (blob) {
    const file = new File([blob], filename, { type: 'image/png' });
    const result = await tryNativeShare(file, caption, title);
    if (result) {
      if (result === 'shared') showCaptionTip(caption, captionCopied, false);
      return;
    }
    downloadBlob(blob, filename);
    flashButton(button, 'Saved ✓');
    showCaptionTip(caption, captionCopied, true);
    return;
  }

  let ready = promise ? await promise : null;
  if (!ready && photo) {
    try {
      ready = await composeShareCard(item, photo);
    } catch {
      flashButton(button, "Couldn't share");
      return;
    }
  }
  if (!ready) {
    flashButton(button, "Couldn't share");
    return;
  }

  const file = new File([ready], filename, { type: 'image/png' });
  const result = await tryNativeShare(file, caption, title);
  if (result) {
    if (result === 'shared') showCaptionTip(caption, captionCopied, false);
    return;
  }

  downloadBlob(ready, filename);
  flashButton(button, 'Saved ✓');
  showCaptionTip(caption, captionCopied, true);
}

async function shareResult() {
  if (!lastResult || !lastPhoto) return;
  await sharePiece({
    item: lastResult,
    photo: lastPhoto,
    blob: shareCardBlob,
    promise: shareCardPromise,
    button: els.shareBtn,
  });
}

// ---- Local journal (this device only) ------------------------------------
function loadJournal() {
  try {
    let raw = localStorage.getItem(JOURNAL_KEY);
    if (raw === null) {
      // One-time migration from the pre-rename key.
      raw = localStorage.getItem(LEGACY_JOURNAL_KEY);
      if (raw !== null) localStorage.setItem(JOURNAL_KEY, raw);
    }
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function saveJournal(entries) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries.slice(0, 100)));
  updateJournalCount();
  void pruneJournalPhotos(entries.slice(0, 100));
}

function updateJournalCount() {
  els.journalCount.textContent = String(loadJournal().length);
}

// A journal entry's title and writing are small enough for localStorage. The
// photo is not: keep a display-size copy in IndexedDB so an old entry can still
// make the same share card as a fresh result. Everything stays on this device.
let journalDbPromise = null;

function openJournalDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (journalDbPromise) return journalDbPromise;

  journalDbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(JOURNAL_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JOURNAL_PHOTO_STORE)) {
        db.createObjectStore(JOURNAL_PHOTO_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return journalDbPromise;
}

function journalPhotoKey(entry) {
  return entry?.id || (entry?.at ? `at-${entry.at}` : '');
}

async function getJournalPhoto(entry) {
  const key = journalPhotoKey(entry);
  if (!key) return '';
  const db = await openJournalDb().catch(() => null);
  if (!db) return '';

  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(JOURNAL_PHOTO_STORE, 'readonly')
        .objectStore(JOURNAL_PHOTO_STORE)
        .get(key);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : '');
      request.onerror = () => resolve('');
    } catch {
      resolve('');
    }
  });
}

async function storeJournalPhoto(key, photo) {
  if (!key || !photo) return false;
  const db = await openJournalDb().catch(() => null);
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(JOURNAL_PHOTO_STORE, 'readwrite');
      tx.objectStore(JOURNAL_PHOTO_STORE).put(photo, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

// Drop photo copies for entries trimmed from the journal (and all of them when
// the journal is cleared), so the browser store cannot grow forever.
function pruneJournalPhotos(entries) {
  return openJournalDb()
    .then((db) => {
      if (!db) return;
      const keep = new Set(entries.map(journalPhotoKey).filter(Boolean));
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(JOURNAL_PHOTO_STORE, 'readwrite');
          const store = tx.objectStore(JOURNAL_PHOTO_STORE);
          if (typeof store.getAllKeys !== 'function') {
            resolve();
            return;
          }
          const keys = store.getAllKeys();
          keys.onsuccess = () => {
            keys.result.forEach((key) => {
              if (!keep.has(key)) store.delete(key);
            });
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    })
    .catch(() => {});
}

function newJournalId() {
  return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Preparing a journal card when its entry opens keeps the eventual Share tap a
// live gesture on phones that require one before opening the OS share sheet.
const journalShareCards = new WeakMap();

function prepareJournalShare(entry, details) {
  const existing = journalShareCards.get(details);
  if (existing) return existing;

  const item = { ...entry, poem: entry.lines || [] };
  const state = { item, blob: null, promise: null };
  state.promise = (async () => {
    const photo = (await getJournalPhoto(entry)) || entry.thumb || '';
    if (!photo) throw new Error('This entry has no photo to share.');
    const blob = await composeShareCard(item, photo);
    state.blob = blob;
    return blob;
  })().catch(() => null);

  journalShareCards.set(details, state);
  return state;
}

function shareJournalEntry(entry, details, button) {
  const state = prepareJournalShare(entry, details);
  void sharePiece({
    item: state.item,
    blob: state.blob,
    promise: state.promise,
    button,
  });
}

function addToJournal() {
  if (!lastResult) return;
  const entries = loadJournal();
  // Keep everything the model told us, not just the writing: which model wrote
  // it, whether it was a real one or a fallback, and the things it named.
  const entry = {
    id: newJournalId(),
    title: lastResult.title,
    mode: lastResult.mode || 'haiku',
    lines: lastResult.poem || [],
    story: lastResult.story || '',
    model: lastResult.model || '',
    language: lastResult.language || getLang(),
    degraded: !!lastResult.degraded,
    demo: !!lastResult.demo,
    objects: lastResult.objects || [],
    colors: lastResult.colors || [],
    thumb: lastThumb,
    at: Date.now(),
  };
  entries.unshift(entry);
  saveJournal(entries);
  void storeJournalPhoto(entry.id, lastPhoto);

  els.saveBtn.textContent = 'Saved ✓';
  els.saveBtn.disabled = true;
}

function renderJournal() {
  const entries = loadJournal();
  els.journalList.innerHTML = '';

  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'journal-empty';
    li.textContent = 'No poems or stories yet. Point at something and snap one.';
    els.journalList.appendChild(li);
    return;
  }

  entries.forEach((e) => els.journalList.appendChild(journalItem(e)));
}

// One journal entry: a collapsed summary (thumbnail + title + first line or
// story opening + form/model/date) that expands to the full poem or story, the
// things and colours it saw, the model that wrote it, and when it was saved.
function journalItem(e) {
  const when = new Date(e.at);
  const isStory = e.mode === 'story' && !!e.story;
  const lines = e.lines || [];
  const objects = e.objects || [];
  const colors = e.colors || [];

  const li = document.createElement('li');

  const details = document.createElement('details');
  details.className = 'j-entry';

  // ---- summary: always visible ----
  const summary = document.createElement('summary');
  summary.className = 'j-summary';

  if (e.thumb) {
    const img = document.createElement('img');
    img.src = e.thumb;
    img.alt = '';
    summary.appendChild(img);
  }

  const head = document.createElement('div');
  head.className = 'j-head';

  const name = document.createElement('p');
  name.className = 'j-name';
  name.textContent = e.title || 'Untitled';

  const tagline = document.createElement('p');
  tagline.className = 'j-tagline';
  tagline.textContent = isStory ? e.story : lines[0] || '';
  if (!isStory && lines.length > 1) {
    const more = document.createElement('span');
    more.className = 'j-more';
    more.textContent = ` +${lines.length - 1} more line${lines.length > 2 ? 's' : ''}`;
    tagline.appendChild(more);
  }

  const meta = document.createElement('p');
  meta.className = 'j-meta';
  meta.textContent = [
    isStory ? 'short story' : 'haiku',
    modelShort(e), // the model that wrote it, or why it is a demo/fallback
    when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  ]
    .filter(Boolean)
    .join(' · ');

  head.append(name, tagline, meta);
  summary.appendChild(head);

  const chevron = document.createElement('span');
  chevron.className = 'j-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  summary.appendChild(chevron);

  details.appendChild(summary);

  // ---- body: revealed on expand ----
  const body = document.createElement('div');
  body.className = 'j-body';

  const poem = document.createElement('div');
  poem.className = 'j-poem';
  // A saved Persian poem or story keeps reading right-to-left.
  if (RTL_LANGS.has(e.language)) {
    poem.dir = 'rtl';
    poem.lang = 'fa';
  }
  if (isStory) {
    const p = document.createElement('p');
    p.className = 'j-story';
    p.textContent = e.story;
    poem.appendChild(p);
  } else {
    lines.forEach((line) => {
      const p = document.createElement('p');
      p.className = 'poem-line';
      p.textContent = line;
      poem.appendChild(p);
    });
  }
  body.appendChild(poem);

  if (objects.length) {
    const label = document.createElement('p');
    label.className = 'j-label';
    label.textContent = 'Things it saw';
    body.appendChild(label);

    const chips = document.createElement('ul');
    chips.className = 'object-chips j-objects';
    objects.forEach((o) => {
      const li = document.createElement('li');
      li.textContent = o;
      chips.appendChild(li);
    });
    body.appendChild(chips);
  }

  if (colors.length) {
    const label = document.createElement('p');
    label.className = 'j-label';
    label.textContent = 'Colours it saw';
    body.appendChild(label);

    const swatches = document.createElement('div');
    swatches.className = 'swatches j-swatches';
    colors.forEach((c) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.title = `Copy ${c.hex}`;
      swatch.setAttribute('aria-label', `${c.name} ${c.hex} — copy`);

      const dot = document.createElement('span');
      dot.className = 'swatch-dot';
      dot.style.background = c.hex;

      const swatchLabel = document.createElement('span');
      swatchLabel.className = 'swatch-name';
      swatchLabel.textContent = c.name;

      swatch.append(dot, swatchLabel);
      swatch.addEventListener('click', () => copyHex(swatch, swatchLabel, c));
      swatches.appendChild(swatch);
    });
    body.appendChild(swatches);
  }

  if (modelShort(e)) {
    const label = document.createElement('p');
    label.className = 'j-label';
    label.textContent = 'Made by';
    body.appendChild(label);

    const maker = document.createElement('p');
    maker.className = 'j-model';
    maker.textContent = modelFull(e);
    body.appendChild(maker);
  }

  const saved = document.createElement('p');
  saved.className = 'j-when';
  saved.textContent =
    'Saved ' + when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const foot = document.createElement('div');
  foot.className = 'j-foot';
  foot.appendChild(saved);

  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'ghost-btn j-share';
  share.textContent = 'Share';
  share.setAttribute('aria-label', `Share ${e.title || 'this entry'}`);
  share.addEventListener('click', () => shareJournalEntry(e, details, share));
  foot.appendChild(share);
  body.appendChild(foot);

  // Draw this entry's share card as soon as it opens, so a quick Share tap can
  // still open the native sheet within the browser's user gesture.
  details.addEventListener('toggle', () => {
    if (details.open) prepareJournalShare(e, details);
  });

  details.appendChild(body);
  li.appendChild(details);
  return li;
}

// ---- Events --------------------------------------------------------------
function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-picking the same file
  if (!file) return;
  processImage(file)
    .then(identify)
    .catch((err) => showError(err.message || 'Could not read that image.'));
}

els.startBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openCaptureMenu(); // always ask: camera or upload
});
els.takePhotoBtn.addEventListener('click', () => {
  closeCaptureMenu();
  chooseCamera();
});
els.uploadBtn.addEventListener('click', () => {
  closeCaptureMenu();
  els.uploadInput.click();
});
els.cancelCapture.addEventListener('click', closeCaptureMenu);
// Tapping the dimmed backdrop (outside the card) also cancels.
els.captureMenu.addEventListener('click', (e) => {
  if (e.target === els.captureMenu) closeCaptureMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCaptureMenu();
});

els.cameraInput.addEventListener('change', onFilePicked);
els.uploadInput.addEventListener('change', onFilePicked);
els.captureFrame.addEventListener('click', captureFrame);
els.cancelCamera.addEventListener('click', () => show('stage'));
els.switchCamera.addEventListener('click', cycleCamera);
els.cameraSelect.addEventListener('change', (e) => {
  if (e.target.value && e.target.value !== currentCameraId()) switchCamera(e.target.value);
});

els.againBtn.addEventListener('click', () => show('stage'));
els.retryBtn.addEventListener('click', () => show('stage'));
els.saveBtn.addEventListener('click', addToJournal);
els.shareBtn.addEventListener('click', shareResult);

if (els.langSelect) {
  els.langSelect.addEventListener('change', (e) => setLang(e.target.value));
}
document.querySelectorAll('.mode-option').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

els.journalBtn.addEventListener('click', () => {
  renderJournal();
  els.journalDialog.showModal();
});
els.closeJournal.addEventListener('click', () => els.journalDialog.close());
els.clearJournal.addEventListener('click', () => {
  saveJournal([]);
  renderJournal();
});

// ---- Connectivity --------------------------------------------------------
function updateOnline() {
  els.offlineBanner.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

// ---- Boot ----------------------------------------------------------------
updateJournalCount();
updateOnline();
setLang(getLang()); // restore the chosen language
setMode(getMode()); // restore haiku or short story
show('stage');
refreshPulses(); // pull playful AI-made loading words

// Surface demo mode so nobody is confused by the sample writing.
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.demo) {
      els.privacyLine.textContent =
        'Demo mode — here is a sample poem or story. No account, no cookies, nothing about you.';
    }
  })
  .catch(() => {});
