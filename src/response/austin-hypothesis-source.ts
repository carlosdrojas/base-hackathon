// Real (non-stub) Task 1 hypothesis source for the Austin fleet. Diagnoses by re-running
// Megan's real field-rca pipeline (detectors + triage) fresh on every call against the VIN's
// real fixture row in data_input/packet_at_fault_time.csv -- it deliberately does NOT read
// UnitState.fault, which would be the same "cheat" StubHypothesisSource (hypothesis-source.ts)
// uses and documents as MOCKED. This is what Task 1 was meant to become.
//
// triageEvidencePack (src/field-rca/triage-model.ts) already upgrades itself from the
// deterministic placeholder to a live xAI Grok call the moment a real XAI_API_KEY is set in
// the environment -- no code change is needed here for that upgrade path.
import fs from "node:fs";
import path from "node:path";
import { evidenceFromPacketRow, openEvidenceCase, runDetectors, triageEvidencePack, type FwManifest } from "../field-rca/index.js";
import type { DeviceStatus, Hypothesis, HypothesisSource } from "./types.js";

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

export class AustinHypothesisSource implements HypothesisSource {
  private packetRows: Map<string, Record<string, string>> | null = null;
  private manifest: (FwManifest & { signedForAllRevs?: string[] }) | null = null;
  private signed: string[] = [];

  constructor(
    private readonly packetPath: string = path.join(process.cwd(), "data_input", "packet_at_fault_time.csv"),
    private readonly allowlistPath: string = path.join(process.cwd(), "data_input", "fw_allowlist.json"),
  ) {}

  private ensureLoaded(): void {
    this.packetRows ??= new Map(loadCsv(this.packetPath).map((row) => [row.vin, row]));
    if (!this.manifest) {
      this.manifest = JSON.parse(fs.readFileSync(this.allowlistPath, "utf8")) as FwManifest & { signedForAllRevs?: string[] };
      this.signed = this.manifest.signedForAllRevs ?? [];
    }
  }

  async diagnose(caseId: string, status: DeviceStatus): Promise<Hypothesis> {
    this.ensureLoaded();
    const row = this.packetRows!.get(status.vin);
    if (!row) {
      // Every Austin seed unit comes from this same CSV (see austin-seed.ts), so this should
      // not happen. Fail loudly rather than fabricate a hypothesis with no real evidence.
      throw new Error(`AustinHypothesisSource: no fixture packet row for vin ${status.vin}`);
    }

    const run = runDetectors(evidenceFromPacketRow(row), this.manifest!);
    const evidenceCase = openEvidenceCase(row, { allowlist: this.signed });
    const triage = await triageEvidencePack(evidenceCase.evidence, { apiKey: process.env.XAI_API_KEY });

    // One real sentence, then short refs -- not two overlapping sentences (human_summary and
    // decision.summary say almost the same thing) mixed in with them. triage_source is its own
    // short token, not a prefix baked into the sentence, so it reads consistently with the refs
    // when the UI joins this whole array with a middot separator.
    const evidence = [
      triage.output.human_summary,
      `triage_source: ${triage.source}`,
      ...triage.output.evidence_refs.map((ref) => `evidence_ref: ${ref}`),
    ];
    void run.decision.summary; // superseded by human_summary above; kept computed for the detector-run object itself

    return {
      case_id: caseId,
      vin: status.vin,
      // Identical closed taxonomy to field-rca's RootCauseClass (see contracts.ts) -- direct
      // assignment, no translation.
      root_cause: triage.output.root_cause_class,
      confidence: triage.output.confidence,
      evidence,
      fw_version: evidenceCase.evidence.fw_version,
      source: "task1",
    };
  }
}
