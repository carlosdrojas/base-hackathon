/**
 * Structured triage call. No key, or the placeholder value, uses the deterministic
 * detectors and still returns the schema. A real XAI_API_KEY posts to api.x.ai.
 * Prose from the model fails the run.
 */

import type { DetectorDecision } from "./detectors/run.js";
import { runDetectors } from "./detectors/run.js";
import type { DetectorEvidence } from "./detectors/evidence.js";
import type { EvidencePack } from "./evidence-pack.js";
import { playbookById } from "./playbooks.js";
import { TRIAGE_JSON_SCHEMA, parseTriageOutput, type TriageOutput } from "./triage-schema.js";

export const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";
export const XAI_MODEL = "grok-4.7";
export const PLACEHOLDER_API_KEY = "YOUR_XAI_API_KEY_HERE";

export const TRIAGE_SYSTEM_PROMPT = [
  "You are the Field RCA triaging agent. Return only the JSON object described by the schema.",
  "Pick one primary root_cause_class from the closed set. Put other plausible classes in differentials.",
  "Prefer comms, firmware, install, and no_fault_found over true_hardware_defect.",
  "unknown and thermal_or_safety_event clamp automation: level L0, no reboot, no OTA, no HQ pull.",
  "recommended_action_id must be one of the catalog values. Never write, patch, or generate firmware.",
  "do_not_pull_to_hq and keep_in_field are false only for schedule_hq_recovery.",
].join(" ");

export interface TriageRun {
  output: TriageOutput;
  source: "placeholder" | "xai";
}

export function isPlaceholderKey(apiKey: string | null | undefined): boolean {
  const value = apiKey?.trim() ?? "";
  return value.length === 0 || value === PLACEHOLDER_API_KEY;
}

export function placeholderTriage(pack: EvidencePack): TriageOutput {
  const decision = runDetectors(packToEvidence(pack), { signedForAllRevs: pack.fw_allowlist }).decision;
  return parseTriageOutput(JSON.stringify(decisionToOutput(decision, pack)));
}

export async function triageEvidencePack(
  pack: EvidencePack,
  options: { apiKey?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<TriageRun> {
  const apiKey = options.apiKey === undefined ? process.env.XAI_API_KEY : options.apiKey;
  if (isPlaceholderKey(apiKey)) {
    return { output: placeholderTriage(pack), source: "placeholder" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(XAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      messages: [
        { role: "system", content: TRIAGE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ evidence: pack }) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "field_rca_triage", strict: true, schema: TRIAGE_JSON_SCHEMA },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`xAI triage request failed (${response.status}).`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("xAI triage response had no message content.");
  }
  return { output: parseTriageOutput(content), source: "xai" };
}

function decisionToOutput(decision: DetectorDecision, pack: EvidencePack): TriageOutput {
  const book = playbookById(decision.playbookId);
  if (!book || book.class !== decision.rootCauseClass) {
    throw new Error(`playbook ${decision.playbookId} is not authored for ${decision.rootCauseClass}`);
  }
  const pull = decision.actionId === "schedule_hq_recovery";
  return {
    root_cause_class: decision.rootCauseClass,
    confidence: decision.confidence,
    differentials: decision.differentials,
    evidence_refs: evidenceRefs(pack),
    human_summary: decision.summary,
    recommended_action_id: decision.actionId,
    level: decision.maxLevel,
    playbook_id: book.id,
    alerts: book.alerts,
    do_not_pull_to_hq: !pull,
    keep_in_field: !pull,
  };
}

function evidenceRefs(pack: EvidencePack): string[] {
  const refs: string[] = [];
  if (pack.can.bus_off > 0) refs.push("can.bus_off");
  if (pack.can.missing_nodes.length > 0) refs.push("can.missing_nodes");
  if (pack.can.error_frames_per_min > 0) refs.push("can.error_frames_per_min");
  if (pack.can.dropped > 0) refs.push("can.dropped");
  if (pack.boot_reason === "watchdog") refs.push("boot_reason");
  if (pack.recent_reboots_24h > 0) refs.push("recent_reboots_24h");
  if (pack.l0_flags.length > 0) refs.push("l0_flags");
  if (!pack.commissioning_complete) refs.push("commissioning_complete");
  if (!pack.fw_allowlist.includes(pack.fw_version)) refs.push("fw_version");
  if (refs.length === 0) refs.push("fw_version", "can.bus_off");
  return refs;
}

function packToEvidence(pack: EvidencePack): DetectorEvidence {
  return {
    caseId: `rca-${pack.vin}`,
    vin: pack.vin,
    observedAt: new Date(0).toISOString(),
    hwRev: pack.hw_rev,
    fwVersion: pack.fw_version,
    faulted: true,
    activeFaultCodes: [],
    repeatFaultCode: false,
    offline: pack.connectivity === "offline",
    boot: {
      reason: pack.boot_reason === "watchdog" ? "WDT" : "power_on",
      watchdogResets: pack.recent_reboots_24h,
      panicCount: 0,
      repeatedSoftReset: pack.boot_reason === "watchdog" && pack.recent_reboots_24h >= 2,
    },
    rails: { allPresent: true, missingWhenMated: false, healthy: !pack.l0_flags.includes("overtemp") },
    can: {
      errorFrames: pack.can.error_frames_per_min,
      droppedFrames: pack.can.dropped,
      busOffCount: pack.can.bus_off,
      missingNodes: pack.can.missing_nodes,
      linkFlapCount: 0,
    },
    commissioning: {
      checklistComplete: pack.commissioning_complete,
      firstBootSelfTestPass: pack.commissioning_complete,
    },
    grid: { voltageV: pack.grid_v, islandingFailed: false },
    safety: {
      overtemp: pack.l0_flags.includes("overtemp"),
      thermalOrSmoke: pack.l0_flags.some((flag) => /smoke|thermal/i.test(flag)),
      cellTempMaxC: pack.thermal_c,
    },
    attempts: { rebootPlaybookDone: false, reseatPlaybookDone: false, faultRepeatedAfterBoth: false },
  };
}
