## WUP Draft Assist (Web)

Lightweight browser app that mirrors the original Streamlit app. CSVs load from `public/data` at runtime and all scoring is done client-side for instant feedback after clicking ✓ or x.

### Local development

1. Install deps
   - `npm install`
2. Start dev server
   - `npm run dev`

### Build

`npm run build` → outputs static files to `dist/`.

### Deploy to Vercel

- Framework preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

The CSVs in `public/data` are bundled as static assets and fetched as `/data/*.csv`.
