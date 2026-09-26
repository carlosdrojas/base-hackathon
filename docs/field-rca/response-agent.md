# Response Agent + Fake Fleet — design (source of truth)

Owner: Carlos. Status: design approved for build 2026-09-26. Part of the Field RCA product
(see `software-features.md`, `software-structure.md`, and `ProjectContext.md` for the parent design).

This doc is self-contained. A fresh session should be able to build its piece from this doc,
`src/response/types.ts`, and `data/sim-fleet.seed.json` alone. **Do not edit `types.ts` or the seed
in a parallel branch.** If something is missing, add it in your own file and flag it in your final
message; it gets reconciled at integration.

---

## 1. What this piece does

A faulted inverter's RCA ticket arrives with a diagnosis. The **response agent** turns it into a
plan built from a fixed action list, cheapest and safest first. A **policy gate** (plain code) decides
whether each step can run, needs approval, and whose. People approve or reject with **real buttons**
on the `/response` page. The **runner** sends approved actions to the **fake fleet**. The **verifier**
re-reads device status to confirm the fault actually cleared: if yes, the case goes to an engineer to
close; if not, the next step runs or the case escalates. Physical work is **scheduled** to a named tech
with a slot, a brief, and a checklist. When several units on one firmware version fail the same way,
the agent writes an **engineer bug report**. Every step lands on the case timeline.

North star: **don't pull a healthy inverter.** Try the cheap, safe fix, prove whether it worked, and
only roll a truck when needed.

### Owned here vs elsewhere

| Owned by this piece | Owned by teammates (do not build) |
|---|---|
| Fake fleet: device state + behavior (`apply`, `techVisit`) | **Telemetry output**: fleet CSV export, FW log + CAN packet rendering (`TelemetryRenderer` in types.ts is the hook) |
| Response engine: planner, gate, runner, verifier, scheduler, bug reports, case store | Event detectors, Task 1 diagnosis (we stub it) |
| `/response` page + its API routes | `/fleet`, `/case`, map, Issue Router signals |

## 2. Decisions (do not change)

1. **The AI never writes, patches, or generates firmware.** OTA only to a version on the allow-list (`fw_allowlist` in the seed). Why: locked product decision in `software-features.md`; Base engineers own safety-critical firmware.
2. **Only an engineer can approve an OTA.** Not ops, not a technician, not the AI.
3. **Safety (L0) cases get no remote actuation.** No reboot, no OTA, "no try one more thing." Read-only queries are allowed. The sim *also* refuses (defense in depth).
4. **The planner cannot invent actions.** Its tool schema only allows the catalog in §5. The engine re-derives level and approval from the catalog and ignores whatever the model says about them.
5. **The gate is deterministic code, not the model.** It is the thing we point at in the demo.
6. **Technicians approve nothing.** They complete or mark visits incomplete. **Admin does not bypass safety** and cannot approve actions.
7. **Only an engineer closes a case.**
8. **Bias to keep units in the field.** `hq_recovery` is never the first step unless the case is L0 or hardware was confirmed on site.
9. **Everything is MOCKED** and labeled as such in the UI. No Base production APIs.
10. **Diagnosis is a stub** until Task 1 exists. The stub reads the sim's true fault, except where the seed plants a misdiagnosis.

## 3. Architecture

```
            ┌─────────────── FAKE FLEET (src/sim/) ───────────────┐
            │ UnitState per inverter (truth, incl. hidden fault)    │
            │ apply(action) / techVisit() mutate state              │
            │ getStatus() = what the device reports (observable)    │
            └──────▲──────────────────────────┬────────────────────┘
                   │ FleetGateway             │ list()/getStatus()
                   │                          ▼
 ┌──────────── RESPONSE ENGINE (src/response/) ─────────────────────────────┐
 │ ingestFaults: faulted & no open case → RcaCase → HypothesisSource (stub)  │
 │   → planner (Claude tool-use | playbook) → gameplan → gate each step      │
 │ tick: run allowed steps → runner → FleetGateway.apply → verifier          │
 │   pass → "Engineer review"   fail → next step / escalate / re-plan        │
 │ dispatch_tech/hq_recovery → scheduler → ScheduledVisit                    │
 │ bug-report: ≥3 cases same (fw_version, root_cause) → BugReport            │
 │ case-store: RcaCase + CaseEvent timeline, persisted to data/runtime/      │
 └───────────────────────────────▲──────────────────────────────────────────┘
                                 │ ResponseEngine interface
              routes.ts (/api/response/*, /api/sim/*) ◄──── response-page.ts (/response)
```

Later, the telemetry teammate's `TelemetryRenderer` reads `getUnitState()` to produce the CSV and
packets for the event detectors, and Task 1 replaces the hypothesis stub. Neither is needed for this
piece to work end to end.

## 4. Fake fleet behavior

### Data
- Seed: `data/sim-fleet.seed.json` (committed, read-only). Runtime copy: `data/runtime/sim-fleet.json` (gitignored). `reset()` copies seed → runtime.
- Seed also holds: `fw_allowlist`, `misdiagnose`, `users`, `tech_roster`, `drivers`.

### Fault codes (MOCKED, invented for the demo, not Base's real codes)

| True fault | `active_fault_codes` |
|---|---|
| `fw_soft_fault_reboot_candidate` | `INV-F101 WDT_RESET_LOOP` |
| `fw_version_mismatch` | `INV-F120 FW_COMPAT` |
| `can_link_unreliable` | `INV-F210 CAN_COMM_LOSS` |
| `install_commissioning_incomplete` | `INV-F310 COMMISSIONING` |
| `install_wiring_or_sense_error` | `INV-F320 CT_SENSE` |
| `grid_or_home_side_condition` | `INV-F410 GRID_OOR` |
| `thermal_or_safety_event` | `INV-F900 OVERTEMP` |
| `true_hardware_defect` | `INV-F510 POWER_STAGE` |
| `no_fault_found` | `INV-F050 TRANSIENT` (latched, no underlying problem) |

`faulted = fault !== null`. Healthy units report no codes.

### Response table (the contract the sim implements and the tests check)

| True fault ↓ / action → | `reboot` | `ota_to_allowlisted` | `monitor` | read-only (`request_log_dump`, `can_health_query`) | tech visit (completed) | `hq_recovery` |
|---|---|---|---|---|---|---|
| `fw_soft_fault_reboot_candidate` | **cleared** | **cleared** | no_change | info_only | **cleared** (tech power-cycles) | replaced *(unnecessary pull)* |
| `fw_version_mismatch` | no_change (fault returns after boot) | **cleared** | no_change | info_only | no_change ("needs engineer-approved OTA") | replaced *(unnecessary pull)* |
| `can_link_unreliable` | no_change | no_change | no_change | info_only (CAN query shows link flaps) | **cleared** (connector reseated) | replaced *(unnecessary pull)* |
| `install_commissioning_incomplete` | no_change | no_change | no_change | info_only | **cleared** | replaced *(unnecessary pull)* |
| `install_wiring_or_sense_error` | no_change | no_change | no_change | info_only | **cleared** | replaced *(unnecessary pull)* |
| `grid_or_home_side_condition` | no_change | no_change | no_change | info_only | **nothing_found** (home-side issue, customer notified; fault cleared on unit) | replaced *(unnecessary pull)* |
| `no_fault_found` | **cleared** (latch cleared) | **cleared** | **cleared** (no recurrence) | info_only | **nothing_found** → avoided false pull | replaced *(unnecessary pull)* |
| `true_hardware_defect` | no_change | no_change | no_change | info_only | no_change ("power stage failure confirmed") | **replaced** *(justified)* |
| `thermal_or_safety_event` | **refused_interlock** | **refused_interlock** | no_change | info_only | **made_safe** (needs HQ recovery) | **replaced** *(justified)* |
| healthy (`null`) | no_change (stays healthy) | no_change | no_change | info_only | nothing_found | replaced *(unnecessary pull)* |

Rules:
- `ota_to_allowlisted` sets `fw_version = params.target_fw` if on the allow-list (sim throws otherwise), `last_boot_reason = "ota"`.
- `reboot` resets `uptime_s`, `last_boot_reason = "reboot_cmd"`.
- `hq_recovery` → unit replaced: `fault = null`, `fw_version` = first allow-listed version.
- Incomplete tech visit (`completed: false`) → no state change, outcome `no_change`.
- Every call appends to `action_history` and persists.
- **Flakiness:** optional, seeded per VIN: a reboot on a soft fault fails on the first try with p = 0.25. **Off by default**, on with env `SIM_FLAKY=1`. Tests run with it off.

## 5. Action catalog + gate

| Action | Level | Approval | Gate denies when |
|---|---|---|---|
| `monitor` | L1 | none | — |
| `engineer_bug_report` | L1 | none | — |
| `request_log_dump` | L2 | ops_or_engineer | — (read-only, allowed on L0) |
| `can_health_query` | L2 | ops_or_engineer | — (read-only, allowed on L0) |
| `reboot` | L2 | ops_or_engineer | case is safety/L0 · hypothesis `unknown` · confidence < 0.5 |
| `ota_to_allowlisted` | L3 | **engineer** | case is safety/L0 · `target_fw` not on allow-list · hypothesis `unknown` · confidence < 0.5 |
| `dispatch_tech` | L4 | ops_or_engineer | — |
| `hq_recovery` | L4 | **ops_and_engineer** (two distinct users) | not L0 and no on-site confirmation (tech visit `no_change`/`made_safe`) yet |

"Case is safety/L0" = hypothesis `thermal_or_safety_event` **or** device reports `INV-F900` **or** status `Escalated L0`.

Gate: `gate(step, case, approvalsSoFar, actingUser?) → allow | needs_approval(requires, missing roles) | deny(reason)`.
- Technician or admin trying to approve → deny ("technicians complete visits; they don't approve actions" / "admin doesn't bypass safety").
- Wrong role (e.g. ops approving OTA) → deny with reason; the UI shows the button disabled with that reason.
- The gate runs at plan time (steps that can never run are marked `denied` and logged as `gate_denied`) and again at approval time.

## 6. Planner (the agent)

Input: `Hypothesis`, `DeviceStatus` (never `UnitState`), prior steps and results on this case, the catalog, the allow-list.
Output: `Gameplan`.

- **Claude path:** model `claude-sonnet-5`, a single tool `propose_gameplan` with `{summary, steps: [{action (enum = catalog), params, expected_effect, rationale}], alerts: [{role, reason}]}`, forced tool choice, 8 s timeout. Used when `ANTHROPIC_API_KEY` is set.
- **Playbook path** (fallback, and what tests use):

| Hypothesis | Steps |
|---|---|
| `fw_soft_fault_reboot_candidate` | `reboot` → `ota_to_allowlisted` (only if fw not on allow-list) → `dispatch_tech` |
| `fw_version_mismatch` | `ota_to_allowlisted` → `dispatch_tech` |
| `can_link_unreliable` | `can_health_query` → `dispatch_tech` (photos required) |
| `install_commissioning_incomplete`, `install_wiring_or_sense_error` | `dispatch_tech` (photos required) |
| `grid_or_home_side_condition` | `monitor` → `dispatch_tech` |
| `no_fault_found` | `monitor` → `dispatch_tech` |
| `true_hardware_defect` | `request_log_dump` → `dispatch_tech` (confirm on site) → `hq_recovery` |
| `thermal_or_safety_event` | `dispatch_tech` (with engineer) → `hq_recovery`; status `Escalated L0` |
| `unknown` / confidence < 0.5 | `request_log_dump` → `can_health_query` → `dispatch_tech` |

- **Post-processing (both paths):** drop actions not in the catalog; set `level`/`requires` from the catalog; strip remote actuation on L0 and on unknown/low confidence; move `hq_recovery` to the end unless allowed first; plan `level` = max step level; run the gate over every step.
- **Alerts** (logged as `alert_sent` case events, no real notifications, MOCKED): L0 → engineer + ops · L1 → engineer · L2 → ops · L3 → engineer · L4 → technician + driver (if `hq_recovery`) + ops.
- Record `source: "claude" | "playbook"`; the UI shows it as a badge.

## 7. Runner, verifier, escalation

- A step runs when the gate returns `allow` (no approval needed, or approvals complete). `tick()` does this.
- Device actions: `FleetGateway.apply` → store `ActionResult` on the step → **verifier** calls `getStatus(vin)`:
  - `faulted === false` → `verify_pass`, remaining steps `skipped`, status **Engineer review**, outcome `fixed_remote`.
  - still faulted → step `failed`, `verify_fail`; the next step becomes `awaiting_approval` (or runs if allowed).
  - plan exhausted → **escalate**: re-plan with the history (Claude or playbook). If it can't produce anything new, append `dispatch_tech`; if a visit already happened, `hq_recovery`.
- `refused_interlock` → case goes **Escalated L0**, and engineer + ops are alerted.
- Read-only actions (`info_only`) never pass or fail verification; they just advance to the next step.
- `monitor` → the sim evaluates immediately (demo shortcut, labeled): cleared → pass, else fail.

## 8. Visits, scheduling, closing

- An approved `dispatch_tech` → **scheduler** picks a technician from `tech_roster` whose `skills` include the hypothesis (tie → first in roster), with a slot starting at the next hour and lasting 2 h. It writes a `brief` (2 sentences: why you're here) and a `checklist` (3–6 items from the hypothesis). `photos_required` is true for `can_link_unreliable` and `install_*`. Status → **Field visit**.
- An approved `hq_recovery` → a visit of kind `hq_recovery` assigned to the driver.
- **Completing a visit** (technician-role user in the UI): `completed: true` requires `photos_attached` when `photos_required`, otherwise it's rejected with an error. `completed: false` requires an `incomplete_reason`; the visit stays on the case, and a new visit can be scheduled (a bounce, counted).
- Visit result → `FleetGateway.techVisit` → verifier as in §7. `nothing_found` → status **Engineer review**, outcome `avoided_false_pull`. `made_safe` → unlocks `hq_recovery`. `replaced` → outcome `pulled_justified` or counted in `unnecessary_pulls`.
- **Close:** engineer only, from **Engineer review**, or from **Escalated L0** once the unit is made safe or replaced.

## 9. Bug reports

After every ingest and verify: group open and closed cases by `(fw_version, hypothesis.root_cause)`. Any group of ≥3 without a report → a `BugReport`: title, evidence per case, affected VINs, and a recommendation such as "OTA affected units to allow-listed 3.4.0, engineer approval required." Never a patch. Written by Claude when a key is present, otherwise from a template. A `bug_report_linked` event goes on each case. Seed group: INV-5009/5010/5011 on 3.3.0 with a soft fault.

## 10. Status flow

`Open` (created) → `Investigating` (hypothesis + plan) → `Action pending` (waiting on approval) → `In progress` (step running) → `Field visit` (visit scheduled) → `Engineer review` (fixed or nothing found) → `Closed` (engineer).
Side state: `Escalated L0` (safety). Every change logs a `status_changed` event.

Metrics (`ResponseMetrics`): open, closed, fixed_remote, avoided_false_pulls, truck_rolls (visits completed), gate_denials, unnecessary_pulls.

## 11. API (routes.ts, JSON)

| Method + path | Body | Calls |
|---|---|---|
| GET `/api/response/state` | — | `getState()` |
| POST `/api/response/ingest` | — | `ingestFaults()` |
| POST `/api/response/approve` | `{case_id, step_id, user_id}` | `approve()` → returns `GateResult` |
| POST `/api/response/reject` | `{case_id, step_id, user_id, reason}` | `reject()` |
| POST `/api/response/visit` | `{visit_id, user_id, outcome: VisitOutcome}` | `completeVisit()` |
| POST `/api/response/close` | `{case_id, user_id, note}` | `closeCase()` |
| POST `/api/sim/plant` | `{vin, fault}` | `plantFault()` then `ingestFaults()` |
| POST `/api/response/reset` | — | `reset()` |

`user_id` resolves against `users` in the seed. Errors → 400 `{error}`; gate denials → 403 `{error, gate}`. The server calls `tick()` every 2 s and `ingestFaults()` on startup.

## 12. `/response` page

Vanilla HTML/JS string (`RESPONSE_PAGE`), matching the look of `src/pages/fleet-dashboard.ts`. Polls state every 2 s.
- **Header:** role switcher (pick a user: D. Osei tech / M. Alvarez ops / J. Park engineer), kept in localStorage; a planner badge (Claude / playbook); a **MOCKED** label; metric tiles.
- **Fleet panel:** one tile per inverter (green healthy / red faulted / amber in-progress / dark red L0), fw version, a "plant fault" menu on each tile, and a reset button.
- **Case queue:** cards with status chip, level, hypothesis + confidence, and plan steps with state. **Approve / Reject** buttons appear per step for the current user; when the gate says no, the button is disabled and shows the reason.
- **Case detail:** the timeline (CaseEvents), the step results, and a **Close case** button (engineer).
- **Visits:** scheduled visits with brief and checklist. A technician user sees **Complete visit** (photos checkbox) and **Mark incomplete** (reason dropdown).
- **Bug reports:** a list; click to read the markdown body.
- **Onboarding tour:** spotlight walkthrough of each panel on the first visit (localStorage `response.tour.v1`). Replay with the **Tour** button or `/response?tour=1`.
- **Getting here:** `/fleet` and `/case` share the Fleet · Case · Response nav, and `/fleet` shows a live Response agent banner (actions waiting, safety cases). `/response?case=RCA-0003` opens a specific case.

## 13. Seed fleet + demo script

| VIN | fw | True fault | Demo role |
|---|---|---|---|
| INV-5001, 5004, 5006 | 3.4.0 | healthy | plant faults live |
| INV-5002 | 3.4.0 | `no_fault_found` | monitor → clears → avoided pull |
| INV-5003 | 3.4.0 | `fw_soft_fault_reboot_candidate` | **Scene 1:** reboot, ops approves, clears, no truck |
| INV-5005 | 3.4.0 | `can_link_unreliable` (**misdiagnosed** as soft fault, 0.62) | **Scene 2:** reboot fails → verifier escalates → tech (photos) → reseat clears |
| INV-5007 | 3.4.0 | `thermal_or_safety_event` | **Scene 3:** reboot denied by gate, Escalated L0, tech makes safe → HQ recovery (ops + engineer) |
| INV-5008 | 3.2.1 | `fw_version_mismatch` | **Scene 4:** OTA button disabled for ops ("engineer only"), engineer approves → clears |
| INV-5009, 5010, 5011 | 3.3.0 | `fw_soft_fault_reboot_candidate` | **Scene 5:** bug report for 3.3.0 |
| INV-5012 | 3.4.0 | `true_hardware_defect` | log dump → tech confirms → HQ recovery (justified pull) |

**Scene 6 (live):** plant a fault on INV-5001 from the UI, and watch the case open, get planned, and get worked.

Integration tests must drive scenes 1–5 through the `ResponseEngine` interface and assert the final status and outcome.

## 14. Files and ownership

| Path | Owner |
|---|---|
| `src/response/types.ts`, `data/sim-fleet.seed.json`, this doc, `package.json` test script | Step 0 (done; frozen during the parallel build) |
| `src/sim/**` | Prompt A |
| `src/response/**` except `types.ts`, `routes.ts`, `mock-engine.ts`; `package.json` dependency `@anthropic-ai/sdk` | Prompt B |
| `src/response/routes.ts`, `src/response/mock-engine.ts`, `src/pages/response-page.ts`, 2–3 lines in `src/dashboard-server.ts` | Prompt C |

Tests: `*.test.ts` next to the code, `node:test` + `node:assert/strict`, run with `npm test` (`tsc && node --test "dist/**/*.test.js"`). ESM with NodeNext: relative imports end in `.js`.

## 15. Build plan

**Setup (per prompt):**
```
cd /Users/carlosrojas/Documents/Dev/base-hackathon
git worktree add ../bh-<name> -b resp-<name>
cd ../bh-<name> && npm install
# Prompt B only, for the live Claude planner:
cp ../base-hackathon/.env .env
```
Then start a Claude Code session in `../bh-<name>` and paste the prompt. `Dev/CLAUDE.md` and the repo's `AGENTS.md` load automatically.

**Integration (after A, B, C finish):** merge `resp-sim`, `resp-engine`, `resp-ui` into `main`; wire `FleetSim` + the real engine into `routes.ts` in place of the mock; run `npm test`; walk scenes 1–6 in the browser; fix; update `AGENTS.md` Status.
