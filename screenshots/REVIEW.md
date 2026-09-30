# Visual Definition-of-Done — REVIEW

Preview: http://127.0.0.1:3847  
Captured on box desktop (ScreenshotOne/SnapRender cannot reach localhost).

## Required set

| # | View | File | Result |
| --- | --- | --- | --- |
| 1 | Empty / shell + completed report | `01-saved-verified-report.webp` | Pass — ROG palette, bracket headers, teal SAVED · VERIFIED (pixel-checked), blue path |
| 2 | Log drawer open | `02-report-log-open.webp` | Pass |
| 3 | TRACKING PAUSED + Resume Tracking | `03-tracking-paused.webp` | Pass |
| 4 | RECEIVED · SAVE FAILED + Save Again | `04-save-failed.webp` | Pass — maroon error EACCES, Save Again visible |
| 5 | FAILED error block | `05-failed.webp` | Pass — Payment Required demo message |
| 6 | Narrow ~720px, ☰ drawer | `06-narrow-hamburger.webp` | Pass after fix (breakpoint 960px) |
| — | Composer 4 modes / Raw / Settings | Exercised live | Pass functionally (Contents URL field; Settings KEY/DIR/NOTIFS) |

## Fixes during visual pass
- Test isolation via `YDC_DATA_DIR` (no live `data/` pollution)
- Readout values right-aligned; expandable JOB ID
- Narrow sidebar drawer: breakpoint 960px, visibility+transform, close on thread select, `styles.css?v=2`

## Gaps (documented, not blockers)
- No file-upload UI (APIs don't document uploads)
- You.com SSE partials not streamed into reader
- Mid-run live ELAPSED countdown not screenshot with active poll (paused seed shows — for timers)
- Notification permission was DENIED in this browser session
