# Backend del Simulador LangGraph — análisis de diseño con IA

Backend mínimo para Vercel que recibe el grafo del frontend y devuelve una crítica
de diseño generada por Gemini (Google AI). La API key vive solo acá,
nunca en el frontend.

## Qué hace

- Expone `POST /api/analyze` que recibe `{ "prompt": "..." }` y devuelve `{ "text": "..." }`.
- Esconde la API key de Gemini (variable de entorno del servidor).
- Limita a 5 análisis por IP por minuto.
- Usa el modelo `gemini-flash-lite-latest` (free tier amigable).

## Deploy en Vercel (paso a paso)

### 1. Conseguí una API key de Gemini (gratis)
- Entrá a https://aistudio.google.com/apikey
- Creá una API key y copiala.

### 2. Subí esta carpeta a Vercel
Opción A — con la CLI:
```bash
npm i -g vercel
cd backend
vercel            # seguí los pasos, creá el proyecto
vercel env add GEMINI_API_KEY     # pegá tu key cuando lo pida (para Production)
vercel --prod     # deploy final
```

Opción B — desde la web:
- Subí la carpeta `backend/` a un repo de GitHub.
- En https://vercel.com → "Add New Project" → importá ese repo.
- En Settings → Environment Variables, agregá:
  - Nombre: `GEMINI_API_KEY`
  - Valor: tu key de Google AI Studio
- Deploy.

### 3. Anotá la URL del deploy
Vercel te da algo como `https://tu-proyecto.vercel.app`.
Tu endpoint es `https://tu-proyecto.vercel.app/api/analyze`.

### 4. Conectá el frontend
Abrí `langcanvas.html` y buscá la constante `BACKEND_URL` cerca del
inicio del `<script>`. Poné ahí tu URL:
```js
const BACKEND_URL = 'https://tu-proyecto.vercel.app/api/analyze';
```
Guardá y abrí / subí el HTML.

## Seguridad / costos

- El rate limit en memoria es "best effort" (Vercel recicla instancias).
- Para restringir quién puede llamar al backend, cambiá en `api/analyze.js` la
  línea `Access-Control-Allow-Origin` de `'*'` por la URL exacta de tu sitio.
- En el free tier de Gemini, Google puede usar prompts/respuestas para mejorar productos.

## Probar localmente
```bash
cd backend
# Poné GEMINI_API_KEY en .env o .env.local
vercel dev        # http://localhost:3000/api/analyze
```
