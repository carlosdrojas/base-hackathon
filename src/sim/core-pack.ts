// Loads the team's synthetic Base Core telemetry pack (data_input/) as a fleet for FleetSim.
// MOCKED: simulated data shaped by the team, not Base production data. See data_input/DATA_DICTIONARY.md.
//
// Truth per unit comes from `scenario` (packet_at_fault_time.csv) and the answer key from
// inventory.csv (`recommended_action`, `do_not_return_hardware`). Neither is shown to diagnosis or
// the planner: diagnosis runs Megan's detectors on the packet row (src/response/detector-hypothesis.ts).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerKey, PlantableFault, UnitState } from "../response/types.js";
import type { SimSeed } from "./fleet-sim.js";

export const DATA_INPUT_DIR = fileURLToPath(new URL("../../data_input", import.meta.url));

/** How a scenario behaves under each fix, beyond the generic §4 table keyed by `fault`. */
export interface ScenarioSpec {
  fault: PlantableFault | null; // true root cause (drives the generic response table)
  expect: AnswerKey["expect"];
  dnr: boolean; // do_not_return_hardware
  recommended?: string; // answer key for fixtures (not in inventory.csv)
  monitor?: string; // monitoring clears it, with this detail
  reboot?: string; // a remote reboot clears it, with this detail
  tech?: { outcome: "cleared" | "no_change" | "nothing_found" | "made_safe"; detail: string };
}

export const SCENARIOS: Record<string, ScenarioSpec> = {
  normal: { fault: null, expect: "none", dnr: true },
  hot_site_derate_ok: {
    fault: "grid_or_home_side_condition", expect: "no_truck", dnr: true,
    monitor: "Derate ended as the garage cooled; fans spinning, unit healthy",
    tech: { outcome: "nothing_found", detail: "Unit fine; hot garage, site ventilation advised to customer" },
  },
  fan_never_installed: {
    fault: "install_commissioning_incomplete", expect: "on_site", dnr: true,
    tech: { outcome: "cleared", detail: "Installed the 2 missing fans (BOM expects 2, enum saw 0); over-temp cleared" },
  },
  fan_stalled: {
    fault: "true_hardware_defect", expect: "on_site", dnr: true,
    tech: { outcome: "cleared", detail: "Replaced the stalled fan on site; inverter and pack stay in the field" },
  },
  fan_unplugged: {
    fault: "install_wiring_or_sense_error", expect: "on_site", dnr: true,
    tech: { outcome: "cleared", detail: "Reseated the fan harness; RPM back, over-temp cleared" },
  },
  intake_restricted: {
    fault: "install_commissioning_incomplete", expect: "on_site", dnr: true,
    tech: { outcome: "cleared", detail: "Cleared the blocked intake; clearance restored, heatsink ΔT normal" },
  },
  igbt_module_fault: {
    fault: "true_hardware_defect", expect: "pull", dnr: false,
    tech: { outcome: "no_change", detail: "IGBT phase A far hotter than B/C; module failure confirmed on site" },
  },
  sensor_implausible: {
    fault: "install_wiring_or_sense_error", expect: "on_site", dnr: true,
    tech: { outcome: "cleared", detail: "Replaced the heatsink NTC; power stack stays in the field" },
  },
  healthy_false_alarm: { fault: "no_fault_found", expect: "no_truck", dnr: true },
  ct_reversed: {
    fault: "install_wiring_or_sense_error", expect: "on_site", dnr: true,
    tech: { outcome: "cleared", detail: "Flipped the CT to the correct orientation; AC current sign fixed" },
  },
  comms_stale: {
    fault: "can_link_unreliable", expect: "no_truck", dnr: true,
    reboot: "Gateway restarted remotely; packets flowing again",
    tech: { outcome: "cleared", detail: "Power-cycled the gateway on site; comms restored" },
  },
  cell_gradient: { fault: "thermal_or_safety_event", expect: "pull", dnr: false },
  // Detector fixtures (packet rows only, no inventory row): answer keys follow their scenario names.
  fixture_fw_mismatch: { fault: "fw_version_mismatch", expect: "no_truck", dnr: true, recommended: "L3_ota_allowlisted_fw" },
  fixture_watchdog: { fault: "fw_soft_fault_reboot_candidate", expect: "no_truck", dnr: true, recommended: "L2_reboot_firmware" },
  fixture_single_watchdog: { fault: "no_fault_found", expect: "no_truck", dnr: true, recommended: "L1_monitor" },
  fixture_can_bus_off: { fault: "can_link_unreliable", expect: "on_site", dnr: true, recommended: "L4_reseat_can_connector" },
  fixture_can_drops: { fault: "can_link_unreliable", expect: "on_site", dnr: true, recommended: "L4_reseat_can_connector" },
  fixture_commissioning: { fault: "install_commissioning_incomplete", expect: "on_site", dnr: true, recommended: "L4_finish_commissioning" },
  fixture_grid_home: {
    fault: "grid_or_home_side_condition", expect: "no_truck", dnr: true, recommended: "L1_monitor_home_side",
    monitor: "Home-side condition cleared; unit healthy",
  },
  fixture_hardware: { fault: "true_hardware_defect", expect: "pull", dnr: false, recommended: "L4_schedule_hq_recovery" },
  fixture_l0_and_stale_fw: { fault: "thermal_or_safety_event", expect: "pull", dnr: false, recommended: "L0_flag_then_hq_recovery" },
};

export type Row = Record<string, string>;

/** Minimal CSV reader: the pack has no quoted fields. */
export function readCsv(file: string): Row[] {
  const lines = readFileSync(file, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const cols = lines[0].split(",");
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const cells = line.split(",");
    const row: Row = {};
    cols.forEach((c, i) => (row[c] = cells[i] ?? ""));
    return row;
  });
}

const yes = (v: string | undefined) => ["y", "yes", "true", "1"].includes((v ?? "").trim().toLowerCase());

/** Semver-ish descending sort so allowlist[0] is the newest signed build (OTA target). */
function byVersionDesc(a: string, b: string): number {
  const n = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** Codes a device would report, from the packet's detector bits and fixture flags. */
export function packetCodes(row: Row): string[] {
  const codes = Object.keys(row)
    .filter((k) => k.startsWith("evt_") && !["", "0", "0.0"].includes(row[k]))
    .map((k) => `CORE ${k.slice(4).toUpperCase()}`);
  if (Number(row.watchdog_resets) > 0) codes.push(`CORE WDT_RESET x${row.watchdog_resets}`);
  if (Number(row.can_bus_off_count) > 0) codes.push("CORE CAN_BUS_OFF");
  if (Number(row.can_dropped_frames) > 0) codes.push("CORE CAN_DROPS");
  if (row.fw_on_signed_manifest === "N") codes.push("CORE FW_NOT_SIGNED");
  if (row.checklist_complete === "N") codes.push("CORE COMMISSIONING_INCOMPLETE");
  if (yes(row.gateway_offline)) codes.push("CORE GATEWAY_OFFLINE");
  return codes.length ? codes : ["CORE FAULT_FLAG"];
}

export interface CorePack {
  seed: SimSeed;
  packets: Map<string, Row>; // vin → packet_at_fault_time row
  events: Map<string, Row[]>; // vin → events.csv rows
}

/**
 * Build a FleetSim seed from the pack. Users, roster and drivers come from the demo seed so the
 * role switcher and scheduling work the same on both fleets.
 */
export function loadCorePack(base: Omit<SimSeed, "units">, dir = DATA_INPUT_DIR): CorePack {
  const packetRows = readCsv(join(dir, "packet_at_fault_time.csv"));
  const inventory = new Map(readCsv(join(dir, "inventory.csv")).map((r) => [r.vin, r]));
  const events = new Map<string, Row[]>();
  if (existsSync(join(dir, "events.csv"))) {
    for (const e of readCsv(join(dir, "events.csv"))) events.set(e.vin, [...(events.get(e.vin) ?? []), e]);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "fw_allowlist.json"), "utf8")) as { signedForAllRevs?: string[] };
  const allowlist = [...(manifest.signedForAllRevs ?? [])].sort(byVersionDesc);

  const units: UnitState[] = packetRows.map((row, i) => {
    const inv = inventory.get(row.vin);
    const spec = SCENARIOS[row.scenario] ?? { fault: "unknown" as never, expect: "none", dnr: true };
    const faulted = yes(row.faulted) && spec.fault !== null;
    // Fixtures have no inventory row: place them deterministically around Austin.
    const lat = inv ? Number(inv.lat) : 30.27 + ((i * 37) % 40) / 400;
    const lng = inv ? Number(inv.lon) : -97.74 + ((i * 53) % 40) / 400;
    return {
      vin: row.vin,
      asset_id: row.vin,
      site: inv ? `${inv.city}, ${inv.state} (${inv.site_type.replace(/_/g, " ")})` : "Austin, TX (detector fixture)",
      lat,
      lng,
      hw_rev: row.hw_rev || inv?.hw_rev || "G3",
      sku: "BASE-CORE-39.2",
      fw_version: row.fw_version || inv?.fw_rev || allowlist[0],
      install_date: "",
      crew_id: ["CREW-N1", "CREW-S2", "CREW-E3"][i % 3],
      fault: faulted ? spec.fault : null,
      fault_time: faulted ? row.ts_utc : null,
      online: !yes(row.gateway_offline),
      uptime_s: 3600 * (24 + (i % 90)),
      last_boot_reason: row.boot_reason === "WDT" ? "WDT" : "power_on",
      action_history: [],
      scenario: row.scenario,
      fault_codes: faulted ? packetCodes(row) : [],
      answer_key: {
        recommended_action: inv?.recommended_action ?? spec.recommended ?? "none",
        expect: faulted ? spec.expect : "none",
        do_not_return_hardware: inv ? yes(inv.do_not_return_hardware) : spec.dnr,
      },
    };
  });

  return {
    seed: {
      ...base,
      _note: "MOCKED: generated from data_input/ (synthetic Base Core telemetry pack). Not Base data.",
      fw_allowlist: allowlist,
      misdiagnose: {},
      units,
    },
    packets: new Map(packetRows.map((r) => [r.vin, r])),
    events,
  };
}
