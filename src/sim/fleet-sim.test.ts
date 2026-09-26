import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, PlantableFault } from "../response/types.js";
import { DEFAULT_SEED_PATH, FleetSim, flakyForVin } from "./fleet-sim.js";
import { FAULT_CODES } from "./fault-codes.js";

type Outcome = ActionResult["outcome"];
type Col = "reboot" | "ota" | "monitor" | "log_dump" | "can_query" | "visit" | "hq";

const VIN = "INV-5001"; // healthy in the seed, fw 3.4.0

function newSim(opts: { flaky?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-sim-"));
  const runtimePath = join(dir, "runtime", "sim-fleet.json");
  const sim = new FleetSim({ runtimePath, flaky: opts.flaky ?? false });
  return { sim, runtimePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(sim: FleetSim, col: Col): ActionResult {
  switch (col) {
    case "reboot": return sim.apply(VIN, "reboot");
    case "ota": return sim.apply(VIN, "ota_to_allowlisted", { target_fw: "3.4.0" });
    case "monitor": return sim.apply(VIN, "monitor");
    case "log_dump": return sim.apply(VIN, "request_log_dump");
    case "can_query": return sim.apply(VIN, "can_health_query");
    case "visit": return sim.techVisit(VIN, { completed: true, photos_attached: true });
    case "hq": return sim.apply(VIN, "hq_recovery");
  }
}

// §4 response table, row by row. [outcome, faulted after]
const TABLE: Record<PlantableFault | "healthy", Record<Col, [Outcome, boolean]>> = {
  fw_soft_fault_reboot_candidate: { reboot: ["cleared", false], ota: ["cleared", false], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["cleared", false], hq: ["replaced", false] },
  fw_version_mismatch: { reboot: ["no_change", true], ota: ["cleared", false], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["no_change", true], hq: ["replaced", false] },
  can_link_unreliable: { reboot: ["no_change", true], ota: ["no_change", true], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["cleared", false], hq: ["replaced", false] },
  install_commissioning_incomplete: { reboot: ["no_change", true], ota: ["no_change", true], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["cleared", false], hq: ["replaced", false] },
  install_wiring_or_sense_error: { reboot: ["no_change", true], ota: ["no_change", true], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["cleared", false], hq: ["replaced", false] },
  grid_or_home_side_condition: { reboot: ["no_change", true], ota: ["no_change", true], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["nothing_found", false], hq: ["replaced", false] },
  no_fault_found: { reboot: ["cleared", false], ota: ["cleared", false], monitor: ["cleared", false], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["nothing_found", false], hq: ["replaced", false] },
  true_hardware_defect: { reboot: ["no_change", true], ota: ["no_change", true], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["no_change", true], hq: ["replaced", false] },
  thermal_or_safety_event: { reboot: ["refused_interlock", true], ota: ["refused_interlock", true], monitor: ["no_change", true], log_dump: ["info_only", true], can_query: ["info_only", true], visit: ["made_safe", true], hq: ["replaced", false] },
  healthy: { reboot: ["no_change", false], ota: ["no_change", false], monitor: ["no_change", false], log_dump: ["info_only", false], can_query: ["info_only", false], visit: ["nothing_found", false], hq: ["replaced", false] },
};

for (const [row, cols] of Object.entries(TABLE)) {
  for (const [col, [outcome, faultedAfter]] of Object.entries(cols) as [Col, [Outcome, boolean]][]) {
    test(`§4 table: ${row} × ${col} → ${outcome}`, () => {
      const { sim, cleanup } = newSim();
      try {
        if (row !== "healthy") sim.plantFault(VIN, row as PlantableFault);
        const before = sim.getUnitState(VIN);
        const r = run(sim, col);
        assert.equal(r.outcome, outcome, r.detail);
        assert.equal(r.status_after.faulted, faultedAfter);
        assert.equal(sim.getStatus(VIN).faulted, faultedAfter);
        assert.ok(r.detail.length > 0);
        const after = sim.getUnitState(VIN);
        assert.equal(after.action_history.length, 1);
        assert.equal(after.action_history[0].result, outcome);
        if (outcome === "info_only" || outcome === "refused_interlock") {
          assert.deepEqual({ ...after, action_history: [] }, { ...before, action_history: [] });
        }
      } finally {
        cleanup();
      }
    });
  }
}

test("getStatus derives fault codes from the §4 table; healthy reports none", () => {
  const { sim, cleanup } = newSim();
  try {
    assert.deepEqual(sim.getStatus(VIN).active_fault_codes, []);
    assert.equal(sim.getStatus(VIN).faulted, false);
    for (const [fault, code] of Object.entries(FAULT_CODES)) {
      sim.plantFault(VIN, fault as PlantableFault);
      assert.deepEqual(sim.getStatus(VIN).active_fault_codes, [code]);
      assert.equal(sim.getStatus(VIN).faulted, true);
    }
    const seeded = sim.list();
    assert.equal(seeded.length, 12);
    assert.deepEqual(seeded.find((s) => s.vin === "INV-5007")!.active_fault_codes, ["INV-F900 OVERTEMP"]);
    assert.equal(seeded.find((s) => s.vin === "INV-5004")!.faulted, false);
  } finally {
    cleanup();
  }
});

test("reboot resets uptime and sets boot reason; OTA sets fw + boot reason", () => {
  const { sim, cleanup } = newSim();
  try {
    const r = sim.apply("INV-5003", "reboot");
    assert.equal(r.status_after.uptime_s, 0);
    assert.equal(r.status_after.last_boot_reason, "reboot_cmd");

    const o = sim.apply("INV-5008", "ota_to_allowlisted", { target_fw: "3.4.0" });
    assert.equal(o.outcome, "cleared");
    assert.equal(o.status_after.fw_version, "3.4.0");
    assert.equal(o.status_after.last_boot_reason, "ota");
    assert.equal(o.status_after.uptime_s, 0);
  } finally {
    cleanup();
  }
});

test("interlock: safety unit refuses reboot and OTA without touching state", () => {
  const { sim, cleanup } = newSim();
  try {
    const before = sim.getUnitState("INV-5007");
    assert.equal(sim.apply("INV-5007", "reboot").outcome, "refused_interlock");
    assert.equal(sim.apply("INV-5007", "ota_to_allowlisted", { target_fw: "3.4.0" }).outcome, "refused_interlock");
    const after = sim.getUnitState("INV-5007");
    assert.equal(after.uptime_s, before.uptime_s);
    assert.equal(after.last_boot_reason, before.last_boot_reason);
    assert.equal(after.fault, "thermal_or_safety_event");
    assert.deepEqual(after.action_history.map((a) => a.result), ["refused_interlock", "refused_interlock"]);
  } finally {
    cleanup();
  }
});

test("OTA to a non-allow-listed version throws and changes nothing", () => {
  const { sim, cleanup } = newSim();
  try {
    const before = sim.getUnitState("INV-5008");
    assert.throws(() => sim.apply("INV-5008", "ota_to_allowlisted", { target_fw: "3.3.0" }), /allow-list/);
    assert.throws(() => sim.apply("INV-5008", "ota_to_allowlisted"), /allow-list/);
    assert.throws(() => sim.apply("INV-5007", "ota_to_allowlisted", { target_fw: "9.9.9" }), /allow-list/);
    assert.deepEqual(sim.getUnitState("INV-5008"), before);
  } finally {
    cleanup();
  }
});

test("hq_recovery replaces the unit: fault cleared, fw = first allow-listed version", () => {
  const { sim, cleanup } = newSim();
  try {
    const r = sim.apply("INV-5008", "hq_recovery"); // 3.2.1, fw mismatch → unnecessary pull
    assert.equal(r.outcome, "replaced");
    assert.match(r.detail, /unnecessary/);
    const u = sim.getUnitState("INV-5008");
    assert.equal(u.fault, null);
    assert.equal(u.fw_version, sim.fwAllowlist[0]);
    assert.match(sim.apply("INV-5012", "hq_recovery").detail, /justified/);
  } finally {
    cleanup();
  }
});

test("incomplete tech visit is no_change and leaves the unit alone", () => {
  const { sim, cleanup } = newSim();
  try {
    for (const vin of ["INV-5005", "INV-5007", "INV-5002"]) {
      const before = sim.getUnitState(vin);
      const r = sim.techVisit(vin, { completed: false, photos_attached: false, incomplete_reason: "access" });
      assert.equal(r.outcome, "no_change");
      const after = sim.getUnitState(vin);
      assert.deepEqual({ ...after, action_history: [] }, { ...before, action_history: [] });
      assert.deepEqual(after.action_history.map((a) => [a.action, a.result]), [["tech_visit", "no_change"]]);
    }
  } finally {
    cleanup();
  }
});

test("every call persists to the runtime file; a new instance reloads it", () => {
  const { sim, runtimePath, cleanup } = newSim();
  try {
    assert.ok(existsSync(runtimePath));
    sim.apply("INV-5003", "reboot");
    sim.plantFault("INV-5001", "can_link_unreliable");
    const reloaded = new FleetSim({ runtimePath, flaky: false });
    assert.equal(reloaded.getUnitState("INV-5003").fault, null);
    assert.equal(reloaded.getUnitState("INV-5003").action_history.length, 1);
    assert.equal(reloaded.getUnitState("INV-5001").fault, "can_link_unreliable");
    assert.ok(reloaded.getUnitState("INV-5001").fault_time);
  } finally {
    cleanup();
  }
});

test("reset() restores the seed exactly", () => {
  const { sim, runtimePath, cleanup } = newSim();
  try {
    sim.apply("INV-5003", "reboot");
    sim.apply("INV-5012", "hq_recovery");
    sim.plantFault("INV-5001", "true_hardware_defect");
    sim.reset();
    const seed = JSON.parse(readFileSync(DEFAULT_SEED_PATH, "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(runtimePath, "utf8")), seed);
    for (const u of seed.units) assert.deepEqual(sim.getUnitState(u.vin), u);
  } finally {
    cleanup();
  }
});

test("unknown vin throws", () => {
  const { sim, cleanup } = newSim();
  try {
    assert.throws(() => sim.getStatus("INV-0000"), /unknown vin/);
    assert.throws(() => sim.apply("INV-0000", "reboot"), /unknown vin/);
  } finally {
    cleanup();
  }
});

test("flakiness is off by default; when on, a flaky VIN's first soft-fault reboot fails, the second clears", () => {
  const flakyVin = ["INV-5003", "INV-5009", "INV-5010", "INV-5011", "INV-5001", "INV-5004", "INV-5006"].find(flakyForVin);
  const { sim, cleanup } = newSim({ flaky: true });
  const off = newSim();
  try {
    assert.equal(off.sim.flaky, false);
    if (!flakyVin) return; // no seed VIN draws flaky; nothing more to check
    sim.plantFault(flakyVin, "fw_soft_fault_reboot_candidate");
    assert.equal(sim.apply(flakyVin, "reboot").outcome, "no_change");
    assert.equal(sim.apply(flakyVin, "reboot").outcome, "cleared");
    off.sim.plantFault(flakyVin, "fw_soft_fault_reboot_candidate");
    assert.equal(off.sim.apply(flakyVin, "reboot").outcome, "cleared");
  } finally {
    cleanup();
    off.cleanup();
  }
});
