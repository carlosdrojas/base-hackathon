/**
 * Step 3 output. Prose is a failed run. The action id has to be in the catalog.
 * unknown and thermal_or_safety_event cannot reboot, OTA, or schedule an HQ pull.
 */

import { z } from "zod";
import { ACTION_IDS, PERMISSION_LEVELS, ROOT_CAUSE_CLASSES } from "./contracts.js";
import { PLAYBOOK_IDS } from "./detectors/run.js";

export const ALERT_IDS = ["tech", "ops", "engineer", "truck"] as const;

export const triageOutputSchema = z
  .object({
    root_cause_class: z.enum(ROOT_CAUSE_CLASSES),
    confidence: z.number().min(0).max(1),
    differentials: z.array(z.enum(ROOT_CAUSE_CLASSES)),
    evidence_refs: z.array(z.string()),
    human_summary: z.string().min(1),
    recommended_action_id: z.enum(ACTION_IDS),
    level: z.enum(PERMISSION_LEVELS),
    playbook_id: z.enum(PLAYBOOK_IDS),
    alerts: z.array(z.enum(ALERT_IDS)),
    do_not_pull_to_hq: z.boolean(),
    keep_in_field: z.boolean(),
  })
  .strict();

export type TriageOutput = z.infer<typeof triageOutputSchema>;

export const TRIAGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    root_cause_class: { type: "string", enum: [...ROOT_CAUSE_CLASSES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    differentials: { type: "array", items: { type: "string", enum: [...ROOT_CAUSE_CLASSES] } },
    evidence_refs: { type: "array", items: { type: "string" } },
    human_summary: { type: "string" },
    recommended_action_id: { type: "string", enum: [...ACTION_IDS] },
    level: { type: "string", enum: [...PERMISSION_LEVELS] },
    playbook_id: { type: "string", enum: [...PLAYBOOK_IDS] },
    alerts: { type: "array", items: { type: "string", enum: [...ALERT_IDS] } },
    do_not_pull_to_hq: { type: "boolean" },
    keep_in_field: { type: "boolean" },
  },
  required: [
    "root_cause_class",
    "confidence",
    "differentials",
    "evidence_refs",
    "human_summary",
    "recommended_action_id",
    "level",
    "playbook_id",
    "alerts",
    "do_not_pull_to_hq",
    "keep_in_field",
  ],
} as const;

export class TriageOutputError extends Error {
  readonly reason: "prose" | "schema" | "policy";

  constructor(reason: "prose" | "schema" | "policy", message: string) {
    super(message);
    this.name = "TriageOutputError";
    this.reason = reason;
  }
}

const REMOTE_ACTIONS = new Set(["reboot_firmware", "ota_allowlisted_fw", "schedule_hq_recovery"]);

export function parseTriageOutput(text: string): TriageOutput {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new TriageOutputError("prose", "Triage output is not a JSON object.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new TriageOutputError("prose", "Triage output is not valid JSON.");
  }
  const result = triageOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new TriageOutputError("schema", result.error.issues.map((issue) => issue.message).join("; "));
  }
  assertPolicy(result.data);
  return result.data;
}

function assertPolicy(output: TriageOutput): void {
  const clamped = output.root_cause_class === "thermal_or_safety_event" || output.root_cause_class === "unknown";
  if (clamped && REMOTE_ACTIONS.has(output.recommended_action_id)) {
    throw new TriageOutputError("policy", `${output.root_cause_class} cannot ${output.recommended_action_id}.`);
  }
  if (clamped && output.level !== "L0") {
    throw new TriageOutputError("policy", `${output.root_cause_class} clamps the level to L0.`);
  }
  if (output.recommended_action_id === "schedule_hq_recovery" && output.root_cause_class !== "true_hardware_defect") {
    throw new TriageOutputError("policy", "HQ recovery is only allowed for true_hardware_defect.");
  }
  const pull = output.recommended_action_id === "schedule_hq_recovery";
  if (output.do_not_pull_to_hq === pull || output.keep_in_field === pull) {
    throw new TriageOutputError("policy", "do_not_pull_to_hq and keep_in_field must agree with the action.");
  }
}
