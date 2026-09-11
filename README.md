# GRIPS — Backend Edition

This is the full-backend version of GRIPS. The frontend (`public/index.html`)
is the exact same tested app you already had — it now talks to a Next.js backend
instead of calling OpenAlex/Semantic Scholar/CrossRef/arXiv/Unpaywall directly
from the browser.

## What changed vs. the single-HTML version

- **Search** now goes through `/api/search` — all the accuracy logic
  (topic matching, Pakistan-confidence disambiguation, dedup, Unpaywall
  enrichment) runs server-side in `lib/sources.js`, ported line-for-line from
  the working client version.
- **API keys** (OpenAlex, and any future ones — IEEE/Springer/Elsevier) live in
  server environment variables, never in code the browser can see.
- **Reports, bookmarks, and history** are saved to Netlify Blobs (a database,
  effectively) under a private **Sync Code**, in addition to your local
  browser storage. No login/password system — just a code, shown in the
  About tab, that you can copy to another device to pull the same data down.

## Deploying on Netlify

1. Push this whole folder to your GitHub repo (replacing the old single-file
   version) using GitHub Desktop, same as before.
2. On [app.netlify.com](https://app.netlify.com), connect that repo. Netlify
   will detect `netlify.toml` and the `@netlify/plugin-nextjs` plugin
   automatically — no manual build settings needed.
3. **Add environment variables** (Netlify dashboard → Site settings →
   Environment variables):
   - `OPENALEX_API_KEY` — get a free one at
     [openalex.org/settings/api](https://openalex.org/settings/api). Required
     since Feb 13, 2026 (without it, OpenAlex is capped at ~10 searches/day).
   - Add `IEEE_API_KEY`, `SPRINGER_API_KEY`, `ELSEVIER_API_KEY` here later as
     you register for them — `lib/sources.js` can be extended to use them the
     same way `OPENALEX_API_KEY` is used now.
4. Deploy. Netlify Blobs works automatically on Netlify — no extra account or
   setup needed for it.

## Running locally (optional, for testing before you push)

```bash
npm install
npm run build && npm start        # test without Blobs (search works; reports/bookmarks/history will show a clear error instead of crashing)
# OR, to test Blobs locally too:
npm install -g netlify-cli
netlify dev                        # provides a local Netlify Blobs context
```

## The Sync Code system

- On first visit, the app generates a random code (e.g. `a1b2c3d4`) and shows
  it under **About → Sync Across Devices**.
- Every bookmark, note, history entry, and report is saved locally AND mirrored
  to the backend under that code.
- To see the same data on another device (or share with your lab director),
  enter the same code in the "Enter a sync code to load" box there — it pulls
  that code's bookmarks/history/reports down and replaces what's currently
  local.
- There's no password on a Sync Code — anyone who has the code can load that
  data. Treat it like a shareable link, not a secret password.

## Still to do (per earlier conversation)

- Register free keys for CORE, PLOS (may not even need a key), Springer
  Nature, IEEE Xplore, and Elsevier/ScienceDirect — add them as env vars and
  extend `lib/sources.js`'s `buildUrls`/`fetchBatch` the same way OpenAlex is
  wired in now.
- For IEEE/Elsevier **full-text** (not just metadata), you'll need to confirm
  with your lab director whether University of Punjab has an HEC-backed
  institutional subscription, and whether requests need to come from a
  campus IP/VPN.
