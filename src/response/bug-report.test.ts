import test from "node:test";
import assert from "node:assert/strict";
import { findBugGroups } from "./bug-report.js";
import type { PlannedStep, RcaCase } from "./types.js";

function mkCase(id: string, fw: string, stepState: PlannedStep["state"]): RcaCase {
  return {
    case_id: id, vin: `INV-${id}`, asset_id: id, site: "x", fw_version: fw, trigger: "fault_flag",
    opened_at: "2026-09-26T00:00:00Z", status: "Action pending", visits: [], timeline: [],
    hypothesis: { case_id: id, vin: `INV-${id}`, root_cause: "fw_soft_fault_reboot_candidate", confidence: 0.85, evidence: [], fw_version: fw, source: "stub" },
    gameplan: {
      case_id: id, level: "L4", alerts: [], summary: "", source: "playbook", created_at: "",
      steps: [{ step_id: "s1", action: "reboot", params: {}, level: "L2", requires: "ops_or_engineer", expected_effect: "", rationale: "", state: stepState, approvals: [] }],
    },
  };
}

test("three cases on one fw with the same hypothesis produce a bug group", () => {
  const groups = findBugGroups([mkCase("1", "3.3.0", "awaiting_approval"), mkCase("2", "3.3.0", "done"), mkCase("3", "3.3.0", "planned")], []);
  assert.equal(groups.length, 1);
});

test("a case whose remote fix failed does not count (diagnosis is suspect)", () => {
  const groups = findBugGroups([mkCase("1", "3.4.0", "done"), mkCase("2", "3.4.0", "failed"), mkCase("3", "3.4.0", "awaiting_approval")], []);
  assert.equal(groups.length, 0);
});

test("install / thermal clusters on one firmware are not firmware bug reports", () => {
  const cases = ["1", "2", "3"].map((id) => {
    const c = mkCase(id, "core-inv-3.4.17", "awaiting_approval");
    c.hypothesis!.root_cause = "thermal_or_safety_event";
    return c;
  });
  assert.equal(findBugGroups(cases, []).length, 0);
});
