# Code Deletion Log

## 2026-11-09 Refactor Session

### Unused Files Deleted
- `dashboard/app/components/ui/StatCard.tsx` — never imported since the initial dashboard commit; removed its `index.ts` re-export too.

### Dead Exports / Values Removed
- `dashboard/app/lib/ingest.ts` — `RTSP_PORT` (no references).
- `dashboard/app/lib/jstChat.ts` — `JstChatScene` type (no references).
- `dashboard/app/lib/twitchClipsPlayer.ts` — `TwitchClipsScene` type (no references).
- `scripts/constants.py` — `SRTLA_METRICS_PORT` (no references; the port is hardcoded in `scripts/templates/oink-srtla.service`).

### Duplicate Consolidated
- `dashboard/app/lib/jstChat.ts` — removed `DEFAULT_JST_CHAT_OPTIONS` alias; kept the exported `DEFAULT_JST_CHAT_CONFIG`.

### Exports Narrowed (used only inside their own module)
- Removed `export` from internal-only types/constants in `dashboard/app/lib/{api,auth,ingest,irlServerPlayer,jstChat,twitchClipsPlayer,useIngestControls,useNoalbs,useStatusUpdate,useWebSocket}.ts`, `dashboard/app/utils/theme.ts`, and the UI/island components.

### Not Removed
- `dashboard/e2e-server.mjs` — knip flags it, but `playwright.config.ts` launches it.
- `scripts/templates/scenes.py` — deliberate self-contained mirror of `scripts/obs_ws.py` for host deployment.
- `stack/*.js` internal-only exports — used within their own modules; left exported to avoid churn.

### Verification
- `dashboard`: `npm test` (382 passed), `npm run typecheck`, `npm run build` — all pass.
- `pytest` — 197 passed.
- `ruff check` — no new errors.
- `knip` (dashboard) — clean apart from the `e2e-server.mjs` false positive.
