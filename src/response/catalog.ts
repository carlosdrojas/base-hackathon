// Action catalog (design doc §5). The planner may only pick from these actions; level and approval
// always come from here, never from the model.

import type { ActionType, Approval, Level } from "./types.js";

export interface CatalogEntry {
  level: Level;
  requires: Approval;
  /** Returns data only; allowed on L0 cases, never passes or fails verification. */
  readOnly: boolean;
  /** Changes device state remotely. Blocked on L0 and on unknown / low-confidence hypotheses. */
  remoteActuation: boolean;
  /** Goes through FleetGateway.apply (vs. scheduling a visit or writing a document). */
  deviceAction: boolean;
  description: string;
}

export const CATALOG: Record<ActionType, CatalogEntry> = {
  monitor: {
    level: "L1", requires: "none", readOnly: false, remoteActuation: false, deviceAction: true,
    description: "Watch for recurrence; no device command. Demo shortcut: evaluated immediately.",
  },
  engineer_bug_report: {
    level: "L1", requires: "none", readOnly: true, remoteActuation: false, deviceAction: false,
    description: "Write an engineering bug report. Document only, never a patch.",
  },
  request_log_dump: {
    level: "L2", requires: "ops_or_engineer", readOnly: true, remoteActuation: false, deviceAction: true,
    description: "Pull the firmware log from the device. Read-only.",
  },
  can_health_query: {
    level: "L2", requires: "ops_or_engineer", readOnly: true, remoteActuation: false, deviceAction: true,
    description: "Query CAN bus link health counters. Read-only.",
  },
  reboot: {
    level: "L2", requires: "ops_or_engineer", readOnly: false, remoteActuation: true, deviceAction: true,
    description: "Remote firmware reboot.",
  },
  ota_to_allowlisted: {
    level: "L3", requires: "engineer", readOnly: false, remoteActuation: true, deviceAction: true,
    description: "Update firmware to a signed, allow-listed version (params.target_fw). Engineer approval only.",
  },
  dispatch_tech: {
    level: "L4", requires: "ops_or_engineer", readOnly: false, remoteActuation: false, deviceAction: false,
    description: "Schedule a field technician visit.",
  },
  hq_recovery: {
    level: "L4", requires: "ops_and_engineer", readOnly: false, remoteActuation: false, deviceAction: false,
    description: "Truck the unit back to Base HQ for replacement. Needs ops + engineer.",
  },
};

export const ACTIONS = Object.keys(CATALOG) as ActionType[];

export function isCatalogAction(a: string): a is ActionType {
  return Object.prototype.hasOwnProperty.call(CATALOG, a);
}

const RANK: Record<Level, number> = { L1: 1, L2: 2, L3: 3, L4: 4, L0: 5 };

/** Highest level; L0 (safety) outranks everything. */
export function maxLevel(levels: Level[]): Level {
  return levels.reduce<Level>((best, l) => (RANK[l] > RANK[best] ? l : best), "L1");
}
