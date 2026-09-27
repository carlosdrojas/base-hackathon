// Diagnosis for the Core telemetry pack: runs the team's Task 1 detectors (src/field-rca/detectors,
// Megan) on the unit's packet row instead of reading simulator truth. The answer key and scenario
// label are never consulted. Falls back to the stub for units with no packet (e.g. a planted fault).

import { runDetectors } from "../field-rca/detectors/run.js";
import { evidenceFromPacketRow } from "../field-rca/detectors/from-packet.js";
import type { FwManifest } from "../field-rca/detectors/evidence.js";
import type { Row } from "../sim/core-pack.js";
import type { DeviceStatus, FleetGateway, Hypothesis, HypothesisSource, RootCause } from "./types.js";

/** Packet readings worth putting in front of the planner (and a human) as one evidence line. */
function packetHighlights(row: Row): string | null {
  const num = (k: string) => (row[k] === undefined || row[k] === "" ? null : Number(row[k]));
  const parts: string[] = [];
  const hs = num("t_heatsink_c");
  const amb = num("t_ambient_c");
  if (hs !== null) parts.push(`heatsink ${hs.toFixed(0)}°C${amb !== null ? ` (ambient ${amb.toFixed(0)}°C)` : ""}`);
  const r0 = num("fan_rpm_0"), r1 = num("fan_rpm_1");
  if (r0 !== null && r1 !== null) {
    const c0 = num("fan_current_0_a"), c1 = num("fan_current_1_a");
    parts.push(`fan rpm ${r0.toFixed(0)}/${r1.toFixed(0)}${c0 !== null && c1 !== null ? `, current ${c0.toFixed(2)}/${c1.toFixed(2)} A` : ""}`);
  }
  const a = num("t_igbt_a_c"), b = num("t_igbt_b_c"), c = num("t_igbt_c_c");
  if (a !== null && b !== null && c !== null) parts.push(`IGBT A/B/C ${a.toFixed(0)}/${b.toFixed(0)}/${c.toFixed(0)}°C`);
  const spread = num("t_cell_spread_c");
  if (spread !== null) parts.push(`cell spread ${spread.toFixed(1)}°C`);
  const derate = num("thermal_derate_pct");
  if (derate) parts.push(`derate ${derate.toFixed(0)}%`);
  if (row.gateway_offline === "Y") parts.push("gateway offline");
  return parts.length ? `Packet at fault: ${parts.join(", ")}` : null;
}

/** events.csv rolled up to one line: "FAN_MISSING rising ×3, OVER_TEMP rising ×4 (first 04:53Z)". */
function eventSummary(events: Row[] | undefined): string | null {
  if (!events?.length) return null;
  const counts = new Map<string, number>();
  for (const e of events) counts.set(`${e.event} ${e.edge}`, (counts.get(`${e.event} ${e.edge}`) ?? 0) + 1);
  const first = events.map((e) => e.ts_utc).sort()[0]?.slice(11, 16);
  return `Detector events: ${[...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ")}${first ? ` (first ${first}Z)` : ""}`;
}

export class DetectorHypothesisSource implements HypothesisSource {
  constructor(
    private readonly packets: Map<string, Row>,
    private readonly events: Map<string, Row[]>,
    private readonly manifest: FwManifest,
    private readonly fallback: HypothesisSource,
    private readonly gateway: FleetGateway,
  ) {}

  async diagnose(caseId: string, status: DeviceStatus): Promise<Hypothesis> {
    const row = this.packets.get(status.vin);
    // A planted fault drops the unit's scenario: the packet no longer describes it.
    if (!row || !this.gateway.getUnitState(status.vin).scenario) return this.fallback.diagnose(caseId, status);

    const run = runDetectors(evidenceFromPacketRow(row), this.manifest);
    const d = run.decision;
    const evidence = [
      `Detectors (Task 1): ${d.summary}`,
      ...(d.differentials.length ? [`Differentials: ${d.differentials.join(", ")}`] : []),
      ...[eventSummary(this.events.get(status.vin)), packetHighlights(row)].filter((x): x is string => !!x),
      `Device reports ${status.active_fault_codes.join(", ") || "no active fault codes"} · fw ${status.fw_version}`,
    ];
    return {
      case_id: caseId,
      vin: status.vin,
      root_cause: d.rootCauseClass as RootCause,
      confidence: d.confidence,
      evidence,
      fw_version: status.fw_version,
      source: "task1",
    };
  }
}
