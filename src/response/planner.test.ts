// Claude-path post-processing with a stubbed model call (no API key, no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { Planner, type ClaudeCaller, type PlannerInput } from "./planner.js";
import type { DeviceStatus, RcaCase, RootCause } from "./types.js";

function input(root: RootCause, confidence = 0.9, codes = ["INV-F101 WDT_RESET_LOOP"]): PlannerInput {
  let n = 0;
  const c: RcaCase = {
    case_id: "RCA-0001", vin: "INV-5003", asset_id: "A-5003", site: "x", fw_version: "3.4.0", trigger: "fault_flag",
    opened_at: "2026-09-26T12:00:00Z", status: "Investigating", visits: [], timeline: [],
    hypothesis: { case_id: "RCA-0001", vin: "INV-5003", root_cause: root, confidence, evidence: [], fw_version: "3.4.0", source: "stub" },
  };
  const status: DeviceStatus = {
    vin: "INV-5003", asset_id: "A-5003", fw_version: "3.4.0", online: true, faulted: true, active_fault_codes: codes,
    uptime_s: 1, last_boot_reason: "power_on", last_seen: "2026-09-26T12:00:00Z",
  };
  return {
    rcaCase: c, status, allowlist: ["3.4.0"], history: [], onSiteConfirmed: false, visitCompleted: false, replan: false,
    newStepId: () => `S${++n}`, now: "2026-09-26T12:00:00Z",
  };
}

function stub(toolInput: unknown): { call: ClaudeCaller; bodies: Anthropic.MessageCreateParamsNonStreaming[] } {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const call: ClaudeCaller = async (body) => {
    bodies.push(body);
    return {
      id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "tu_1", name: "propose_gameplan", input: toolInput }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message;
  };
  return { call, bodies };
}

test("Claude plan: invented actions dropped, level/approval re-derived from the catalog", async () => {
  const { call, bodies } = stub({
    summary: "Reboot, then flash a custom build.",
    steps: [
      { action: "reboot", expected_effect: "clears", rationale: "wdt", level: "L1", requires: "none" },
      { action: "write_firmware_patch", expected_effect: "?", rationale: "invented" },
      { action: "hq_recovery", expected_effect: "swap", rationale: "just in case" },
      { action: "dispatch_tech", expected_effect: "visit", rationale: "fallback" },
    ],
    alerts: [{ role: "ops", reason: "reboot pending" }],
  });
  const r = await new Planner("claude", call).plan(input("fw_soft_fault_reboot_candidate"));
  assert.equal(r.gameplan.source, "claude");
  assert.deepEqual(r.gameplan.steps.map((s) => s.action), ["reboot", "dispatch_tech", "hq_recovery"]); // hq moved last
  const reboot = r.gameplan.steps[0];
  assert.equal(reboot.level, "L2");
  assert.equal(reboot.requires, "ops_or_engineer");
  assert.equal(r.gameplan.level, "L4");
  // Request shape: sonnet-5, single forced tool whose action enum is the catalog.
  const body = bodies[0];
  assert.equal(body.model, "claude-sonnet-5");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "propose_gameplan" });
  assert.equal(body.tools!.length, 1);
});

test("Claude plan on an L0 case: remote actuation is marked denied, plan level L0", async () => {
  const { call } = stub({
    summary: "Try a reboot.",
    steps: [
      { action: "reboot", expected_effect: "x", rationale: "x" },
      { action: "ota_to_allowlisted", params: { target_fw: "3.4.0" }, expected_effect: "x", rationale: "x" },
      { action: "dispatch_tech", expected_effect: "x", rationale: "x" },
    ],
    alerts: [],
  });
  const r = await new Planner("claude", call).plan(input("thermal_or_safety_event", 0.95, ["INV-F900 OVERTEMP"]));
  assert.equal(r.gameplan.level, "L0");
  assert.deepEqual(r.gameplan.steps.map((s) => s.state), ["denied", "denied", "planned"]);
  assert.equal(r.denials.length, 2);
  assert.deepEqual(r.gameplan.alerts.map((a) => a.role).sort(), ["engineer", "ops"]);
});

test("Claude failure or timeout falls back to the playbook", async () => {
  const failing: ClaudeCaller = async () => {
    throw new Error("Request timed out.");
  };
  const r = await new Planner("claude", failing).plan(input("fw_version_mismatch"));
  assert.equal(r.gameplan.source, "playbook");
  assert.equal(r.fallbackReason, "Request timed out.");
  assert.deepEqual(r.gameplan.steps.map((s) => s.action), ["ota_to_allowlisted", "dispatch_tech"]);
});

test("malformed tool input falls back to the playbook", async () => {
  const { call } = stub({ steps: "not an array" });
  const r = await new Planner("claude", call).plan(input("can_link_unreliable"));
  assert.equal(r.gameplan.source, "playbook");
  assert.deepEqual(r.gameplan.steps.map((s) => s.action), ["can_health_query", "dispatch_tech"]);
});

test("playbook: unknown / low confidence gathers data, no remote actuation", async () => {
  const r = await new Planner("playbook").plan(input("fw_soft_fault_reboot_candidate", 0.3));
  assert.deepEqual(r.gameplan.steps.map((s) => s.action), ["request_log_dump", "can_health_query", "dispatch_tech"]);
});

test("re-plan with nothing new escalates to dispatch_tech, then hq_recovery after a visit", async () => {
  const i = input("install_wiring_or_sense_error");
  i.replan = true;
  i.history = [{ step_id: "S0", action: "dispatch_tech", params: {}, level: "L4", requires: "ops_or_engineer", expected_effect: "", rationale: "", state: "failed", approvals: [] }];
  let r = await new Planner("playbook").plan(i);
  assert.deepEqual(r.gameplan.steps.map((s) => s.action), ["dispatch_tech"]);
  i.visitCompleted = true;
  r = await new Planner("playbook").plan(i);
  assert.deepEqual(r.gameplan.steps.map((s) => s.action), ["hq_recovery"]);
});
