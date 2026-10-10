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
  resMood: $('resMood'),
  resSource: $('resSource'),
  moodRow: $('moodRow'),
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
  retryBtn: $('retryBtn'),
  journalBtn: $('journalBtn'),
  journalCount: $('journalCount'),
  journalDialog: $('journalDialog'),
  journalList: $('journalList'),
  clearJournal: $('clearJournal'),
  closeJournal: $('closeJournal'),
  offlineBanner: $('offlineBanner'),
  privacyLine: $('privacyLine'),
};

const JOURNAL_KEY = 'haikamera.journal.v1';
const LEGACY_JOURNAL_KEY = 'touchgrass.journal.v4'; // pre-rename key, migrated once
const MAX_EDGE = 1024;         // px — plenty for the model, keeps uploads tiny
const JPEG_QUALITY = 0.82;

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
function withThumb(canvas) {
  const full = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

  const tScale = Math.min(1, 160 / Math.max(canvas.width, canvas.height));
  const tCanvas = document.createElement('canvas');
  tCanvas.width = Math.max(1, Math.round(canvas.width * tScale));
  tCanvas.height = Math.max(1, Math.round(canvas.height * tScale));
  tCanvas.getContext('2d').drawImage(canvas, 0, 0, tCanvas.width, tCanvas.height);

  return { full, thumb: tCanvas.toDataURL('image/jpeg', 0.7) };
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
async function identify({ full, thumb }) {
  lastThumb = thumb;
  els.previewImg.src = thumb || full;
  startPulses();
  show('loading');

  try {
    const res = await fetch('/api/poem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: full }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status}).`);
    }

    renderResult(await res.json(), full);
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
function renderResult(r, photo) {
  lastResult = r;

  els.sceneImg.src = photo;
  els.poemTitle.textContent = r.title || '';

  els.poemLines.innerHTML = '';
  (r.poem || []).forEach((line) => {
    const p = document.createElement('p');
    p.className = 'poem-line';
    p.textContent = line;
    els.poemLines.appendChild(p);
  });

  // "See how this was made": mood + model, clearly labelled behind a disclosure.
  const moodText = [r.mood, r.degraded ? 'best guess' : ''].filter(Boolean).join(' · ');
  els.resMood.textContent = moodText;
  els.moodRow.classList.toggle('hidden', !moodText);

  // Be honest about what actually wrote the poem — especially in demo mode,
  // where every photo returns the same canned verse.
  let makerText = '';
  if (r.demo) makerText = 'demo sample';
  else if (r.degraded) makerText = 'fallback verse';
  else if (r.model) makerText = String(r.model).split('/').pop().replace(/:free$/, '');
  els.resSource.textContent = makerText;
  els.resSource.title = r.model || '';
  els.makerRow.classList.toggle('hidden', !makerText);

  // A tiny badge on the summary so state is clear even when collapsed.
  const badgeText = r.demo ? 'demo' : r.degraded ? 'best guess' : '';
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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
  entries.unshift({
    title: lastResult.title,
    lines: lastResult.poem || [],
    mood: lastResult.mood,
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

  entries.forEach((e) => {
    const li = document.createElement('li');
    const when = new Date(e.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const firstLine = (e.lines && e.lines[0]) || '';
    li.innerHTML = `
      ${e.thumb ? `<img src="${e.thumb}" alt="">` : ''}
      <div>
        <p class="j-name">${escapeHtml(e.title || 'Untitled')}</p>
        <p class="j-tagline">${escapeHtml(firstLine)}</p>
        <p class="j-meta">${escapeHtml(e.mood || '')}${e.mood ? ' · ' : ''}${when}</p>
      </div>`;
    els.journalList.appendChild(li);
  });
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
