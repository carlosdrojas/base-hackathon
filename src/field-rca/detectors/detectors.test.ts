import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceStatus } from "../../response/types.js";
import type { DetectorEvidence, FwManifest } from "./evidence.js";
import { evidenceFromDeviceStatus } from "./from-device-status.js";
import { runDetectors } from "./run.js";
import { CAN_DROPPED_FRAMES_MIN, HOUSE_LOAD_ISLANDING_KW } from "./thresholds.js";

const manifest: FwManifest = { signedForAllRevs: ["3.4.0"] };

function evidence(patch: Partial<DetectorEvidence> = {}): DetectorEvidence {
  const base: DetectorEvidence = {
    caseId: "case-1",
    vin: "INV-1",
    observedAt: "2026-09-26T15:00:00Z",
    hwRev: "A",
    fwVersion: "3.4.0",
    faulted: true,
    activeFaultCodes: [],
    repeatFaultCode: false,
    boot: { reason: "power_on", watchdogResets: 0, panicCount: 0, repeatedSoftReset: false },
    rails: { allPresent: true, missingWhenMated: false, healthy: true },
    can: { errorFrames: 0, droppedFrames: 0, busOffCount: 0, missingNodes: [], linkFlapCount: 0 },
    commissioning: { checklistComplete: true, firstBootSelfTestPass: true },
    sense: { gridSenseImplausible: false, ctPolarityReversed: false },
    grid: { voltageV: 240, freqHz: 60, houseLoadKw: 4, islandingFailed: false },
    safety: {},
    attempts: { rebootPlaybookDone: false, reseatPlaybookDone: false, faultRepeatedAfterBoth: false },
  };
  return { ...base, ...patch };
}

function decide(patch: Partial<DetectorEvidence> = {}, fw: FwManifest = manifest) {
  return runDetectors(evidence(patch), fw);
}

describe("deterministic detectors", () => {
  it("flags firmware that is not on the signed manifest for the hw rev", () => {
    const byRev: FwManifest = { signedForAllRevs: ["3.4.0"], byHwRev: { B: ["1.0.0"], C: [] } };
    const mismatch = decide({ hwRev: "B", fwVersion: "3.4.0" }, byRev);
    assert.equal(mismatch.decision.rootCauseClass, "fw_version_mismatch");
    assert.equal(mismatch.decision.maxLevel, "L3");
    assert.equal(mismatch.decision.actionId, "ota_allowlisted_fw");
    assert.equal(mismatch.decision.blockedActionIds.includes("schedule_hq_recovery"), true);
    assert.match(mismatch.decision.summary, /FW 3\.4\.0 not on allow-list for B \(signed: 1\.0\.0\)/);
    assert.equal(mismatch.events.some((event) => event.eventType === "fw.version_mismatch"), true);

    assert.equal(decide({ hwRev: "B", fwVersion: "1.0.0" }, byRev).decision.rootCauseClass, "no_fault_found");
    assert.equal(decide({ hwRev: "A", fwVersion: "3.4.0" }, byRev).decision.rootCauseClass, "no_fault_found");
    assert.equal(decide({ hwRev: "C", fwVersion: "3.4.0" }, byRev).decision.rootCauseClass, "fw_version_mismatch");
    assert.match(decide({ fwVersion: null }).decision.summary, /FW missing not on allow-list/);
  });

  it("treats a repeated watchdog with healthy rails as a reboot candidate", () => {
    const run = decide({
      boot: { reason: "WDT", watchdogResets: 3, panicCount: 0, repeatedSoftReset: true },
    });
    assert.equal(run.decision.rootCauseClass, "fw_soft_fault_reboot_candidate");
    assert.equal(run.decision.maxLevel, "L2");
    assert.equal(run.decision.actionId, "reboot_firmware");
    assert.equal(run.events.some((event) => event.eventType === "fw.watchdog"), true);
  });

  it("does not call a single watchdog a reboot candidate when the rails are unhealthy", () => {
    const single = decide({
      boot: { reason: "WDT", watchdogResets: 1, panicCount: 0, repeatedSoftReset: false },
    });
    assert.notEqual(single.decision.rootCauseClass, "fw_soft_fault_reboot_candidate");
    assert.equal(single.events.some((event) => event.eventType === "fw.watchdog"), true);

    const unhealthy = decide({
      boot: { reason: "WDT", watchdogResets: 4, panicCount: 0, repeatedSoftReset: true },
      rails: { allPresent: false, missingWhenMated: true, healthy: false },
    });
    assert.notEqual(unhealthy.decision.rootCauseClass, "fw_soft_fault_reboot_candidate");
    assert.equal(unhealthy.decision.rootCauseClass, "install_wiring_or_sense_error");
  });

  it("sends a CAN bus-off to a reseat visit and never to HQ", () => {
    const run = decide({
      can: { errorFrames: 0, droppedFrames: 1, busOffCount: 3, missingNodes: ["0x23"], linkFlapCount: 0 },
      attempts: { rebootPlaybookDone: true, reseatPlaybookDone: true, faultRepeatedAfterBoth: true },
    });
    assert.equal(run.decision.rootCauseClass, "can_link_unreliable");
    assert.equal(run.decision.maxLevel, "L4");
    assert.equal(run.decision.actionId, "dispatch_technician");
    assert.equal(run.decision.photosRequired, true);
    assert.notEqual(run.decision.actionId, "schedule_hq_recovery");
    assert.equal(run.decision.blockedActionIds.includes("schedule_hq_recovery"), true);
    assert.match(run.events.find((event) => event.eventType === "can.node_missing")?.summary ?? "", /0x23/);
  });

  it("ignores a single dropped CAN frame and recommends reseat below the truck-roll level", () => {
    const quiet = decide({
      can: { errorFrames: 0, droppedFrames: 1, busOffCount: 0, missingNodes: [], linkFlapCount: 0 },
    });
    assert.equal(quiet.decision.rootCauseClass, "no_fault_found");

    const noisy = decide({
      can: {
        errorFrames: 0,
        droppedFrames: CAN_DROPPED_FRAMES_MIN,
        busOffCount: 0,
        missingNodes: [],
        linkFlapCount: 0,
      },
    });
    assert.equal(noisy.decision.rootCauseClass, "can_link_unreliable");
    assert.equal(noisy.decision.maxLevel, "L1");
    assert.equal(noisy.decision.actionId, "request_log_dump");
    assert.equal(noisy.decision.photosRequired, false);
  });

  it("prefers the CAN reseat over a watchdog reboot when both are present", () => {
    const run = decide({
      boot: { reason: "WDT", watchdogResets: 4, panicCount: 0, repeatedSoftReset: true },
      can: { errorFrames: 40, droppedFrames: 0, busOffCount: 1, missingNodes: [], linkFlapCount: 0 },
    });
    assert.equal(run.decision.rootCauseClass, "can_link_unreliable");
    assert.equal(run.decision.actionId, "dispatch_technician");
    assert.deepEqual(run.decision.differentials, ["fw_soft_fault_reboot_candidate"]);
  });

  it("sends incomplete commissioning and reversed CT polarity to a photo visit", () => {
    const commissioning = decide({
      commissioning: { checklistComplete: false, firstBootSelfTestPass: true },
    });
    assert.equal(commissioning.decision.rootCauseClass, "install_commissioning_incomplete");
    assert.equal(commissioning.decision.maxLevel, "L4");
    assert.equal(commissioning.decision.photosRequired, true);

    const ct = decide({ sense: { gridSenseImplausible: false, ctPolarityReversed: true } });
    assert.equal(ct.decision.rootCauseClass, "install_wiring_or_sense_error");
    assert.equal(ct.decision.actionId, "dispatch_technician");
    assert.equal(ct.decision.blockedActionIds.includes("schedule_hq_recovery"), true);
  });

  it("keeps a grid or house-side condition in the field", () => {
    const load = decide({
      grid: { houseLoadKw: HOUSE_LOAD_ISLANDING_KW + 0.5, islandingFailed: true, voltageV: 240, freqHz: 60 },
    });
    assert.equal(load.decision.rootCauseClass, "grid_or_home_side_condition");
    assert.equal(load.decision.maxLevel, "L1");
    assert.equal(load.decision.actionId, "mark_no_fault_found_monitor");
    assert.match(load.decision.summary, /stays in the field/);

    const atLimit = decide({
      grid: { houseLoadKw: HOUSE_LOAD_ISLANDING_KW, islandingFailed: true, voltageV: 240, freqHz: 60 },
    });
    assert.equal(atLimit.decision.rootCauseClass, "no_fault_found");

    const loadOnly = decide({
      grid: { houseLoadKw: 14, islandingFailed: false, voltageV: 240, freqHz: 60 },
    });
    assert.equal(loadOnly.decision.rootCauseClass, "no_fault_found");

    const voltage = decide({ grid: { voltageV: 200, freqHz: 60, houseLoadKw: 2, islandingFailed: false } });
    assert.equal(voltage.decision.rootCauseClass, "grid_or_home_side_condition");
  });

  it("clamps every other finding when an L0 signature is present", () => {
    const nearMiss = decide({ safety: { cellTempMaxC: 63.7, packCurrentA: 48 } });
    assert.equal(nearMiss.decision.rootCauseClass, "no_fault_found");

    const trip = decide({
      fwVersion: "0.9.0",
      safety: { cellTempMaxC: 66, packCurrentA: 1 },
    });
    assert.equal(trip.decision.rootCauseClass, "thermal_or_safety_event");
    assert.equal(trip.decision.actionId, "flag_l0_safety");
    assert.equal(trip.decision.maxLevel, "L0");
    assert.equal(trip.decision.smokingInverterRule, true);
    assert.equal(trip.decision.blockedActionIds.includes("reboot_firmware"), true);
    assert.equal(trip.decision.blockedActionIds.includes("ota_allowlisted_fw"), true);
    assert.equal(trip.decision.blockedActionIds.includes("schedule_hq_recovery"), true);
    assert.deepEqual(trip.decision.differentials, ["fw_version_mismatch"]);
    assert.equal(trip.events.some((event) => event.eventType === "safety.thermal" && event.severity === "l0"), true);

    const warning = decide({ safety: { overtempWarning: true, cellTempMaxC: 63.7, packCurrentA: 48 } });
    assert.equal(warning.decision.smokingInverterRule, true);

    const pyro = decide({
      safety: { pyroFuseActivated: true },
      attempts: { rebootPlaybookDone: true, reseatPlaybookDone: true, faultRepeatedAfterBoth: true },
    });
    assert.equal(pyro.decision.rootCauseClass, "thermal_or_safety_event");
    assert.notEqual(pyro.decision.actionId, "reboot_firmware");
    assert.notEqual(pyro.decision.actionId, "schedule_hq_recovery");

    const smoke = decide({ safety: { thermalOrSmoke: true } });
    assert.equal(smoke.decision.actionId, "flag_l0_safety");
    const hv = decide({ safety: { unexpectedHv: true } });
    assert.equal(hv.events.some((event) => event.eventType === "safety.hv"), true);
  });

  it("calls a healthy faulted unit no-fault-found and refuses a hardware pull", () => {
    const run = decide();
    assert.equal(run.decision.rootCauseClass, "no_fault_found");
    assert.equal(run.decision.maxLevel, "L1");
    assert.equal(run.decision.actionId, "mark_no_fault_found_monitor");
    assert.equal(run.events.some((event) => event.eventType === "src.fault_flag"), true);
    assert.equal(run.decision.blockedActionIds.includes("schedule_hq_recovery"), true);
  });

  it("reaches true_hardware_defect only after reboot and reseat both failed", () => {
    const unexplained = decide({
      rails: undefined,
      can: undefined,
      commissioning: undefined,
      sense: undefined,
      grid: undefined,
    });
    assert.equal(unexplained.decision.rootCauseClass, "unknown");
    assert.equal(unexplained.decision.maxLevel, "L0");
    assert.equal(unexplained.decision.blockedActionIds.includes("reboot_firmware"), true);
    assert.equal(unexplained.decision.blockedActionIds.includes("ota_allowlisted_fw"), true);
    assert.equal(unexplained.decision.blockedActionIds.includes("schedule_hq_recovery"), true);
    assert.equal(unexplained.decision.smokingInverterRule, false);

    const rebootOnly = decide({
      rails: undefined,
      can: undefined,
      commissioning: undefined,
      sense: undefined,
      grid: undefined,
      attempts: { rebootPlaybookDone: true, reseatPlaybookDone: false, faultRepeatedAfterBoth: true },
    });
    assert.equal(rebootOnly.decision.rootCauseClass, "unknown");

    const confirmed = decide({
      rails: undefined,
      can: undefined,
      commissioning: undefined,
      sense: undefined,
      grid: undefined,
      attempts: { rebootPlaybookDone: true, reseatPlaybookDone: true, faultRepeatedAfterBoth: true },
    });
    assert.equal(confirmed.decision.rootCauseClass, "true_hardware_defect");
    assert.equal(confirmed.decision.maxLevel, "L4");
    assert.equal(confirmed.decision.actionId, "schedule_hq_recovery");
    assert.equal(confirmed.decision.blockedActionIds.includes("schedule_hq_recovery"), false);
  });

  it("does not treat a mocked fault code string as the class", () => {
    const run = decide({ activeFaultCodes: ["INV-F900 OVERTEMP"] });
    assert.notEqual(run.decision.rootCauseClass, "thermal_or_safety_event");
    assert.equal(run.decision.rootCauseClass, "unknown");
    assert.equal(run.events.some((event) => event.eventType === "fw.fault_code"), true);
  });
});

describe("device status adapter", () => {
  it("compares the reported firmware and leaves the fault code as a print", () => {
    const status: DeviceStatus = {
      vin: "INV-5002",
      asset_id: "asset-5002",
      fw_version: "3.3.0",
      online: true,
      faulted: true,
      active_fault_codes: ["INV-F120 FW_COMPAT"],
      uptime_s: 10,
      last_boot_reason: "power_on",
      last_seen: "2026-09-26T15:04:00Z",
    };
    const run = runDetectors(
      evidenceFromDeviceStatus({ caseId: "case-5002", status, hwRev: "rev-a" }),
      manifest,
    );
    assert.equal(run.decision.rootCauseClass, "fw_version_mismatch");
    assert.equal(run.decision.smokingInverterRule, false);
    assert.equal(run.events.some((event) => event.summary.includes("INV-F120 FW_COMPAT")), true);
  });
});
