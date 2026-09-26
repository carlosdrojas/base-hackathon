# Base Field RCA — shared context index

Use these Notion pages as source of truth. Read the parent design doc first, then the child pages. Do not invent APIs, firmware write paths, or extra action types.

Event: Base Power × AITX Talent Hackathon (Austin, Sep 25–27 2026).
Product: AI-assisted field RCA / auto-triage for Base Cores and inverters.
North star: stop healthy hardware from being pulled to HQ (~90% of returned inverters are actually fine).

## Pages (read in this order)

1. **Design doc (parent / project context)**  
   https://app.notion.com/p/3e7e26707bba81ceb9f3f9e25d90b227  
   Problem, jobs, safety bans, L0–L4 permission ladder, objects (Asset, RCA Case, Visit, Playbook), action catalog, taxonomy, metrics, build sequence. Context log at the bottom is the running product diary.

2. **Megan’s Grok Prompt**  
   https://app.notion.com/p/3e7e26707bba804ca18cecbcb40885f3  
   Original product ask. Treat as intent, not schema. Prefer the design doc if they conflict.

3. **Software features**  
   https://app.notion.com/p/3e7e26707bba819aa480e2acde0fb6ce  
   Feature list and roles (engineer-only OTA / RCA close). Not architecture.

4. **Software structure**  
   https://app.notion.com/p/3e7e26707bba8125a38bfb302bc8022b  
   Pipeline + block diagram for this build:  
   `faulted inverter CSV → RCA ticket + telemetry packet → triaging agent (debug + gameplan) → dashboard (map + tickets + analysis)`.

## Hard constraints (all agents)

- No live Base device APIs. Fleet input for this scope is a large CSV (VIN, location, HW/FW, faulted Y/N, fault time).
- AI cannot write, patch, or generate firmware. OTA only to a signed allow-listed version, engineer-approved.
- AI cannot invent new action types. Catalog lives on the design doc.
- L0 safety signatures clamp the case. No reboot / reflash / “try one more thing.”
- Engineer must approve an RCA before Closed.
- Bias: keep the unit in the field unless L0 or repeated confirmed hardware.

## Pipeline to implement

1. Ingest CSV of all inverters (healthy rows stay; map needs the full fleet).
2. Dashboard map: pin per inverter; faulted marked; click → case.
3. If `faulted=yes` and no open RCA for that VIN → create RCA and pull FW logs + CAN packet.
4. Triaging agent job 1: root cause from logs (closed taxonomy on the design doc).
5. Triaging agent job 2: gameplan + L0–L4 + alert tech / truck / engineer + schedule if L4.
6. Ticket status changes update the map, the RCA list, and the analysis dashboard.

## Page IDs (if a tool wants UUID not URL)

| Page | UUID |
|---|---|
| Design doc | `3e7e2670-7bba-81ce-b9f3-f9e25d90b227` |
| Megan’s Grok Prompt | `3e7e2670-7bba-804c-a18c-ecbcb40885f3` |
| Software features | `3e7e2670-7bba-819a-a480-e2acde0fb6ce` |
| Software structure | `3e7e2670-7bba-8125-a38b-fb302bc8022b` |