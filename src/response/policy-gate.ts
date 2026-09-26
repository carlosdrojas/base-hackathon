// Policy gate (design doc §2, §5). Deterministic, pure: same inputs → same answer. This is the
// thing that decides whether a step may run, not the model.

import { CATALOG } from "./catalog.js";
import type { DeviceStatus, GateResult, PlannedStep, RcaCase, Role, User } from "./types.js";

export interface GateContext {
  rcaCase: RcaCase;
  /** Latest device-reported status, if known (used for the INV-F900 safety check). */
  status?: DeviceStatus;
  allowlist: string[];
  /** A completed tech visit confirmed the problem on site (outcome no_change or made_safe). */
  onSiteConfirmed: boolean;
  /**
   * "plan": only static rules (ones that can never become true later) deny; used to mark steps
   * `denied` at plan time. "run" (default): every rule applies.
   */
  phase?: "plan" | "run";
}

export type Approvals = PlannedStep["approvals"];

export const SAFETY_FAULT_CODE = "INV-F900";
export const MIN_CONFIDENCE = 0.5;

export function isSafetyCase(c: RcaCase, status?: DeviceStatus): boolean {
  return (
    c.hypothesis?.root_cause === "thermal_or_safety_event" ||
    c.status === "Escalated L0" ||
    (status?.active_fault_codes ?? []).some((code) => code.startsWith(SAFETY_FAULT_CODE))
  );
}

export function isLowConfidence(c: RcaCase): boolean {
  const h = c.hypothesis;
  return !h || h.root_cause === "unknown" || h.confidence < MIN_CONFIDENCE;
}

/** Rules that deny a step regardless of who is asking. */
function staticDenial(step: PlannedStep, ctx: GateContext): string | null {
  const entry = CATALOG[step.action];
  if (!entry) return `"${step.action}" is not in the action catalog`;
  const c = ctx.rcaCase;
  if (entry.remoteActuation) {
    if (isSafetyCase(c, ctx.status)) {
      return "Safety (L0) case: no remote actuation (no reboot, no OTA). Read-only queries only.";
    }
    if (c.hypothesis?.root_cause === "unknown" || !c.hypothesis) {
      return "Hypothesis is unknown: no remote actuation until the cause is diagnosed.";
    }
    if (c.hypothesis.confidence < MIN_CONFIDENCE) {
      return `Confidence ${c.hypothesis.confidence.toFixed(2)} < ${MIN_CONFIDENCE}: no remote actuation.`;
    }
  }
  if (step.action === "ota_to_allowlisted") {
    const target = step.params.target_fw;
    if (!target || !ctx.allowlist.includes(target)) {
      return `OTA target "${target ?? "(none)"}" is not on the firmware allow-list (${ctx.allowlist.join(", ")}). The AI never writes firmware.`;
    }
  }
  return null;
}

/** Rules that deny now but can clear later (evaluated only at run / approval time). */
function dynamicDenial(step: PlannedStep, ctx: GateContext): string | null {
  if (step.action === "hq_recovery" && !isSafetyCase(ctx.rcaCase, ctx.status) && !ctx.onSiteConfirmed) {
    return "HQ recovery needs a hardware problem confirmed on site first (or an L0 safety case). Bias: keep units in the field.";
  }
  return null;
}

function hasRole(approvals: Approvals, role: Role): boolean {
  return approvals.some((a) => a.user.role === role);
}

/** Roles still needed; empty when the approval requirement is satisfied. */
export function missingRoles(step: PlannedStep, approvals: Approvals): Role[] {
  switch (step.requires) {
    case "none":
      return [];
    case "ops_or_engineer":
      return hasRole(approvals, "ops") || hasRole(approvals, "engineer") ? [] : ["ops", "engineer"];
    case "engineer":
      return hasRole(approvals, "engineer") ? [] : ["engineer"];
    case "ops_and_engineer": {
      const missing: Role[] = [];
      if (!hasRole(approvals, "ops")) missing.push("ops");
      if (!hasRole(approvals, "engineer")) missing.push("engineer");
      // Two distinct people: one user can't satisfy both halves.
      if (missing.length === 0 && new Set(approvals.map((a) => a.user.id)).size < 2) return ["ops", "engineer"];
      return missing;
    }
  }
}

/**
 * gate(step, ctx, approvalsSoFar, actingUser?)
 * - without actingUser: can the step run now?
 * - with actingUser: may this user approve it, and does their approval complete the requirement?
 */
export function gate(step: PlannedStep, ctx: GateContext, approvals: Approvals, actingUser?: User): GateResult {
  const denial = staticDenial(step, ctx) ?? (ctx.phase === "plan" ? null : dynamicDenial(step, ctx));
  if (denial) return { kind: "deny", reason: denial };

  if (actingUser) {
    if (actingUser.role === "technician") {
      return { kind: "deny", reason: "Technicians complete visits; they don't approve actions." };
    }
    if (actingUser.role === "admin") {
      return { kind: "deny", reason: "Admin doesn't bypass safety and cannot approve actions." };
    }
    if (step.requires === "none") return { kind: "allow" };
    if (approvals.some((a) => a.user.id === actingUser.id)) {
      return { kind: "deny", reason: `${actingUser.name} already approved this step; it needs a different person.` };
    }
    if (step.requires === "engineer" && actingUser.role !== "engineer") {
      return {
        kind: "deny",
        reason: `${step.action === "ota_to_allowlisted" ? "OTA" : step.action} is engineer only: ${actingUser.role} cannot approve it.`,
      };
    }
    if (step.requires === "ops_and_engineer" && hasRole(approvals, actingUser.role)) {
      return {
        kind: "deny",
        reason: `An ${actingUser.role} user already approved; this step needs one ops and one engineer.`,
      };
    }
    const missing = missingRoles(step, [...approvals, { user: actingUser, ts: "" }]);
    return missing.length === 0 ? { kind: "allow" } : { kind: "needs_approval", requires: step.requires, missing };
  }

  const missing = missingRoles(step, approvals);
  return missing.length === 0 ? { kind: "allow" } : { kind: "needs_approval", requires: step.requires, missing };
}
