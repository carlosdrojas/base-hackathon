// Diagnosis stub (design doc §2.10). Task 1 will replace this. Until then it reads the sim's true
// fault, except where the seed plants a misdiagnosis (INV-5005). MOCKED.

import type { DeviceStatus, FleetGateway, Hypothesis, HypothesisSource, RootCause } from "./types.js";
import type { FleetSeed } from "./seed.js";

const STUB_CONFIDENCE: Partial<Record<RootCause, number>> = {
  thermal_or_safety_event: 0.95,
  fw_version_mismatch: 0.9,
  true_hardware_defect: 0.8,
  no_fault_found: 0.7,
};

export class StubHypothesisSource implements HypothesisSource {
  constructor(
    private readonly gateway: FleetGateway,
    private readonly misdiagnose: FleetSeed["misdiagnose"] = {},
  ) {}

  async diagnose(caseId: string, status: DeviceStatus): Promise<Hypothesis> {
    const evidence = [
      `Device reports ${status.active_fault_codes.join(", ") || "no active fault codes"}`,
      `fw ${status.fw_version}, last boot ${status.last_boot_reason}, uptime ${status.uptime_s}s`,
    ];
    const planted = this.misdiagnose[status.vin];
    if (planted) {
      return {
        case_id: caseId,
        vin: status.vin,
        root_cause: planted.root_cause,
        confidence: planted.confidence,
        evidence: [...evidence, "Pattern resembles a soft firmware fault"],
        fw_version: status.fw_version,
        source: "stub",
      };
    }
    const truth = this.gateway.getUnitState(status.vin).fault;
    const rootCause: RootCause = truth ?? "unknown";
    return {
      case_id: caseId,
      vin: status.vin,
      root_cause: rootCause,
      confidence: truth ? (STUB_CONFIDENCE[truth] ?? 0.85) : 0.3,
      evidence: [...evidence, "Diagnosed from the planted fault (no telemetry packet for this unit)"],
      fw_version: status.fw_version,
      source: "stub",
    };
  }
}
