# LangCanvas

Visual simulator to practice designing LangGraph-style state graphs, with AI design critique (Gemini), code generation (LangChain MCP), and freemium access.

Brand: **LangCanvas** · Site: [langcanvas.dev](https://langcanvas.dev)

## Project layout

```
api/                     # Vercel serverless functions
  analyze.js             # POST /api/analyze — AI design critique
  generate-code.js       # POST /api/generate-code — LangGraph Python via MCP
  feedback.js            # POST /api/feedback — email via Resend
index.html               # Frontend (canvas + auth gate)
firebase-config.example.js
firestore.rules
scripts/                 # Optional local diagnostics
vercel.json
```

## Features

- Visual LangGraph-style canvas (templates, multi-select, export)
- Step-through execution + structural validate
- **Try for free**: 5 AI critiques per guest (browser id + IP)
- Google sign-in for member / Pro path
- Generate code with live LangChain docs (MCP) + local fallback
- Feedback form → Resend email

## Quotas

| Plan | Analyze AI |
|------|------------|
| `guest` (Try for free) | 5 lifetime / guest+IP |
| `free` (signed in) | 5 / day |
| `pro` | 50 / day |

## Firebase setup

1. Create a project at [Firebase Console](https://console.firebase.google.com).
2. **Authentication** → enable **Google**.
3. Copy web config into `firebase-config.js` (from `firebase-config.example.js`).
4. Authorized domains: `langcanvas.dev`, `*.vercel.app`, `localhost`.
5. Firestore → paste [`firestore.rules`](firestore.rules) → Publish.
6. Service account → set on Vercel / `.env`:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`

Also set `GEMINI_API_KEY`. Optional: LangSmith, Resend.

## Environment variables

See [`.env.example`](.env.example). Important extras:

| Var | Purpose |
|-----|---------|
| `RESEND_API_KEY` | Feedback emails |
| `FEEDBACK_TO` | Inbox for feedback |
| `RESEND_FROM` | Verified sender (or Resend onboarding address) |

## Deploy (Vercel)

```bash
cp firebase-config.example.js firebase-config.js   # fill values
cp .env.example .env                                 # fill secrets
npx vercel env add …                                 # production secrets
npx vercel --prod
```

App uses same-origin APIs (`/api/analyze`, `/api/generate-code`, `/api/feedback`).

### Local

```bash
npx vercel dev
```

## LangSmith (optional)

```bash
LANGSMITH_API_KEY=lsv2_pt_...
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=langcanvas
```

Built by [Leandro Garcia](https://www.linkedin.com/in/leandroomargarcia/).
