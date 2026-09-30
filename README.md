# You.com Research Console

Local single-page app (Ubuntu/Debian GNOME) that drives the You.com **Research** (Frontier & Exhaustive), **Contents**, and **Answers** APIs and saves every result as Markdown to a directory you choose.

**Interface quality and truthful state are the primary deliverable.** The backend exists to make the UI honest.

## Requirements

- **Node.js 20+** (tested on Node 20)
- Linux recommended (`xdg-open` for Open file / Open folder)

## Quick start

```bash
cd youcom-research-console
npm install
npm start
```

Open the URL printed in the terminal (default **http://127.0.0.1:3847**).  
The listening URL is also written to `PREVIEW_URL.txt`.

```bash
npm test    # automated suite (mocks You.com; no real API key required)
```

## Configuration

| Item | Location |
| --- | --- |
| API key | `.env` → `YDC_API_KEY=…` (created/updated/deleted from **Settings**; never sent to the browser) |
| Example env | `.env.example` |
| Preferences | `data/settings.json` (output directory, notification preference) |
| Threads / jobs / logs | `data/state.json` (survives restart) |
| Demo output (seeded) | `data/output/` |

On first launch with empty state, a sample **SAVED · VERIFIED** Frontier report is seeded so you can screenshot the reader without a live key.

### Settings UI

1. **API KEY** — Save/Replace or Delete (confirm). UI only sees `KEY SAVED` / `NO KEY`.
2. **OUTPUT DIRECTORY** — absolute path; backend creates it when possible and reports `WRITABLE` or the OS error.
3. **NOTIFICATIONS** — request browser permission; notifications fire **after** disk verification.

## Modes

| Mode | API | Notes |
| --- | --- | --- |
| Frontier | `POST /v1/research` `research_effort: "frontier"` | Always `background: true` (required) |
| Exhaustive | `POST /v1/research` `research_effort: "exhaustive"` | Always `background: true` |
| Contents | `POST https://ydc-index.io/v1/contents` | `formats: ["markdown"]`; one file per page (`-01`, `-02`, …) |
| Answers | `POST /v1/answer` | Query max 400 chars; `.md` = `answer` string only |

Auth on every call: header `X-API-Key`.

### Research polling (local observer)

From successful submission:

| Elapsed | Interval |
| --- | --- |
| 0–3 min | 30 s |
| 3–6 min | 15 s |
| 6–15 min | 5 s |

At **15 minutes** or app close → `TRACKING PAUSED` (job ID kept). **Resume Tracking** / **Stop Local Polling** available. On restart, in-flight jobs load as `TRACKING PAUSED` with **no automatic polling**.

Filenames (local time at write): `MM-DD:HHMM.SS.md` or `MM-DD:HHMM.SS-01.md`.

## API capability gaps

Documented against the confirmed contract and `docs/api_notes.txt`:

1. **File uploads** — None of Research / Contents / Answers document file uploads in current official docs. **Attachment UI is intentionally omitted.**
2. **Research effort tiers** — Official API also offers `lite` / `standard` / `deep`. This app only exposes **Frontier** and **Exhaustive** per product spec.
3. **SSE progress stream** — `GET /v1/research/{task_id}/stream` exists; the console relies on poll + backend SSE to the browser. Optional You.com SSE can be added later for incremental partials; final content always comes from the poll result.
4. **Answers Markdown** — The Answer API returns JSON (`answer`, `citations`, `results`). We persist full raw JSON on the request record and write the `.md` file as the `answer` string alone (byte-faithful to that field). Citations are not appended to the file.
5. **Finance Research / Web Search** — Out of scope (not in the four-mode product surface).

## Architecture

- `public/` — SPA (HTML/CSS/vanilla JS; `marked` from CDN for Rendered view)
- `server/` — Express: key, settings, state, You.com client, poller, atomic saver, orchestrator, REST + SSE
- Browser talks **only** to this backend. Keys are redacted from logs and error bodies.

### Backend routes (summary)

- `GET|POST|DELETE /api/key`
- `GET|PUT /api/settings`
- `GET /api/state` · `GET /api/events` (SSE)
- `GET|POST /api/threads` · `PATCH|DELETE /api/threads/:id` · `POST …/activate`
- `POST /api/submit`
- `POST /api/tracking/:requestId/stop|resume`
- `POST /api/save-again/:requestId`
- `GET /api/logs`
- `POST /api/open-path`

## State words (exact)

`DRAFT` · `SUBMITTING` · `SUBMITTED` · `RESEARCHING` · `RECEIVING` · `RECEIVED` · `SAVING` · `SAVED · VERIFIED` · `RECEIVED · SAVE FAILED` · `FAILED` · `TRACKING PAUSED`

## License

Private / local utility. You.com API usage is subject to You.com’s terms and billing.
