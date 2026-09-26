// Drives the demo scenes (design doc §13) through the ResponseEngine interface only, against the
// in-memory fake fleet, with the playbook planner and no API key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResponseEngine } from "./engine.js";
import { StubHypothesisSource } from "./hypothesis-source.js";
import { FakeFleet } from "./test-helpers.js";
import { loadSeed } from "./seed.js";
import type { ActionType, RcaCase, ResponseEngine, User } from "./types.js";

const seed = loadSeed();
const user = (id: string): User => {
  const u = [...seed.users, ...seed.drivers].find((x) => x.id === id);
  if (!u) throw new Error(id);
  return u;
};
const OSEI = user("u-osei");
const FENWICK = user("u-fenwick");
const DRIVER = user("u-driver");
const OPS = user("u-alvarez");
const ENG = user("u-park");
const ADMIN = user("u-admin");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "resp-engine-"));
  const fleet = new FakeFleet(seed, () => new Date("2026-09-26T18:20:00Z"));
  const engine: ResponseEngine = new DefaultResponseEngine(fleet, new StubHypothesisSource(fleet, seed.misdiagnose), {
    runtimeDir: dir,
    planner: "playbook",
    seed,
    clock: () => new Date("2026-09-26T18:20:00Z"),
  });
  await engine.ingestFaults();
  await engine.tick();
  return { dir, fleet, engine };
}

function caseOf(engine: ResponseEngine, vin: string): RcaCase {
  const c = engine.getState().cases.find((x) => x.vin === vin && x.status !== "Closed") ??
    engine.getState().cases.filter((x) => x.vin === vin).at(-1);
  assert.ok(c, `no case for ${vin}`);
  return c;
}

function pendingStep(engine: ResponseEngine, vin: string, action: ActionType) {
  const s = caseOf(engine, vin).gameplan!.steps.find((x) => x.action === action && x.state === "awaiting_approval");
  assert.ok(s, `no ${action} awaiting approval on ${vin}: ${JSON.stringify(caseOf(engine, vin).gameplan!.steps.map((x) => [x.action, x.state]))}`);
  return s;
}

function scheduledVisit(engine: ResponseEngine, vin: string) {
  const v = engine.getState().visits.find((x) => x.vin === vin && x.state === "scheduled");
  assert.ok(v, `no scheduled visit for ${vin}`);
  return v;
}

async function approve(engine: ResponseEngine, vin: string, action: ActionType, u: User) {
  const c = caseOf(engine, vin);
  return engine.approve(c.case_id, pendingStep(engine, vin, action).step_id, u);
}

test("ingest opens one case per faulted unit, planned by the playbook", async () => {
  const { engine, dir } = await setup();
  const s = engine.getState();
  assert.equal(s.cases.length, 9);
  assert.equal(s.planner, "playbook");
  assert.equal(s.mocked, true);
  for (const c of s.cases) {
    assert.ok(c.hypothesis && c.gameplan, c.case_id);
    assert.equal(c.gameplan.source, "playbook");
    for (const k of ["case_opened", "hypothesis", "gameplan", "alert_sent"]) {
      assert.ok(c.timeline.some((e) => e.kind === k), `${c.vin} missing ${k}`);
    }
  }
  // Healthy units get no case.
  assert.ok(!s.cases.some((c) => ["INV-5001", "INV-5004", "INV-5006"].includes(c.vin)));
  // A second ingest is a no-op.
  assert.equal((await engine.ingestFaults()).length, 0);
  assert.ok(existsSync(join(dir, "response-cases.json")));
});

test("Scene 1 — INV-5003 soft fault: ops approves reboot, clears, no truck", async () => {
  const { engine, fleet } = await setup();
  assert.equal(caseOf(engine, "INV-5003").status, "Action pending");
  // A technician can't approve.
  assert.equal((await approve(engine, "INV-5003", "reboot", OSEI)).kind, "deny");
  assert.deepEqual(await approve(engine, "INV-5003", "reboot", OPS), { kind: "allow" });
  const c = caseOf(engine, "INV-5003");
  assert.equal(c.status, "Engineer review");
  assert.equal(c.outcome, "fixed_remote");
  assert.equal(c.gameplan!.steps.find((s) => s.action === "dispatch_tech")!.state, "skipped");
  assert.ok(c.timeline.some((e) => e.kind === "verify_pass"));
  assert.equal(fleet.getStatus("INV-5003").faulted, false);
  assert.equal(engine.getState().visits.filter((v) => v.vin === "INV-5003").length, 0);
  // Only an engineer closes.
  await assert.rejects(engine.closeCase(c.case_id, OPS, "done"), /engineer/);
  await assert.rejects(engine.closeCase(c.case_id, ADMIN, "done"), /engineer/);
  await engine.closeCase(c.case_id, ENG, "Reboot cleared WDT loop.");
  assert.equal(caseOf(engine, "INV-5003").status, "Closed");
});

test("Scene 2 — INV-5005 misdiagnosed: reboot fails, verifier escalates to a tech, reseat clears", async () => {
  const { engine } = await setup();
  const h = caseOf(engine, "INV-5005").hypothesis!;
  assert.equal(h.root_cause, "fw_soft_fault_reboot_candidate");
  assert.equal(h.confidence, 0.62);
  await approve(engine, "INV-5005", "reboot", OPS);
  let c = caseOf(engine, "INV-5005");
  assert.equal(c.gameplan!.steps.find((s) => s.action === "reboot")!.state, "failed");
  assert.ok(c.timeline.some((e) => e.kind === "verify_fail"));
  assert.equal(c.status, "Action pending");
  await approve(engine, "INV-5005", "dispatch_tech", OPS);
  c = caseOf(engine, "INV-5005");
  assert.equal(c.status, "Field visit");
  const v = scheduledVisit(engine, "INV-5005");
  assert.equal(v.photos_required, true);
  assert.ok(v.brief.length > 0 && v.checklist.length >= 3 && v.checklist.length <= 6);
  // Photos are required; ops can't complete visits.
  await assert.rejects(engine.completeVisit(v.visit_id, OSEI, { completed: true, photos_attached: false }), /Photos/);
  await assert.rejects(engine.completeVisit(v.visit_id, OPS, { completed: true, photos_attached: true }), /technician/);
  await engine.completeVisit(v.visit_id, OSEI, { completed: true, photos_attached: true, notes: "CAN connector loose" });
  c = caseOf(engine, "INV-5005");
  assert.equal(c.status, "Engineer review");
  assert.equal(c.outcome, "fixed_on_site");
  await engine.closeCase(c.case_id, ENG, "Connector reseated.");
  assert.equal(caseOf(engine, "INV-5005").status, "Closed");
});

test("Scene 3 — INV-5007 thermal: reboot denied by gate, Escalated L0, made safe, HQ recovery by ops + engineer", async () => {
  const { engine, fleet } = await setup();
  let c = caseOf(engine, "INV-5007");
  assert.equal(c.status, "Escalated L0");
  assert.equal(c.gameplan!.level, "L0");
  const reboot = c.gameplan!.steps.find((s) => s.action === "reboot")!;
  assert.equal(reboot.state, "denied");
  assert.ok(c.timeline.some((e) => e.kind === "gate_denied" && /Safety \(L0\)/.test(e.summary)));
  assert.ok(c.timeline.some((e) => e.kind === "alert_sent" && (e.detail as { role: string }).role === "engineer"));

  await approve(engine, "INV-5007", "dispatch_tech", OPS);
  const v = scheduledVisit(engine, "INV-5007");
  assert.equal(v.assignee.id, FENWICK.id);
  await engine.completeVisit(v.visit_id, FENWICK, { completed: true, photos_attached: true });
  c = caseOf(engine, "INV-5007");
  assert.equal(c.status, "Escalated L0");
  assert.equal(c.outcome, "l0_made_safe");

  // HQ recovery: two distinct approvers.
  const r1 = await approve(engine, "INV-5007", "hq_recovery", ENG);
  assert.deepEqual(r1, { kind: "needs_approval", requires: "ops_and_engineer", missing: ["ops"] });
  assert.equal((await approve(engine, "INV-5007", "hq_recovery", ENG)).kind, "deny");
  assert.deepEqual(await approve(engine, "INV-5007", "hq_recovery", OPS), { kind: "allow" });
  const hq = scheduledVisit(engine, "INV-5007");
  assert.equal(hq.kind, "hq_recovery");
  assert.equal(hq.assignee.id, DRIVER.id);
  await engine.completeVisit(hq.visit_id, DRIVER, { completed: true, photos_attached: true });
  c = caseOf(engine, "INV-5007");
  assert.equal(c.outcome, "pulled_justified");
  assert.equal(c.status, "Engineer review");
  // The device never saw a reboot or OTA.
  const history = fleet.getUnitState("INV-5007").action_history.map((a) => a.action);
  assert.ok(!history.includes("reboot") && !history.includes("ota_to_allowlisted"));
  await engine.closeCase(c.case_id, ENG, "Replaced.");
  assert.equal(engine.getState().metrics.unnecessary_pulls, 0);
});

test("Scene 3b — an L0 case can close from Escalated L0 once made safe", async () => {
  const { engine } = await setup();
  const id = caseOf(engine, "INV-5007").case_id;
  await assert.rejects(engine.closeCase(id, ENG, "too early"), /Escalated L0/);
  await approve(engine, "INV-5007", "dispatch_tech", ENG);
  await engine.completeVisit(scheduledVisit(engine, "INV-5007").visit_id, FENWICK, { completed: true, photos_attached: false });
  await engine.closeCase(id, ENG, "Made safe; HQ recovery tracked separately.");
  assert.equal(caseOf(engine, "INV-5007").status, "Closed");
});

test("Scene 4 — INV-5008 on 3.2.1: OTA denied for ops (engineer only), engineer approves, clears", async () => {
  const { engine, fleet } = await setup();
  const step = pendingStep(engine, "INV-5008", "ota_to_allowlisted");
  assert.equal(step.params.target_fw, "3.4.0");
  assert.equal(step.level, "L3");
  const denied = await approve(engine, "INV-5008", "ota_to_allowlisted", OPS);
  assert.equal(denied.kind, "deny");
  assert.match((denied as { reason: string }).reason, /engineer only/);
  assert.ok(caseOf(engine, "INV-5008").timeline.some((e) => e.kind === "gate_denied"));
  assert.deepEqual(await approve(engine, "INV-5008", "ota_to_allowlisted", ENG), { kind: "allow" });
  const c = caseOf(engine, "INV-5008");
  assert.equal(c.status, "Engineer review");
  assert.equal(c.outcome, "fixed_remote");
  assert.equal(fleet.getStatus("INV-5008").fw_version, "3.4.0");
  await engine.closeCase(c.case_id, ENG, "OTA to 3.4.0.");
});

test("Scene 5 — INV-5009/5010/5011 on 3.3.0: bug report, never a patch", async () => {
  const { engine } = await setup();
  const reports = engine.getState().bug_reports;
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.fw_version, "3.3.0");
  assert.equal(r.root_cause, "fw_soft_fault_reboot_candidate");
  assert.deepEqual([...r.vins].sort(), ["INV-5009", "INV-5010", "INV-5011"]);
  assert.equal(r.source, "template");
  assert.match(r.recommendation, /allow-listed 3\.4\.0/);
  assert.match(r.recommendation, /engineer approval/);
  assert.match(r.recommendation, /no patch/);
  for (const vin of r.vins) {
    assert.ok(caseOf(engine, vin).timeline.some((e) => e.kind === "bug_report_linked"));
    // Soft fault on non-allow-listed fw: reboot first, OTA queued behind it.
    assert.deepEqual(caseOf(engine, vin).gameplan!.steps.map((s) => s.action), ["reboot", "ota_to_allowlisted", "dispatch_tech"]);
    await approve(engine, vin, "reboot", OPS);
    assert.equal(caseOf(engine, vin).outcome, "fixed_remote");
  }
  // Re-running ingest / tick doesn't duplicate the report.
  await engine.ingestFaults();
  await engine.tick();
  assert.equal(engine.getState().bug_reports.length, 1);
});

test("INV-5002 no_fault_found: monitor clears on tick, avoided false pull", async () => {
  const { engine } = await setup();
  const c = caseOf(engine, "INV-5002");
  assert.equal(c.gameplan!.steps[0].action, "monitor");
  assert.equal(c.gameplan!.steps[0].state, "done");
  assert.equal(c.status, "Engineer review");
  assert.equal(c.outcome, "avoided_false_pull");
  assert.equal(engine.getState().visits.filter((v) => v.vin === "INV-5002").length, 0);
});

test("INV-5012 hardware: log dump → tech confirms → HQ recovery (justified pull)", async () => {
  const { engine } = await setup();
  // HQ recovery can't be approved before on-site confirmation (it isn't even the current step).
  await approve(engine, "INV-5012", "request_log_dump", OPS);
  let c = caseOf(engine, "INV-5012");
  assert.equal(c.gameplan!.steps[0].state, "done");
  assert.equal(c.gameplan!.steps[0].result!.outcome, "info_only");
  await approve(engine, "INV-5012", "dispatch_tech", OPS);
  const v = scheduledVisit(engine, "INV-5012");
  assert.equal(v.assignee.id, FENWICK.id);
  await engine.completeVisit(v.visit_id, FENWICK, { completed: true, photos_attached: true });
  c = caseOf(engine, "INV-5012");
  assert.equal(c.gameplan!.steps.find((s) => s.action === "dispatch_tech")!.state, "failed");
  await approve(engine, "INV-5012", "hq_recovery", OPS);
  await approve(engine, "INV-5012", "hq_recovery", ENG);
  const hq = scheduledVisit(engine, "INV-5012");
  await engine.completeVisit(hq.visit_id, DRIVER, { completed: true, photos_attached: false });
  c = caseOf(engine, "INV-5012");
  assert.equal(c.status, "Engineer review");
  assert.equal(c.outcome, "pulled_justified");
  await engine.closeCase(c.case_id, ENG, "Power stage replaced.");
});

test("incomplete visit bounces: needs a reason, re-queues the visit", async () => {
  const { engine } = await setup();
  await approve(engine, "INV-5005", "reboot", OPS);
  await approve(engine, "INV-5005", "dispatch_tech", OPS);
  const v = scheduledVisit(engine, "INV-5005");
  await assert.rejects(engine.completeVisit(v.visit_id, OSEI, { completed: false, photos_attached: false }), /incomplete_reason/);
  await engine.completeVisit(v.visit_id, OSEI, { completed: false, photos_attached: false, incomplete_reason: "access" });
  const c = caseOf(engine, "INV-5005");
  assert.ok(c.timeline.some((e) => e.kind === "visit_incomplete"));
  assert.equal(c.status, "Action pending");
  await approve(engine, "INV-5005", "dispatch_tech", OPS);
  const v2 = scheduledVisit(engine, "INV-5005");
  assert.notEqual(v2.visit_id, v.visit_id);
  await engine.completeVisit(v2.visit_id, OSEI, { completed: true, photos_attached: true });
  assert.equal(caseOf(engine, "INV-5005").outcome, "fixed_on_site");
});

test("Scene 6 — plant a fault live, then reset", async () => {
  const { engine } = await setup();
  await engine.plantFault("INV-5001", "fw_version_mismatch");
  const opened = await engine.ingestFaults();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].vin, "INV-5001");
  assert.ok(opened[0].gameplan);
  await engine.reset();
  const s = engine.getState();
  assert.equal(s.cases.length, 0);
  assert.equal(s.fleet.find((d) => d.vin === "INV-5001")!.faulted, false);
});

test("full demo run: final statuses, outcomes and metrics", async () => {
  const { engine, dir } = await setup();
  // Scene 1
  await approve(engine, "INV-5003", "reboot", OPS);
  // Scene 2
  await approve(engine, "INV-5005", "reboot", OPS);
  await approve(engine, "INV-5005", "dispatch_tech", OPS);
  await engine.completeVisit(scheduledVisit(engine, "INV-5005").visit_id, OSEI, { completed: true, photos_attached: true });
  // Scene 3 (incl. one denied double-approval)
  await approve(engine, "INV-5007", "dispatch_tech", OPS);
  await engine.completeVisit(scheduledVisit(engine, "INV-5007").visit_id, FENWICK, { completed: true, photos_attached: true });
  await approve(engine, "INV-5007", "hq_recovery", ENG);
  await approve(engine, "INV-5007", "hq_recovery", ENG);
  await approve(engine, "INV-5007", "hq_recovery", OPS);
  await engine.completeVisit(scheduledVisit(engine, "INV-5007").visit_id, DRIVER, { completed: true, photos_attached: true });
  // Scene 4 (incl. ops denied)
  await approve(engine, "INV-5008", "ota_to_allowlisted", OPS);
  await approve(engine, "INV-5008", "ota_to_allowlisted", ENG);
  // Scene 5
  for (const vin of ["INV-5009", "INV-5010", "INV-5011"]) await approve(engine, vin, "reboot", ENG);
  // INV-5012
  await approve(engine, "INV-5012", "request_log_dump", OPS);
  await approve(engine, "INV-5012", "dispatch_tech", OPS);
  await engine.completeVisit(scheduledVisit(engine, "INV-5012").visit_id, FENWICK, { completed: true, photos_attached: true });
  await approve(engine, "INV-5012", "hq_recovery", OPS);
  await approve(engine, "INV-5012", "hq_recovery", ENG);
  await engine.completeVisit(scheduledVisit(engine, "INV-5012").visit_id, DRIVER, { completed: true, photos_attached: true });
  await engine.tick();

  const expected: Record<string, RcaCase["outcome"]> = {
    "INV-5002": "avoided_false_pull",
    "INV-5003": "fixed_remote",
    "INV-5005": "fixed_on_site",
    "INV-5007": "pulled_justified",
    "INV-5008": "fixed_remote",
    "INV-5009": "fixed_remote",
    "INV-5010": "fixed_remote",
    "INV-5011": "fixed_remote",
    "INV-5012": "pulled_justified",
  };
  for (const [vin, outcome] of Object.entries(expected)) {
    const c = caseOf(engine, vin);
    assert.equal(c.status, "Engineer review", vin);
    assert.equal(c.outcome, outcome, vin);
    await engine.closeCase(c.case_id, ENG, "Reviewed.");
  }
  // Every faulted unit is now healthy.
  assert.ok(engine.getState().fleet.every((d) => !d.faulted));

  const m = engine.getState().metrics;
  assert.equal(m.open_cases, 0);
  assert.equal(m.closed_cases, 9);
  assert.equal(m.fixed_remote, 5);
  assert.equal(m.avoided_false_pulls, 1);
  assert.equal(m.truck_rolls, 5); // 5005 visit, 5007 visit + HQ, 5012 visit + HQ
  assert.equal(m.unnecessary_pulls, 0);
  // 5007 reboot at plan time + 5007 double approval + 5008 ops OTA.
  assert.equal(m.gate_denials, 3);

  // Persisted.
  const saved = JSON.parse(readFileSync(join(dir, "response-cases.json"), "utf8"));
  assert.equal(saved.cases.length, 9);
  assert.equal(saved.bug_reports.length, 1);
});

test('planner "auto" without ANTHROPIC_API_KEY uses the playbook', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const fleet = new FakeFleet(seed);
    const engine = new DefaultResponseEngine(fleet, new StubHypothesisSource(fleet, seed.misdiagnose), {
      runtimeDir: mkdtempSync(join(tmpdir(), "resp-engine-")),
      planner: "auto",
      seed,
    });
    assert.equal(engine.getState().planner, "playbook");
    const [c] = await engine.ingestFaults();
    assert.equal(c.gameplan!.source, "playbook");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
