Before starting, read ../HACKATHON.md and skim ../base-hackathon-research/ (plus ../base-hackathon-ideas.md).

# base-hackathon: ercot-mcp + Issue Router

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit this one.

## Idea and pitch
**Issue Router:** independent detector agents watch live ERCOT public data, plus a mocked fleet-telemetry feed standing in for Base's real data. Each one classifies what's happening, attempts an automated fix where one exists, and escalates to a human, routed to the owning team, only when judgment is needed. Philosophy: visibility first, page only when context calls for it. The foundation is `ercot-mcp`, an MCP server that exposes the ERCOT Public API as LLM tools.
*(The one-line goal framing in `SESSION_HANDOFF.md` was drafted but never explicitly confirmed. Treat the wording above as a working pitch.)*

Tracks: **1 Open Grid Data + 2 Orchestration** (decided).

## Stack
TypeScript (ES modules) on Node · `@modelcontextprotocol/sdk` · `zod` · `dotenv` · plain `node:http` for the dashboard (no framework) · `tsc` build to `dist/` (gitignored). No tests yet.

## Repo structure
```
src/index.ts             MCP server (stdio): list_products, get_product, get_report_data, get_archive, raw_get
src/ercot-client.ts      ERCOT auth (username/password → 1-h ID token, cached) + authenticated GET
src/dashboard-server.ts  Issue Router dashboard + /api/status, http://localhost:4173, polls every 20 s
README.md                setup: ERCOT key registration, .env, MCP config
COLLABORATOR_GUIDE.md    teammate setup (each person needs their own ERCOT key)
SESSION_HANDOFF.md       temporary context dump from a prior session (signals, numbers, sources). Read for detail; delete when obsolete
.env                     real ERCOT credentials. Gitignored. Never print or commit
```
Commands: `npm install` · `npm run build` · `npm start` (MCP server) · `npm run dashboard` (build + serve dashboard).

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
- **Out of scope for now:** real Base telemetry (we don't have it) · "Layer 2" forward prediction (NP4-751, NP4-732, NP3-562): designed, not built · node-level congestion prediction · routing hardware vs market issues to different teams (needs real telemetry).

## Status
**Works**
- ercot-mcp server with 5 tools against the live ERCOT Public API.
- Dashboard: signals 01 and 02 on live data; signal 03 on mocked telemetry, including ERCOT-context suppression of false tickets.
- Published artifacts (private): Curtailment Radar https://claude.ai/artifact/NP7Uvc1XSsTVFZeRT1zQ9a · Issue Router https://claude.ai/artifact/VmwZV4Sajzu3xzra37T23i

**In progress**
- Issue Router design doc in Notion (goal framing → structure → content). Not started as of the handoff.
- "Router Trace" walkthrough of the real Sep 25 18:35 CT congestion event: drafted, never published.

**Next steps** (proposed, confirm with the team)
- Confirm the pitch framing, then record the 5-min demo video before the **Sun 11:00 AM** deadline.
- Restore `.env.example`. Its deletion is uncommitted, and README / COLLABORATOR_GUIDE both tell people to `cp .env.example .env`.
- Consider folding Megan's Field RCA design (Notion, linked in HACKATHON.md) into signal 03. It targets the same pain: inverter failures leading to blind truck rolls.
- Add at least a smoke test so "completes its core workflow without crashing" (15 pts) is demonstrable.

## Rules for agents
- Never print, log or commit `.env` values.
- Confirm ERCOT EMIL IDs and field names with a live call before using them.
- Claude Code works on `main`. Codex works on a branch or worktree. Gemini reads and reports.
- After a real decision or a finished chunk of work, update **Decisions** / **Status** above.
