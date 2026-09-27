import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { openEvidenceCase } from "./evidence-pack.js";
import { placeholderTriage, triageEvidencePack } from "./triage-model.js";
import { TriageOutputError, parseTriageOutput } from "./triage-schema.js";

function loadCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header?.split(",") ?? [];
  return lines.map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    cols.forEach((col, index) => {
      row[col] = cells[index] ?? "";
    });
    return row;
  });
}

const rows = loadCsv(path.join(process.cwd(), "data_input", "packet_at_fault_time.csv"));
const allowlist = (JSON.parse(fs.readFileSync(path.join(process.cwd(), "data_input", "fw_allowlist.json"), "utf8")) as {
  signedForAllRevs: string[];
}).signedForAllRevs;

function row(vin: string): Record<string, string> {
  const found = rows.find((item) => item.vin === vin);
  assert.ok(found, vin);
  return found;
}

const packKeys = [
  "vin",
  "hw_rev",
  "fw_version",
  "fw_allowlist",
  "fault_code",
  "boot_reason",
  "uptime_s",
  "can",
  "thermal_c",
  "grid_v",
  "soc",
  "connectivity",
  "commissioning_complete",
  "recent_reboots_24h",
  "l0_flags",
];

describe("evidence pack", () => {
  it("builds the bus-off case from the CSV row and the packet fixture", () => {
    const opened = openEvidenceCase(row("BP-CORE-9003-03"), { allowlist });
    assert.deepEqual(Object.keys(opened.evidence).sort(), [...packKeys].sort());
    assert.equal(opened.evidence.fault_code, "CAN_TIMEOUT");
    assert.equal(opened.evidence.boot_reason, "watchdog");
    assert.equal(opened.evidence.uptime_s, 412);
    assert.equal(opened.evidence.can.bus_off, 1);
    assert.deepEqual(opened.evidence.can.missing_nodes, ["bms"]);
    assert.equal(opened.evidence.can.error_frames_per_min, 180);
    assert.equal(opened.evidence.grid_v, Number(row("BP-CORE-9003-03").line_voltage_v));
    assert.notEqual(opened.evidence.grid_v, Number(row("BP-CORE-9003-03").v_c_v));
    assert.equal(opened.logs[0]?.id, "bus-off");
    assert.match(opened.logs[0]?.text ?? "", /node bms missing/);
    assert.equal(opened.case_id, "rca-BP-CORE-9003-03");
  });

  it("attaches the canned log that matches the pack", () => {
    assert.equal(openEvidenceCase(row("BP-CORE-9002-02"), { allowlist }).logs[0]?.id, "watchdog");
    assert.equal(openEvidenceCase(row("BP-CORE-00016-57"), { allowlist }).logs[0]?.id, "cell-overtemp");
    assert.equal(openEvidenceCase(row("BP-CORE-00011-22"), { allowlist }).logs[0]?.id, "nff");
    assert.equal(openEvidenceCase(row("BP-CORE-00016-57"), { allowlist }).evidence.l0_flags.includes("overtemp"), true);
  });
});

describe("structured triage output", () => {
  it("rejects prose and actions outside the catalog", () => {
    assert.throws(() => parseTriageOutput("The connector looks loose."), (error: unknown) => {
      return error instanceof TriageOutputError && error.reason === "prose";
    });
    assert.throws(
      () =>
        parseTriageOutput(
          JSON.stringify({
            root_cause_class: "can_link_unreliable",
            confidence: 0.5,
            differentials: [],
            evidence_refs: [],
            human_summary: "no",
            recommended_action_id: "write_firmware",
            level: "L4",
            playbook_id: "reseat_j3_can_capture_counters",
            alerts: ["tech"],
            do_not_pull_to_hq: true,
            keep_in_field: true,
          }),
        ),
      (error: unknown) => error instanceof TriageOutputError && error.reason === "schema",
    );
  });

  it("rejects a reboot on a safety class", () => {
    assert.throws(
      () =>
        parseTriageOutput(
          JSON.stringify({
            root_cause_class: "thermal_or_safety_event",
            confidence: 0.9,
            differentials: [],
            evidence_refs: ["l0_flags"],
            human_summary: "Overtemp.",
            recommended_action_id: "reboot_firmware",
            level: "L0",
            playbook_id: "isolate_no_actuate",
            alerts: ["engineer", "ops"],
            do_not_pull_to_hq: true,
            keep_in_field: true,
          }),
        ),
      (error: unknown) => error instanceof TriageOutputError && error.reason === "policy",
    );
  });

  it("uses the placeholder when the API key is empty and still returns the schema", async () => {
    let called = false;
    const opened = openEvidenceCase(row("BP-CORE-9003-03"), { allowlist });
    const run = await triageEvidencePack(opened.evidence, {
      apiKey: null,
      fetchImpl: async () => {
        called = true;
        throw new Error("network");
      },
    });
    assert.equal(called, false);
    assert.equal(run.source, "placeholder");
    assert.equal(run.output.root_cause_class, "can_link_unreliable");
    assert.equal(run.output.recommended_action_id, "dispatch_technician");
    assert.equal(run.output.level, "L4");
    assert.equal(run.output.playbook_id, "reseat_j3_can_capture_counters");
    assert.equal(run.output.do_not_pull_to_hq, true);
    assert.equal(run.output.keep_in_field, true);
    assert.deepEqual(run.output.alerts, ["tech", "ops"]);
    assert.equal(run.output.differentials.includes("fw_soft_fault_reboot_candidate"), true);
    assert.equal(run.output.differentials.includes("true_hardware_defect"), false);

    const safety = placeholderTriage(openEvidenceCase(row("BP-CORE-00016-57"), { allowlist }).evidence);
    assert.equal(safety.root_cause_class, "thermal_or_safety_event");
    assert.equal(safety.recommended_action_id, "flag_l0_safety");
    assert.equal(safety.level, "L0");

    const healthy = placeholderTriage(openEvidenceCase(row("BP-CORE-00011-22"), { allowlist }).evidence);
    assert.equal(healthy.root_cause_class, "no_fault_found");
    assert.equal(healthy.keep_in_field, true);
  });

  it("fails the run when the model returns prose", async () => {
    const opened = openEvidenceCase(row("BP-CORE-9002-02"), { allowlist });
    await assert.rejects(
      () =>
        triageEvidencePack(opened.evidence, {
          apiKey: "test-key",
          fetchImpl: async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: "I think it is a loose connector." } }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        }),
      (error: unknown) => error instanceof TriageOutputError && error.reason === "prose",
    );
  });
});
