# You.com Research Console

Local single-page app (Ubuntu/Debian GNOME) that drives the You.com **Research** (Frontier & Exhaustive), **Contents**, and **Answers** APIs and saves every result as Markdown to a directory you choose.

**Interface quality and truthful state are the primary deliverable.** The backend exists to make the UI honest.

## Requirements

- **Node.js 20+** (tested on Node 20)
- Linux recommended (`xdg-open` for Open folder)

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

## Install as a desktop app

```bash
git clone https://github.com/itstanner5216/YouSearchConsole.git ~/.local/opt/YouSearchConsole
cd ~/.local/opt/YouSearchConsole
npm ci --omit=dev
scripts/install-desktop.sh      # adds "You Research Console" to the app menu and `you-research` to ~/.local/bin
```

Launching opens the console in its own window (Chrome, Chromium, Brave or Edge in app mode; otherwise the default browser). The launcher starts the server if it isn't already running and reuses it if it is. The server shuts itself down about 10 seconds after the last window closes, so a reload doesn't stop it. If research is still running then, it waits until the report is saved to the output directory (or the request's time limit passes) before exiting. Installed launches start with no sample report.

- `YDC_PORT`: port to use (default 3847)
- `YDC_BROWSER`: browser command to use for the window
- Server log: `~/.local/state/you-research-console/server.log`
- Update: `git pull && npm ci --omit=dev`. Your key and data are untracked, so pulling doesn't touch them.
- Remove from the menu: `scripts/install-desktop.sh --uninstall`

## Configuration

| Item | Location |
| --- | --- |
| API key | `.env` → `YDC_API_KEY=…` (created/updated/deleted from **Settings**; never sent to the browser) |
| Other providers' keys | same `.env`: `TAVILY_API_KEY`, `EXA_API_KEY`, `TINYFISH_API_KEY`, `JINA_API_KEY`, `KEENABLE_API_KEY` (set with `POST /api/providers/:id/key`) |
| Example env | `.env.example` |
| Preferences | `data/settings.json` (output directory, notification preference) |
| Threads / jobs / logs | `data/state.json` (survives restart) |
| Demo output (seeded) | `data/output/` |

When started with `npm start` on empty state, a sample **SAVED · VERIFIED** Frontier report is seeded so you can screenshot the reader without a live key. The desktop launcher sets `YDC_DEMO=0`, so installed launches skip it.

### Settings UI

1. **API KEY** — Save/Replace or Delete. UI only sees `KEY SAVED` / `NO KEY`.
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
| 6–15 min | 30 s |

A job sent to You.com can't be stopped, so tracking never pauses: it keeps polling until You.com answers, then saves the report. Closing the window doesn't stop it, and a restarted server picks up every job still in flight. At **15 minutes** the app makes one last check; if the report still isn't there, the request is marked `FAILED` and tracking ends.

Filenames (local time at write): `MM-DD:HHMM.SS.md` or `MM-DD:HHMM.SS-01.md`; another provider's report carries its id (`MM-DD:HHMM.SS-tavily.md`). A second report in the same second gets `_2` rather than replacing the first.

### Research providers (backend only; not yet in the UI)

One prompt can go to every provider with a saved key, a chosen group, or one. Each provider's run is its own request in the thread, tracked and saved on its own; runs sent together share a `batchId`. Each provider offers at most two options; everything else is fixed.

| Provider | Options (default first) | How it runs | Limit |
| --- | --- | --- | --- |
| You.com | `frontier`, `exhaustive` | job, polled | 15 min |
| Tavily | `pro`, `mini` | streamed (`POST /research`, `stream: true`) | 15 min |
| Exa | `high`, `xhigh` | job, polled (`/agent/runs`) | 15 min |
| TinyFish | `deep`, `standard` | job, polled; prompt ≤ 2,000 chars | 20 min deep, 15 standard |
| Jina | `high`, `medium` | streamed (DeepSearch); thinking is dropped | 15 min |
| Keenable | `search` | one search, saved as a list of results | — |

Polled jobs resume after a restart. A streamed run can't: if the app stops mid-stream, that request becomes `FAILED`. A provider's sources are listed under `## Sources` when its report doesn't already link them.

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
- `GET /api/providers` (options, limits, key presence) · `POST|DELETE /api/providers/:id/key`
- `POST /api/research` `{ threadId, input, providers }`: `providers` is `"all"` (or omitted), or a list like `["tavily", "exa:xhigh", { "provider": "you", "level": "exhaustive" }]`
- `POST /api/save-again/:requestId`
- `GET /api/logs`
- `POST /api/open-path`

## State words (exact)

`DRAFT` · `SUBMITTING` · `SUBMITTED` · `RESEARCHING` · `RECEIVING` · `RECEIVED` · `SAVING` · `SAVED · VERIFIED` · `RECEIVED · SAVE FAILED` · `FAILED`

## License

Private / local utility. You.com API usage is subject to You.com’s terms and billing.
