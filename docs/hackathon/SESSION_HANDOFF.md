# Session handoff — ercot-mcp / Issue Router (Base Power & AITX Talent Hackathon)

Temporary context-transfer file for a new Claude Code session. Delete once no longer needed —
this is not part of the project deliverable itself.

## Hackathon context

- **Base Power & AITX Talent Hackathon**, Sep 25–27 2026, Base Power HQ, Austin TX. Base engineers judge; Base is hiring off what gets built.
- Three tracks, **a project may enter up to 2**:
  - Track 1 — Open Grid Data (ERCOT public data)
  - Track 2 — Orchestration ("coordinates many independent things... how it holds up when pieces fail")
  - Track 3 — Most Commercializable
- **Decision made: enter Track 1 + Track 2.**
- Judging: Technical Execution & Completeness (30), Fit to Track (30), Value & Impact (20), Innovation & Execution (20). Judged off a 5-min demo video + codebase, not slides.
- Repo: `/Users/mariacruz/base-hackathon`, pushed to `github.com/maria0406/base-hackathon`.
- `.env` in the repo has **real, working ERCOT Public API credentials** (confirmed live). Base project is an MCP server (`ercot-mcp`) exposing ERCOT data as tools (`list_products`, `get_product`, `get_report_data`, `get_archive`, `raw_get`) — see `README.md` / `COLLABORATOR_GUIDE.md`.

## The product: "Issue Router"

**Philosophy** (important, established after correcting an earlier overclaim): visibility first, paging only when context genuinely calls for it — not "alarm on everything." Architecture: **Detect → Classify → (attempt auto-fix) → Route → Page**, built as independent detector agents feeding one shared ticket feed/router.

### Three signals, all implemented in one live local dashboard (`src/dashboard-server.ts`, run via `npm run dashboard`, serves `http://localhost:4173`, polls every 20s):

**1. Curtailment Radar (Signal 02)** — real-time, built and live
- Data: `NP4-733-CD` (wind actual GEN/HSL, confirmed fields `genSystemWide`/`HSLSystemWide`) + `NP6-905-CD` (RTM price)
- Formula: `curtailmentRatio = (HSL−GEN)/HSL`; elevated if >1.25× trailing baseline (demo simplification of a real 30-day-percentile design); classifies **OVERSUPPLY** (price also depressed) vs **CONGESTION** (price normal/high) vs NORMAL
- Real traced example (2026-09-25 18:35 CT): 5.96% curtailment vs 4.03% baseline, but HB_WEST price was the day's *high* ($71.46) → correctly classified CONGESTION, not oversupply — demonstrates the dual-condition rule avoiding a bad trading inference
- Routes to **"Market Operations Engineer"** — a REAL Base Power job title, confirmed via 3 independent postings (Built In Austin, MCJ Job Board, Dreamwork)
- "Layer 2" (designed, NOT built): true forward prediction using real confirmed ERCOT forecast products — `NP4-751-CD` (5-min, 2h-ahead wind forecast by region), `NP4-732-CD` (hourly, 7-day-ahead STWPF/WGRPP), `NP3-562-CD` (load forecast). Honestly scoped: would only catch *system-wide* oversupply, NOT the node-level congestion event actually traced above.
- **Honest positioning**: forecast-vs-actual curtailment prediction is NOT novel — Tesla Autobidder and Fluence Mosaic already do this at utility scale (real cited sources: CTO Magazine on Autobidder, Fluence Mosaic product page, World Climate Service's ERCOT curtailment-forecast writeup). Our differentiator is claimed as **accessibility at residential/small-battery scale via free public data**, not technique novelty. (We got this wrong once — originally claimed "batteries are reactive" as fact without checking — corrected after research. Keep this pattern: verify novelty claims before making them.)

**2. DAM–RTM Deviation (Signal 01)** — real-time, built and live
- Data: `NP4-190-CD` (day-ahead price, posted once/day) vs `NP6-905-CD` (real-time price, 15-min)
- Real 30-day backtest (Aug 27–Sep 25, HB_HOUSTON, 2,869 intervals): mean spread $9.95/MWh, worst-decile mean $49.41/MWh, max $314.56/MWh, 19/2,869 extreme intervals. **Zero negative-price intervals in that window** — an honest finding, not every window shows curtailment.
- $ estimates (real spread × estimated capture assumptions, explicitly split): ~$13k–21.6k/MWh/year of exposure; Base's real 39.2 kWh home battery (cited: Solar Power World) ~$400–600/yr; 1 MWh commercial ~$15k–22k/yr.

**3. Fleet Health / "Telemetry CI/CD" (Signal 03)** — MOCKED telemetry, cross-checked against real ERCOT signals
- **Motivating pain point, from an actual Base engineer at the hackathon**: an inverter can blow and Base doesn't know until telemetry happens to flag it — then a technician is dispatched to physically retrieve the unit and investigate blind, even when the fix would've been a simple remote reset.
- Mocked 10-unit fleet (`INV-1000`..`1009`) with simulated temp/efficiency/fault-code drift. Triage: `AUTO_FIXABLE` (soft faults → simulated remote reset, no dispatch), `SCHEDULE_MAINTENANCE` (degrading efficiency → proactive pre-diagnosed visit before hard failure), `DISPATCH_NOW` (hard inverter fault → technician dispatched WITH pre-loaded trend history, not blind), `SUPPRESSED_BY_ERCOT_CONTEXT` (unit idle during a REAL Curtailment Radar OVERSUPPLY window → explained by real market conditions, no false ticket).
- Real ERCOT ties: (a) false-positive suppression via the real live Curtailment Radar classification, (b) a "cycling stress multiplier" derived from the REAL DAM–RTM `baselineAbsDeviation` — more real market volatility this week → assumed harder cycling → faster simulated wear (explicitly flagged as an unvalidated heuristic, not proven against real failure data).
- Profit framing: dispatches avoided × **$200–$1,000 per truck roll** (Aberdeen Group ~$200–300 direct cost, TSIA ~$1,000 fully loaded — real industry-estimate figures repeated across vendor/trade sources, explicitly caveated as **not a single verified primary study**).
- **Roadmap (not built)**: real Base telemetry would let the router (1) verify whether the fleet actually acted on a fired trading signal, (2) route hardware vs. market issues to *different* teams — today everything routes to Market Operations Engineer because public ERCOT data alone can't tell hardware problems from market ones, (3) use each unit's real settlement point instead of a hub-level proxy, (4) attribute real dollars to Base's actual fleet size/SoC instead of a generic per-MWh multiplier.

## Established values for this project (carry forward — don't relitigate)

- Every claim is either (a) real and verified via a live ERCOT API call or a cited source, or (b) explicitly labeled ESTIMATED / ASSUMED / MOCKED. Never blend the two without a visible tag.
- Verify novelty claims against real competitors before making them (we got burned once on this).
- Use real EMIL IDs and field names confirmed via live API calls — never guess them.
- Look up real benchmark numbers (e.g., truck-roll cost) rather than inventing round figures; cite sources and note when a number is a repeated industry estimate rather than a primary study.
- Prefer "here's what's built vs. roadmap" framing over hype.

## Artifacts published so far (Claude Artifacts — private by default, need a Share click before sending links externally)

- **Curtailment Radar**: https://claude.ai/artifact/NP7Uvc1XSsTVFZeRT1zQ9a
- **Issue Router**: https://claude.ai/artifact/VmwZV4Sajzu3xzra37T23i (includes the telemetry-integration roadmap section)
- **Router Trace** (a worked-example walkthrough of the real Sep 25 congestion event, drafted locally but **never actually published as an Artifact** — still pending, file was at a scratch path in the old session, would need to be rewritten)
- No dedicated artifact yet for DAM–RTM Deviation as its own page (numbers currently live inside Issue Router's proof-of-concept section and the dashboard).

## Notion

- A Notion connector was just approved in claude.ai (workspace: "The University of Texas at Austin") — should be usable as an MCP tool in a **new** session (the prior session had it connected mid-session, too late for its own tool list).

## What's being asked right now

Build a **design document for the whole Issue Router project**, to live in **Notion**. Process requested: go step by step — first agree on the high-level goal framing, then structure, then fill in content. A draft high-level goal statement (not yet explicitly confirmed by the user) was:

> Base's engineers and traders have three blind spots that all present the same way — something's wrong, nobody notices until it's costly: (1) missed profitable market windows because nobody's watching ERCOT's public data in real time, (2) telemetry issues escalate into full technician dispatches with no automated triage step, (3) alerts aren't routed to the specific team that owns them. Issue Router solves all three with one architecture: independent detector agents that watch real ERCOT data (plus a mocked telemetry feed standing in for Base's real fleet data), classify what's happening, attempt an automated fix first where one exists, and only escalate to a human — routed to the right team — when the situation genuinely needs judgment.

Confirm/refine that framing with the user first, then build the design doc (goal, architecture, the three signals, real-vs-mocked data table, track fit, honest positioning, roadmap) directly in their Notion workspace via the new Notion MCP tools.
