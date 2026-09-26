/**
 * Frozen Field RCA contracts.
 * Source: Notion design doc 3e7e2670-7bba-81ce-b9f3-f9e25d90b227
 * and Software structure 3e7e2670-7bba-8125-a38b-fb302bc8022b.
 * Closed sets. Do not add action ids, root-cause classes, or event types here
 * without a human updating the design doc first.
 */

export const PERMISSION_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const ROOT_CAUSE_CLASSES = [
  "fw_version_mismatch",
  "fw_soft_fault_reboot_candidate",
  "can_link_unreliable",
  "install_commissioning_incomplete",
  "install_wiring_or_sense_error",
  "grid_or_home_side_condition",
  "thermal_or_safety_event",
  "true_hardware_defect",
  "no_fault_found",
  "unknown",
] as const;
export type RootCauseClass = (typeof ROOT_CAUSE_CLASSES)[number];

/** These classes always clamp the case to L0. */
export const L0_CLAMP_CAUSES = ["thermal_or_safety_event", "unknown"] as const satisfies readonly RootCauseClass[];

export const ACTION_IDS = [
  "flag_l0_safety",
  "request_log_dump",
  "reboot_firmware",
  "ota_allowlisted_fw",
  "dispatch_technician",
  "schedule_hq_recovery",
  "mark_no_fault_found_monitor",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export const EVENT_TYPES = [
  "fw.version_mismatch",
  "fw.boot",
  "fw.panic",
  "fw.watchdog",
  "fw.fault_code",
  "can.error_burst",
  "can.bus_off",
  "can.node_missing",
  "can.link_flap",
  "safety.thermal",
  "safety.hv",
  "net.offline",
  "src.fault_flag",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SEVERITIES = ["info", "warn", "fault", "l0"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const CASE_STATUSES = [
  "Open",
  "Investigating",
  "Action pending approval",
  "Action in progress",
  "Awaiting field visit",
  "Awaiting engineer review",
  "Closed",
  "Blocked",
  "Escalated L0",
  "Incomplete visit",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const ROLES = ["technician", "ops", "engineer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ALERT_PARTIES = ["engineer", "ops", "technician", "truck"] as const;
export type AlertParty = (typeof ALERT_PARTIES)[number];

/** Hackathon stand-in for the inverter database. One row per inverter, healthy rows included. */
export interface InverterCsvRow {
  vin: string;
  assetId?: string;
  siteId?: string;
  address?: string;
  lat?: number;
  lng?: number;
  hwRev?: string;
  sku?: string;
  fwVersion?: string;
  installDate?: string;
  crewId?: string;
  faulted: "yes" | "no";
  faultTime?: string;
  faultCode?: string;
  faultNotes?: string;
}

export interface AssetHeader {
  vin: string;
  assetId?: string;
  fwVersion?: string;
  hwRev?: string;
  location?: { lat?: number; lng?: number; label?: string };
}

export interface RawRef {
  file: string;
  startTs?: string;
  endTs?: string;
}

/** Compacted detector output. The agent reads these, not the raw packet. */
export interface FieldEvent {
  eventId: string;
  caseId: string;
  vin: string;
  ts: string;
  tsEnd?: string;
  eventType: EventType;
  severity: EventSeverity;
  summary: string;
  fields: Record<string, string | number | boolean | null>;
  rawRef?: RawRef;
  detectorId: string;
  detectorVersion: string;
}

export interface PriorCaseRef {
  caseId: string;
  outcome?: string;
  rootCauseClass?: RootCauseClass;
}

/** Task 1 output. */
export interface Hypothesis {
  rootCauseClass: RootCauseClass;
  confidence: number;
  differentials: RootCauseClass[];
  evidenceRefs: string[];
  humanSummary: string;
}

export interface ServiceSchedule {
  kind: "technician_visit" | "hq_recovery";
}

/** Task 2 output. Policy still has to accept it before anything runs. */
export interface Gameplan {
  recommendedActionId: ActionId;
  level: PermissionLevel;
  playbookId: string | null;
  alertParties: AlertParty[];
  schedule: ServiceSchedule | null;
  humanSummary: string;
}

export interface DebugInput {
  caseId: string;
  asset: AssetHeader;
  events: FieldEvent[];
  priorCases: PriorCaseRef[];
}

export interface GameplanInput {
  caseId: string;
  hypothesis: Hypothesis;
  /** True when an L0 safety signature is already on the case. */
  l0Present: boolean;
}
