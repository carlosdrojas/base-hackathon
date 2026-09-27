// End-to-end on the team's synthetic Core telemetry pack (data_input/): Task 1 detectors diagnose,
// the playbook plans, every step is approved by the right role and every visit completed, then the
// outcomes are graded against inventory.csv's answer key.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_INPUT_DIR, loadCorePack } from "../sim/core-pack.js";
import { FleetSim } from "../sim/fleet-sim.js";
import { DetectorHypothesisSource } from "./detector-hypothesis.js";
import { DefaultResponseEngine } from "./engine.js";
import { StubHypothesisSource } from "./hypothesis-source.js";
import { loadSeed, type FleetSeed } from "./seed.js";
import type { ResponseEngine, User } from "./types.js";

export function buildCore(dir = mkdtempSync(join(tmpdir(), "core-"))) {
  const { units: _u, ...base } = loadSeed();
  const pack = loadCorePack(base);
  const fleet = new FleetSim({ seed: pack.seed, runtimePath: join(dir, "sim.json") });
  const manifest = JSON.parse(readFileSync(join(DATA_INPUT_DIR, "fw_allowlist.json"), "utf8"));
  const dx = new DetectorHypothesisSource(pack.packets, pack.events, manifest, new StubHypothesisSource(fleet, {}), fleet);
  const engine = new DefaultResponseEngine(fleet, dx, { runtimeDir: dir, planner: "playbook", seed: pack.seed as FleetSeed, fleetSource: "core" });
  return { engine, fleet, pack };
}

/** Approve everything as the right role, complete every visit with photos, until nothing moves. */
export async function driveAll(engine: ResponseEngine) {
  const users = engine.getState().users;
  const by = (r: User["role"]) => users.find((u) => u.role === r)!;
  for (let round = 0; round < 40; round++) {
    await engine.tick();
    const s = engine.getState();
    let moved = false;
    for (const c of s.cases) {
      for (const st of c.gameplan?.steps ?? []) {
        if (st.state !== "awaiting_approval") continue;
        const who = st.requires === "engineer" ? [by("engineer")] : st.requires === "ops_and_engineer" ? [by("ops"), by("engineer")] : [by("ops")];
        for (const u of who) if (!st.approvals.some((a) => a.user.id === u.id)) { await engine.approve(c.case_id, st.step_id, u); moved = true; }
      }
    }
    for (const v of s.visits.filter((v) => v.state === "scheduled")) {
      await engine.completeVisit(v.visit_id, by("technician"), { completed: true, photos_attached: true });
      moved = true;
    }
    if (!moved) { await engine.tick(); break; }
  }
  return engine.getState();
}

test("core pack loads 57 units and diagnosis comes from the Task 1 detectors", async () => {
  const { engine, pack } = buildCore();
  assert.equal(pack.seed.units.length, 57);
  const cases = await engine.ingestFaults();
  assert.equal(cases.length, 47);
  assert.ok(cases.every((c) => c.hypothesis?.source === "task1"));
  assert.equal(engine.getState().fleet_source, "core");
});

test("driving the core fleet end to end never pulls do-not-return hardware", async () => {
  const { engine } = buildCore();
  await engine.ingestFaults();
  const s = await driveAll(engine);
  const card = s.scorecard!;
  assert.equal(card.graded, 47);
  assert.equal(card.pending, 0);
  assert.ok(card.matched >= 40, `matched ${card.matched}/47`);
  assert.equal(card.missed_pulls, 0);
  assert.equal(card.wrong_pulls, 0);
  assert.equal(card.dnr_kept, card.dnr_resolved);
});

test("the app fleet is real hardware only: 48 inventory units, no detector fixtures", () => {
  const { units: _u, ...base } = loadSeed();
  const pack = loadCorePack(base, DATA_INPUT_DIR, { includeFixtures: false });
  assert.equal(pack.seed.units.length, 48);
  assert.ok(pack.seed.units.every((u) => !u.vin.startsWith("BP-CORE-900")));
  assert.equal(pack.seed.units.filter((u) => u.site.startsWith("Austin,")).length, 4);
});
