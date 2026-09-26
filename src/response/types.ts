// Shared contracts for the Response Agent + Fake Fleet.
// Design: docs/field-rca/response-agent.md. Parallel builders code against this file and must
// not edit it; if something is missing, add it in your own file and flag it at integration.

// ---------------------------------------------------------------------------
// Taxonomy (closed sets, from docs/field-rca/software-structure.md)
// ---------------------------------------------------------------------------

export type RootCause =
  | "fw_version_mismatch"
  | "fw_soft_fault_reboot_candidate"
  | "can_link_unreliable"
  | "install_commissioning_incomplete"
  | "install_wiring_or_sense_error"
  | "grid_or_home_side_condition"
  | "thermal_or_safety_event"
  | "true_hardware_defect"
  | "no_fault_found"
  | "unknown";

/** Faults the simulator can plant. `unknown` is a diagnosis, never a true fault. */
export type PlantableFault = Exclude<RootCause, "unknown">;

export type Level = "L0" | "L1" | "L2" | "L3" | "L4";

export type ActionType =
  | "monitor" //              L1  watch for recurrence, no device command
  | "request_log_dump" //     L2  read-only
  | "can_health_query" //     L2  read-only
  | "reboot" //               L2  remote firmware reboot
  | "ota_to_allowlisted" //   L3  update to a signed, allow-listed version (params.target_fw)
  | "dispatch_tech" //        L4  schedule a field visit
  | "hq_recovery" //          L4  truck the unit back to Base HQ
  | "engineer_bug_report"; // L1  document only, never a patch

export type Role = "technician" | "ops" | "engineer" | "admin";

export interface User {
  id: string;
  name: string;
  role: Role;
}

/** Who must click Approve before an action runs. */
export type Approval = "none" | "ops_or_engineer" | "engineer" | "ops_and_engineer";

// ---------------------------------------------------------------------------
// Fake fleet (src/sim/) — the device side
// ---------------------------------------------------------------------------

/**
 * Full truth about one simulated inverter. `fault` is hidden from diagnosis: only the sim, the
 * hypothesis stub, and the telemetry renderer (owned by a teammate) may read it.
 */
export interface UnitState {
  vin: string;
  asset_id: string;
  site: string; // street address, for display
  lat: number;
  lng: number;
  hw_rev: string;
  sku: string;
  fw_version: string;
  install_date: string; // ISO date
  crew_id: string;
  fault: PlantableFault | null;
  fault_time: string | null; // ISO
  online: boolean;
  uptime_s: number;
  last_boot_reason: "power_on" | "WDT" | "reboot_cmd" | "ota";
  action_history: ActionRecord[];
}

export interface ActionRecord {
  action: ActionType | "tech_visit";
  ts: string; // ISO
  result: ActionResult["outcome"];
}

/** What the device reports about itself. Observable, so diagnosis and verification may read it. */
export interface DeviceStatus {
  vin: string;
  asset_id: string;
  fw_version: string;
  online: boolean;
  faulted: boolean;
  active_fault_codes: string[]; // MOCKED codes, see design doc §Fault codes
  uptime_s: number;
  last_boot_reason: UnitState["last_boot_reason"];
  last_seen: string; // ISO
}

export interface ActionResult {
  vin: string;
  action: ActionType | "tech_visit";
  outcome:
    | "cleared" //            fault gone
    | "no_change" //          fault still present
    | "refused_interlock" //  device refused (safety fault present)
    | "info_only" //          read-only action, returned data
    | "nothing_found" //      tech found nothing wrong → avoided false pull
    | "made_safe" //          tech made a safety unit safe; needs HQ recovery
    | "replaced"; //          unit swapped at HQ
  detail: string; // one human-readable line
  status_after: DeviceStatus;
}

/** Field-visit completion submitted by a technician. */
export interface VisitOutcome {
  completed: boolean;
  photos_attached: boolean; // required for connector / install jobs
  incomplete_reason?: "parts" | "access" | "did_not_know" | "unsafe" | "needs_engineer";
  notes?: string;
}

/** The only way the response engine touches devices. Implemented by FleetSim. */
export interface FleetGateway {
  list(): DeviceStatus[];
  getStatus(vin: string): DeviceStatus;
  apply(vin: string, action: ActionType, params?: Record<string, string>): ActionResult;
  /** A technician's on-site work. Only the engine calls this, from completeVisit(). */
  techVisit(vin: string, outcome: VisitOutcome): ActionResult;
  /** Demo controls. */
  plantFault(vin: string, fault: PlantableFault): void;
  reset(): void;
  /** Truth for the hypothesis stub and the telemetry renderer. Never shown to the planner. */
  getUnitState(vin: string): UnitState;
}

/** Hook for the telemetry teammate: renders a unit's truth into CSV rows / FW log + CAN packets. */
export interface TelemetryRenderer {
  csvRow(state: UnitState): Record<string, string>;
  renderPacket(state: UnitState): { fw_log: string; can_stats: unknown };
}

// ---------------------------------------------------------------------------
// Diagnosis input (Task 1 owns the real one; we stub it)
// ---------------------------------------------------------------------------

export interface Hypothesis {
  case_id: string;
  vin: string;
  root_cause: RootCause;
  confidence: number; // 0–1
  evidence: string[]; // one-line evidence strings (or Event ids once Task 1 exists)
  fw_version: string;
  source: "stub" | "task1";
}

export interface HypothesisSource {
  diagnose(caseId: string, status: DeviceStatus): Promise<Hypothesis>;
}

// ---------------------------------------------------------------------------
// Response engine (src/response/)
// ---------------------------------------------------------------------------

export type CaseStatus =
  | "Open"
  | "Investigating"
  | "Action pending"
  | "In progress"
  | "Field visit"
  | "Engineer review"
  | "Escalated L0"
  | "Closed";

export type StepState =
  | "planned"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "denied" //    blocked by the policy gate
  | "running"
  | "done"
  | "failed" //    ran, fault still present
  | "skipped";

export interface PlannedStep {
  step_id: string;
  action: ActionType;
  params: Record<string, string>;
  level: Level;
  requires: Approval;
  expected_effect: string;
  rationale: string;
  state: StepState;
  approvals: { user: User; ts: string }[];
  result?: ActionResult;
}

export interface Alert {
  role: Role | "driver";
  reason: string;
}

export interface Gameplan {
  case_id: string;
  level: Level; // highest level among steps
  steps: PlannedStep[]; // ordered, cheapest / safest first
  alerts: Alert[];
  summary: string;
  source: "claude" | "playbook";
  created_at: string;
}

export interface ScheduledVisit {
  visit_id: string;
  case_id: string;
  vin: string;
  kind: "tech_visit" | "hq_recovery";
  assignee: User; // technician or driver
  slot_start: string; // ISO
  slot_end: string;
  brief: string; // short "why you are here"
  checklist: string[];
  photos_required: boolean;
  state: "scheduled" | "completed" | "incomplete";
  outcome?: VisitOutcome;
}

export interface BugReport {
  report_id: string;
  fw_version: string;
  root_cause: RootCause;
  case_ids: string[];
  vins: string[];
  title: string;
  body_md: string;
  recommendation: string; // e.g. "OTA affected units to allow-listed 3.4.0" — never a patch
  source: "claude" | "template";
  created_at: string;
}

export type CaseEventKind =
  | "case_opened"
  | "hypothesis"
  | "gameplan"
  | "approval_requested"
  | "approved"
  | "rejected"
  | "gate_denied"
  | "action_run"
  | "verify_pass"
  | "verify_fail"
  | "escalated"
  | "visit_scheduled"
  | "visit_completed"
  | "visit_incomplete"
  | "alert_sent"
  | "bug_report_linked"
  | "status_changed"
  | "closed";

export interface CaseEvent {
  event_id: string;
  case_id: string;
  ts: string;
  kind: CaseEventKind;
  actor: "agent" | "system" | User;
  summary: string; // one line, shown on the timeline
  detail?: Record<string, unknown>;
}

export interface RcaCase {
  case_id: string;
  vin: string;
  asset_id: string;
  site: string;
  fw_version: string;
  trigger: "fault_flag" | "manual";
  opened_at: string;
  status: CaseStatus;
  hypothesis?: Hypothesis;
  gameplan?: Gameplan;
  visits: string[]; // visit_ids
  outcome?: "fixed_remote" | "fixed_on_site" | "avoided_false_pull" | "pulled_justified" | "l0_made_safe";
  timeline: CaseEvent[];
}

export type GateResult =
  | { kind: "allow" }
  | { kind: "needs_approval"; requires: Approval; missing: Role[] }
  | { kind: "deny"; reason: string };

export interface ResponseMetrics {
  open_cases: number;
  closed_cases: number;
  fixed_remote: number;
  avoided_false_pulls: number;
  truck_rolls: number;
  unnecessary_pulls: number; // hq_recovery on a unit whose true fault was not hardware
  gate_denials: number;
}

export interface ResponseState {
  fleet: DeviceStatus[];
  cases: RcaCase[];
  visits: ScheduledVisit[];
  bug_reports: BugReport[];
  users: User[];
  metrics: ResponseMetrics;
  planner: "claude" | "playbook"; // which planner is active
  mocked: true; // UI must label everything as MOCKED
}

/** The only API the UI / routes call. */
export interface ResponseEngine {
  getState(): ResponseState;
  /** Open a case for every faulted unit without an open case; diagnose + plan each. */
  ingestFaults(): Promise<RcaCase[]>;
  /** Run auto-allowed steps, verify results, advance cases. Idempotent; called on a timer. */
  tick(): Promise<void>;
  approve(caseId: string, stepId: string, user: User): Promise<GateResult>;
  reject(caseId: string, stepId: string, user: User, reason: string): Promise<void>;
  completeVisit(visitId: string, user: User, outcome: VisitOutcome): Promise<void>;
  /** Engineer only. Allowed from "Engineer review" or "Escalated L0" once made safe. */
  closeCase(caseId: string, user: User, note: string): Promise<void>;
  plantFault(vin: string, fault: PlantableFault): Promise<void>;
  reset(): Promise<void>;
}
