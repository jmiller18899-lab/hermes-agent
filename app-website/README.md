# app-website

A fresh, self-contained marketing website for Hermes Agent.

This is an alternative take on the existing `landingpage/` site — added in a
separate directory so it can be reviewed side-by-side before deciding whether
to replace the deployed landing page.

## Contents

- `index.html` — single-page site
- `styles.css` — dark theme, responsive, no framework
- `script.js` — sticky nav, mobile menu, copy-to-clipboard, scroll reveal

No build step, no dependencies.

## Preview locally

```bash
cd app-website
python3 -m http.server 8080
# open http://localhost:8080
```

## How it relates to the other web folders

- `landingpage/` — the current live marketing site at
  `hermes-agent.nousresearch.com`.
- `website/` — Docusaurus documentation site served at `/docs/`.
- `web/` — Vite/React scaffold (separate app, not the marketing page).
- `app-website/` — this directory.
