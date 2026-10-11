# Haikamera: point your phone at anything and an open-weight model hands you a poem back

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05)*

![Cover: a phone held up at golden hour, haiku ink lines rising from the screen](https://raw.githubusercontent.com/safeamiiir/haikamera/main/images/cover.png)

## What I Built

Haikamera is a mobile web app with one button. You point your phone at something ordinary, a desk, a window, a mossy wall, tap **Snap a poem**, and an open-weight vision model writes a three-line haiku about the colours and objects that are actually in the frame. Then the app shows you your own photo with the verse underneath, and you go back to looking at the real thing.

That last part is the whole design. The app's job is to be the shortest possible interruption. There is no feed to refresh and no streak to protect. You open it, you take one picture, you read three lines, you close it.

It is for anyone who wants a nudge to notice what is in front of them. I built it to be handed to a kid without a lecture about privacy, so nothing about the phone or the person leaves the device except one downscaled photo.

One switch is worth calling out, because it changes who the app is for: the poem does not have to be in English. A language selector in the top bar offers English and Farsi (Persian). Pick Persian and the model writes the whole verse in Persian, title, three lines, the objects it names, the colours, and the poem is laid out right-to-left while the rest of the interface stays English. It is a small feature on paper and a large one for a reader who would otherwise be handed a poem in a script that is not theirs.

There is one more thing worth calling out, because it is the feature people ask for first: the poem travels. A **Share** button hands the phone's share sheet a single card holding your photo, the three lines, the name of the model that wrote them, and the app's address. The colours and objects stay in the app. On a browser that cannot share files, the card downloads instead.

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

It is a zero-dependency Node app, MIT licensed. `server.js` is the entire backend (static files plus three endpoints) in about 800 lines, and `public/` is the whole front end. No build step, no framework, no `node_modules`. Clone it, run `node server.js`, and it is up.

```
server.js                 zero-dependency server: /api/poem, /api/pulse, /api/health
public/index.html         the entire UI: one screen, one button, one poem card
public/app.js             camera + upload, EXIF-stripping downscale, language switch, share card, render, journal
public/sw.js              offline app shell
.env.example              vision-model config with a table of free options
```

There is a **Fork me on GitHub** ribbon in the corner, because the fastest way to understand an open project is to own a copy of it.

## How I Built It

Two constraints shaped everything: the AI has to be open-weight, and the open parts have to be what make the app work, not decoration.

### The AI is a swappable component

The server speaks plain OpenAI chat-completions. The default model is Google Gemma 4 31B (`google/gemma-4-31b-it:free`), an open-weight vision model on OpenRouter's free tier. I did not need a code change to get there, because the provider is inferred from the key's prefix, so you paste a key and go:

```bash
AI_API_KEY=sk-or-v1-...   # sk-or- => OpenRouter; gsk_ => Groq; nvapi- => NVIDIA; hf_ => Hugging Face

# or run two providers at once, tried in the order written:
AI_API_KEYS=sk-or-v1-...,gsk_...
```

Want a different brain? One environment variable. Same code, different poem:

```bash
AI_MODEL=qwen/qwen3.8-27b                 # Groq's current vision model
AI_MODEL=Qwen/Qwen3-VL-30B-A3B-Instruct   # on Hugging Face
```

### Where the poem actually gets made

The model has to answer with strict JSON: a title, three poem lines, the objects it saw, and the dominant colours with hex codes. The prompt counts syllables out loud, bans a list of poem clichés, and forbids refusing:

```
1. Exactly THREE lines, with exactly this many syllables: 5, then 7, then 5.
2. Every line must mention something that is really in the photo.
   ...
4. Do NOT invent things that are not visible. Do NOT use these clichés:
   beauty, majestic, breathtaking, nature's embrace, whisper, dance, eternal, serene.
```

### The poem can be written in another language

The language selector is stored on the device and sent along with the photo. On the server, that choice appends one more instruction to the system prompt: answer in Persian, keep the JSON keys English. The schema never changes, only the values. On the client, a Persian poem is marked right-to-left so it reads the way it should, and each journal entry remembers the language it was written in, so a saved poem reopens with the same direction.

Two details I did not want to get wrong. First, 5-7-5 is an English and Japanese shape; counting syllables that way in Persian is a different exercise, so in that mode I relax the rule to "three short lines" rather than force a count that does not really exist. Second, the fallback matters most exactly when things go wrong, so the guaranteed verse and the demo-mode sample are Persian too. The reader never gets dropped back into English at the moment the model fails.

### Sharing the poem without shipping the metadata

The result screen has a **Share** button now. It draws a 1080px card on a canvas — your photo on top, the verse beneath it, and a footer with the name of the model that wrote it and the app's address — and hands that card to the phone's share sheet through the Web Share API. Colours and objects stay out of it; the card is written for someone who was not looking over your shoulder.

Three details made this more than a screenshot:

- The card is built from the same 1024px copy that is already on screen, which was re-encoded on the device, so sharing it cannot reintroduce the EXIF or GPS that first re-encode stripped.
- It is drawn as soon as a result renders, not when you tap. Mobile browsers only open a share sheet during a live user gesture, and awaiting a canvas export before calling `navigator.share` can spend that gesture. Handing the sheet a `File` that is already built keeps the tap honest.
- Where `navigator.canShare` will not take files, the same card downloads as a PNG and the button says so. The feature degrades into something you can still send.

A Persian poem stays right-to-left on the card, and the footer stays Latin, because a model id and a URL are Latin either way.

### The result screen, and a field journal that stays on your phone

The result is your photo, the poem, and a **"See how this was made"** disclosure. Open it and you get the model that wrote the verse, the **objects** it named as chips, and the dominant **colours** as tappable swatches — tap one to copy its hex. The colours are the one part of the result you can take somewhere else, which is rather the point: "the light was nice" becomes a hex you can actually use.

The **field journal** is `localStorage` on your device and nowhere else, so there is no server copy to leak and nothing to sync. An entry keeps a thumbnail, the full poem, the language it was written in — a Persian poem reopens right-to-left — the model, the objects and the colours, and the date. Tapping one expands it, and clearing the whole thing is a single button. It is deliberately the opposite of a feed: a drawer, not a timeline.

### Rate limits are normal, so the server moves on

Free `:free` model pools get 429'd constantly. The server walks a fallback chain, retries a model only when it answered with unparseable JSON instead of a transport error, and if everything fails it returns a guaranteed verse, honestly labelled a *fallback verse*. Every tap produces a poem.

The bigger fix was to stop betting on a single provider. `AI_API_KEYS` takes a list, and the order of the keys is the priority order. A key that comes back with a daily-quota 429 is retired for the rest of the request and the next provider picks up, so exhausting OpenRouter's 50-a-day hands off to Groq's 1,000 in about 300ms without the user seeing a thing. Every provider spells "stop thinking" differently, so the request builder keeps that per-host: OpenRouter takes `reasoning: {enabled: false}`, Groq takes `reasoning_effort: "none"`.

One thing worth saying out loud, because it cost me an afternoon: a "free vision model" is a moving target. Groq retired its Llama 4 vision models in 2026, Maverick in March and Scout in July, and the replacement it suggested was text-only, so for a while a Groq key could not read a photo at all. Its one multimodal model now is a *preview*. If you build on a free tier, treat the model name as configuration, not architecture.

The health endpoint tells the truth about what is actually running:

```
$ curl https://haikamera.onrender.com/api/health
{"ok":true,"demo":false,"provider":"openrouter+groq","reasoning":"off",
 "models":["google/gemma-4-31b-it:free", ...],
 "providers":[{"provider":"openrouter","models":[...],"reasoning":"off"},
              {"provider":"groq","models":["qwen/qwen3.8-27b"],"reasoning":"off"}]}
```

### The loading words are model-generated too

The waiting screen shows gerunds like "Haikoizing…", "Shakespearing…", "Colour-sipping…". The server asks a text model to invent a fresh batch, caches it for three hours, and falls back to a built-in list if that call fails. Small thing, but it makes the two seconds of waiting feel like part of the app instead of a spinner.

### What didn't work, and what I changed

- Early drafts came back as prose wrapped in code fences, which broke `JSON.parse`. The fix was a tolerant extractor that slices from the first `{` to the last `}` and retries the same model when parsing fails.
- Some models echoed the schema's placeholder title back verbatim. Now the normalizer drops known placeholders and substitutes a real name.
- After a deploy, a cached `app.js` running against new HTML threw `Cannot set properties of null`. I serve the app shell with `Cache-Control: no-cache`, made the service worker network-first, and added a one-time reload when an updated service worker takes over.
- An early version also asked the model for a one-word **mood** and showed it beside the model name. I cut it. The three lines already carry the feeling, and the extra field gave the model one more thing to invent and the schema one more key to get wrong.

On the client, the interesting part is the privacy step: re-encode through a canvas (that re-encode is what drops EXIF and GPS), then POST a data URL. One captured frame becomes three encodings — a 1024px copy for the screen and the journal, a 512px copy (about 330 tokens) that is the only thing the model ever sees, and a 160px thumbnail for the journal list. On desktop it opens the webcam, and on a Mac with Continuity Camera it auto-selects your iPhone as the camera.

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
