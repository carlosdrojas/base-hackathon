import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gate, loadCatalog, type GateDetectors, type GateProposal } from "./policy-gate.js";

const manifest = { G3: ["core-inv-3.4.20"] };

function proposal(patch: Partial<GateProposal> = {}): GateProposal {
  return {
    action_id: "reboot_firmware",
    level: "L2",
    root_cause_class: "fw_soft_fault_reboot_candidate",
    confidence: 0.9,
    ...patch,
  };
}

function detectors(patch: Partial<GateDetectors> = {}): GateDetectors {
  return { l0_flags: [], hw_rev: "G3", fw_target: null, ...patch };
}

describe("policy gate", () => {
  it("loads the YAML catalog and clamps an L0 flag before the proposal", () => {
    const catalog = loadCatalog();
    assert.equal(catalog.reboot_firmware?.max_level, "L2");
    assert.equal(catalog.schedule_hq_recovery?.max_level, "L4");
    assert.equal(catalog.write_firmware, undefined);

    const result = gate(proposal({ action_id: "reboot_firmware", level: "L2" }), detectors({ l0_flags: ["overtemp"] }));
    assert.deepEqual(result, { kind: "clamp", action_id: "flag_l0_safety", level: "L0" });
  });

  it("rejects an action that is not in the catalog", () => {
    const result = gate(proposal({ action_id: "write_firmware" }), detectors());
    assert.equal(result.kind, "reject");
  });

  it("holds HQ unless the class is hardware and confidence is high enough to skip a reseat", () => {
    const wrongClass = gate(
      proposal({ action_id: "schedule_hq_recovery", level: "L4", root_cause_class: "can_link_unreliable", confidence: 0.95 }),
      detectors(),
    );
    assert.equal(wrongClass.kind, "reject");
    if (wrongClass.kind === "reject") assert.match(wrongClass.reason, /hardware class/);

    const low = gate(
      proposal({ action_id: "schedule_hq_recovery", level: "L4", root_cause_class: "true_hardware_defect", confidence: 0.84 }),
      detectors(),
    );
    assert.deepEqual(low, { kind: "downgrade", action_id: "dispatch_technician", level: "L4", reason: "reseat first" });

    const high = gate(
      proposal({ action_id: "schedule_hq_recovery", level: "L4", root_cause_class: "true_hardware_defect", confidence: 0.85 }),
      detectors(),
    );
    assert.deepEqual(high, { kind: "allow", action_id: "schedule_hq_recovery", level: "L4" });
  });

  it("sends an allow-listed OTA to an engineer and rejects any other version", () => {
    const missing = gate(
      proposal({ action_id: "ota_allowlisted_fw", level: "L3", root_cause_class: "fw_version_mismatch" }),
      detectors({ fw_target: "core-inv-3.3.0" }),
      { signedManifest: manifest },
    );
    assert.equal(missing.kind, "reject");

    const listed = gate(
      proposal({ action_id: "ota_allowlisted_fw", level: "L4", root_cause_class: "fw_version_mismatch" }),
      detectors({ fw_target: "core-inv-3.4.20" }),
      { signedManifest: manifest },
    );
    assert.deepEqual(listed, { kind: "pending_engineer", action_id: "ota_allowlisted_fw", level: "L3" });
  });

  it("waits for a person on L2 and L3, then allows the proposal after approval", () => {
    const waiting = gate(proposal(), detectors());
    assert.deepEqual(waiting, { kind: "pending_approval", action_id: "reboot_firmware", level: "L2" });

    const approved = gate(proposal({ level: "L4" }), detectors(), { humanApproved: true });
    assert.deepEqual(approved, { kind: "allow", action_id: "reboot_firmware", level: "L2" });
  });

  it("rejects a playbook that was not authored for the class", () => {
    const invented = gate(proposal({ playbook_id: "invented_playbook" }), detectors());
    assert.equal(invented.kind, "reject");

    const mismatch = gate(
      proposal({ playbook_id: "reseat_j3_can_capture_counters", root_cause_class: "fw_version_mismatch" }),
      detectors(),
    );
    assert.equal(mismatch.kind, "reject");
    if (mismatch.kind === "reject") assert.match(mismatch.reason, /does not match class/);
  });

  it("allows a tech visit without an API key or an extra approval step", () => {
    const result = gate(
      proposal({ action_id: "dispatch_technician", level: "L4", root_cause_class: "can_link_unreliable", confidence: 0.78 }),
      detectors(),
    );
    assert.deepEqual(result, { kind: "allow", action_id: "dispatch_technician", level: "L4" });
  });
});
