// In-memory fake FleetGateway for engine tests. Follows the §4 response table of the design doc.
// The real FleetSim lives in src/sim/ (built separately); this stays a test double. MOCKED.

import type {
  ActionResult,
  ActionType,
  DeviceStatus,
  FleetGateway,
  PlantableFault,
  UnitState,
  VisitOutcome,
} from "./types.js";
import { loadSeed, type FleetSeed } from "./seed.js";

export const FAULT_CODES: Record<PlantableFault, string> = {
  fw_soft_fault_reboot_candidate: "INV-F101 WDT_RESET_LOOP",
  fw_version_mismatch: "INV-F120 FW_COMPAT",
  can_link_unreliable: "INV-F210 CAN_COMM_LOSS",
  install_commissioning_incomplete: "INV-F310 COMMISSIONING",
  install_wiring_or_sense_error: "INV-F320 CT_SENSE",
  grid_or_home_side_condition: "INV-F410 GRID_OOR",
  thermal_or_safety_event: "INV-F900 OVERTEMP",
  true_hardware_defect: "INV-F510 POWER_STAGE",
  no_fault_found: "INV-F050 TRANSIENT",
};

type Outcome = ActionResult["outcome"];

export class FakeFleet implements FleetGateway {
  private units = new Map<string, UnitState>();
  private readonly seed: FleetSeed;
  private clock: () => Date;

  constructor(seed: FleetSeed = loadSeed(), clock: () => Date = () => new Date()) {
    this.seed = seed;
    this.clock = clock;
    this.reset();
  }

  reset(): void {
    this.units = new Map(this.seed.units.map((u) => [u.vin, structuredClone(u)]));
  }

  list(): DeviceStatus[] {
    return [...this.units.keys()].map((vin) => this.getStatus(vin));
  }

  getStatus(vin: string): DeviceStatus {
    const u = this.unit(vin);
    return {
      vin: u.vin,
      asset_id: u.asset_id,
      fw_version: u.fw_version,
      online: u.online,
      faulted: u.fault !== null,
      active_fault_codes: u.fault ? [FAULT_CODES[u.fault]] : [],
      uptime_s: u.uptime_s,
      last_boot_reason: u.last_boot_reason,
      last_seen: this.clock().toISOString(),
    };
  }

  getUnitState(vin: string): UnitState {
    return structuredClone(this.unit(vin));
  }

  plantFault(vin: string, fault: PlantableFault): void {
    const u = this.unit(vin);
    u.fault = fault;
    u.fault_time = this.clock().toISOString();
  }

  apply(vin: string, action: ActionType, params: Record<string, string> = {}): ActionResult {
    const u = this.unit(vin);
    const f = u.fault;
    let outcome: Outcome = "no_change";
    let detail = "No change: fault still present.";

    if (action === "request_log_dump" || action === "can_health_query") {
      outcome = "info_only";
      detail =
        action === "can_health_query" && f === "can_link_unreliable"
          ? "CAN query: link flaps, 37 bus-off events in 24 h."
          : `${action}: returned data.`;
    } else if (action === "hq_recovery") {
      outcome = "replaced";
      const justified = f === "true_hardware_defect" || f === "thermal_or_safety_event";
      detail = justified ? "Unit swapped at HQ (justified pull)." : "Unit swapped at HQ (unnecessary pull).";
      u.fault = null;
      u.fault_time = null;
      u.fw_version = this.seed.fw_allowlist[0];
    } else if (action === "reboot" || action === "ota_to_allowlisted") {
      if (f === "thermal_or_safety_event") {
        outcome = "refused_interlock";
        detail = "Device refused: safety interlock active.";
      } else {
        if (action === "ota_to_allowlisted") {
          const target = params.target_fw;
          if (!target || !this.seed.fw_allowlist.includes(target)) {
            throw new Error(`OTA target ${target} is not on the allow-list`);
          }
          u.fw_version = target;
          u.last_boot_reason = "ota";
        } else {
          u.last_boot_reason = "reboot_cmd";
        }
        u.uptime_s = 0;
        const clears =
          f === "fw_soft_fault_reboot_candidate" ||
          f === "no_fault_found" ||
          (action === "ota_to_allowlisted" && f === "fw_version_mismatch");
        if (clears) {
          outcome = "cleared";
          detail = `${action} cleared the fault.`;
          u.fault = null;
          u.fault_time = null;
        } else if (f === "fw_version_mismatch") {
          detail = "Fault returned after boot.";
        }
      }
    } else if (action === "monitor") {
      if (f === "no_fault_found") {
        outcome = "cleared";
        detail = "No recurrence during the monitor window; latch cleared.";
        u.fault = null;
        u.fault_time = null;
      }
    }
    return this.record(u, action, outcome, detail);
  }

  techVisit(vin: string, visit: VisitOutcome): ActionResult {
    const u = this.unit(vin);
    const f = u.fault;
    if (!visit.completed) return this.record(u, "tech_visit", "no_change", "Visit incomplete: no change.");
    let outcome: Outcome = "no_change";
    let detail = "No change.";
    switch (f) {
      case "fw_soft_fault_reboot_candidate":
      case "can_link_unreliable":
      case "install_commissioning_incomplete":
      case "install_wiring_or_sense_error":
        outcome = "cleared";
        detail = f === "can_link_unreliable" ? "Connector reseated; CAN link stable." : "Fixed on site.";
        u.fault = null;
        u.fault_time = null;
        break;
      case "grid_or_home_side_condition":
      case "no_fault_found":
      case null:
        outcome = "nothing_found";
        detail = f === "grid_or_home_side_condition" ? "Home-side issue; customer notified." : "Nothing wrong found.";
        u.fault = null;
        u.fault_time = null;
        break;
      case "fw_version_mismatch":
        detail = "Needs engineer-approved OTA.";
        break;
      case "true_hardware_defect":
        detail = "Power stage failure confirmed.";
        break;
      case "thermal_or_safety_event":
        outcome = "made_safe";
        detail = "Unit made safe; needs HQ recovery.";
        break;
    }
    return this.record(u, "tech_visit", outcome, detail);
  }

  private record(u: UnitState, action: ActionType | "tech_visit", outcome: Outcome, detail: string): ActionResult {
    u.action_history.push({ action, ts: this.clock().toISOString(), result: outcome });
    return { vin: u.vin, action, outcome, detail, status_after: this.getStatus(u.vin) };
  }

  private unit(vin: string): UnitState {
    const u = this.units.get(vin);
    if (!u) throw new Error(`unknown vin ${vin}`);
    return u;
  }
}
