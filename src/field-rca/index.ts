/**
 * Public entry for the Field RCA auto-triage workspace.
 * Separate from the Issue Router mock fleet in dashboard-server.ts.
 */

import { createTriagingAgent, type TriagingAgent } from "./agent.js";
import {
  ACTION_IDS,
  EVENT_TYPES,
  PERMISSION_LEVELS,
  ROOT_CAUSE_CLASSES,
  type ActionId,
  type EventType,
  type PermissionLevel,
  type RootCauseClass,
} from "./contracts.js";
import { DETECTOR_IDS } from "./detectors/run.js";
import type { FieldRcaHost } from "./ports.js";

export {
  ACTION_IDS,
  ALERT_PARTIES,
  CASE_STATUSES,
  EVENT_SEVERITIES,
  EVENT_TYPES,
  L0_CLAMP_CAUSES,
  PERMISSION_LEVELS,
  ROLES,
  ROOT_CAUSE_CLASSES,
} from "./contracts.js";
export type {
  ActionId,
  AlertParty,
  AssetHeader,
  CaseStatus,
  DebugInput,
  EventSeverity,
  EventType,
  FieldEvent,
  Gameplan,
  GameplanInput,
  Hypothesis,
  InverterCsvRow,
  PermissionLevel,
  PriorCaseRef,
  RawRef,
  Role,
  RootCauseClass,
  ServiceSchedule,
} from "./contracts.js";
export type { FieldRcaHost, RawSlice } from "./ports.js";
export { createTriagingAgent, FieldRcaNotReadyError } from "./agent.js";
export type { TriagingAgent } from "./agent.js";
export { evidenceFromDeviceStatus } from "./detectors/from-device-status.js";
export { evidenceFromPacketRow } from "./detectors/from-packet.js";
export type { DeviceStatusEvidenceInput } from "./detectors/from-device-status.js";
export { fwIsSigned, signedVersionsFor } from "./detectors/evidence.js";
export type {
  BootEvidence,
  CanEvidence,
  CommissioningEvidence,
  DetectorEvidence,
  FwManifest,
  GridEvidence,
  PlaybookAttempts,
  RailEvidence,
  SafetyEvidence,
  SenseEvidence,
} from "./detectors/evidence.js";
export { DETECTOR_IDS, DETECTOR_VERSION, PLAYBOOK_IDS, hypothesisFromDecision, runDetectors } from "./detectors/run.js";
export type { DetectorDecision, DetectorFinding, DetectorId, DetectorRun, PlaybookId } from "./detectors/run.js";

export interface FieldRcaDescriptor {
  module: "field-rca";
  /** Model-backed debug and gameplan are not wired. */
  ready: false;
  /** Comparison detectors from step 1. */
  detectorsReady: true;
  detectorIds: readonly string[];
  jobs: readonly ["debug", "gameplan"];
  rootCauseClasses: readonly RootCauseClass[];
  actionIds: readonly ActionId[];
  eventTypes: readonly EventType[];
  permissionLevels: readonly PermissionLevel[];
}

export interface FieldRcaWorkspace {
  agent: TriagingAgent;
  describe(): FieldRcaDescriptor;
}

export function createFieldRcaWorkspace(host?: FieldRcaHost): FieldRcaWorkspace {
  const agent = createTriagingAgent(host);
  return {
    agent,
    describe: () => ({
      module: "field-rca",
      ready: false,
      detectorsReady: true,
      detectorIds: DETECTOR_IDS,
      jobs: ["debug", "gameplan"],
      rootCauseClasses: ROOT_CAUSE_CLASSES,
      actionIds: ACTION_IDS,
      eventTypes: EVENT_TYPES,
      permissionLevels: PERMISSION_LEVELS,
    }),
  };
}
