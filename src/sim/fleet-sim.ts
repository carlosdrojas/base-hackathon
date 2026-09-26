// Fake fleet: MOCKED simulated inverters behind the FleetGateway contract.
// Behavior is the §4 response table in docs/field-rca/response-agent.md. No Base production APIs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActionResult,
  ActionType,
  DeviceStatus,
  FleetGateway,
  PlantableFault,
  UnitState,
  User,
  VisitOutcome,
} from "../response/types.js";
import { FAULT_CODES, PLANTABLE_FAULTS, faultCodes } from "./fault-codes.js";

// Shape of data/sim-fleet.seed.json (not in types.ts; flagged for integration).
export interface SimSeed {
  _note?: string;
  fw_allowlist: string[];
  misdiagnose: Record<string, { root_cause: string; confidence: number; why: string }>;
  users: User[];
  tech_roster: { user_id: string; skills: string[]; zone: string }[];
  drivers: User[];
  units: UnitState[];
}

export interface FleetSimOptions {
  seedPath?: string;
  runtimePath?: string;
  /** Seeded reboot flakiness (§4). Defaults to env SIM_FLAKY=1. */
  flaky?: boolean;
  /** Clock override for tests. */
  now?: () => Date;
}

// src/sim/ and dist/sim/ are both two levels below the repo root.
export const DEFAULT_SEED_PATH = fileURLToPath(new URL("../../data/sim-fleet.seed.json", import.meta.url));
export const DEFAULT_RUNTIME_PATH = fileURLToPath(new URL("../../data/runtime/sim-fleet.json", import.meta.url));

type Outcome = ActionResult["outcome"];

const READ_ONLY: ActionType[] = ["request_log_dump", "can_health_query"];
const NON_DEVICE: ActionType[] = ["dispatch_tech", "engineer_bug_report"];
const JUSTIFIED_PULL: (PlantableFault | null)[] = ["true_hardware_defect", "thermal_or_safety_event"];

export class FleetSim implements FleetGateway {
  readonly seedPath: string;
  readonly runtimePath: string;
  readonly flaky: boolean;
  private readonly now: () => Date;
  private data: SimSeed;

  constructor(opts: FleetSimOptions = {}) {
    this.seedPath = opts.seedPath ?? DEFAULT_SEED_PATH;
    this.runtimePath = opts.runtimePath ?? DEFAULT_RUNTIME_PATH;
    this.flaky = opts.flaky ?? process.env.SIM_FLAKY === "1";
    this.now = opts.now ?? (() => new Date());
    if (existsSync(this.runtimePath)) {
      this.data = JSON.parse(readFileSync(this.runtimePath, "utf8")) as SimSeed;
    } else {
      this.data = this.readSeed();
      this.persist();
    }
  }

  // ---- read side ---------------------------------------------------------

  get fwAllowlist(): string[] {
    return [...this.data.fw_allowlist];
  }

  /** Seed extras the engine needs (users, roster, drivers, misdiagnose). */
  get seed(): Omit<SimSeed, "units"> {
    const { units: _units, ...rest } = structuredClone(this.data);
    return rest;
  }

  list(): DeviceStatus[] {
    return this.data.units.map((u) => this.toStatus(u));
  }

  getStatus(vin: string): DeviceStatus {
    return this.toStatus(this.unit(vin));
  }

  getUnitState(vin: string): UnitState {
    return structuredClone(this.unit(vin));
  }

  // ---- device actions ----------------------------------------------------

  apply(vin: string, action: ActionType, params: Record<string, string> = {}): ActionResult {
    const u = this.unit(vin);
    const fault = u.fault;
    let outcome: Outcome;
    let detail: string;

    if (READ_ONLY.includes(action)) {
      outcome = "info_only";
      detail = readOnlyDetail(action, fault);
    } else if (NON_DEVICE.includes(action)) {
      outcome = "info_only";
      detail = `${action} is not a device command; no change to the unit`;
    } else if (action === "monitor") {
      if (fault === "no_fault_found") {
        this.clearFault(u);
        outcome = "cleared";
        detail = "Monitored: no recurrence, transient latch cleared";
      } else {
        outcome = "no_change";
        detail = fault ? `Monitored: ${FAULT_CODES[fault]} still active` : "Monitored: unit healthy, nothing to watch";
      }
    } else if (action === "reboot") {
      ({ outcome, detail } = this.reboot(u));
    } else if (action === "ota_to_allowlisted") {
      ({ outcome, detail } = this.ota(u, params.target_fw));
    } else if (action === "hq_recovery") {
      ({ outcome, detail } = this.hqRecovery(u));
    } else {
      throw new Error(`FleetSim: unknown action ${String(action)}`);
    }

    return this.record(u, action, outcome, detail);
  }

  techVisit(vin: string, visit: VisitOutcome): ActionResult {
    const u = this.unit(vin);
    const fault = u.fault;
    let outcome: Outcome;
    let detail: string;

    if (!visit.completed) {
      outcome = "no_change";
      detail = `Visit incomplete${visit.incomplete_reason ? ` (${visit.incomplete_reason})` : ""}; unit unchanged`;
    } else {
      switch (fault) {
        case "fw_soft_fault_reboot_candidate":
          this.clearFault(u);
          this.boot(u, "power_on");
          outcome = "cleared";
          detail = "Tech power-cycled the unit; watchdog loop cleared";
          break;
        case "can_link_unreliable":
          this.clearFault(u);
          outcome = "cleared";
          detail = "Tech reseated the CAN connector; link stable";
          break;
        case "install_commissioning_incomplete":
          this.clearFault(u);
          outcome = "cleared";
          detail = "Tech completed commissioning";
          break;
        case "install_wiring_or_sense_error":
          this.clearFault(u);
          outcome = "cleared";
          detail = "Tech corrected CT wiring / sense leads";
          break;
        case "grid_or_home_side_condition":
          this.clearFault(u);
          outcome = "nothing_found";
          detail = "Unit OK; home-side issue, customer notified; fault cleared on unit";
          break;
        case "no_fault_found":
          this.clearFault(u);
          outcome = "nothing_found";
          detail = "Tech found nothing wrong; latch cleared (avoided false pull)";
          break;
        case "fw_version_mismatch":
          outcome = "no_change";
          detail = "Needs engineer-approved OTA; nothing to fix on site";
          break;
        case "true_hardware_defect":
          outcome = "no_change";
          detail = "Power stage failure confirmed on site; needs HQ recovery";
          break;
        case "thermal_or_safety_event":
          u.online = false;
          outcome = "made_safe";
          detail = "Tech isolated and made the unit safe; needs HQ recovery";
          break;
        case null:
          outcome = "nothing_found";
          detail = "Tech found nothing wrong; unit healthy";
          break;
      }
    }

    return this.record(u, "tech_visit", outcome, detail);
  }

  // ---- demo controls -----------------------------------------------------

  plantFault(vin: string, fault: PlantableFault): void {
    if (!PLANTABLE_FAULTS.includes(fault)) throw new Error(`FleetSim: not a plantable fault: ${fault}`);
    const u = this.unit(vin);
    u.fault = fault;
    u.fault_time = this.now().toISOString();
    u.online = true;
    this.persist();
  }

  reset(): void {
    this.data = this.readSeed();
    this.persist();
  }

  // ---- internals ---------------------------------------------------------

  private reboot(u: UnitState): { outcome: Outcome; detail: string } {
    if (u.fault === "thermal_or_safety_event") {
      return { outcome: "refused_interlock", detail: "Device refused reboot: safety interlock (INV-F900) active" };
    }
    const firstTry = !u.action_history.some((r) => r.action === "reboot");
    this.boot(u, "reboot_cmd");
    switch (u.fault) {
      case "fw_soft_fault_reboot_candidate":
        if (this.flaky && firstTry && flakyForVin(u.vin)) {
          return { outcome: "no_change", detail: "Rebooted, but watchdog loop recurred (SIM_FLAKY first-try failure)" };
        }
        this.clearFault(u);
        return { outcome: "cleared", detail: "Rebooted; watchdog loop cleared" };
      case "no_fault_found":
        this.clearFault(u);
        return { outcome: "cleared", detail: "Rebooted; transient latch cleared" };
      case "fw_version_mismatch":
        return { outcome: "no_change", detail: "Rebooted; INV-F120 FW_COMPAT returned after boot" };
      case null:
        return { outcome: "no_change", detail: "Rebooted; unit stays healthy" };
      default:
        return { outcome: "no_change", detail: `Rebooted; ${FAULT_CODES[u.fault]} still active` };
    }
  }

  private ota(u: UnitState, target: string | undefined): { outcome: Outcome; detail: string } {
    if (!target || !this.data.fw_allowlist.includes(target)) {
      throw new Error(`FleetSim: OTA target_fw ${target ?? "(missing)"} is not on the allow-list`);
    }
    if (u.fault === "thermal_or_safety_event") {
      return { outcome: "refused_interlock", detail: "Device refused OTA: safety interlock (INV-F900) active" };
    }
    const from = u.fw_version;
    u.fw_version = target;
    this.boot(u, "ota");
    switch (u.fault) {
      case "fw_soft_fault_reboot_candidate":
      case "fw_version_mismatch":
      case "no_fault_found":
        this.clearFault(u);
        return { outcome: "cleared", detail: `OTA ${from} → ${target}; fault cleared` };
      case null:
        return { outcome: "no_change", detail: `OTA ${from} → ${target}; unit stays healthy` };
      default:
        return { outcome: "no_change", detail: `OTA ${from} → ${target}; ${FAULT_CODES[u.fault]} still active` };
    }
  }

  private hqRecovery(u: UnitState): { outcome: Outcome; detail: string } {
    const was = u.fault;
    u.fault = null;
    u.fault_time = null;
    u.fw_version = this.data.fw_allowlist[0];
    u.online = true;
    this.boot(u, "power_on");
    const justified = JUSTIFIED_PULL.includes(was);
    return {
      outcome: "replaced",
      detail: justified
        ? `Unit replaced at HQ (justified: ${was})`
        : `Unit replaced at HQ (unnecessary pull: true fault ${was ?? "none"})`,
    };
  }

  private boot(u: UnitState, reason: UnitState["last_boot_reason"]): void {
    u.uptime_s = 0;
    u.last_boot_reason = reason;
  }

  private clearFault(u: UnitState): void {
    u.fault = null;
    u.fault_time = null;
    u.online = true;
  }

  private record(u: UnitState, action: ActionType | "tech_visit", outcome: Outcome, detail: string): ActionResult {
    u.action_history.push({ action, ts: this.now().toISOString(), result: outcome });
    this.persist();
    return { vin: u.vin, action, outcome, detail, status_after: this.toStatus(u) };
  }

  private toStatus(u: UnitState): DeviceStatus {
    return {
      vin: u.vin,
      asset_id: u.asset_id,
      fw_version: u.fw_version,
      online: u.online,
      faulted: u.fault !== null,
      active_fault_codes: faultCodes(u.fault),
      uptime_s: u.uptime_s,
      last_boot_reason: u.last_boot_reason,
      last_seen: this.now().toISOString(),
    };
  }

  private unit(vin: string): UnitState {
    const u = this.data.units.find((x) => x.vin === vin);
    if (!u) throw new Error(`FleetSim: unknown vin ${vin}`);
    return u;
  }

  private readSeed(): SimSeed {
    return JSON.parse(readFileSync(this.seedPath, "utf8")) as SimSeed;
  }

  private persist(): void {
    mkdirSync(dirname(this.runtimePath), { recursive: true });
    const tmp = `${this.runtimePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.runtimePath);
  }
}

function readOnlyDetail(action: ActionType, fault: PlantableFault | null): string {
  if (action === "can_health_query") {
    return fault === "can_link_unreliable"
      ? "CAN health: link flaps, intermittent frame loss"
      : "CAN health: link stable, no frame loss";
  }
  return fault ? `Log dump captured; latest code ${FAULT_CODES[fault]}` : "Log dump captured; no active faults";
}

/** Deterministic per-VIN draw: true for ~25% of VINs (FNV-1a hash). */
export function flakyForVin(vin: string): boolean {
  let h = 0x811c9dc5;
  for (const ch of vin) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100 < 25;
}
