import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fwIsSigned, type FwManifest } from "./evidence.js";
import { evidenceFromPacketRow } from "./from-packet.js";
import { runDetectors } from "./run.js";
import { CELL_OVERTEMP_C, CELL_OVERTEMP_CURRENT_A, GRID_VOLTAGE_MIN_V } from "./thresholds.js";

function loadCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = text.trim().split(/\r?\n/);
  const cols = lines[0]?.split(",") ?? [];
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    cols.forEach((col, index) => {
      row[col] = cells[index] ?? "";
    });
    return row;
  });
}

const packetPath = path.join(process.cwd(), "data_input", "packet_at_fault_time.csv");
const allowlistPath = path.join(process.cwd(), "data_input", "fw_allowlist.json");
const rows = loadCsv(packetPath);
const manifest = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as FwManifest;

describe("packet_at_fault_time.csv", () => {
  it("matches the detector decision on every row", () => {
    assert.equal(rows.length, 57);
    for (const row of rows) {
      const run = runDetectors(evidenceFromPacketRow(row), manifest);
      const label = `${row.vin} ${row.scenario}`;
      assert.equal(run.decision.rootCauseClass, row.expected_root_cause, label);
      assert.equal(run.decision.maxLevel, row.expected_level, label);
      assert.equal(run.decision.actionId, row.expected_action, label);
      assert.equal(row.fw_on_signed_manifest, fwIsSigned(manifest, row.hw_rev, row.fw_version) ? "Y" : "N", label);
      const temp = Number(row.t_cell_max_c);
      const current = Number(row.i_pack_a);
      const cellTrip = temp > CELL_OVERTEMP_C && Math.abs(current) > CELL_OVERTEMP_CURRENT_A;
      assert.equal(row.cell_overtemp_trip, cellTrip ? "Y" : "N", label);
      assert.equal(row.overtemp_signature, row.evt_over_temp === "1" ? "Y" : "N", label);
      assert.ok(Number(row.v_c_v) < GRID_VOLTAGE_MIN_V, label);
      assert.equal(row.grid_voltage_outside_window, "N", label);
    }
  });

  it("lets an overtemp bit block a stale-firmware OTA", () => {
    const row = rows.find((item) => item.vin === "BP-CORE-9008-08");
    assert.ok(row);
    const run = runDetectors(evidenceFromPacketRow(row), manifest);
    assert.equal(run.decision.smokingInverterRule, true);
    assert.equal(run.decision.blockedActionIds.includes("ota_allowlisted_fw"), true);
    assert.equal(run.decision.blockedActionIds.includes("reboot_firmware"), true);
    assert.deepEqual(run.decision.differentials, ["fw_version_mismatch"]);
  });

  it("records one watchdog reset without calling it a reboot candidate", () => {
    const row = rows.find((item) => item.vin === "BP-CORE-9009-09");
    assert.ok(row);
    const run = runDetectors(evidenceFromPacketRow(row), manifest);
    assert.equal(run.decision.rootCauseClass, "no_fault_found");
    assert.equal(run.decision.actionId, "mark_no_fault_found_monitor");
    assert.equal(run.events.some((event) => event.eventType === "fw.watchdog"), true);
  });
});
