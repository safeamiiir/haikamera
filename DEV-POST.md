# Haikamera: point your phone at anything and an open-weight model hands you a poem back

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05)*

![Cover: a phone held up at golden hour, haiku ink lines rising from the screen](https://raw.githubusercontent.com/safeamiiir/haikamera/main/images/cover.png)

## What I Built

Haikamera is a mobile web app with one button. You point your phone at something ordinary, a desk, a window, a mossy wall, tap **Snap a poem**, and an open-weight vision model writes a three-line haiku about the colours and objects that are actually in the frame. Then the app shows you your own photo with the verse underneath, and you go back to looking at the real thing.

That last part is the whole design. The app's job is to be the shortest possible interruption. There is no feed to refresh and no streak to protect. You open it, you take one picture, you read three lines, you close it.

It is for anyone who wants a nudge to notice what is in front of them. I built it to be handed to a kid without a lecture about privacy, so nothing about the phone or the person leaves the device except one downscaled photo.

Privacy here is construction, not policy:

- The frame is re-encoded in a canvas on your phone, which strips EXIF and GPS before anything is uploaded.
- There are no accounts, cookies, analytics, or device fingerprints, and no login screen to skip because there is no login.
- The photo is held in memory for a single request and never written to disk.
- The only image on screen is your photo. Nothing is generated or fetched, so no second service ever sees a description of your scene.
- The field journal is `localStorage` on your device. It never syncs.
- The model API key lives on the server, so the public page holds no secret.

## Demo

Live at [haikamera.onrender.com](https://haikamera.onrender.com).

It is a PWA. On a phone, open the share sheet and choose Add to Home Screen, and it behaves like an app. Take a photo with the rear camera, or upload one you already have.

You can try the whole UI with zero setup: run it with no API key and it boots in `DEMO MODE`, returning the same canned verse for every photo so you can poke at the flow before you touch a model.

![Haikamera on a phone: a photo of a scene with a three-line poem underneath it](https://raw.githubusercontent.com/safeamiiir/haikamera/main/images/mobile-view-example.jpeg)

*On a phone. Your photo, then the poem it earned.*

![Haikamera on desktop: the capture screen and a poem card](https://raw.githubusercontent.com/safeamiiir/haikamera/main/images/desktop-view-example.png)

*The same app on desktop.*

## Code

{% embed https://github.com/safeamiiir/haikamera %}

It is a zero-dependency Node app, MIT licensed. `server.js` is the entire backend (static files plus three endpoints) in about 600 lines, and `public/` is the whole front end. No build step, no framework, no `node_modules`. Clone it, run `node server.js`, and it is up.

```
server.js                 zero-dependency server: /api/poem, /api/pulse, /api/health
public/index.html         the entire UI: one screen, one button, one poem card
public/app.js             camera + upload, EXIF-stripping downscale, render, journal
public/sw.js              offline app shell
.env.example              vision-model config with a table of free options
```

## How I Built It

Two constraints shaped everything: the AI has to be open-weight, and the open parts have to be what make the app work, not decoration.

### The AI is a swappable component

The server speaks plain OpenAI chat-completions. The default model is Google Gemma 4 31B (`google/gemma-4-31b-it:free`), an open-weight vision model on OpenRouter's free tier. I did not need a code change to get there, because the provider is inferred from the key's prefix, so you paste a key and go:

```bash
AI_API_KEY=sk-or-v1-...   # sk-or- => OpenRouter; gsk_ => Groq; nvapi- => NVIDIA; hf_ => Hugging Face
```

Want a different brain? One environment variable. Same code, different poem:

```bash
AI_MODEL=meta-llama/llama-4-maverick-17b-128e-instruct   # on Groq
AI_MODEL=Qwen/Qwen3-VL-30B-A3B-Instruct                  # on Hugging Face
```

### Where the poem actually gets made

The model has to answer with strict JSON: a title, three poem lines, the objects it saw, the dominant colours with hex codes, and a mood. The prompt counts syllables out loud, bans a list of poem clichés, and forbids refusing:

```
1. Exactly THREE lines, with exactly this many syllables: 5, then 7, then 5.
2. Every line must mention something that is really in the photo.
   ...
4. Do NOT invent things that are not visible. Do NOT use these clichés:
   beauty, majestic, breathtaking, nature's embrace, whisper, dance, eternal, serene.
```

### Rate limits are normal, so the server moves on

Free `:free` model pools get 429'd constantly. The server walks a fallback chain, retries a model only when it answered with unparseable JSON instead of a transport error, and if everything fails it returns a guaranteed verse flagged as a *best guess*. Every tap produces a poem. The health endpoint tells the truth about what is running:

```
$ curl https://haikamera.onrender.com/api/health
{"ok":true,"demo":false,"provider":"openrouter","model":"google/gemma-4-31b-it:free", "models":[...]}
```

### The loading words are model-generated too

The waiting screen shows gerunds like "Haikoizing…", "Shakespearing…", "Colour-sipping…". The server asks a text model to invent a fresh batch, caches it for three hours, and falls back to a built-in list if that call fails. Small thing, but it makes the two seconds of waiting feel like part of the app instead of a spinner.

### What didn't work, and what I changed

- Early drafts came back as prose wrapped in code fences, which broke `JSON.parse`. The fix was a tolerant extractor that slices from the first `{` to the last `}` and retries the same model when parsing fails.
- Some models echoed the schema's placeholder title back verbatim. Now the normalizer drops known placeholders and substitutes a real name.
- After a deploy, a cached `app.js` running against new HTML threw `Cannot set properties of null`. I serve the app shell with `Cache-Control: no-cache`, made the service worker network-first, and added a one-time reload when an updated service worker takes over.

On the client, the interesting part is the privacy step: downscale to 1024px, re-encode through a canvas (that re-encode is what drops EXIF and GPS), then POST a data URL. On desktop it opens the webcam, and on a Mac with Continuity Camera it auto-selects your iPhone as the camera.

Deploy is Render: build `npm install`, start `node server.js`, health check `/api/health`, key in the service environment. Merges to `main` auto-deploy through the GitHub App.

## Why Does Open Innovation Matter?

Because every one of the app's best properties falls out of the AI being open. Take the open part away and the app either stops working or stops being free.

### It can be free

The default model is open-weight and served on a free tier, so there is no per-token bill, no credit card, and no trial that expires. A closed frontier stack turns every tap into a line on an invoice, which means the toy has to become a business before it can become fun. I wanted to build a small delightful thing and just leave it running.

### Privacy becomes a design choice, not a vendor's terms

When the model is a component I can point anywhere, I never have to accept a data policy to use it. That freedom is what let me design the app around what stays on the phone: EXIF stripped locally, nothing stored, no account. With a closed API that mandates an account and telemetry, each of those choices is a fight rather than a default.

### No lock-in

The provider is a config line. If a host gets slow, changes its limits, or turns hostile, I repoint one variable and the app is unchanged. That is the difference between building on AI and building inside someone else's AI.

The theme is "touch grass", and short screen time is only safe to recommend when the screen is not also charging you money, harvesting your location, or holding your project hostage. Open weights make all three of those costs disappear.

## My Agent Session

I built the whole thing on [OpenCode](https://opencode.ai), and saved the session with DevRelay. It covers the build, the rename from the working title, and the deploy. I was sitting in [Cambridge Central Library](https://www.google.com/maps/search/?api=1&query=Cambridge%20Central%20Library%2C%207%20Lion%20Yard%2C%20Cambridge) while I did most of it, which is a good place to find a window worth photographing:

![Me, working on Haikamera](https://raw.githubusercontent.com/safeamiiir/haikamera/main/images/me-working-on-it.jpeg)

*Me, building it in Cambridge Central Library.*

{% agent_session haikamera-touch-grass-merged-sessions-build-rename-deploy-mrrp9j %}

Read it on DEV: [Haikamera (Touch Grass), merged sessions](https://dev.to/agent_sessions/haikamera-touch-grass-merged-sessions-build-rename-deploy-mrrp9j)

## Prize Categories

I am entering two partner categories, and only because the project uses them:

- **Best Use of Render:** Haikamera runs on Render as a Node web service, with `/api/health` as the health check and auto-deploy on every merge to `main`.
- **Best Use of Gemma:** the default model is the open-weight Google Gemma 4 31B (`google/gemma-4-31b-it:free`), and the fallback chain is Gemma-first as well.

If you point the camera at something and the poem names a colour you had walked past a hundred times, that is the app doing its job.

How this post was written: I gave the instructions and the opinions, and an AI agent in [OpenCode](https://opencode.ai) wrote the prose. The decisions are mine; the words are the agent's. I was at [Cambridge Central Library](https://www.google.com/maps/search/?api=1&query=Cambridge%20Central%20Library%2C%207%20Lion%20Yard%2C%20Cambridge) while we worked, and the app was built the same way.

Written by AI and [Amirreza](https://safeamii.ir).
