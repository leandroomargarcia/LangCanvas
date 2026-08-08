# LangCanvas

Visual simulator to practice designing LangGraph-style state graphs, with optional AI design critique powered by Gemini.

## What’s included

- `index.html` / `langcanvas.html` — frontend canvas simulator
- `api/analyze.js` — Vercel serverless function (`POST /api/analyze`) that calls Gemini
- Free-tier friendly model: `gemini-flash-lite-latest`
- Aggressive public rate limits on the analyze endpoint
- Optional [LangSmith](https://smith.langchain.com) tracing for each analyze call

## Local frontend

```bash
python -m http.server 8765
# http://localhost:8765
```

Without a backend, **Analyze design (AI)** falls back to a copyable prompt.

## Deploy on Vercel (frontend + API)

1. Set env var `GEMINI_API_KEY` (from https://aistudio.google.com/apikey)
2. (Optional) Enable LangSmith — see below
3. Deploy this repo (root directory)
4. The app uses same-origin `BACKEND_URL = '/api/analyze'`

```bash
npx vercel env add GEMINI_API_KEY
npx vercel --prod
```

## LangSmith tracing (optional)

When `LANGSMITH_API_KEY` is set, each successful `/api/analyze` call is traced as `langcanvas-analyze` with:

- anonymized visitor hash (not raw IP)
- problem description
- node/edge counts, node types
- compact graph snapshot (labels, edges, state vars)

Without the key, the API works as before (no tracing).

Env vars:

```bash
LANGSMITH_API_KEY=lsv2_pt_...   # https://smith.langchain.com → Settings → API Keys
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=langcanvas
# optional:
IP_HASH_SALT=any-random-string
```

Free Developer plan is enough for a public demo (~5k traces/month).

## Local API (`vercel dev`)

```bash
cp .env.example .env   # put your GEMINI_API_KEY (+ optional LangSmith vars)
npx vercel dev
```
