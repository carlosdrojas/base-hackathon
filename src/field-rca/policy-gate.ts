/**
 * The model proposes. This gate decides.
 * No API key. L0 flags clamp. Unknown action ids are rejected.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionId, PermissionLevel } from "./contracts.js";
import { playbookById } from "./playbooks.js";

const LEVEL_RANK: Record<PermissionLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export interface CatalogAction {
  id: string;
  max_level: PermissionLevel;
}

export interface GateProposal {
  action_id: string;
  level: PermissionLevel;
  root_cause_class: string;
  confidence: number;
  playbook_id?: string;
}

export interface GateDetectors {
  l0_flags: readonly string[];
  hw_rev: string;
  fw_target: string | null;
}

export type GateResult =
  | { kind: "allow"; action_id: ActionId; level: PermissionLevel }
  | { kind: "clamp"; action_id: "flag_l0_safety"; level: "L0" }
  | { kind: "reject"; reason: string }
  | { kind: "downgrade"; action_id: "dispatch_technician"; level: PermissionLevel; reason: string }
  | { kind: "pending_engineer"; action_id: "ota_allowlisted_fw"; level: PermissionLevel }
  | { kind: "pending_approval"; action_id: ActionId; level: PermissionLevel };

export function gate(
  proposal: GateProposal,
  detectors: GateDetectors,
  options: {
    humanApproved?: boolean;
    catalog?: Readonly<Record<string, CatalogAction>>;
    signedManifest?: Readonly<Record<string, readonly string[]>>;
  } = {},
): GateResult {
  if (detectors.l0_flags.length > 0) return { kind: "clamp", action_id: "flag_l0_safety", level: "L0" };

  const catalog = options.catalog ?? loadCatalog();
  const action = catalog[proposal.action_id];
  if (!action) return { kind: "reject", reason: `unknown action ${proposal.action_id}` };

  let level = minLevel(proposal.level, action.max_level);
  if (proposal.playbook_id) {
    const book = playbookById(proposal.playbook_id);
    if (!book) return { kind: "reject", reason: `unknown playbook ${proposal.playbook_id}` };
    if (book.class !== proposal.root_cause_class) return { kind: "reject", reason: "playbook does not match class" };
    level = minLevel(level, book.max_level);
  }
  if (action.id === "schedule_hq_recovery") {
    if (proposal.root_cause_class !== "true_hardware_defect") {
      return { kind: "reject", reason: "HQ pull not allowed without hardware class" };
    }
    if (proposal.confidence < 0.85) {
      const reseat = catalog.dispatch_technician;
      if (!reseat) return { kind: "reject", reason: "dispatch_technician missing from catalog" };
      return { kind: "downgrade", action_id: "dispatch_technician", level: reseat.max_level, reason: "reseat first" };
    }
  } else if (action.id === "ota_allowlisted_fw") {
    const signed = options.signedManifest?.[detectors.hw_rev] ?? [];
    if (!detectors.fw_target || !signed.includes(detectors.fw_target)) {
      return { kind: "reject", reason: "version not on allow-list" };
    }
    return { kind: "pending_engineer", action_id: "ota_allowlisted_fw", level };
  }

  if ((level === "L2" || level === "L3") && options.humanApproved !== true) {
    return { kind: "pending_approval", action_id: action.id as ActionId, level };
  }
  return { kind: "allow", action_id: action.id as ActionId, level };
}

export function minLevel(left: PermissionLevel, right: PermissionLevel): PermissionLevel {
  return LEVEL_RANK[left] <= LEVEL_RANK[right] ? left : right;
}

export function parseCatalog(text: string): Record<string, CatalogAction> {
  const catalog: Record<string, CatalogAction> = {};
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "actions:") continue;
    const header = /^([a-z0-9_]+):$/.exec(line);
    if (header?.[1]) {
      current = header[1];
      continue;
    }
    const level = /^max_level:\s*(L[0-4])$/.exec(line);
    if (level?.[1] && current) {
      catalog[current] = { id: current, max_level: level[1] as PermissionLevel };
    }
  }
  return catalog;
}

export function loadCatalog(file = defaultCatalogPath()): Record<string, CatalogAction> {
  return parseCatalog(fs.readFileSync(file, "utf8"));
}

function defaultCatalogPath(): string {
  const besideModule = fileURLToPath(new URL("./policy-catalog.yaml", import.meta.url));
  if (fs.existsSync(besideModule)) return besideModule;
  return path.join(process.cwd(), "src", "field-rca", "policy-catalog.yaml");
}
