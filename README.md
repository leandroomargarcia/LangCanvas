# LangCanvas

Visual simulator to practice designing LangGraph-style state graphs, with optional AI design critique powered by Gemini.

## What’s included

- `index.html` / `langcanvas.html` — frontend canvas simulator
- `api/analyze.js` — Vercel serverless function (`POST /api/analyze`) that calls Gemini
- Free-tier friendly model: `gemini-flash-lite-latest`

## Local frontend

Open `index.html` in a browser, or:

```bash
python -m http.server 8765
# http://localhost:8765
```

Without a backend, **Analyze design (AI)** falls back to a copyable prompt.

## Deploy on GitHub Pages (frontend)

Static hosting only — the Gemini API route does **not** run on Pages.
On `*.github.io`, **Analyze design (AI)** uses the copy-prompt fallback unless you set `BACKEND_URL` to a Vercel API URL.

Pages is enabled via GitHub Actions (`.github/workflows/deploy-pages.yml`).
Site: `https://leandroomargarcia.github.io/LangCanvas/`

## Deploy on Vercel (frontend + API)

1. Set env var `GEMINI_API_KEY` (from https://aistudio.google.com/apikey)
2. Deploy this repo (root directory)
3. Outside GitHub Pages, the app uses same-origin `/api/analyze`

```bash
npx vercel env add GEMINI_API_KEY
npx vercel --prod
```

## Local API (`vercel dev`)

```bash
cp .env.example .env   # put your GEMINI_API_KEY
npx vercel dev
```
