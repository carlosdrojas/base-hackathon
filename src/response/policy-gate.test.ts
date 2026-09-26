import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "./catalog.js";
import { gate, type GateContext } from "./policy-gate.js";
import type { ActionType, DeviceStatus, PlannedStep, RcaCase, RootCause, User } from "./types.js";

const tech: User = { id: "u-osei", name: "D. Osei", role: "technician" };
const ops: User = { id: "u-alvarez", name: "M. Alvarez", role: "ops" };
const ops2: User = { id: "u-ops2", name: "Second Ops", role: "ops" };
const eng: User = { id: "u-park", name: "J. Park", role: "engineer" };
const admin: User = { id: "u-admin", name: "Admin", role: "admin" };

function mkStep(action: ActionType, params: Record<string, string> = {}): PlannedStep {
  return {
    step_id: "S1",
    action,
    params,
    level: CATALOG[action].level,
    requires: CATALOG[action].requires,
    expected_effect: "",
    rationale: "",
    state: "awaiting_approval",
    approvals: [],
  };
}

function mkCase(root: RootCause, confidence = 0.9, status: RcaCase["status"] = "Action pending"): RcaCase {
  return {
    case_id: "RCA-0001",
    vin: "INV-5003",
    asset_id: "A-5003",
    site: "x",
    fw_version: "3.4.0",
    trigger: "fault_flag",
    opened_at: "2026-09-26T12:00:00Z",
    status,
    hypothesis: { case_id: "RCA-0001", vin: "INV-5003", root_cause: root, confidence, evidence: [], fw_version: "3.4.0", source: "stub" },
    visits: [],
    timeline: [],
  };
}

function mkStatus(codes: string[] = ["INV-F101 WDT_RESET_LOOP"]): DeviceStatus {
  return {
    vin: "INV-5003", asset_id: "A-5003", fw_version: "3.4.0", online: true, faulted: codes.length > 0,
    active_fault_codes: codes, uptime_s: 1, last_boot_reason: "power_on", last_seen: "2026-09-26T12:00:00Z",
  };
}

function ctx(c: RcaCase, extra: Partial<GateContext> = {}): GateContext {
  return { rcaCase: c, status: mkStatus(), allowlist: ["3.4.0"], onSiteConfirmed: false, ...extra };
}

const at = (user: User) => ({ user, ts: "2026-09-26T12:00:00Z" });

function denyReason(r: ReturnType<typeof gate>): string {
  assert.equal(r.kind, "deny");
  return (r as { reason: string }).reason;
}

test("technicians cannot approve anything", () => {
  const r = gate(mkStep("reboot"), ctx(mkCase("fw_soft_fault_reboot_candidate")), [], tech);
  assert.match(denyReason(r), /Technicians complete visits/);
  assert.equal(gate(mkStep("dispatch_tech"), ctx(mkCase("can_link_unreliable")), [], tech).kind, "deny");
});

test("admin cannot approve and does not bypass safety", () => {
  const r = gate(mkStep("reboot"), ctx(mkCase("fw_soft_fault_reboot_candidate")), [], admin);
  assert.match(denyReason(r), /Admin doesn't bypass safety/);
  const l0 = gate(mkStep("reboot"), ctx(mkCase("thermal_or_safety_event")), [], admin);
  assert.equal(l0.kind, "deny");
});

test("OTA is engineer only: ops approving is denied with a reason", () => {
  const c = mkCase("fw_version_mismatch");
  const step = mkStep("ota_to_allowlisted", { target_fw: "3.4.0" });
  assert.match(denyReason(gate(step, ctx(c), [], ops)), /engineer only/);
  assert.deepEqual(gate(step, ctx(c), [], eng), { kind: "allow" });
  assert.deepEqual(gate(step, ctx(c), []), { kind: "needs_approval", requires: "engineer", missing: ["engineer"] });
});

test("L0 blocks reboot and OTA but allows read-only log dump / CAN query", () => {
  const c = mkCase("thermal_or_safety_event", 0.95);
  assert.match(denyReason(gate(mkStep("reboot"), ctx(c), [], ops)), /Safety \(L0\)/);
  assert.match(denyReason(gate(mkStep("ota_to_allowlisted", { target_fw: "3.4.0" }), ctx(c), [], eng)), /Safety \(L0\)/);
  assert.deepEqual(gate(mkStep("request_log_dump"), ctx(c), [], ops), { kind: "allow" });
  assert.deepEqual(gate(mkStep("can_health_query"), ctx(c), [], eng), { kind: "allow" });
});

test("L0 also triggers on device code INV-F900 or Escalated L0 status, whatever the hypothesis", () => {
  const byCode = mkCase("fw_soft_fault_reboot_candidate");
  assert.equal(gate(mkStep("reboot"), ctx(byCode, { status: mkStatus(["INV-F900 OVERTEMP"]) }), []).kind, "deny");
  const byStatus = mkCase("fw_soft_fault_reboot_candidate", 0.9, "Escalated L0");
  assert.equal(gate(mkStep("reboot"), ctx(byStatus), []).kind, "deny");
});

test("unknown hypothesis and confidence < 0.5 clamp remote actuation", () => {
  assert.match(denyReason(gate(mkStep("reboot"), ctx(mkCase("unknown", 0.9)), [])), /unknown/);
  assert.match(denyReason(gate(mkStep("reboot"), ctx(mkCase("fw_soft_fault_reboot_candidate", 0.4)), [])), /Confidence 0.40/);
  assert.equal(gate(mkStep("ota_to_allowlisted", { target_fw: "3.4.0" }), ctx(mkCase("fw_version_mismatch", 0.3)), []).kind, "deny");
  // Read-only and visits are still fine.
  assert.equal(gate(mkStep("request_log_dump"), ctx(mkCase("unknown", 0.2)), []).kind, "needs_approval");
  assert.equal(gate(mkStep("dispatch_tech"), ctx(mkCase("unknown", 0.2)), []).kind, "needs_approval");
  // 0.5 exactly is allowed.
  assert.equal(gate(mkStep("reboot"), ctx(mkCase("fw_soft_fault_reboot_candidate", 0.5)), []).kind, "needs_approval");
});

test("OTA target must be on the allow-list", () => {
  const c = mkCase("fw_version_mismatch");
  assert.match(denyReason(gate(mkStep("ota_to_allowlisted", { target_fw: "3.5.0-beta" }), ctx(c), [], eng)), /allow-list/);
  assert.match(denyReason(gate(mkStep("ota_to_allowlisted"), ctx(c), [], eng)), /allow-list/);
});

test("L1 actions need no approval; L2 needs ops or engineer", () => {
  const c = mkCase("no_fault_found");
  assert.deepEqual(gate(mkStep("monitor"), ctx(c), []), { kind: "allow" });
  assert.deepEqual(gate(mkStep("engineer_bug_report"), ctx(c), []), { kind: "allow" });
  const reboot = mkStep("reboot");
  const sc = mkCase("fw_soft_fault_reboot_candidate");
  assert.deepEqual(gate(reboot, ctx(sc), []), { kind: "needs_approval", requires: "ops_or_engineer", missing: ["ops", "engineer"] });
  assert.deepEqual(gate(reboot, ctx(sc), [], ops), { kind: "allow" });
  assert.deepEqual(gate(reboot, ctx(sc), [], eng), { kind: "allow" });
  assert.deepEqual(gate(reboot, ctx(sc), [at(ops)]), { kind: "allow" });
});

test("hq_recovery needs on-site confirmation or L0", () => {
  const c = mkCase("true_hardware_defect");
  assert.match(denyReason(gate(mkStep("hq_recovery"), ctx(c), [], eng)), /confirmed on site/);
  // At plan time the prerequisite can still become true, so it isn't a denial.
  assert.equal(gate(mkStep("hq_recovery"), ctx(c, { phase: "plan" }), []).kind, "needs_approval");
  assert.equal(gate(mkStep("hq_recovery"), ctx(c, { onSiteConfirmed: true }), []).kind, "needs_approval");
  assert.equal(gate(mkStep("hq_recovery"), ctx(mkCase("thermal_or_safety_event")), []).kind, "needs_approval");
});

test("hq_recovery needs two distinct users: one ops and one engineer", () => {
  const c = mkCase("true_hardware_defect");
  const cx = ctx(c, { onSiteConfirmed: true });
  const step = mkStep("hq_recovery");
  assert.deepEqual(gate(step, cx, []), { kind: "needs_approval", requires: "ops_and_engineer", missing: ["ops", "engineer"] });
  assert.deepEqual(gate(step, cx, [], eng), { kind: "needs_approval", requires: "ops_and_engineer", missing: ["ops"] });
  // Same engineer again: denied.
  assert.match(denyReason(gate(step, cx, [at(eng)], eng)), /already approved/);
  // A second ops user can't stand in for the engineer.
  assert.match(denyReason(gate(step, cx, [at(ops)], ops2)), /one ops and one engineer/);
  assert.deepEqual(gate(step, cx, [at(eng)], ops), { kind: "allow" });
  assert.deepEqual(gate(step, cx, [at(eng), at(ops)]), { kind: "allow" });
});

test("gate is deterministic and does not mutate its inputs", () => {
  const c = mkCase("fw_soft_fault_reboot_candidate");
  const step = mkStep("reboot");
  const before = JSON.stringify({ c, step });
  const a = gate(step, ctx(c), [], ops);
  const b = gate(step, ctx(c), [], ops);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ c, step }), before);
});
