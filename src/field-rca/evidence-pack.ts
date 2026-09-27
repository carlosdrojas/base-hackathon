/**
 * Evidence pack attached to an RCA case. The fleet map does not render this object.
 * CSV columns fill the pack. fixtures/packets/{vin}.json overrides fields.
 * Canned logs live in fixtures/logs and are linked from the case, not copied onto the map.
 */

import fs from "node:fs";
import path from "node:path";

export interface CanPack {
  error_frames_per_min: number;
  dropped: number;
  bus_off: number;
  missing_nodes: string[];
}

/** Shape the triaging agent is allowed to read. */
export interface EvidencePack {
  vin: string;
  hw_rev: string;
  fw_version: string;
  fw_allowlist: string[];
  fault_code: string | null;
  boot_reason: string;
  uptime_s: number | null;
  can: CanPack;
  thermal_c: number | null;
  grid_v: number | null;
  soc: number | null;
  connectivity: string;
  commissioning_complete: boolean;
  recent_reboots_24h: number;
  l0_flags: string[];
}

export interface CaseLog {
  id: string;
  path: string;
  text: string;
}

/** Case record. Map markers stay on the fleet row; they do not embed this pack. */
export interface EvidenceCase {
  case_id: string;
  vin: string;
  evidence: EvidencePack;
  logs: CaseLog[];
}

const LOG_FILES = {
  watchdog: "watchdog.txt",
  "bus-off": "bus-off.txt",
  "cell-overtemp": "cell-overtemp.txt",
  nff: "nff.txt",
} as const;

type LogId = keyof typeof LOG_FILES;

function num(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function yes(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase() ?? "";
  return text === "y" || text === "yes" || text === "true" || text === "1";
}

function nodes(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(";")
    .map((node) => node.trim())
    .filter((node) => node.length > 0);
}

export function buildEvidencePack(row: Record<string, string>, allowlist: readonly string[]): EvidencePack {
  const offline = yes(row.gateway_offline);
  const overtemp = yes(row.overtemp_signature) || yes(row.cell_overtemp_trip);
  const busOff = num(row.can_bus_off_count) ?? 0;
  const missing = nodes(row.can_missing_nodes);
  const reboots = num(row.watchdog_resets) ?? 0;
  const boot = row.boot_reason === "WDT" || row.boot_reason === "watchdog" ? "watchdog" : (row.boot_reason?.trim() || "power_on");
  const checklist = row.checklist_complete?.trim() === "" ? true : yes(row.checklist_complete);
  const selfTest = row.first_boot_self_test_pass?.trim() === "" ? true : yes(row.first_boot_self_test_pass);

  let faultCode: string | null = null;
  if (overtemp) faultCode = "OVERTEMP";
  else if (busOff > 0 || missing.length > 0) faultCode = "CAN_TIMEOUT";
  else if (boot === "watchdog" && reboots >= 2) faultCode = "WDT_LOOP";

  const l0Flags: string[] = [];
  if (overtemp) l0Flags.push("overtemp");

  return {
    vin: row.vin ?? "",
    hw_rev: row.hw_rev?.trim() || "unknown",
    fw_version: row.fw_version?.trim() || "missing",
    fw_allowlist: [...allowlist],
    fault_code: faultCode,
    boot_reason: boot,
    uptime_s: null,
    can: {
      error_frames_per_min: num(row.can_error_frames) ?? 0,
      dropped: num(row.can_dropped_frames) ?? 0,
      bus_off: busOff,
      missing_nodes: missing,
    },
    thermal_c: num(row.t_cell_max_c),
    grid_v: num(row.line_voltage_v),
    soc: num(row.soc),
    connectivity: offline ? "offline" : "lte-ok",
    commissioning_complete: checklist && selfTest,
    recent_reboots_24h: reboots,
    l0_flags: l0Flags,
  };
}

export function mergeEvidencePack(base: EvidencePack, overlay: Partial<EvidencePack>): EvidencePack {
  return {
    ...base,
    ...overlay,
    fw_allowlist: overlay.fw_allowlist ?? base.fw_allowlist,
    can: { ...base.can, ...overlay.can },
    l0_flags: overlay.l0_flags ?? base.l0_flags,
  };
}

export function logIdForPack(pack: EvidencePack): LogId {
  if (pack.l0_flags.some((flag) => /temp|thermal|smoke|pyro/i.test(flag))) return "cell-overtemp";
  if (pack.can.bus_off > 0 || pack.can.missing_nodes.length > 0) return "bus-off";
  if (pack.boot_reason === "watchdog" && pack.recent_reboots_24h >= 2) return "watchdog";
  return "nff";
}

export function openEvidenceCase(
  row: Record<string, string>,
  options: { allowlist: readonly string[]; fixturesRoot?: string },
): EvidenceCase {
  const root = options.fixturesRoot ?? path.join(process.cwd(), "fixtures");
  let evidence = buildEvidencePack(row, options.allowlist);
  const packetPath = path.join(root, "packets", `${evidence.vin}.json`);
  if (fs.existsSync(packetPath)) {
    const overlay = JSON.parse(fs.readFileSync(packetPath, "utf8")) as Partial<EvidencePack>;
    evidence = mergeEvidencePack(evidence, overlay);
  }
  const logId = logIdForPack(evidence);
  const logPath = path.join(root, "logs", LOG_FILES[logId]);
  const logs: CaseLog[] = fs.existsSync(logPath)
    ? [{ id: logId, path: logPath, text: fs.readFileSync(logPath, "utf8") }]
    : [];
  return { case_id: `rca-${evidence.vin}`, vin: evidence.vin, evidence, logs };
}
