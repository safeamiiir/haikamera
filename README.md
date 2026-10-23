# 🪷📸 Haikamera — a tiny poem or story about your scene

**Point your phone at anything — your desk, a window, a trail — and a free, open-weight AI writes a short colour-poem or a one-paragraph short story about what it sees. Then it shows you the photo you took, with the writing beneath it.**

A mobile web app. No install, no account, no personal data collected.

- **It's a game about looking.** The whole point is the two seconds *before* the writing: noticing the amber of a mug, the moss on a wall, the slate of the sky. The poem or story just hands your attention back to the world.
- **Poem or story.** A switch beside the shutter chooses a three-line colour haiku or a single-paragraph short story. Both are grounded in the colours and objects that are actually visible; the story has a small character, a turn and a quiet resolution, and stays around 80–120 words.
- **Screen time is short by design.** Tap **Snap a poem** (or **Snap a story**), take or upload a photo, and a moment later you have a three-line haiku or one short paragraph about the colours and objects in front of you. The app's whole job is to make you stop looking at the app.
- **Open-weight AI at its core.** The writing comes from an open-weight vision model on a free, OpenAI-compatible API. Swap the model or the provider with a single environment variable — no code changes, no lock-in.
- **More than one language.** A selector on the landing page picks the language. Choose **Farsi (Persian)** and the model returns the whole piece — title, poem lines or story, objects, colour names — in Persian, laid out right-to-left while the rest of the interface stays English.
- **Your own photo is the only image.** We never generate or fetch another picture. No stock photos, no image search, no second image host that ever sees your scene.
- **Share the writing with the world, cheaply.** A **Share** button on the result — or on any saved journal entry — draws your photo, the poem or story, the model that wrote it, and the app's address into one tidy card and hands it to the phone's share sheet, or saves it as a PNG where the browser can't share files. The tucked-away details (colours and objects) stay in the app.
- **Zero personal info.** No accounts, no emails, no cookies, no analytics. Your camera frame is re-encoded on your phone (**stripping EXIF/GPS**) before it is ever sent, held in memory for one request, and never stored. The API key lives on the server, so it is never exposed to the browser.

---

## Why open innovation matters here

This project only works *because* the AI is open. Three reasons, in order of how much they matter:

### 1. Cost — it is genuinely free to run

The writing runs on a **free tier serving an open-weight vision model**. There is no per-token bill, no credit card, and no "trial that expires". A closed frontier stack would make this exact app impossible to give away — every tap would cost money, so the toy would have to become a business before it became fun. Open weights on a free endpoint mean someone can build a silly, delightful thing and just… leave it running.

### 2. Privacy — the parts that stay on your device are the parts that should

Because the models are components I can pick up and put down, I never have to accept a vendor's data terms to use them. That lets me design the *app* around privacy instead of around an SDK:

- The photo is downscaled and re-encoded with a canvas on the phone. That re-encode is what removes EXIF — **including GPS coordinates** — so your location never leaves the device.
- Nothing about you is sent: no device ID, no account, no history. The key is server-side, so the public UI holds no secret.
- The "field journal" lives on your phone only: the writing in `localStorage`, the photo copy used for sharing in `IndexedDB`. Never uploaded, never synced. Clear it any time.
- And because the shown image is **your own photo**, there is no second service — no image search, no image generator — that has to receive even a text description of your scene.

A closed API with a mandatory account and telemetry would make each of those choices harder, not easier.

### 3. Swappability — the models are components, not landlords

The server speaks the plain OpenAI chat-completions schema. The brains are one line of config — and usually you don't even need that, because the provider is inferred from the key's prefix:

```bash
# Usually you just paste a key; provider + model are auto-detected.
AI_API_KEY=sk-or-v1-...

# Run two providers at once: tried in order, each key picking up when the
# other is busy or out for the day. One key is spent, the other still answers.
AI_API_KEYS=gsk_your_groq_key,sk-or-v1-your_openrouter_key

# Or be explicit. Any of these work. Same code. Different writing.
AI_BASE_URL=https://openrouter.ai/api/v1         AI_MODEL=google/gemma-4-31b-it:free
AI_BASE_URL=https://api.groq.com/openai/v1       AI_MODEL=qwen/qwen3.8-27b
AI_BASE_URL=https://integrate.api.nvidia.com/v1  AI_MODEL=meta/llama-3.2-11b-vision-instruct
AI_BASE_URL=https://router.huggingface.co/v1     AI_MODEL=Qwen/Qwen3-VL-30B-A3B-Instruct
AI_FALLBACK_MODELS=dots-studio/dots-3-note-preview:free,google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free
```

The default is **Google Gemma 4 31B** (open-weight, image+text) on OpenRouter's free tier — it grounds colours and objects better than the rest and clings to the strict 5-7-5 JSON shape, which matters when the whole point is a tidy little haiku. The shared free pool rate-limits it often, but a 429 comes back in ~300ms, so the chain simply falls through: **Gemma 4 26B**, then **Nemotron 3 Nano Omni** and **dots-3-note-preview** — the two that answer most dependably (~3s a piece with thinking switched off). If a model errors, is rate-limited, or is withdrawn, the server falls through `AI_FALLBACK_MODELS` before ever giving up — and with `AI_API_KEYS` it will also cross from one provider to the next. For tougher scenes, the paid **Qwen3-VL** line (`qwen/qwen3-vl-30b-a3b-instruct` or `qwen/qwen3-vl-235b-a22b-instruct` on OpenRouter) is the strongest visual-grounding swap.

> **The free tier has a daily ceiling, and it is the usual reason you see "fallback verse."** A free OpenRouter account is capped at **20 requests/minute and 50 requests/day** on `:free` models (a one-off $10 credit raises the day to **1,000**; the per-minute cap stays). Once the day is gone, *every* free model on that key 429s. With one key the app says so plainly instead of showing you canned writing; with `AI_API_KEYS` it retires the dead key and routes to the next provider. Three things keep you under the ceiling: the biggest model call is a **512px** image (~330 tokens), reasoning is **switched off** (each host in its own dialect — OpenRouter's `reasoning: {enabled: false}`, Groq's `reasoning_effort: "none"`; thinking turned a 22s request into 3s and often ate the whole output budget, which is what emptied the reply), and the server retires a key the moment its day-quota 429 lands rather than walking the rest of that key's chain. **The most reliable free path is Groq** — no card, 30 requests/minute and **1,000 requests/day**, and the server auto-detects a `gsk_` key. Note what Groq can and can't do now: it retired its Llama 4 vision models in 2026 (Maverick in March, Scout in July) and the suggested replacements are text-only, so its one vision model is `qwen/qwen3.8-27b` — a *preview* model. For quality, a few dollars of OpenRouter credit on `google/gemini-2.5-flash` is the best value; the cheapest vision model on the platform (`inclusionai/ling-3.0-flash-vl`, $0.021/M in) costs about **$0.000013 a piece** — roughly 10,000 pieces per 13¢.

If a provider gets slow, changes its limits, or turns hostile, I point the config somewhere else and the app is unchanged. Want a different vibe — spookier, more scientific, all-food? Change the system prompt. That freedom is the entire difference between building *on* AI and building *inside* someone else's AI.

> The theme is "get people off the screen." The thing that makes that safe is that none of the screen's usual costs — money, tracking, lock-in — are present.

---

## What it does

A switch beside the shutter chooses the form — **Haiku** or **Short story** — and a small selector in the top bar chooses the language, **English** or **Farsi (Persian)**. Both choices are remembered on the device. Everything below is the same either way.

1. Tap **Snap a poem** (or **Snap a story**) → a small menu with **two ways in**:
   - **Take a photo** — on a phone that's the native rear camera (`<input capture>`; works on iOS Safari and Android Chrome, no permissions dance). On a desktop it opens the webcam in-app, and falls back to a file chooser if there's no camera or permission is denied. **On a Mac, if your iPhone is set up as a Continuity Camera, the app auto-selects it** (and offers a camera picker otherwise).
   - **Upload an image** — pick a photo you already have. Same on every device.
2. Point at (or pick) any scene. Anything at all.
3. The frame is re-encoded on-device into **two copies**: a ≤1024px one to show you, and a **≤512px** one to send to the model. A poem or a story needs the gist of the scene, not a forensic read, so the model call carries roughly **330 image tokens instead of 870** — a fraction of the cost, latency and rate-limit pressure, and the writing still lands on what's actually there. The re-encode is what strips EXIF/GPS; only the small copy is POSTed to the local server proxy.
4. An open-weight vision model reads the scene and returns strict JSON. In **Haiku** mode: a short title, a **three-line haiku (5-7-5 syllables)**, the **objects** it can see, and the dominant **colours** with hex codes. In **Short story** mode: a title, **one paragraph of about 80–120 words** with a small character, a turn and a quiet resolution, plus the objects and colours. Choose **Farsi (Persian)** and the same fields come back in Persian instead — see below.
5. While it writes, the waiting line shows a **playful gerund** — *Haikoizing…*, *Shakespearing…*, *Story-weaving…* — drawn from a batch the AI invents on the fly (the server asks for fresh words and caches them; a built-in list covers the very first run).
6. You get **your own photo**, the poem or story beneath it, and a **"See how this was made"** disclosure with the model that wrote it, tappable colour swatches (tap to copy the hex), and the objects as chips. Save it to your on-device field journal — or hit **Share** and a card with the photo, the writing, the model and the app's address is handed to your phone's share sheet (or saved as a PNG on browsers that can't share files). Saved entries can be opened later and shared again from the journal.
7. Then go look at the real thing.

**A note on captions.** WhatsApp shows the caption attached to the shared image. Telegram's share extension is less reliable: some versions drop the text from a web share, even though the image arrives. Haikamera keeps the caption within the 1024-character photo-caption limit and copies it to the clipboard when you tap Share, so it is ready to paste into the chat if Telegram leaves it out. The card itself always carries the writing, so the post still reads even if the caption goes missing.

The model is prompted to ground every line in what is *actually visible* — real objects, real colours — to keep it calm and family-friendly, and to **never refuse**: if the photo is unclear it still answers, describing the colours and shapes it can honestly see. If JSON parsing ever fails, the server falls back to a guaranteed verse or story, honestly labelled *fallback verse* / *fallback story*.

### Haiku or short story

The switch beside the shutter offers **Haiku** and **Short story**. It is stored in `localStorage` and sent with the photo, so the server can choose the matching prompt and JSON shape:

- **Haiku** keeps the original brief: exactly three lines, 5-7-5 syllables, every line touching a real object or colour.
- **Short story** asks for exactly one paragraph of about 80–120 words. The prompt follows the craft of a tiny story rather than just describing the scene: it establishes a place from the frame, gives one ordinary character a small want, turns the moment on something small (a sound, a change in the light, a thing noticed), and ends on a concrete image or gesture instead of a moral. It must name at least three visible objects and two dominant colours, show rather than tell, and stay family-friendly.
- The story may imagine a small moment around the photo, but every physical detail has to stay consistent with the frame. It is fiction, not a report.

The same choice shapes the result card, the journal entry, and the share card (where a story sets as prose, in a smaller face than the poem's verse).

### Writing languages

The language selector in the top bar offers **English** and **Farsi (Persian)**. It changes the writing, not the interface.

- The choice is stored in `localStorage`, so it survives a reload, and it's restored on the next visit.
- The selected language travels with the photo. The server adds a matching instruction to the prompt, so the model writes the title, the poem or story, the object names and the colour names in the chosen language. The JSON *keys* stay English underneath; only the values change.
- A Farsi poem or story is rendered **right-to-left**, and saved journal entries remember their language, so they reopen the same way. A **Farsi share card** drawing reads right-to-left too.
- If the model fails, or the app is running in demo mode, the guaranteed writing and the sample come back in the chosen language too — no sudden drop back into English mid-flow.

Because the 5-7-5 count is really an English/Japanese shape, the Persian haiku prompt relaxes it to "three short lines" rather than forcing a syllable count the language doesn't use. The Persian story keeps the same one-paragraph, character/turn/resolution brief.

---

## Run it

Requires Node 18+ (uses built-in `fetch`). No dependencies to install.

```bash
node server.js
```

Open `http://localhost:8787`. If a `.env` file is present it's loaded automatically, so you can just paste your key and run `node server.js`. With no API key set it starts in **DEMO MODE** with a canned poem or story, so you can try the whole UI immediately — including on your phone.

### Try it on your actual phone (same Wi-Fi)

`server.js` binds to `0.0.0.0` and prints your LAN address on boot. Find your computer's IP:

```bash
ipconfig getifaddr en0        # macOS Wi-Fi
```

Then open `http://<that-ip>:8787` on your phone. In Safari/Chrome, **Share → Add to Home Screen** to install it as an app (it's a PWA).

### Use your iPhone as the camera (Mac + Continuity Camera)

On a Mac, "Take a photo" opens the webcam. Browsers only allow webcam access in a *secure context*, so use `http://localhost:8787` (the webcam won't open over a plain `http://` LAN IP — use **Upload an image** there, or put the app behind HTTPS).

The app tries to follow Apple's own setup: if you've turned on **Continuity Camera** (on your iPhone: **Settings → General → AirPlay & Continuity → Continuity Camera**; both devices on the same Apple Account with Wi-Fi + Bluetooth on), the iPhone appears to macOS as a normal camera. The app spots it and **auto-selects it**; if it can't find one, it keeps your built-in webcam and shows a short tip. There's also a **⇄ switch button** next to Capture (and a camera picker) so you can flip between cameras manually. See Apple's guide: <https://support.apple.com/guide/mac-help/use-iphone-as-a-webcam-mchl77879b8a/mac>.

### Go live

1. Get a free API key — no credit card — from one of:

   | Provider | Free tier | Notes |
   |---|---|---|
   | **OpenRouter** (default) | 20+ free models, no card | Broad choice; free vision via Gemma 4 / others |
   | **Groq** | No card, very fast | 30/min, 1,000/day; vision via `qwen/qwen3.8-27b` (its only one — a preview model) |
   | **NVIDIA NIM** | 120+ open-weight models | Best open-weight catalogue; vision included |
   | **Hugging Face** | Inference Providers free tier | One token covers the vision call |

2. Configure and run:

   ```bash
   cp .env.example .env
   # edit .env: paste AI_API_KEY. Provider + a good free vision model are
   # auto-detected from the key (sk-or- → OpenRouter, gsk_ → Groq, …).
   # Two free keys? Use AI_API_KEYS=sk-or-v1-...,gsk_... instead — tried in
   # order, and one keeps answering when the other is out for the day.
   node server.js
   ```

3. Confirm it's live: `curl http://localhost:8787/api/health` → `{"ok":true,"demo":false,"provider":"openrouter","model":"google/gemma-4-31b-it:free","reasoning":"off",...}`. If `demo` is `true`, no key was found — you're seeing the same sample writing for every photo.

### Deploy

**Live:** <https://haikamera.onrender.com>.

It's a single stateless Node process plus static files, and the key stays server-side — so any host that runs Node works (Fly, Render, Railway, a VPS, even a Raspberry Pi on your LAN). Put it behind HTTPS and add it to your home screen. Rotate a key if a deploy ever leaks it.

**On Render.** It runs as a Node web service: build `npm install`, start `node server.js`, health check `/api/health`. Add `AI_API_KEY` (or `AI_API_KEYS` for several, and optionally `AI_MODEL`) in the service's **Environment** tab — server-side only, never in the repo.

For it to redeploy on every merge to `main`, Render needs the repo connected through the **GitHub App**. A service created from a *public repo URL* can't auto-deploy and must be deployed by hand (<https://render.com/docs/deploys#automatic-deploys>), so connect the provider instead:

1. Render → **Account Settings → Account Security → Git Deployment Credentials → Add credential → GitHub**, and grant access to the `haikamera` repo (or install from <https://github.com/apps/render/installations/new> and tick the repo).
2. Point the service at that connected repo — on the service's **Settings** page update the Git credentials/repository, or create the service fresh via **New → Web Service → GitHub**.
3. Keep **Settings → Build & Deploy → Auto-Deploy: On Commit**. From then on, every merge to `main` deploys automatically (deploys show up on the service's **Deploys** page).

### If the page throws an error after an update

You're almost certainly running a **stale cached `app.js`** against newer HTML (the classic symptom is `Cannot set properties of null`). The server serves the app shell with `Cache-Control: no-cache` and the service worker is network-first, so this should not happen — but if you updated while an old version was already cached, do one clean reload:

- Desktop: **hard reload** (macOS: ⌘⇧R, Windows/Linux: Ctrl⇧R).
- Phone: close the tab and reopen, or clear the site's data (**Safari:** Settings → Safari → Advanced → Website Data; **Chrome:** ⋮ → Settings → Site settings).

The next load fetches fresh, matching files.

---

## Project layout

```
server.js                 Zero-dependency server: static files, /api/poem, /api/pulse, /api/health
public/
  index.html              The whole UI (one screen, one button, one poem-or-story card)
  styles.css              Mobile-first, light/dark, safe-area aware
  app.js                  Capture (camera or upload, Continuity Camera on a Mac),
                          EXIF-stripping downscale, haiku/story mode, language +
                          right-to-left writing, render, share card, local journal
  manifest.webmanifest    PWA: installable to the home screen
  sw.js                   Offline app shell (writing still needs a connection)
  icon.svg                App icon
.env.example              Vision-model config, with a table of free options
```

---

## Privacy, precisely

| Data | Where it goes |
|---|---|
| Your photo | Downscaled + EXIF/GPS-stripped on your phone, sent to **your own server**, forwarded once to the vision model, and not stored anywhere. |
| The shown image | **Your own photo.** Nothing else is generated or fetched. |
| Your location | **Never collected.** Removed by the client-side re-encode; the app has no location code. |
| Your identity | **Never collected.** No account, no cookie, no device fingerprint, no analytics. |
| Your field journal | `localStorage` (text) and `IndexedDB` (the photo copy used for sharing) on your device only. Never uploaded. Clear it any time. |
| The API key | Server-side only. Never shipped to the browser. |

---

## Honest limits

- It's a poem or a story, not a field guide. The writing is a *response to* what's there, not a measurement of it.
- A story is fiction. It is anchored in the frame's real objects and colours, but the character and the little moment are imagined; don't read it as a factual account of the place.
- **"fallback verse" / "fallback story" are honest labels.** The card names whoever wrote your piece. If it says *fallback verse* or *fallback story*, no model answered in time and you're reading canned writing — not one about your scene. On the free tier that usually means the **daily 50-request cap** is spent (see above); it resets daily. Otherwise retry, or point `AI_MODEL` at a provider that's actually up (Groq).
- **Never eat, touch, or handle anything based on an AI output.** The model is prompted to keep it kind; you should keep it safe.
- Writing needs a connection (the vision model runs in the cloud). The app shell itself loads offline.
- Providers' free tiers have rate limits. The server has small built-in limiters to protect your quota from a single busy client.
- Syllables are counted by the model, not a dictionary, so a line can occasionally be a beat off. In Farsi the 5-7-5 count is dropped on purpose — Persian meter works differently — so the three lines stay short rather than syllable-locked. Change the prompt (or the model) to taste.

---

## License

MIT — see [LICENSE](./LICENSE). Any open-weight models you point it at carry their own licenses (usually permissive; check the provider's page).
