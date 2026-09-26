Before starting, read ../HACKATHON.md and skim ../base-hackathon-research/ (plus ../base-hackathon-ideas.md).
For Field RCA work, also read `ProjectContext.md` (Megan's Notion index, which is the source of truth for that product).

# base-hackathon: ercot-mcp + Issue Router

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit this one.

## Idea and pitch
**Issue Router:** independent detector agents watch live ERCOT public data, plus a mocked fleet-telemetry feed standing in for Base's real data. Each one classifies what's happening, attempts an automated fix where one exists, and escalates to a human, routed to the owning team, only when judgment is needed. Philosophy: visibility first, page only when context calls for it. The foundation is `ercot-mcp`, an MCP server that exposes the ERCOT Public API as LLM tools.
*(The one-line goal framing in `SESSION_HANDOFF.md` was drafted but never explicitly confirmed. Treat the wording above as a working pitch.)*

**Field RCA / auto-triage** (Megan, Sep 26): AI-assisted root-cause triage for faulted Cores and inverters, behind the L0–L4 permission ladder. Pipeline: fleet CSV → map → RCA ticket + telemetry packet → triage agent (root cause, then gameplan + level) → dashboard. See `ProjectContext.md`. It overlaps with signal 03 below.
*(Open: is Field RCA now the headline product, with Issue Router as the ERCOT-context layer, or are they two submissions? Not decided in the repo.)*

Tracks: **1 Open Grid Data + 2 Orchestration** (decided for Issue Router).

## Stack
TypeScript (ES modules) on Node · `@modelcontextprotocol/sdk` · `zod` · `dotenv` · plain `node:http` for the dashboard (no framework) · `tsc` build to `dist/` (gitignored). No tests yet.

## Repo structure
```
src/index.ts             MCP server (stdio): list_products, get_product, get_report_data, get_archive, raw_get
src/ercot-client.ts      ERCOT auth (username/password → 1-h ID token, cached) + authenticated GET
src/dashboard-server.ts  Issue Router dashboard + /api/status, /fleet, /case, http://localhost:4173, polls every 20 s
src/pages/               Field RCA UI ported from the artifact mockups: fleet-dashboard.ts (/fleet), case-workspace.ts (/case). Static data for now
src/mock-telemetry/      core-fleet-telemetry.json: 8 mock Cores bounded by real specs from Base's owner's manual (see its README). Not wired in yet
public/base_logo.png     served at /base_logo.png
ProjectContext.md        Field RCA source-of-truth index (Notion links, hard constraints, pipeline)
docs/field-rca/          local copies of Notion 'Software features' (roles, permissions, feature set) and 'Software structure' (pipeline, CSV contract, Telemetry→Events detectors + Event schema). Read before building the RCA engine
docs/field-rca/response-agent.md  Response Agent + Fake Fleet design (Carlos): action catalog, policy gate, sim behavior, /response page. Contracts in src/response/types.ts, seed in data/sim-fleet.seed.json
README.md                setup: ERCOT key registration, .env, MCP config
COLLABORATOR_GUIDE.md    teammate setup (each person needs their own ERCOT key)
SESSION_HANDOFF.md       temporary context dump from a prior session (signals, numbers, sources). Read for detail; delete when obsolete
.env                     real ERCOT credentials. Gitignored. Never print or commit
```
Commands: `npm install` · `npm run build` · `npm start` (MCP server) · `npm run dashboard` (build + serve dashboard) · `npm test` (tsc + node:test on dist/**/*.test.js).

## Signals (details and real numbers in SESSION_HANDOFF.md)
| Signal | Data | Status |
|---|---|---|
| 01 DAM–RTM Deviation | NP4-190-CD vs NP6-905-CD | live, real data |
| 02 Curtailment Radar | NP4-733-CD (wind GEN/HSL) + NP6-905-CD; classifies OVERSUPPLY vs CONGESTION vs NORMAL | live, real data (1.25× trailing baseline is a demo simplification) |
| 03 Fleet Health / Telemetry CI/CD | mocked 10-unit fleet (INV-1000..1009), cross-checked against signals 01/02 | **MOCKED** telemetry |

## Decisions
- Enter Tracks 1 + 2.
- Architecture: Detect → Classify → attempt auto-fix → Route → Page, with independent detectors feeding one shared ticket feed.
- Market signals route to "Market Operations Engineer", a real Base job title (3 postings).
- Claimed differentiator: accessibility at residential/small-battery scale on free public data. Not technique novelty; Tesla Autobidder and Fluence Mosaic already forecast curtailment.
- Every number is either real (live call or cited source) or tagged ESTIMATED / ASSUMED / MOCKED. Truck-roll cost of $200–1,000 is an industry estimate, not a primary study.
- Field RCA technician app (design doc §8.2) is **out of scope for the demo** (Megan, Sep 26). Base's real "Base Site Visit" installer app is login-only with no API, and a disconnected mock wouldn't meet the "works end to end" bar.
- **Out of scope for now:** real Base telemetry (we don't have it) · "Layer 2" forward prediction (NP4-751, NP4-732, NP3-562): designed, not built · node-level congestion prediction · routing hardware vs market issues to different teams (needs real telemetry).

## Status  (updated Sep 26 after Maria's + Megan's commits; build passes)
**Works**
- ercot-mcp server with 5 tools against the live ERCOT Public API.
- Dashboard: signals 01 and 02 on live data; signal 03 on mocked telemetry, including ERCOT-context suppression of false tickets.
- Field RCA UI pages at `/fleet` and `/case` (static, hardcoded values; severity filter works).
- Real-spec mock Core telemetry file (8 units, provenance-tagged).
- Published artifacts (private): Curtailment Radar https://claude.ai/artifact/NP7Uvc1XSsTVFZeRT1zQ9a · Issue Router https://claude.ai/artifact/VmwZV4Sajzu3xzra37T23i

**In progress / not built**
- Field RCA pipeline itself: CSV ingest, map, auto-created RCA tickets, model triage, live status updates. UI exists. Step 1 deterministic detectors are in `src/field-rca/detectors/` (`runDetectors`); the model agent is still unwired.
- `core-fleet-telemetry.json` → `/case` and `/fleet` wiring.
- "Router Trace" walkthrough of the Sep 25 18:35 CT congestion event: drafted, never published.

**Known conflicts to resolve**
- Per Base's manual, every Core BMS protective fault fires an **irreversible pyro fuse**. Signal 03's `AUTO_FIXABLE → remote reset` must not apply to Core BMS faults, only to soft or inverter-side faults. The "~90% are fine" claim is about **inverters**, and the manual covers Cores only.
- Signal 03 (Issue Router) and Field RCA triage are two versions of the same idea. Pick one model and taxonomy.

**Next steps** (proposed, confirm with the team)
- Decide the headline product and track(s), then freeze scope. Deadline **Sun 11:00 AM**.
- Build the Field RCA engine end to end on the mock data: ingest → detectors → agent → policy gate → case events → UI.
- Restore `.env.example`. Its deletion is uncommitted, and README / COLLABORATOR_GUIDE both tell people to `cp .env.example .env`.
- Add a smoke test so "completes its core workflow without crashing" (15 pts) is demonstrable.
- Record the 5-min demo video.

## Rules for agents
- Never print, log or commit `.env` values.
- Confirm ERCOT EMIL IDs and field names with a live call before using them.
- Claude Code works on `main`. Codex works on a branch or worktree. Gemini reads and reports.
- After a real decision or a finished chunk of work, update **Decisions** / **Status** above.
