// Builds a real UnitState[] seed for the Austin fleet from the real fixture CSVs
// (data_input/inventory.csv + data_input/packet_at_fault_time.csv), so FleetSim /
// DefaultResponseEngine can run Carlos's actuation + policy-gate machinery over the
// real Austin cases instead of a synthetic fleet ("full merge" integration).
//
// This is a builder, not a hand-authored JSON file, so it always reflects the current
// CSVs. It is regenerated (see austin-routes.ts) and written to disk because FleetSim
// only ever reads its seed from a file path -- its constructor either loads a persisted
// runtime file or calls readFileSync(this.seedPath) (see src/sim/fleet-sim.ts); there is
// no constructor option to hand it units in memory.
//
// Root-cause taxonomy note: field-rca's RootCauseClass (src/field-rca/contracts.ts) and
// the response engine's RootCause (src/response/types.ts) are the exact same closed set
// of string literals, so a detector decision's rootCauseClass is usable directly as a
// response-engine RootCause/PlantableFault with no translation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceFromPacketRow, openEvidenceCase, runDetectors, type FwManifest } from "../field-rca/index.js";
import type { PlantableFault, UnitState } from "./types.js";
import type { SimSeed } from "../sim/fleet-sim.js";

// src/response/ and dist/response/ both sit two levels below the repo root (matches the
// convention already used by src/sim/fleet-sim.ts and src/response/seed.ts).
export const AUSTIN_SEED_PATH = fileURLToPath(new URL("../../data/austin-fleet.seed.json", import.meta.url));
export const AUSTIN_RUNTIME_DIR = fileURLToPath(new URL("../../data/runtime-austin", import.meta.url));
export const AUSTIN_RUNTIME_FLEET_PATH = path.join(AUSTIN_RUNTIME_DIR, "austin-fleet.json");

export interface SkippedUnit {
  vin: string;
  reason: string;
}

function loadCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
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

function csvBool(value: string | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase();
  return text === "y" || text === "yes" || text === "true" || text === "1";
}

/** Real Base staff roster reused as-is from Carlos's MOCKED seed (data/sim-fleet.seed.json) --
 * there is no real per-technician assignment data for the Austin fleet anywhere in data_input/,
 * so this reuses the same disclosed-MOCKED roster already shown on /fleet's "Technician view"
 * card rather than inventing a second, distinct fake one. */
function loadStaffRoster(): Pick<SimSeed, "users" | "tech_roster" | "drivers"> {
  const carlosSeedPath = path.join(process.cwd(), "data", "sim-fleet.seed.json");
  const carlos = JSON.parse(fs.readFileSync(carlosSeedPath, "utf8")) as SimSeed;
  return { users: carlos.users, tech_roster: carlos.tech_roster, drivers: carlos.drivers };
}

export interface BuildAustinUnitsResult {
  units: UnitState[];
  skipped: SkippedUnit[];
  fwAllowlist: string[];
}

/** Re-derives the Austin fleet's UnitState[] fresh from the real CSVs. Never fabricates a
 * PlantableFault: a real "unknown" detector decision is skipped (not coerced), and the VIN is
 * reported in `skipped` for a human to look at instead of silently entering the seed. */
export function buildAustinUnits(): BuildAustinUnitsResult {
  const inventoryPath = path.join(process.cwd(), "data_input", "inventory.csv");
  const packetPath = path.join(process.cwd(), "data_input", "packet_at_fault_time.csv");
  const allowlistPath = path.join(process.cwd(), "data_input", "fw_allowlist.json");

  const manifest = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as FwManifest & { signedForAllRevs?: string[] };
  const signed = manifest.signedForAllRevs ?? [];

  const austinRows = loadCsv(inventoryPath).filter((row) => row.city === "Austin");
  const packetByVin = new Map(loadCsv(packetPath).map((row) => [row.vin, row]));

  const units: UnitState[] = [];
  const skipped: SkippedUnit[] = [];

  for (const row of austinRows) {
    const vin = row.vin;
    const faulted = csvBool(row.faulted);
    const packet = packetByVin.get(vin);

    if (!packet) {
      if (faulted) {
        skipped.push({ vin, reason: "inventory.csv marks this unit faulted but it has no row in packet_at_fault_time.csv -- no real evidence to diagnose from" });
        continue;
      }
      // Healthy unit with no packet row: still seed it (site/lat/lng/fw/hw are all real from
      // inventory.csv), just with placeholder online/boot fields since there's no evidence pack.
      units.push(unitFromInventoryRow(row, null, true, "power_on", 0));
      continue;
    }

    const evidenceCase = openEvidenceCase(packet, { allowlist: signed });
    const online = evidenceCase.evidence.connectivity !== "offline"; // real: packet's gateway_offline column
    const rawBoot = packet.boot_reason?.trim();
    // UnitState.last_boot_reason has no "panic" member (unlike the raw packet enum); a real
    // panic boot folds into "WDT" since both are soft-fault reboot signatures in this taxonomy.
    // No Austin unit currently has boot_reason=panic, but this keeps the mapping total.
    const lastBootReason: UnitState["last_boot_reason"] =
      rawBoot === "WDT" || rawBoot === "reboot_cmd" || rawBoot === "ota" ? rawBoot : rawBoot === "panic" ? "WDT" : "power_on";

    let fault: PlantableFault | null = null;
    if (faulted) {
      const run = runDetectors(evidenceFromPacketRow(packet), manifest);
      const rootCauseClass = run.decision.rootCauseClass;
      if (rootCauseClass === "unknown") {
        skipped.push({
          vin,
          reason: `real detector decision was "unknown" -- not coerced into a fake PlantableFault; left out of the Austin seed for a human to review. Detector summary: ${run.decision.summary}`,
        });
        continue;
      }
      fault = rootCauseClass;
    }

    units.push(unitFromInventoryRow(row, fault, online, lastBootReason, 0));
  }

  return { units, skipped, fwAllowlist: signed };
}

function unitFromInventoryRow(
  row: Record<string, string>,
  fault: PlantableFault | null,
  online: boolean,
  lastBootReason: UnitState["last_boot_reason"],
  uptimeS: number,
): UnitState {
  return {
    vin: row.vin,
    // inventory.csv has no separate asset_id column; reusing the real VIN rather than
    // fabricating a distinct-looking asset code.
    asset_id: row.vin,
    // UnitState.site's own doc comment says "street address, for display", but
    // data_input/inventory.csv only records city-level location (one lat/lon per city,
    // shared by every unit in it -- see fleet-dashboard.ts's own note on this). Using the
    // real "<city>, <state>" string here instead of fabricating a fake street address.
    site: [row.city, row.state].filter(Boolean).join(", "),
    lat: Number(row.lat),
    lng: Number(row.lon),
    hw_rev: row.hw_rev,
    // No per-unit SKU field anywhere in data_input/ -- obviously-placeholder, not a
    // plausible-looking fake value.
    sku: "UNKNOWN_SKU (no per-unit SKU field in inventory.csv)",
    fw_version: row.fw_rev,
    // No per-unit install date or crew field in data_input/ -- fixed placeholders per the
    // integration instructions (an obvious placeholder date, crew_id "unassigned").
    install_date: "1970-01-01",
    crew_id: "unassigned",
    fault,
    fault_time: fault ? row.fault_time_utc || null : null,
    online,
    // No real per-unit uptime field anywhere in the pipeline: packet_at_fault_time.csv has
    // no uptime column, and evidence-pack.ts's own EvidencePack.uptime_s is unconditionally
    // null too. Placeholder 0, not a fabricated number.
    uptime_s: uptimeS,
    last_boot_reason: lastBootReason,
    action_history: [],
  };
}

/** Regenerates the Austin seed JSON on disk from the current CSVs. Call once at server
 * startup, before constructing FleetSim against AUSTIN_SEED_PATH. */
export function writeAustinSeedFile(outPath: string = AUSTIN_SEED_PATH): { skipped: SkippedUnit[] } {
  const { units, skipped, fwAllowlist } = buildAustinUnits();
  const staff = loadStaffRoster();
  const seed: SimSeed = {
    _note:
      "Austin fleet seed, regenerated from data_input/inventory.csv + packet_at_fault_time.csv on every server start (see austin-seed.ts). fw_allowlist is the real signed manifest from data_input/fw_allowlist.json. users/tech_roster/drivers are MOCKED, reused as-is from Carlos's data/sim-fleet.seed.json (no real per-technician assignment data exists for this fleet). misdiagnose is intentionally empty: AustinHypothesisSource is a real Task 1 implementation, not the misdiagnosis-stub pattern.",
    fw_allowlist: fwAllowlist,
    misdiagnose: {},
    ...staff,
    units,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seed, null, 2) + "\n");
  fs.renameSync(tmp, outPath);
  return { skipped };
}
