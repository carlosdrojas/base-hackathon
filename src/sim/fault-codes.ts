// MOCKED fault codes invented for the demo, not Base's real codes. Design doc §4 "Fault codes".
import type { PlantableFault } from "../response/types.js";

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

export const PLANTABLE_FAULTS = Object.keys(FAULT_CODES) as PlantableFault[];

export function faultCodes(fault: PlantableFault | null): string[] {
  return fault ? [FAULT_CODES[fault]] : [];
}
