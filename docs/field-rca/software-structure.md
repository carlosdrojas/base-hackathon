# Software structure

> Local copy of the Notion page **Software structure** (child of the Field RCA design doc).
> Source: https://app.notion.com/p/3e7e26707bba8125a38bfb302bc8022b · copied 2026-09-26. Notion wins if they diverge.

Captured 2026-09-26 from product direction. This page is the pipeline + block diagram. Feature list stays on **Software features** (`software-features.md`). Safety / permission ladder stays on the parent design doc.

---

## Pipeline (scope for this build)

```
faulted inverter data  →  RCA creation  →  auto-triaging  →  dashboard
```

1. **Input:** database of all Base inverters + faulted flag.
2. **On fault:** auto-create an RCA ticket and pull the full telemetry packet.
3. **Dashboard:** map of the fleet; faulted units highlighted; RCA tickets listed and updated as the case moves.
4. **Triaging agent (two jobs):**
    - Debug / RCA from FW logs + CAN packets. Goal: do not pull a healthy box because a tech could not see a small software / connector / FW issue.
    - Turn the hypothesis into a gameplan. Split by automation level (AI can implement vs must go through a human). Alert the right people (truck / tech / engineer) and schedule service when needed.
5. **Feedback:** as the ticket is diagnosed, individual RCA tickets and the analysis dashboard both update.

Hackathon stand-in for the live inverter DB: **one large CSV** of inverter info + fault info. Do not pretend we have Base production APIs.

---

## Block diagram

```
               +---------------------------------------+
               |  Inverter fleet source (hackathon)    |
               |  large CSV                            |
               |  VIN / serial, location, HW rev, FW,  |
               |  faulted? (Y/N), fault_time,          |
               |  fault_code / notes                   |
               +------------------+--------------------+
                                  |
                                  | ingest / poll
                                  v
               +---------------------------------------+
               |  Fleet state store                    |
               |  one row per inverter                 |
               |  healthy vs faulted                   |
               +------------------+--------------------+
                                  |
               +------------------+------------------+
               |                                     |
               v                                     v
+------------------------------+     +------------------------------+
| Dashboard — map              |     | Fault detector               |
| pin per inverter             |     | if faulted == yes            |
| red = faulted                |     | and no open RCA for this VIN |
| grey / green = healthy       |     +---------------+--------------+
| click pin → case             |                     |
+---------------+--------------+                     | open case
                ^                                    v
                |                     +------------------------------+
                |                     | RCA factory                  |
                |                     | create RCA ticket            |
                |                     | status = Open                |
                |                     | pull full telemetry packet   |
                |                     |   FW logs                    |
                |                     |   CAN packets / bus stats    |
                |                     |   last-seen, boot reason     |
                |                     +---------------+--------------+
                |                                     |
                |                                     v
                |                     +------------------------------+
                |                     | Evidence pack                |
                |                     | attached to the RCA          |
                |                     +---------------+--------------+
                |                                     |
                |                                     v
                |                     +------------------------------+
                |                     | TRIAGING AGENT               |
                |                     |                              |
                |                     |  Job 1 — debug / RCA         |
                |                     |  read FW logs + CAN          |
                |                     |  distinguish:                |
                |                     |    connector / comms         |
                |                     |    stale / soft FW           |
                |                     |    install / sense           |
                |                     |    true hardware             |
                |                     |    no-fault-found            |
                |                     |    L0 safety                 |
                |                     |  write hypothesis +          |
                |                     |  confidence + diffs          |
                |                     |                              |
                |                     |  Job 2 — gameplan            |
                |                     |  map hypothesis → playbook   |
                |                     |  assign automation level     |
                |                     |    L0 observe / safety       |
                |                     |    L1 recommend              |
                |                     |    L2 supervised act         |
                |                     |    L3 narrow auto            |
                |                     |    L4 physical (tech/truck)  |
                |                     |  alert parties               |
                |                     |    engineer / tech / driver  |
                |                     |  schedule service if L4      |
                |                     +-------+-----------+----------+
                |                             |           |
                |              auto-implement |           | human path
                |              (policy allows)|           |
                |                             v           v
                |                     +-----------+  +----------------+
                |                     | Command / |  | Approval +     |
                |                     | playbook  |  | dispatch       |
                |                     | runner    |  | engineer / ops |
                |                     | (reboot,  |  | tech job,      |
                |                     |  log dump)|  | truck to HQ    |
                |                     +-----+-----+  +--------+-------+
                |                           |                 |
                |                           +--------+--------+
                |                                    |
                |                                    v
                |                     +------------------------------+
                |                     | RCA ticket store             |
                |                     | status, hypothesis, level,   |
                |                     | assignee, visit, outcome     |
                |                     +---------------+--------------+
                |                                     |
                +-------------------------------------+
                                                      |
                                                      v
                                   +--------------------------------+
                                   | Dashboard — analysis + tickets |
                                   | open RCA list                  |
                                   | status chips as case moves     |
                                   | cause histogram / false-pull   |
                                   | counts                         |
                                   +--------------------------------+
```

North star for the agent: **avoid returning a hardware part that is actually fine** because the problem was small and a technician could not see it in logs.

---

## CSV contract (hackathon input)

Treat this as the stand-in for “all Base inverters.” One row per inverter.

**Identity / location**

- `vin` or `serial` (unique)
- `asset_id`
- `site_id` / address or lat,lng (needed for the map)
- `hw_rev`, `sku`
- `fw_version`
- `install_date`, `crew_id` (nice to have)

**Fault**

- `faulted` (`yes` / `no`)
- `fault_time` (ISO)
- `fault_code` (optional)
- `fault_notes` (optional)

Healthy rows still belong in the file so the map is a full fleet, not only failures.

When `faulted = yes` and there is no open RCA for that VIN → create RCA + pull telemetry packet.

---

## Telemetry packet (per faulted inverter)

Pulled at RCA open (and again on re-eval). This is what the agent is allowed to read.

- FW logs (boot reason, panics, watchdog, version string)
- CAN: packets / error frames / dropped frames / bus-off / missing node heartbeats
- Last-seen, uptime, connectivity
- Fault codes already on the inverter
- Recent reboot / OTA history if present in the fixture

Do not dump the raw packet onto the map. Link it from the RCA ticket.

---

## Triaging agent — two tasks

### Task 1 — Debug and root cause

Look at FW logs and CAN to name the problem.

Closed set (same taxonomy as parent doc):

- `fw_version_mismatch`
- `fw_soft_fault_reboot_candidate`
- `can_link_unreliable`
- `install_commissioning_incomplete`
- `install_wiring_or_sense_error`
- `grid_or_home_side_condition`
- `thermal_or_safety_event` (clamp to L0)
- `true_hardware_defect`
- `no_fault_found`
- `unknown` (clamp automation)

Bias: prefer `no_fault_found` / comms / FW / install over `true_hardware_defect` unless evidence is strong. That is how we stop the 90% false-pull.

### Task 2 — Gameplan

Hypothesis → playbook + level + who to alert.

| Level | AI may auto-implement? | Who is alerted | Typical move |
| --- | --- | --- | --- |
| L0 | No. Observe only. | Engineer + ops | Safety ticket. No remote actuation. |
| L1 | No. Recommend only. | Engineer | Write RCA + playbook. Human approves. |
| L2 | Only after human click. | Ops or engineer | Reboot, request log dump, CAN health query. |
| L3 | Narrow auto propose. Reflash still human. | Engineer (OTA is engineer-only) | Allow-listed FW update proposal. |
| L4 | No. Physical world. | Tech, truck driver, ops | Schedule service visit or HQ recovery. |

Alerts and scheduling are outputs of Task 2, not a separate product.

---

## Dashboard surfaces (this build)

**Map**

- Every inverter from the CSV as a point.
- Faulted = distinct color / marker.
- Click → open that VIN’s RCA (or “healthy, no case”).

**RCA tickets**

- One ticket per fault incident.
- Fields update as the agent and humans move the case: Open → Investigating → Action pending → In progress → Field visit → Engineer review → Closed.
- Show hypothesis, level, assignee, next action.

**Data analysis**

- Counts: faulted vs healthy, open vs closed, cause class, level mix, false-pull / NFF.
- Updates when tickets change. Do not keep a static screenshot of the CSV.

---

## Loop, written as data flow

1. Load CSV → fleet store.
2. Render map from fleet store.
3. For each newly faulted VIN → RCA ticket + telemetry packet.
4. Agent Task 1 writes hypothesis onto the ticket.
5. Agent Task 2 writes gameplan + level + alerts + optional schedule.
6. Policy gate: auto path vs human path.
7. Ticket status changes → map marker + ticket list + analysis widgets all refresh.

---

## Explicitly out of this page

- Live Base device APIs (CSV only for scope).
- Agent-authored firmware.
- New action types invented at runtime.

---

## Original product ask (verbatim)

the general data input should be a database of all base inverters and whether they are in a faulted state. for the sake of this project scope, this will look like a large csv file noting inverter information (VIN, location, etc) and fault info (yes faulted, time of fault, etc). I also want to create a map visual of this on the dashboard. any faulted inverters should then have an RCA auto created (and put on dashboard) and the full telemetry packet of each should be pulled. this will serve as input into the triaging agent. the triaging agent then has two tasks. first, debugging and root cause analysis. so looking at the fw logs, CAN packets to distuinguish a problem. We want to avoid returning a hardware part that is actually fine but has some small problem that a technician can't figure out. second, the agent then takes this hypothesis of what is wrong and creates a gameplan. this is where things are divided into the different levels, distuinguishing whether the ai can auto implement a solution or it has to go through a human. and it will alert any relevent parties (truck drivers, tech, engineer) and schedule a service. then as this ticket is fledged and diagnosed the dashboard should reflect this, creating individual RCA tickets and also updating the data analysis dashboard. so overall: faulted inverter data --> RCA creation --> auto-triaging --> dashboard.

---

## Telemetry → Events (how large packets become consumable)

Added 2026-09-26. Raw FW logs + CAN + analog traces are too big for the agent, the ticket UI, and the analysis dashboard. **Events** are the compression layer. The RCA ticket and the agent consume events first. Raw stays on disk as a pointer, not as the default read.

### Why

- A “full telemetry packet” around one fault is minutes-to-hours of samples plus thousands of CAN frames plus multiline FW logs.
- Dumping that into an LLM context wastes tokens and hides the one bus-off that matters.
- Dumping that onto a dashboard is unreadable.
- Engineers already think in events (“bus-off at 14:02:11, then node 0x23 disappeared for 8s”). The system should emit that sentence as a structured object.

### Rule

**Detectors write events. The agent reasons over events. Humans see events. Raw is evidence-on-demand.**

Do not ask the model to “read the CAN dump.” Ask it to read the 12 events in the window, then optionally fetch raw around one timestamp.

---

### Where it sits in the pipeline

```
CSV fault flag
    → pull raw packet (FW log file + CAN capture + counters + analog)
    → parse / normalize
    → window around fault_time
    → deterministic detectors
    → Event list on the RCA
    → agent Task 1 (hypothesis) + Task 2 (gameplan)
    → dashboard timeline
```

Insert this box between **Evidence pack** and **Triaging agent** on the block diagram. The evidence pack is raw + parsed. The event list is what leaves that pack.

---

### How it actually occurs (runtime steps)

**1. Pull raw, do not interpret yet**

On RCA open (and on re-eval after reboot / visit):

- FW log slice (boot, panic, watchdog, version, fault printfs)
- CAN capture or pre-aggregated bus stats if a full capture is too large
- Counter snapshots (error frames, drops, bus-off count, missing heartbeats)
- Coarse analog / inverter state if present in the fixture (temp, Vbus, grid present)

Store as files keyed by `case_id` + `pulled_at`. This is the packet.

**2. Parse into typed lines**

Each source becomes a homogeneous stream:

- `FwLine { ts, level, component, msg, raw }`
- `CanFrame { ts, id, dlc, data }` or `CanStat { ts, err, drop, bus_off, missing_nodes[] }`
- `Sample { ts, channel, value }` if we have analog

Parsing is boring and deterministic. Bad timestamps get dropped or marked `ts_unreliable`. Do not LLM this step.

**3. Window**

Default window for v0:

- T0 = `fault_time` from the CSV (or first detector hit if CSV time is missing)
- Lookback 15 min, lookforward 5 min for the first pass
- Always include the last boot / panic before T0 even if it is outside the window

Later re-eval can request a wider window. The agent does not get “all history.”

**4. Run detectors on the window (this is the event factory)**

Each detector is a small function: stream in → zero or more `Event` out. Order them cheap → expensive.

Suggested v0 detectors:

| Detector | Input | Emits when | Typical event_type |
| --- | --- | --- | --- |
| `fw_version` | version string vs allow-list | installed ≠ allowed or unknown rev | `fw.version_mismatch` |
| `fw_boot` | FW log | boot, panic, watchdog reset | `fw.boot`, `fw.panic`, `fw.watchdog` |
| `fw_fault_print` | FW log | known fault printf / code | `fw.fault_code` |
| `can_error_burst` | CAN stats / frames | error-frame rate above N for ≥ T seconds | `can.error_burst` |
| `can_bus_off` | CAN stats | bus-off set or count increases | `can.bus_off` |
| `can_node_missing` | heartbeats | expected node silent ≥ T | `can.node_missing` |
| `can_intermittent` | node presence | drop + return ≥ K times in window | `can.link_flap` |
| `l0_thermal` | temp / safety bits | overtemp, insulation, unexpected HV | `safety.thermal` / `safety.hv` — clamps L0 |
| `connectivity` | last-seen / backhaul | gap longer than SLA | `net.offline` |
| `csv_fault_flag` | CSV row | always, so the ticket has an origin | `src.fault_flag` |

If nothing fires except `src.fault_flag`, that is already useful: the agent’s first hypothesis leans `no_fault_found` or `unknown`, not `true_hardware_defect`.

**5. Compact**

Same detector firing every 50ms becomes one event with `count`, `first_ts`, `last_ts`, `peak`. Example: 400 error frames → one `can.error_burst` spanning 12s, count=400, peak=80/s. Compaction is what makes the list human-sized.

**6. Attach pointers, not payloads**

Every event stores:

- `raw_ref`: file + byte offset or timestamp range back into the packet
- `detector_id` + `detector_version`

UI and agent can “expand this event” to 2 seconds of raw. They do not embed the 2 seconds by default.

**7. Agent reads the event list**

Task 1 input is:

- ordered events in the window
- asset header (VIN, FW, hw_rev, location)
- prior open/closed cases on this VIN (ids + outcomes only)

Task 1 output still the structured hypothesis. If the model needs more, it calls a tool `get_raw(event_id)` — that is the only path into the packet.

**8. Dashboard reads the same list**

Case timeline = events + CaseEvents (agent hypothesis, approval, visit). Analysis dashboard counts event_types and root-cause classes, not log lines.

---

### Event object (v0)

Keep it small and closed.

```
Event
  event_id
  case_id
  asset_id / vin
  ts              # first occurrence
  ts_end          # last if compacted
  event_type      # dotted name from the table above
  severity        # info | warn | fault | l0
  summary         # one line, written by the detector, not the LLM
  fields          # small JSON: {node: "0x23", count: 12, peak_err_s: 80}
  raw_ref         # {file, start_ts, end_ts} or byte range
  detector_id
  detector_version
```

`summary` examples the detector should emit:

- `CAN node 0x23 missing 8.2s starting 14:02:11`
- `Watchdog reset at 13:58:02, boot reason=WDT`
- `FW 1.4.2 not on allow-list (current allow=1.6.1)`
- `Bus-off count 0 → 3 between 14:02:09–14:02:18`

---

### What the agent is *not* allowed to do with raw

- Load the entire packet into the prompt.
- Invent an event_type that is not in the detector table. New types = new detector version, same as the action catalog rule.
- Treat a missing event as proof of hardware death. Absence of `can.bus_off` plus a `net.offline` is a comms story, not a pull-to-HQ story.

---

### Hackathon fixture (so this is buildable in 48h)

We will not have hours of real Base captures. Fabricate per faulted VIN:

- a short FW log text file (20–80 lines) with a planted signature
- a CAN stats JSON (not every frame) with planted bursts / missing nodes
- optional 1 Hz samples

Pair each planted signature with the event(s) a correct detector must emit. That gives a test: detector → expected events → agent hypothesis class.

Healthy VINs: no packet pull, no events, map stays green.

---

### Suggested implementation order

1. Event schema + store on the RCA.
2. `src.fault_flag` + `fw_version` detectors only.
3. Timeline UI that renders events.
4. CAN stat detectors (`bus_off`, `node_missing`, `error_burst`).
5. Compaction.
6. Agent Task 1 reads events only.
7. `get_raw(event_id)` tool if time.

If phase 4 is late, the product still works: a ticket with three honest events beats a 40k-line paste.
