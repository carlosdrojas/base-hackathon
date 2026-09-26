/**
 * Maps the observable device report into detector evidence.
 * DeviceStatus has no hw_rev, CAN counters, rails, commissioning, or safety measurements.
 * Those stay optional and must be passed in from the telemetry packet.
 * active_fault_codes are copied as print lines. They are not turned into a root-cause class.
 */

import type { DeviceStatus } from "../../response/types.js";
import type {
  BootEvidence,
  CanEvidence,
  CommissioningEvidence,
  DetectorEvidence,
  GridEvidence,
  PlaybookAttempts,
  RailEvidence,
  SafetyEvidence,
  SenseEvidence,
} from "./evidence.js";

export interface DeviceStatusEvidenceInput {
  caseId: string;
  status: DeviceStatus;
  /** Not on DeviceStatus. Pass from inventory or UnitState.hw_rev. Do not pass UnitState.fault. */
  hwRev?: string | null;
  can?: CanEvidence;
  rails?: RailEvidence;
  commissioning?: CommissioningEvidence;
  sense?: SenseEvidence;
  grid?: GridEvidence;
  safety?: SafetyEvidence;
  boot?: Partial<BootEvidence>;
  attempts?: PlaybookAttempts;
  repeatFaultCode?: boolean;
}

export function evidenceFromDeviceStatus(input: DeviceStatusEvidenceInput): DetectorEvidence {
  const reason = input.status.last_boot_reason;
  const boot: BootEvidence = {
    reason,
    watchdogResets: reason === "WDT" ? 1 : 0,
    panicCount: 0,
    repeatedSoftReset: false,
    ...input.boot,
  };
  return {
    caseId: input.caseId,
    vin: input.status.vin,
    observedAt: input.status.last_seen,
    hwRev: input.hwRev ?? null,
    fwVersion: input.status.fw_version,
    faulted: input.status.faulted,
    activeFaultCodes: input.status.active_fault_codes,
    repeatFaultCode: input.repeatFaultCode ?? false,
    offline: input.status.online === false,
    boot,
    rails: input.rails,
    can: input.can,
    commissioning: input.commissioning,
    sense: input.sense,
    grid: input.grid,
    safety: input.safety,
    attempts: input.attempts,
  };
}
