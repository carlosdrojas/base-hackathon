/**
 * One row of packet_at_fault_time.csv → detector evidence.
 * Line voltage is min(v_a, v_b). v_c is about 2 V on every unit in this file, including healthy ones, so it is not a grid phase.
 * Blank rail / CAN / checklist cells mean "not observed".
 */

import type { BootReason, DetectorEvidence } from "./evidence.js";

const BOOT_REASONS: readonly BootReason[] = ["power_on", "WDT", "reboot_cmd", "ota", "panic"];

function yn(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "y" || text === "yes" || text === "true" || text === "1") return true;
  if (text === "n" || text === "no" || text === "false" || text === "0") return false;
  return undefined;
}

function num(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bootReason(value: string | undefined): BootReason {
  const text = value?.trim() ?? "";
  if (BOOT_REASONS.includes(text as BootReason)) return text as BootReason;
  return "power_on";
}

export function evidenceFromPacketRow(row: Record<string, string>): DetectorEvidence {
  const railsFlag = yn(row.rails_all_present);
  const checklist = yn(row.checklist_complete);
  const selfTest = yn(row.first_boot_self_test_pass);
  const canTexts = [
    row.can_error_frames,
    row.can_dropped_frames,
    row.can_bus_off_count,
    row.can_link_flaps,
    row.can_missing_nodes,
  ];
  const hasCan = canTexts.some((value) => value != null && value.trim() !== "");

  return {
    caseId: `pkt-${row.vin}`,
    vin: row.vin,
    observedAt: row.ts_utc,
    hwRev: row.hw_rev?.trim() ? row.hw_rev.trim() : null,
    fwVersion: row.fw_version?.trim() ? row.fw_version.trim() : null,
    faulted: yn(row.faulted) === true,
    activeFaultCodes: [],
    repeatFaultCode: false,
    offline: yn(row.gateway_offline) === true,
    boot: {
      reason: bootReason(row.boot_reason),
      watchdogResets: num(row.watchdog_resets) ?? 0,
      panicCount: num(row.panic_count) ?? 0,
      repeatedSoftReset: yn(row.repeated_soft_reset) === true,
    },
    rails:
      railsFlag === undefined
        ? undefined
        : {
            allPresent: railsFlag,
            missingWhenMated: yn(row.rail_missing_when_mated) === true,
            healthy: yn(row.rails_healthy) === true,
          },
    can: hasCan
      ? {
          errorFrames: num(row.can_error_frames) ?? 0,
          droppedFrames: num(row.can_dropped_frames) ?? 0,
          busOffCount: num(row.can_bus_off_count) ?? 0,
          missingNodes: (row.can_missing_nodes ?? "")
            .split(";")
            .map((node) => node.trim())
            .filter((node) => node.length > 0),
          linkFlapCount: num(row.can_link_flaps) ?? 0,
        }
      : undefined,
    commissioning:
      checklist === undefined && selfTest === undefined
        ? undefined
        : {
            checklistComplete: checklist !== false,
            firstBootSelfTestPass: selfTest !== false,
          },
    sense: {
      gridSenseImplausible: false,
      ctPolarityReversed: yn(row.ct_polarity_reversed) === true,
    },
    grid: {
      voltageV: num(row.line_voltage_v),
      freqHz: num(row.hz),
      houseLoadKw: num(row.house_load_kw),
      islandingFailed: yn(row.islanding_failed) === true,
    },
    safety: {
      overtemp: yn(row.overtemp_signature) === true,
      cellTempMaxC: num(row.t_cell_max_c),
      packCurrentA: num(row.i_pack_a),
    },
    attempts: {
      rebootPlaybookDone: yn(row.reboot_playbook_done) === true,
      reseatPlaybookDone: yn(row.reseat_playbook_done) === true,
      faultRepeatedAfterBoth: yn(row.fault_repeated_after_both) === true,
    },
  };
}
