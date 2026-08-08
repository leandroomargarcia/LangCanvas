# LangCanvas

Visual simulator to practice designing LangGraph-style state graphs, with optional AI design critique powered by Gemini.

## What’s included

- `index.html` / `langcanvas.html` — frontend canvas simulator
- `api/analyze.js` — Vercel serverless function (`POST /api/analyze`) that calls Gemini
- Free-tier friendly model: `gemini-flash-lite-latest`
- Aggressive public rate limits on the analyze endpoint

## Local frontend

```bash
python -m http.server 8765
# http://localhost:8765
```

Without a backend, **Analyze design (AI)** falls back to a copyable prompt.

## Deploy on Vercel (frontend + API)

1. Set env var `GEMINI_API_KEY` (from https://aistudio.google.com/apikey)
2. Deploy this repo (root directory)
3. The app uses same-origin `BACKEND_URL = '/api/analyze'`

```bash
npx vercel env add GEMINI_API_KEY
npx vercel --prod
```

## Local API (`vercel dev`)

```bash
cp .env.example .env   # put your GEMINI_API_KEY
npx vercel dev
```
