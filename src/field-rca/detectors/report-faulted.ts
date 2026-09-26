/**
 * Print detector results for faulted rows in data_input/packet_at_fault_time.csv.
 * Run: npm run report:faults
 */

import fs from "node:fs";
import path from "node:path";
import type { FwManifest } from "./evidence.js";
import { evidenceFromPacketRow } from "./from-packet.js";
import { runDetectors } from "./run.js";

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

function faulted(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text === "y" || text === "yes" || text === "true" || text === "1";
}

const packetPath = path.join(process.cwd(), "data_input", "packet_at_fault_time.csv");
const allowlistPath = path.join(process.cwd(), "data_input", "fw_allowlist.json");
const manifest = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as FwManifest;
const faultedRows = loadCsv(packetPath).filter((row) => faulted(row.faulted));

const results = faultedRows.map((row) => {
  const run = runDetectors(evidenceFromPacketRow(row), manifest);
  return { row, decision: run.decision };
});

const tally = new Map<string, number>();
for (const { decision } of results) {
  tally.set(decision.rootCauseClass, (tally.get(decision.rootCauseClass) ?? 0) + 1);
}

const headers = ["VIN", "Scenario", "Class", "Level", "Action", "L0", "Note"];
const body = results.map(({ row, decision }) => [
  row.vin,
  row.scenario,
  decision.rootCauseClass,
  decision.maxLevel,
  decision.actionId,
  decision.smokingInverterRule ? "yes" : "",
  noteFor(decision.rootCauseClass, decision.maxLevel),
]);

console.log(`${results.length} faulted inverters\n`);
console.log(renderTable(headers, body));

const tallyRows = [...tally.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([rootCause, count]) => [String(count), rootCause]);
console.log("\nBy class\n");
console.log(renderTable(["Count", "Class"], tallyRows));

function noteFor(rootCause: string, level: string): string {
  switch (rootCause) {
    case "no_fault_found":
      return "keep in field";
    case "thermal_or_safety_event":
      return "safety clamp";
    case "install_commissioning_incomplete":
      return "checklist";
    case "install_wiring_or_sense_error":
      return "CT / wiring";
    case "unknown":
      return "no signature";
    case "fw_version_mismatch":
      return "FW not signed";
    case "fw_soft_fault_reboot_candidate":
      return "watchdog loop";
    case "can_link_unreliable":
      return level === "L4" ? "reseat connector" : "CAN errors";
    case "grid_or_home_side_condition":
      return "grid / home";
    case "true_hardware_defect":
      return "HQ after playbooks";
    default:
      return "";
  }
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  return [format(headers), rule, ...rows.map(format)].join("\n");
}
