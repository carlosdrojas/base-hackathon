/**
 * Deterministic detectors. Comparisons and signatures only.
 * true_hardware_defect is reached only when every explanation above it is absent
 * and both the reboot and reseat playbooks have already run with the fault still present.
 * Any L0 safety signature forces flag_l0_safety and blocks reboot and OTA.
 */

import type {
  ActionId,
  EventSeverity,
  EventType,
  FieldEvent,
  Hypothesis,
  PermissionLevel,
  RootCauseClass,
} from "../contracts.js";
import {
  CAN_DROPPED_FRAMES_MIN,
  CAN_ERROR_FRAMES_MIN,
  CAN_LINK_FLAPS_MIN,
  CELL_OVERTEMP_C,
  CELL_OVERTEMP_CURRENT_A,
  GRID_HZ_MAX,
  GRID_HZ_MIN,
  GRID_VOLTAGE_MAX_V,
  GRID_VOLTAGE_MIN_V,
  HOUSE_LOAD_ISLANDING_KW,
} from "./thresholds.js";
import {
  fwIsSigned,
  signedVersionsFor,
  type BootEvidence,
  type CanEvidence,
  type DetectorEvidence,
  type FwManifest,
  type GridEvidence,
  type PlaybookAttempts,
  type RailEvidence,
  type SafetyEvidence,
} from "./evidence.js";

export const DETECTOR_VERSION = "1";

export const PLAYBOOK_IDS = [
  "flag_l0_safety",
  "ota_allowlisted_fw",
  "reboot_watchdog",
  "reseat_can",
  "commissioning_photos",
  "wiring_sense_photos",
  "monitor_grid_home",
  "nff_monitor",
  "hq_recovery_last",
  "hold_unknown",
] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export const DETECTOR_IDS = [
  "src_fault_flag",
  "fw_allowlist",
  "fw_watchdog",
  "fw_fault_print",
  "can_link",
  "commissioning",
  "sense_wiring",
  "grid_home",
  "l0_safety",
  "connectivity",
  "no_fault_found",
  "true_hardware",
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/** First match is the primary class. Hardware and NFF are applied only if this list is empty. */
const CLASS_PRECEDENCE: readonly RootCauseClass[] = [
  "thermal_or_safety_event",
  "grid_or_home_side_condition",
  "fw_version_mismatch",
  "can_link_unreliable",
  "install_commissioning_incomplete",
  "install_wiring_or_sense_error",
  "fw_soft_fault_reboot_candidate",
];

const REMOTE_ACTUATION: readonly ActionId[] = ["reboot_firmware", "ota_allowlisted_fw"];

export interface DetectorFinding {
  detectorId: DetectorId;
  rootCauseClass: RootCauseClass;
  maxLevel: PermissionLevel;
  actionId: ActionId;
  playbookId: PlaybookId;
  photosRequired: boolean;
  confidence: number;
  summary: string;
}

export interface DetectorDecision {
  rootCauseClass: RootCauseClass;
  maxLevel: PermissionLevel;
  actionId: ActionId;
  playbookId: PlaybookId;
  photosRequired: boolean;
  /** Safety signature. The action is flag_l0_safety. Reboot and OTA are blocked. */
  smokingInverterRule: boolean;
  blockedActionIds: ActionId[];
  differentials: RootCauseClass[];
  confidence: number;
  summary: string;
}

export interface DetectorRun {
  decision: DetectorDecision;
  events: FieldEvent[];
  findings: DetectorFinding[];
}

export function runDetectors(evidence: DetectorEvidence, manifest: FwManifest): DetectorRun {
  const events: FieldEvent[] = [];
  const findings: DetectorFinding[] = [];

  const fault = faultFlag(evidence);
  events.push(...fault.events);

  const codes = faultPrints(evidence);
  events.push(...codes.events);

  const fw = fwAllowList(evidence, manifest);
  events.push(...fw.events);
  if (fw.finding) findings.push(fw.finding);

  const watchdog = fwWatchdog(evidence);
  events.push(...watchdog.events);
  if (watchdog.finding) findings.push(watchdog.finding);

  const can = canLink(evidence);
  events.push(...can.events);
  if (can.finding) findings.push(can.finding);

  const commissioning = commissioningCheck(evidence);
  if (commissioning.finding) findings.push(commissioning.finding);

  const sense = senseWiring(evidence);
  if (sense.finding) findings.push(sense.finding);

  const grid = gridHome(evidence);
  if (grid.finding) findings.push(grid.finding);

  const safety = l0Safety(evidence);
  events.push(...safety.events);
  if (safety.finding) findings.push(safety.finding);

  const link = connectivity(evidence);
  events.push(...link.events);

  const decision = combine(evidence, manifest, findings);
  return { decision, events, findings };
}

export function hypothesisFromDecision(decision: DetectorDecision, events: FieldEvent[]): Hypothesis {
  return {
    rootCauseClass: decision.rootCauseClass,
    confidence: decision.confidence,
    differentials: decision.differentials,
    evidenceRefs: events.map((event) => event.eventId),
    humanSummary: decision.summary,
  };
}

function combine(
  evidence: DetectorEvidence,
  manifest: FwManifest,
  findings: DetectorFinding[],
): DetectorDecision {
  const ranked = [...findings].sort(
    (a, b) => precedence(a.rootCauseClass) - precedence(b.rootCauseClass),
  );
  const primary = ranked[0];
  if (primary) {
    const smoking = primary.rootCauseClass === "thermal_or_safety_event";
    const differentials = unique(ranked.slice(1).map((finding) => finding.rootCauseClass));
    return {
      rootCauseClass: primary.rootCauseClass,
      maxLevel: primary.maxLevel,
      actionId: primary.actionId,
      playbookId: primary.playbookId,
      photosRequired: primary.photosRequired,
      smokingInverterRule: smoking,
      blockedActionIds: blocked(smoking, primary.actionId),
      differentials,
      confidence: primary.confidence,
      summary: smoking ? `${primary.summary} Reboot and OTA are blocked.` : primary.summary,
    };
  }

  if (positiveNoFault(evidence, manifest)) {
    return residual({
      rootCauseClass: "no_fault_found",
      maxLevel: "L1",
      actionId: "mark_no_fault_found_monitor",
      playbookId: "nff_monitor",
      photosRequired: false,
      confidence: 0.9,
      summary: "Rails present, CAN within limits, firmware on the signed manifest, no repeating fault code. Keep the unit in the field.",
    });
  }

  if (evidence.faulted && hardwareGate(evidence.attempts)) {
    return residual({
      rootCauseClass: "true_hardware_defect",
      maxLevel: "L4",
      actionId: "schedule_hq_recovery",
      playbookId: "hq_recovery_last",
      photosRequired: false,
      confidence: 0.8,
      summary:
        "No firmware, CAN, install, sense, grid, or safety signature explains the fault, and the reboot and reseat playbooks have both already run with the fault still present.",
    });
  }

  if (!evidence.faulted) {
    return residual({
      rootCauseClass: "no_fault_found",
      maxLevel: "L1",
      actionId: "mark_no_fault_found_monitor",
      playbookId: "nff_monitor",
      photosRequired: false,
      confidence: 0.55,
      summary: "No fault flag and no detector signature. This is not a positive healthy-rail proof.",
    });
  }

  return residual({
    rootCauseClass: "unknown",
    maxLevel: "L0",
    actionId: "request_log_dump",
    playbookId: "hold_unknown",
    photosRequired: false,
    confidence: 0.35,
    summary:
      "No explanatory signature. Reboot, OTA, and HQ recovery stay blocked until a reboot playbook and a reseat playbook have both run and the fault is still present.",
  });
}

function residual(partial: Omit<DetectorDecision, "smokingInverterRule" | "blockedActionIds" | "differentials">): DetectorDecision {
  const smoking = partial.rootCauseClass === "thermal_or_safety_event";
  return {
    ...partial,
    smokingInverterRule: smoking,
    blockedActionIds: blocked(smoking || partial.rootCauseClass === "unknown", partial.actionId),
    differentials: [],
  };
}

function blocked(blockRemote: boolean, actionId: ActionId): ActionId[] {
  const ids: ActionId[] = [];
  if (blockRemote) ids.push(...REMOTE_ACTUATION);
  if (actionId !== "schedule_hq_recovery") ids.push("schedule_hq_recovery");
  return ids;
}

function precedence(rootCause: RootCauseClass): number {
  const index = CLASS_PRECEDENCE.indexOf(rootCause);
  return index === -1 ? CLASS_PRECEDENCE.length : index;
}

function unique(classes: RootCauseClass[]): RootCauseClass[] {
  const seen = new Set<RootCauseClass>();
  const out: RootCauseClass[] = [];
  for (const rootCause of classes) {
    if (seen.has(rootCause)) continue;
    seen.add(rootCause);
    out.push(rootCause);
  }
  return out;
}

function hardwareGate(attempts: PlaybookAttempts | undefined): boolean {
  return (
    attempts?.rebootPlaybookDone === true &&
    attempts?.reseatPlaybookDone === true &&
    attempts?.faultRepeatedAfterBoth === true
  );
}

function positiveNoFault(evidence: DetectorEvidence, manifest: FwManifest): boolean {
  if (!evidence.faulted) return false;
  if (evidence.activeFaultCodes.length > 0 || evidence.repeatFaultCode) return false;
  if (!railsLookHealthy(evidence.rails)) return false;
  if (!evidence.can || canIsUnreliable(evidence.can)) return false;
  if (!fwIsSigned(manifest, evidence.hwRev, evidence.fwVersion)) return false;
  if (safetySignature(evidence.safety)) return false;
  if (evidence.offline) return false;
  return true;
}

function faultFlag(evidence: DetectorEvidence): { events: FieldEvent[] } {
  if (!evidence.faulted) return { events: [] };
  return {
    events: [
      event(evidence, "src_fault_flag", "src.fault_flag", "warn", `Fault flag set at ${evidence.observedAt}.`, {
        faulted: true,
      }),
    ],
  };
}

function faultPrints(evidence: DetectorEvidence): { events: FieldEvent[] } {
  return {
    events: evidence.activeFaultCodes.map((code) =>
      event(
        evidence,
        "fw_fault_print",
        "fw.fault_code",
        "warn",
        `Fault code ${code}.`,
        { code },
        code,
      ),
    ),
  };
}

function fwAllowList(
  evidence: DetectorEvidence,
  manifest: FwManifest,
): { events: FieldEvent[]; finding: DetectorFinding | null } {
  if (fwIsSigned(manifest, evidence.hwRev, evidence.fwVersion)) {
    return { events: [], finding: null };
  }
  const allowed = signedVersionsFor(manifest, evidence.hwRev);
  const signed = allowed.length > 0 ? allowed.join(", ") : "none";
  const rev = evidence.hwRev ?? "unknown rev";
  const installed = evidence.fwVersion ?? "missing";
  const summary = `FW ${installed} not on allow-list for ${rev} (signed: ${signed}).`;
  return {
    events: [
      event(evidence, "fw_allowlist", "fw.version_mismatch", "fault", summary, {
        fw_version: installed,
        hw_rev: rev,
        signed,
      }),
    ],
    finding: finding({
      detectorId: "fw_allowlist",
      rootCauseClass: "fw_version_mismatch",
      maxLevel: "L3",
      actionId: "ota_allowlisted_fw",
      playbookId: "ota_allowlisted_fw",
      photosRequired: false,
      summary,
    }),
  };
}

function fwWatchdog(evidence: DetectorEvidence): { events: FieldEvent[]; finding: DetectorFinding | null } {
  const boot = evidence.boot;
  if (!boot || !softBootSeen(boot)) return { events: [], finding: null };
  const events: FieldEvent[] = [];
  if (boot.reason === "WDT" || boot.watchdogResets > 0) {
    events.push(
      event(
        evidence,
        "fw_watchdog",
        "fw.watchdog",
        "warn",
        `Watchdog reset count ${boot.watchdogResets} at ${evidence.observedAt}, boot reason=${boot.reason ?? "none"}.`,
        {
          boot_reason: boot.reason,
          watchdog_resets: boot.watchdogResets,
          repeated: boot.repeatedSoftReset,
        },
      ),
    );
  }
  if (boot.reason === "panic" || boot.panicCount > 0) {
    events.push(
      event(evidence, "fw_watchdog", "fw.panic", "fault", `Panic count ${boot.panicCount} at ${evidence.observedAt}.`, {
        panic_count: boot.panicCount,
        boot_reason: boot.reason,
      }),
    );
  }
  if (boot.reason === "WDT" || boot.reason === "panic") {
    events.push(
      event(evidence, "fw_watchdog", "fw.boot", "info", `Boot reason ${boot.reason} at ${evidence.observedAt}.`, {
        boot_reason: boot.reason,
      }),
    );
  }
  if (!(softBootSeen(boot) && repeatedSoft(boot) && railsLookHealthy(evidence.rails))) {
    return { events, finding: null };
  }
  return {
    events,
    finding: finding({
      detectorId: "fw_watchdog",
      rootCauseClass: "fw_soft_fault_reboot_candidate",
      maxLevel: "L2",
      actionId: "reboot_firmware",
      playbookId: "reboot_watchdog",
      photosRequired: false,
      summary: "Repeated watchdog or panic with healthy rails. Reboot is the candidate, not an HQ pull.",
    }),
  };
}

function canLink(evidence: DetectorEvidence): { events: FieldEvent[]; finding: DetectorFinding | null } {
  const can = evidence.can;
  if (!can || !canIsUnreliable(can)) return { events: [], finding: null };
  const events: FieldEvent[] = [];
  if (can.busOffCount > 0) {
    events.push(
      event(evidence, "can_link", "can.bus_off", "fault", `Bus-off count ${can.busOffCount} at ${evidence.observedAt}.`, {
        bus_off_count: can.busOffCount,
      }),
    );
  }
  if (can.missingNodes.length > 0) {
    events.push(
      event(
        evidence,
        "can_link",
        "can.node_missing",
        "fault",
        `CAN node ${can.missingNodes.join(", ")} missing at ${evidence.observedAt}.`,
        { nodes: can.missingNodes.join(","), count: can.missingNodes.length },
      ),
    );
  }
  if (can.linkFlapCount >= CAN_LINK_FLAPS_MIN) {
    events.push(
      event(evidence, "can_link", "can.link_flap", "warn", `CAN link flap count ${can.linkFlapCount}.`, {
        link_flaps: can.linkFlapCount,
      }),
    );
  }
  if (can.errorFrames >= CAN_ERROR_FRAMES_MIN || can.droppedFrames >= CAN_DROPPED_FRAMES_MIN) {
    events.push(
      event(
        evidence,
        "can_link",
        "can.error_burst",
        "warn",
        `CAN error frames ${can.errorFrames}, dropped frames ${can.droppedFrames}.`,
        { error_frames: can.errorFrames, dropped_frames: can.droppedFrames },
      ),
    );
  }
  const physical = can.busOffCount > 0 || can.missingNodes.length > 0;
  return {
    events,
    finding: finding({
      detectorId: "can_link",
      rootCauseClass: "can_link_unreliable",
      maxLevel: physical ? "L4" : "L1",
      actionId: physical ? "dispatch_technician" : "request_log_dump",
      playbookId: "reseat_can",
      photosRequired: physical,
      summary: physical
        ? "CAN bus-off or a missing node. Reseat the connector on a tech visit. Do not pull the unit to HQ."
        : "CAN errors, drops, or link flaps above the window limit. Recommend a reseat. Do not pull the unit to HQ.",
    }),
  };
}

function commissioningCheck(evidence: DetectorEvidence): { finding: DetectorFinding | null } {
  const row = evidence.commissioning;
  if (!row) return { finding: null };
  const checklist = row.checklistComplete === false;
  const selfTest = row.firstBootSelfTestPass === false;
  if (!checklist && !selfTest) return { finding: null };
  const why = [
    checklist ? "commissioning checklist incomplete" : null,
    selfTest ? "first-boot self-test failed" : null,
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
  return {
    finding: finding({
      detectorId: "commissioning",
      rootCauseClass: "install_commissioning_incomplete",
      maxLevel: "L4",
      actionId: "dispatch_technician",
      playbookId: "commissioning_photos",
      photosRequired: true,
      summary: `Install commissioning: ${why}. Tech visit with photos. Do not pull the unit to HQ.`,
    }),
  };
}

function senseWiring(evidence: DetectorEvidence): { finding: DetectorFinding | null } {
  const sense = evidence.sense;
  const missingRail = evidence.rails?.missingWhenMated === true;
  const gridSense = sense?.gridSenseImplausible === true;
  const ct = sense?.ctPolarityReversed === true;
  if (!missingRail && !gridSense && !ct) return { finding: null };
  const why = [
    gridSense ? "grid sense implausible" : null,
    ct ? "CT polarity reversed" : null,
    missingRail ? "rail missing on a mated connector" : null,
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
  return {
    finding: finding({
      detectorId: "sense_wiring",
      rootCauseClass: "install_wiring_or_sense_error",
      maxLevel: "L4",
      actionId: "dispatch_technician",
      playbookId: "wiring_sense_photos",
      photosRequired: true,
      summary: `Sense or wiring: ${why}. Tech visit with photos. Do not pull the unit to HQ.`,
    }),
  };
}

function gridHome(evidence: DetectorEvidence): { finding: DetectorFinding | null } {
  const grid = evidence.grid;
  if (!grid || !gridOutside(grid)) return { finding: null };
  return {
    finding: finding({
      detectorId: "grid_home",
      rootCauseClass: "grid_or_home_side_condition",
      maxLevel: "L1",
      actionId: "mark_no_fault_found_monitor",
      playbookId: "monitor_grid_home",
      photosRequired: false,
      summary: gridSummary(grid),
    }),
  };
}

function l0Safety(evidence: DetectorEvidence): { events: FieldEvent[]; finding: DetectorFinding | null } {
  const safety = evidence.safety;
  if (!safetySignature(safety)) return { events: [], finding: null };
  const events: FieldEvent[] = [];
  if (thermalSignature(safety)) {
    events.push(
      event(evidence, "l0_safety", "safety.thermal", "l0", thermalSummary(safety, evidence.observedAt), {
        cell_temp_max_c: safety?.cellTempMaxC ?? null,
        pack_current_a: safety?.packCurrentA ?? null,
        pyro_fuse_activated: safety?.pyroFuseActivated === true,
      }),
    );
  }
  if (safety?.insulationFault === true || safety?.unexpectedHv === true) {
    events.push(
      event(evidence, "l0_safety", "safety.hv", "l0", "Insulation fault or unexpected HV. No remote actuation.", {
        insulation_fault: safety.insulationFault === true,
        unexpected_hv: safety.unexpectedHv === true,
      }),
    );
  }
  return {
    events,
    finding: finding({
      detectorId: "l0_safety",
      rootCauseClass: "thermal_or_safety_event",
      maxLevel: "L0",
      actionId: "flag_l0_safety",
      playbookId: "flag_l0_safety",
      photosRequired: false,
      confidence: 0.98,
      summary: "L0 safety signature. Flag only. No reboot, no OTA, no further remote tries.",
    }),
  };
}

function connectivity(evidence: DetectorEvidence): { events: FieldEvent[] } {
  if (evidence.offline !== true) return { events: [] };
  return {
    events: [
      event(evidence, "connectivity", "net.offline", "warn", `Unit offline at ${evidence.observedAt}.`, {
        online: false,
      }),
    ],
  };
}

function event(
  evidence: DetectorEvidence,
  detectorId: DetectorId,
  eventType: EventType,
  severity: EventSeverity,
  summary: string,
  fields: FieldEvent["fields"],
  idPart?: string,
): FieldEvent {
  const id = [evidence.caseId, detectorId, eventType, idPart, evidence.observedAt].filter(Boolean).join(":");
  return {
    eventId: id,
    caseId: evidence.caseId,
    vin: evidence.vin,
    ts: evidence.observedAt,
    eventType,
    severity,
    summary,
    fields,
    detectorId,
    detectorVersion: DETECTOR_VERSION,
  };
}

function finding(input: Omit<DetectorFinding, "confidence"> & { confidence?: number }): DetectorFinding {
  return { confidence: 0.92, ...input };
}

function softBootSeen(boot: BootEvidence): boolean {
  return boot.reason === "WDT" || boot.reason === "panic" || boot.watchdogResets > 0 || boot.panicCount > 0;
}

function repeatedSoft(boot: BootEvidence): boolean {
  return boot.repeatedSoftReset || boot.watchdogResets >= 2 || boot.panicCount >= 2;
}

function railsLookHealthy(rails: RailEvidence | undefined): boolean {
  return rails?.allPresent === true && rails.healthy === true && rails.missingWhenMated === false;
}

function canIsUnreliable(can: CanEvidence): boolean {
  return (
    can.busOffCount > 0 ||
    can.missingNodes.length > 0 ||
    can.linkFlapCount >= CAN_LINK_FLAPS_MIN ||
    can.errorFrames >= CAN_ERROR_FRAMES_MIN ||
    can.droppedFrames >= CAN_DROPPED_FRAMES_MIN
  );
}

function gridOutside(grid: GridEvidence): boolean {
  if (grid.voltageOutsideWindow === true || grid.freqOutsideWindow === true) return true;
  if (typeof grid.voltageV === "number" && (grid.voltageV < GRID_VOLTAGE_MIN_V || grid.voltageV > GRID_VOLTAGE_MAX_V)) {
    return true;
  }
  if (typeof grid.freqHz === "number" && (grid.freqHz < GRID_HZ_MIN || grid.freqHz > GRID_HZ_MAX)) {
    return true;
  }
  return (
    typeof grid.houseLoadKw === "number" &&
    grid.houseLoadKw > HOUSE_LOAD_ISLANDING_KW &&
    grid.islandingFailed === true
  );
}

function gridSummary(grid: GridEvidence): string {
  if (typeof grid.houseLoadKw === "number" && grid.houseLoadKw > HOUSE_LOAD_ISLANDING_KW && grid.islandingFailed === true) {
    return `House load ${grid.houseLoadKw} kW is above ${HOUSE_LOAD_ISLANDING_KW} kW and islanding failed. Monitor. The inverter stays in the field.`;
  }
  return "Grid voltage or frequency is outside the window. Monitor. The inverter stays in the field.";
}

function safetySignature(safety: SafetyEvidence | undefined): boolean {
  if (!safety) return false;
  return thermalSignature(safety) || safety.insulationFault === true || safety.unexpectedHv === true;
}

function thermalSignature(safety: SafetyEvidence | undefined): boolean {
  if (!safety) return false;
  if (safety.overtemp === true || safety.overtempWarning === true || safety.thermalOrSmoke === true) return true;
  if (safety.pyroFuseActivated === true) return true;
  const temp = safety.cellTempMaxC;
  const current = safety.packCurrentA;
  return (
    typeof temp === "number" &&
    typeof current === "number" &&
    temp > CELL_OVERTEMP_C &&
    Math.abs(current) > CELL_OVERTEMP_CURRENT_A
  );
}

function thermalSummary(safety: SafetyEvidence | undefined, observedAt: string): string {
  if (safety?.pyroFuseActivated === true) {
    return `Pyro fuse activated at ${observedAt}. No remote actuation.`;
  }
  if (typeof safety?.cellTempMaxC === "number" && typeof safety.packCurrentA === "number") {
    return `Cell temp ${safety.cellTempMaxC}C with pack current ${safety.packCurrentA}A at ${observedAt}.`;
  }
  return `Thermal or smoke signature at ${observedAt}.`;
}
