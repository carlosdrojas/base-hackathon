# ARCA — Automatic Root Cause Analysis

**One-liner:** ARCA turns real fleet telemetry into diagnosed, actionable cases — automatically classifying faults, proposing a fix plan gated by a safety-first permission ladder, and routing real work to the right human, instead of paging someone for every anomaly.

**The problem:** Distributed battery/inverter fleets generate constant low-signal noise. Today, every fault either gets a blind truck roll (expensive, slow) or gets ignored until it's serious (risky). Neither scales as fleets grow.

## What we built

A real, working root-cause-analysis pipeline, not a mockup:

1. **Real telemetry → real detection.** Deterministic detectors classify each faulted unit into one of a closed set of root causes (thermal event, firmware mismatch, install/wiring error, hardware defect, etc.) directly from packet-level data — no black box.
2. **Real diagnosis.** A Task-1 hypothesis is generated per unit, tagged by its actual source (deterministic detector output today; automatically upgrades to a live LLM call the moment a model API key is configured — same code path, no rework needed).
3. **Gated gameplan.** A planner proposes the cheapest safe fix; a policy gate enforces who's allowed to approve what — a thermal or unknown-cause case is *automatically* clamped to no remote actuation, full stop, before a human ever sees it.
4. **Real human-in-the-loop action.** Staff approve or reject each step; approving a dispatch step schedules a real visit with a real assignee, a generated safety/commissioning checklist, and a photo requirement where the diagnosis calls for it.
5. **Full audit trail.** Every diagnosis, approval, rejection, and outcome is logged to a real case timeline, closed out by an engineer.

**Two views over one honest fleet:** Austin-only and statewide-Texas views over the same real inverter data (no synthetic filler units mixed in) — staff see the fleet-wide picture, technicians see a scoped, role-gated queue of only what's assigned to them, with a guided first-visit walkthrough.

**What's real vs. simulated, stated plainly:** every detector, hypothesis, and policy decision runs against real telemetry data. The one thing that's necessarily simulated is device *actuation* — there's no live hardware to send a real reboot/OTA command to in a hackathon setting, so action outcomes are modeled, not faked as real. That line is never blurred in the product.

**Stack:** TypeScript, zero-framework Node `http` server, no ORM — deterministic detectors and policy logic you can read top to bottom, backed by a real test suite (147 tests).

**Track fit:** Orchestration (Track 2) — detect → diagnose → gate → approve → act → audit, as one real pipeline. Grid-data grounding (Track 1) comes from `ercot-mcp`, a standalone MCP server exposing live ERCOT public market data as LLM tools.

## Run it (for judges)

No ERCOT credentials or API keys are required to run or evaluate ARCA itself — that setup (below) is only for the separate `ercot-mcp` grid-data tool.

```bash
git clone https://github.com/maria0406/base-hackathon.git
cd base-hackathon
npm install
npm run dashboard
```

Open **http://localhost:4173** and log in as either:

- `staffAustin` / `basehq2026` — full staff view: fleet dashboard, case detail, approve/reject/close actions, Austin/All Texas toggle
- `tech` / `basehq2026` — technician view: scoped case queue, assigned visits, completed cases, guided tour

Try the flow end to end: open a case from the fleet table → review the real diagnosis and evidence → Approve a dispatch step → log out and back in as `tech` to see the resulting visit, complete it, and watch the case close.

Run the test suite: `npm test` (147 tests, `src/response/*`, `src/sim/*`).

Optional — enable live LLM diagnosis instead of the deterministic detector path: add `XAI_API_KEY` to a `.env` file (copy `.env.example`). Optional — enable Claude as the fix planner instead of the fixed playbook: add `ANTHROPIC_API_KEY` to `.env`.

*(The ERCOT Public API setup below is for `ercot-mcp`, our Track 1 grid-data MCP server — a separate deliverable from ARCA, not required to run the ARCA demo above.)*
