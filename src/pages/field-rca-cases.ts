// Real case source for /fleet, /case, and /technician: Megan's field-rca
// pipeline (src/field-rca/*) run over the real fixture telemetry in
// data_input/packet_at_fault_time.csv. Same call sequence as the working
// reference CLI, src/field-rca/detectors/report-faulted.ts (npm run
// report:faults) — read that file if this one needs cross-checking.
//
// This is a genuinely separate fleet from Carlos's response engine
// (src/response/*, still used on /response): different VIN space
// (BP-CORE-##### fixture VINs vs. his seeded INV-#### sim VINs), different
// case id format (rca-<vin> vs RCA-####), no device actuation, no persisted
// state — every call below recomputes fresh from the CSV, same as the CLI.
import fs from "node:fs";
import path from "node:path";
import {
  evidenceFromPacketRow,
  gate,
  loadCatalog,
  openEvidenceCase,
  runDetectors,
  triageEvidencePack,
  type CatalogAction,
  type DetectorRun,
  type EvidenceCase,
  type GateResult,
  type TriageOutput,
} from "../field-rca/index.js";
import type { FwManifest } from "../field-rca/detectors/evidence.js";

export interface FieldRcaCaseView {
  case_id: string;
  vin: string;
  scenario: string;
  site: string;
  run: DetectorRun;
  evidenceCase: EvidenceCase;
  triage: TriageOutput;
  triageSource: "placeholder" | "xai";
  gate: GateResult;
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

function faulted(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text === "y" || text === "yes" || text === "true" || text === "1";
}

const packetPath = path.join(process.cwd(), "data_input", "packet_at_fault_time.csv");
const allowlistPath = path.join(process.cwd(), "data_input", "fw_allowlist.json");
const inventoryPath = path.join(process.cwd(), "data_input", "inventory.csv");

let manifest: (FwManifest & { signedForAllRevs?: string[] }) | null = null;
let signedVersions: string[] = [];
let catalog: Readonly<Record<string, CatalogAction>> | null = null;
let siteByVin: Map<string, string> | null = null;

function ensureLoaded(): void {
  manifest ??= JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as FwManifest & { signedForAllRevs?: string[] };
  signedVersions = manifest.signedForAllRevs ?? [];
  catalog ??= loadCatalog();
  if (!siteByVin) {
    siteByVin = new Map();
    if (fs.existsSync(inventoryPath)) {
      for (const row of loadCsv(inventoryPath)) {
        siteByVin.set(row.vin, [row.city, row.state].filter(Boolean).join(", "));
      }
    }
  }
}

/** Re-derives every faulted-row case fresh from the CSV, exactly like `npm run report:faults`. */
export async function listFieldRcaCases(): Promise<FieldRcaCaseView[]> {
  ensureLoaded();
  const faultedRows = loadCsv(packetPath).filter((row) => faulted(row.faulted));
  return Promise.all(
    faultedRows.map(async (row): Promise<FieldRcaCaseView> => {
      const run = runDetectors(evidenceFromPacketRow(row), manifest!);
      const evidenceCase = openEvidenceCase(row, { allowlist: signedVersions });
      const triageRun = await triageEvidencePack(evidenceCase.evidence, { apiKey: process.env.XAI_API_KEY });
      const fwTarget = signedVersions.includes(evidenceCase.evidence.fw_version)
        ? evidenceCase.evidence.fw_version
        : (signedVersions[0] ?? null);
      const gated = gate(
        {
          action_id: triageRun.output.recommended_action_id,
          level: triageRun.output.level,
          root_cause_class: triageRun.output.root_cause_class,
          confidence: triageRun.output.confidence,
          playbook_id: triageRun.output.playbook_id,
        },
        {
          l0_flags: evidenceCase.evidence.l0_flags,
          hw_rev: evidenceCase.evidence.hw_rev,
          fw_target: fwTarget,
        },
        { catalog: catalog!, signedManifest: { [evidenceCase.evidence.hw_rev]: signedVersions } },
      );
      return {
        case_id: evidenceCase.case_id,
        vin: evidenceCase.vin,
        scenario: row.scenario ?? "",
        site: siteByVin!.get(row.vin) ?? "",
        run,
        evidenceCase,
        triage: triageRun.output,
        triageSource: triageRun.source,
        gate: gated,
      };
    }),
  );
}

export async function getFieldRcaCase(caseId: string): Promise<FieldRcaCaseView | undefined> {
  const cases = await listFieldRcaCases();
  return cases.find((c) => c.case_id === caseId || c.vin === caseId);
}

/** Same mapping report-faulted.ts uses for its "Outcome"/"Level" columns — the honest status string for a case row. */
export function gateOutcome(result: GateResult): { kind: string; action: string; level: string } {
  switch (result.kind) {
    case "allow":
      return { kind: "allow", action: result.action_id, level: result.level };
    case "clamp":
      return { kind: "clamp", action: result.action_id, level: result.level };
    case "reject":
      return { kind: "reject", action: result.reason, level: "" };
    case "downgrade":
      return { kind: "downgrade", action: `${result.action_id} (${result.reason})`, level: result.level };
    case "pending_engineer":
      return { kind: "pending engineer", action: result.action_id, level: result.level };
    case "pending_approval":
      return { kind: "pending approval", action: result.action_id, level: result.level };
  }
}
