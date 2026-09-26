# Core (battery) mock telemetry

`core-fleet-telemetry.json` — 8 mock Base Power DC ESS ("Core") battery units, built from the real
architecture and fault thresholds in Base's own **Installation, Operation & Service Manual**
(`~/Downloads/base battery owners manual.pdf`, model `000515.XX.Y`), not invented from scratch.

Real vs. mocked is tagged inline in the JSON's `_provenance` block and per-unit `note` fields —
same convention as the rest of this project. Short version:

- **Real** (from the manual, pages 9–13): 30S1P / 102 Ah LFP pack, 87–109.5 VDC range, 51 A
  continuous / 61 A max overcurrent, all 9 named BMS protective functions with their exact
  trigger thresholds and timers, and the fact that every one of those faults ends in an
  **irreversible pyrotechnic fuse activation** — not a remote-resettable soft fault.
- **Mocked**: the actual sensor readings, SOC/SOH, CAN bus health counters, and which units are
  in which state. Bounded by the real ranges above, not invented numbers.

Two of the units (`COR-0092`, `COR-0071`) were deliberately built to match cases already present
in the existing Fleet Health / Case Workspace mockup, so the new realistic telemetry backs up
scenarios that were previously just flavor text.

**Not covered**: this manual is for the battery module only. It says nothing about inverter
telemetry, so `INV-xxxx` assets aren't touched here.

**Not done in this pass**: wiring this file into `dashboard-server.ts` or the Fleet Health
Artifact UI — this is the data source to pull from, not yet plumbed in.
