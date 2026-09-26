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

export interface FieldRcaDescriptor {
  module: "field-rca";
  ready: false;
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
      jobs: ["debug", "gameplan"],
      rootCauseClasses: ROOT_CAUSE_CLASSES,
      actionIds: ACTION_IDS,
      eventTypes: EVENT_TYPES,
      permissionLevels: PERMISSION_LEVELS,
    }),
  };
}
