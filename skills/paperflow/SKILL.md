---
name: paperflow
description: Build, debug, extend, and deploy the PaperFlow web app for translating English academic PDFs into Korean with browser-side PDF extraction and a Netlify OpenAI translation pipeline.
metadata:
  short-description: Develop and maintain PaperFlow
---

# PaperFlow

Use this skill for work on the PaperFlow repository: its browser UI, PDF text extraction, translation orchestration, Netlify Function, prompts, deployment, or operational configuration.

## Architecture

- `index.html` owns the UI, styling, print/PDF output, and browser-side script loading.
- `assets/pdf-text.js` extracts and normalizes PDF text in the browser. Preserve two-column reading order, paragraph recovery, heading detection, repeated header/footer removal, page-number removal, and line-break hyphen repair.
- `assets/translator.js` orchestrates glossary generation, draft translation, and second-pass review/correction. Requests are chunked because Netlify Functions have short execution limits.
- `assets/app.js` handles file selection, progress, rendering, and export.
- `netlify/functions/translate.mjs` is the server boundary for OpenAI calls. Keep prompts and API-key use server-side.
- `vendor/pdfjs/` contains the browser-loaded pdf.js build and worker.

## Translation invariants

When changing translation behavior:

- Keep the glossary step before chunk translation so terminology stays consistent.
- Keep the review pass supplied with both source text and draft translation; it checks omissions, numbers, citations, glossary compliance, and style.
- Preserve academic Korean declarative style (`~이다`, `~한다`).
- Preserve citations, formulas, units, proper nouns, and dataset names unless the existing rules explicitly translate a label (for example, `Figure 3` to `그림 3`).
- Keep references after the detected References section untranslated and separate from translated body text.
- Ensure chunk retries and response-splitting remain deterministic and do not silently drop source text.

## Safe implementation workflow

1. Inspect the relevant client and server files before editing; avoid moving responsibilities across the browser/server boundary without a concrete reason.
2. For extraction changes, test with PDFs that include two columns, repeated headers, headings, hyphenated line breaks, and references.
3. For translation changes, verify glossary propagation, chunk boundaries, retry behavior, review correction, and preservation of numbers/citations.
4. Never expose `OPENAI_API_KEY` in browser code or commit it to the repository. Treat rate limiting and request-size limits as production concerns.
5. Keep browser-visible errors actionable without exposing secrets or raw provider credentials.
6. Before deployment, verify required environment variables: `OPENAI_API_KEY`; optional `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, and `RATE_LIMIT_PER_MINUTE`.

## Common commands

- Install dependencies: `npm install`
- Run locally: `npx netlify dev`
- Update pdf.js vendor files only when intentionally changing the pinned version:
  `npm install pdfjs-dist@<version> --no-save`, then copy the two build files into `vendor/pdfjs/`.

Prefer small, targeted changes and validate the affected workflow end to end.