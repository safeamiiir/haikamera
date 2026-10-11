// Haikamera — client logic.
//
// Flow: tap "Snap a poem" -> a small menu: take a photo (camera) or upload one
// -> the frame is downscaled and re-encoded on the device (this strips
// EXIF/GPS) -> our server asks a free, open-weight vision model to read the
// scene's colours and objects and write a short haiku -> we show YOUR photo
// with the poem. We never invent or fetch another image.

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
};

const JOURNAL_KEY = 'haikamera.journal.v1';
const LEGACY_JOURNAL_KEY = 'touchgrass.journal.v4'; // pre-rename key, migrated once
const LANG_KEY = 'haikamera.lang';

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

// Three encodings come out of one captured frame:
//   display — what you see on screen (and what the journal keeps)
//   payload — what the model sees. A poem needs the gist of the scene, not a
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
let pulsePool = FALLBACK_PULSES.slice();
let pulseTimer = null;

function pickPulse() {
  const w = pulsePool[Math.floor(Math.random() * pulsePool.length)] || 'Pondering';
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
      body: JSON.stringify({ image: payload, language: getLang() }),
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
// What wrote a poem, described two ways. `modelShort` names it for tight spots
// ("google/gemma-4-31b-it:free" -> "gemma-4-31b-it"); `modelFull` is the exact
// id for attribution. Both work on a live result and on a saved journal entry,
// since each carries `model`, `degraded` and `demo`.
function modelShort(r) {
  if (!r) return '';
  if (r.demo) return 'demo sample';
  if (r.degraded) return 'fallback verse';
  return r.model ? String(r.model).split('/').pop().replace(/:free$/, '') : '';
}
function modelFull(r) {
  if (!r) return '';
  if (r.demo) return 'demo sample';
  if (r.degraded) return 'fallback verse';
  return r.model ? String(r.model) : '';
}

function renderResult(r, photo) {
  lastResult = r;

  els.sceneImg.src = photo;

  // The poem carries its own direction: a Persian poem reads right-to-left
  // even though the page around it is English and LTR.
  const rtl = RTL_LANGS.has(r.language);
  els.poemTitle.dir = rtl ? 'rtl' : 'ltr';
  els.poemTitle.lang = rtl ? 'fa' : '';
  els.poemLines.dir = rtl ? 'rtl' : 'ltr';
  els.poemLines.lang = rtl ? 'fa' : '';

  els.poemTitle.textContent = r.title || '';

  els.poemLines.innerHTML = '';
  (r.poem || []).forEach((line) => {
    const p = document.createElement('p');
    p.className = 'poem-line';
    p.textContent = line;
    els.poemLines.appendChild(p);
  });

  // "See how this was made": the model that read the frame, behind the
  // disclosure. A demo or fallback poem has no model to name, so the state
  // stays on the badge and the "Made by" row instead of repeating here.
  const makerText = modelFull(r);
  els.resSource.textContent = makerText;
  els.resSource.title = r.model || '';
  els.resSource.classList.toggle('model-id', !r.demo && !r.degraded && !!r.model);
  els.makerRow.classList.toggle('hidden', !makerText);

  // A tiny badge on the summary so state is clear even when collapsed.
  const badgeText = r.demo ? 'demo' : r.degraded ? 'fallback verse' : '';
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

// ---- Share: the photo, the poem, the model, and where to find the app -----
// The share card carries the photo, the poem it earned, the name of the model
// that wrote it, and the app's address. The colours and objects stay in
// the app. We draw it here on a canvas so it can travel as one image through
// the Web Share API; where the browser can't share files, it downloads instead.

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

let shareCardBlob = null;      // ready-to-share PNG, drawn after each result
let shareCardPromise = null;

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

  const titleFont = rtl ? `26px ${SHARE_PERSIAN}` : `600 25px ${SHARE_SANS}`;
  const poemFont = rtl ? `50px ${SHARE_PERSIAN}` : `50px ${SHARE_SERIF}`;
  const modelFont = `24px ${SHARE_SANS}`;
  const brandFont = `600 24px ${SHARE_SANS}`;

  // Measure first (on a scratch context) so the card's height fits its content.
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = titleFont;
  const title = (r.title || '').trim();
  const titleLines = title ? wrapText(measure, rtl ? title : title.toUpperCase(), contentW) : [];

  measure.font = poemFont;
  const poemLines = [];
  for (const line of (r.poem || []).slice(0, 3)) {
    poemLines.push(...wrapText(measure, line, contentW));
  }
  if (!poemLines.length) poemLines.push('');

  const titleLH = 40;
  const poemLH = 76;
  const topGap = 56;        // photo -> title
  const titleGap = 30;      // title -> poem
  const footerGap = 56;     // poem -> footer
  const footerLH = 44;      // footer line height
  const bottom = 56;

  const titleBlock = titleLines.length * titleLH;
  const poemBlock = poemLines.length * poemLH;
  const H = photoH + topGap + titleBlock + (titleLines.length ? titleGap : 0) + poemBlock + footerGap + footerLH + bottom;

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

  ctx.font = poemFont;
  ctx.fillStyle = SHARE_INK;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = rtl ? 'right' : 'left';
  for (let i = 0; i < poemLines.length; i += 1) {
    ctx.fillText(poemLines[i], anchorX, cursor + (i + 1) * poemLH - 16);
  }
  cursor += poemBlock;

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
function shareCaption(r) {
  const lines = [r.title, ...(r.poem || [])].filter(Boolean);
  const maker = modelFull(r);
  return [lines.join('\n'), maker ? `— ${maker}` : '', `Haikamera 🪷📸\n${APP_HOME_URL}`]
    .filter(Boolean)
    .join('\n\n');
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

// Ask the OS share sheet to take our file. Returns true when sharing either
// happened or was deliberately cancelled; false means "no file sharing here",
// so the caller should download instead.
async function tryNativeShare(file, caption, title) {
  if (!navigator.share || !file || !navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], text: caption, title });
    return true;
  } catch (err) {
    // The user dismissed the sheet — that's a finished action, not a failure.
    if (err?.name === 'AbortError') return true;
    return false;
  }
}

function flashShareButton(text) {
  const original = 'Share';
  els.shareBtn.textContent = text;
  els.shareBtn.disabled = true;
  setTimeout(() => {
    els.shareBtn.textContent = original;
    els.shareBtn.disabled = false;
  }, 1600);
}

async function shareResult() {
  if (!lastResult || !lastPhoto) return;
  const r = lastResult;
  const caption = shareCaption(r);
  const title = r.title || 'Haikamera';

  // Fast path: the card is already drawn, so share it without awaiting anything
  // — that keeps the tap a live user gesture when the share sheet opens.
  if (shareCardBlob) {
    const ready = new File([shareCardBlob], shareFilename(r), { type: 'image/png' });
    if (await tryNativeShare(ready, caption, title)) return;
    downloadBlob(shareCardBlob, shareFilename(r));
    flashShareButton('Saved ✓');
    return;
  }

  // Still drawing (or file sharing isn't available): wait for the card, then
  // share it or, failing that, save it — the image, poem and model still reach
  // the user either way.
  let blob = (await shareCardPromise) || shareCardBlob;
  if (!blob) {
    try {
      blob = await composeShareCard(r, lastPhoto);
    } catch {
      flashShareButton("Couldn't share");
      return;
    }
  }

  const file = new File([blob], shareFilename(r), { type: 'image/png' });
  if (await tryNativeShare(file, caption, title)) return;

  downloadBlob(blob, shareFilename(r));
  flashShareButton('Saved ✓');
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
}

function updateJournalCount() {
  els.journalCount.textContent = String(loadJournal().length);
}

function addToJournal() {
  if (!lastResult) return;
  const entries = loadJournal();
  // Keep everything the model told us, not just the verse: which model wrote
  // it, whether it was a real one or a fallback, and the things it named.
  entries.unshift({
    title: lastResult.title,
    lines: lastResult.poem || [],
    model: lastResult.model || '',
    language: lastResult.language || getLang(),
    degraded: !!lastResult.degraded,
    demo: !!lastResult.demo,
    objects: lastResult.objects || [],
    colors: lastResult.colors || [],
    thumb: lastThumb,
    at: Date.now(),
  });
  saveJournal(entries);

  els.saveBtn.textContent = 'Saved ✓';
  els.saveBtn.disabled = true;
}

function renderJournal() {
  const entries = loadJournal();
  els.journalList.innerHTML = '';

  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'journal-empty';
    li.textContent = 'No poems yet. Point at something and snap one.';
    els.journalList.appendChild(li);
    return;
  }

  entries.forEach((e) => els.journalList.appendChild(journalItem(e)));
}

// One journal entry: a collapsed summary (thumbnail + title + first line +
// model/date) that expands to the full poem, the things and colours it
// saw, the model that wrote it, and when it was saved.
function journalItem(e) {
  const when = new Date(e.at);
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
  tagline.textContent = lines[0] || '';
  if (lines.length > 1) {
    const more = document.createElement('span');
    more.className = 'j-more';
    more.textContent = ` +${lines.length - 1} more line${lines.length > 2 ? 's' : ''}`;
    tagline.appendChild(more);
  }

  const meta = document.createElement('p');
  meta.className = 'j-meta';
  meta.textContent = [
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
  // A saved Persian poem keeps reading right-to-left.
  if (RTL_LANGS.has(e.language)) {
    poem.dir = 'rtl';
    poem.lang = 'fa';
  }
  lines.forEach((line) => {
    const p = document.createElement('p');
    p.className = 'poem-line';
    p.textContent = line;
    poem.appendChild(p);
  });
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
  body.appendChild(saved);

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
setLang(getLang()); // restore the chosen poem language
show('stage');
refreshPulses(); // pull playful AI-made loading words

// Surface demo mode so nobody is confused by the sample verse.
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.demo) {
      els.privacyLine.textContent =
        'Demo mode — here is a sample poem. No account, no cookies, nothing about you.';
    }
  })
  .catch(() => {});
