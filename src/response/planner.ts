// Planner (design doc §6). Turns a hypothesis into a gameplan built only from the catalog.
// Claude path: claude-sonnet-5 with one forced tool, 8 s timeout. Playbook path: fixed table.
// Both paths go through the same post-processing, which re-derives level/approval from the
// catalog and runs the gate; nothing the model says about permissions is trusted.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ACTIONS, CATALOG, isCatalogAction, maxLevel } from "./catalog.js";
import { gate, isLowConfidence, isSafetyCase } from "./policy-gate.js";
import type {
  ActionType,
  Alert,
  DeviceStatus,
  Gameplan,
  Hypothesis,
  PlannedStep,
  RcaCase,
} from "./types.js";

export const PLANNER_MODEL = "claude-sonnet-5";
export const PLANNER_TIMEOUT_MS = 8000;

export interface PlannerInput {
  rcaCase: RcaCase; // must carry `hypothesis`
  status: DeviceStatus; // observable status only, never UnitState
  allowlist: string[];
  /** Steps already on the case (with results), for re-planning. */
  history: PlannedStep[];
  onSiteConfirmed: boolean;
  /** A tech visit has been completed on this case. */
  visitCompleted: boolean;
  /** Re-planning after the current plan ran out. */
  replan: boolean;
  newStepId: () => string;
  now: string;
}

export interface RawStep {
  action: string;
  params?: Record<string, string>;
  expected_effect?: string;
  rationale?: string;
}

export interface RawPlan {
  summary: string;
  steps: RawStep[];
  alerts?: { role: string; reason: string }[];
}

export interface PlanResult {
  gameplan: Gameplan;
  /** Steps the gate denied at plan time, to be logged as gate_denied events. */
  denials: { step: PlannedStep; reason: string }[];
  /** Why the Claude path fell back to the playbook, if it did. */
  fallbackReason?: string;
}

/** Minimal seam over client.messages.create so tests can stub the model. */
export type ClaudeCaller = (
  body: Anthropic.MessageCreateParamsNonStreaming,
  opts: { timeout: number; maxRetries: number },
) => Promise<Anthropic.Message>;

export function defaultClaudeCaller(): ClaudeCaller {
  const client = new Anthropic();
  return (body, opts) => client.messages.create(body, opts);
}

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

function step(action: ActionType, rationale: string, expected_effect: string, params: Record<string, string> = {}): RawStep {
  return { action, rationale, expected_effect, params };
}

export function playbook(input: PlannerInput): RawPlan {
  const h = input.rcaCase.hypothesis!;
  const fw = input.status.fw_version;
  const target = input.allowlist[0];
  const onAllowlist = input.allowlist.includes(fw);
  const photos = { photos_required: "true" };
  const cause = isLowConfidence(input.rcaCase) ? "unknown" : h.root_cause;

  let steps: RawStep[];
  switch (cause) {
    case "fw_soft_fault_reboot_candidate":
      steps = [
        step("reboot", "Watchdog reset loop usually clears with a reboot.", "Fault clears after reboot."),
        ...(onAllowlist
          ? []
          : [step("ota_to_allowlisted", `fw ${fw} is not allow-listed; move to ${target}.`, "Fault clears on allow-listed firmware.", { target_fw: target })]),
        step("dispatch_tech", "Remote fixes exhausted; power-cycle on site.", "Tech clears the fault on site."),
      ];
      break;
    case "fw_version_mismatch":
      steps = [
        step("ota_to_allowlisted", `fw ${fw} is incompatible; update to allow-listed ${target}.`, "Fault clears on allow-listed firmware.", { target_fw: target }),
        step("dispatch_tech", "OTA did not resolve it; inspect on site.", "Tech confirms firmware state."),
      ];
      break;
    case "can_link_unreliable":
      steps = [
        step("can_health_query", "Confirm the CAN link is flapping before rolling a truck.", "Link-health counters returned."),
        step("dispatch_tech", "Loose or damaged CAN connector needs hands on site.", "Connector reseated, link stable.", photos),
      ];
      break;
    case "install_commissioning_incomplete":
    case "install_wiring_or_sense_error":
      steps = [step("dispatch_tech", "Installation issue; only fixable on site.", "Install corrected on site.", photos)];
      break;
    case "grid_or_home_side_condition":
    case "no_fault_found":
      steps = [
        step("monitor", "Likely transient or home-side; watch before acting.", "No recurrence; latch clears."),
        step("dispatch_tech", "Fault persists; check the site.", "Tech confirms home-side condition or clears it."),
      ];
      break;
    case "true_hardware_defect":
      steps = [
        step("request_log_dump", "Capture the power-stage log before anyone touches it.", "FW log captured."),
        step("dispatch_tech", "Confirm the hardware failure on site before pulling the unit.", "Tech confirms the failure."),
        step("hq_recovery", "Confirmed hardware defect: swap the unit.", "Unit replaced."),
      ];
      break;
    case "thermal_or_safety_event":
      steps = [
        // Deliberately proposed so the gate's refusal is visible on the timeline (demo scene 3).
        step("reboot", "Standard first response to a tripped inverter; the policy gate must refuse it on a safety case.", "Blocked by the gate."),
        step("dispatch_tech", "Safety event: make the unit safe on site, with an engineer.", "Unit made safe.", { with_engineer: "true" }),
        step("hq_recovery", "Safety unit goes back to HQ.", "Unit replaced."),
      ];
      break;
    default:
      steps = [
        step("request_log_dump", "Cause unclear; gather the FW log.", "FW log captured."),
        step("can_health_query", "Cause unclear; check CAN link health.", "Link-health counters returned."),
        step("dispatch_tech", "Diagnose on site.", "Tech finds the cause."),
      ];
  }

  if (input.replan) {
    const tried = new Set(input.history.map((s) => s.action));
    steps = steps.filter((s) => !tried.has(s.action as ActionType));
  }
  return {
    summary: `Playbook for ${cause} (confidence ${h.confidence.toFixed(2)}): ${steps.map((s) => s.action).join(" → ") || "nothing new"}.`,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const PROPOSAL_TOOL: Anthropic.Tool = {
  name: "propose_gameplan",
  description:
    "Propose an ordered response plan for one faulted residential battery inverter, cheapest and safest step first. Only actions from the enum are possible.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One or two sentences: what you think is wrong and the plan." },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS },
            params: {
              type: "object",
              additionalProperties: { type: "string" },
              description: 'Action parameters. ota_to_allowlisted needs {"target_fw": "<allow-listed version>"}.',
            },
            expected_effect: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["action", "expected_effect", "rationale"],
        },
      },
      alerts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["technician", "ops", "engineer", "driver"] },
            reason: { type: "string" },
          },
          required: ["role", "reason"],
        },
      },
    },
    required: ["summary", "steps", "alerts"],
  },
};

const RawPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(
    z.object({
      action: z.string(),
      params: z.record(z.string(), z.string()).optional(),
      expected_effect: z.string().optional(),
      rationale: z.string().optional(),
    }),
  ),
  alerts: z.array(z.object({ role: z.string(), reason: z.string() })).optional(),
});

const SYSTEM_PROMPT = `You plan responses to faulted residential battery inverters in a simulated fleet (all data is MOCKED).
North star: don't pull a healthy inverter. Try the cheapest, safest fix first, verify it, and only roll a truck when needed.

Rules you must follow:
- Use only the actions in the catalog. You cannot write, patch, or generate firmware; an OTA may only target an allow-listed version.
- Safety (thermal_or_safety_event, or fault code INV-F900): no remote actuation at all (no reboot, no OTA). Read-only queries, a tech visit with an engineer, then HQ recovery.
- Unknown cause or confidence below 0.5: no remote actuation; gather data (log dump, CAN query) and dispatch a tech.
- hq_recovery is never first unless the case is a safety case or hardware was confirmed on site.
- When re-planning, do not repeat actions that already failed; propose what should come next.
- Approval levels are decided by a separate policy gate, not by you. Just propose the plan.

Call propose_gameplan exactly once.`;

export async function claudePlan(input: PlannerInput, call: ClaudeCaller): Promise<RawPlan> {
  const h = input.rcaCase.hypothesis!;
  const context = {
    case_id: input.rcaCase.case_id,
    replan: input.replan,
    hypothesis: { root_cause: h.root_cause, confidence: h.confidence, evidence: h.evidence },
    device_status: input.status,
    fw_allowlist: input.allowlist,
    on_site_confirmed: input.onSiteConfirmed,
    prior_steps: input.history.map((s) => ({
      action: s.action,
      state: s.state,
      result: s.result ? { outcome: s.result.outcome, detail: s.result.detail } : undefined,
    })),
    catalog: Object.fromEntries(ACTIONS.map((a) => [a, CATALOG[a].description])),
  };
  const response = await call(
    {
      model: PLANNER_MODEL,
      max_tokens: 2048,
      // Forced tool choice is incompatible with thinking; the 8 s budget favors no thinking anyway.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [PROPOSAL_TOOL],
      tool_choice: { type: "tool", name: PROPOSAL_TOOL.name },
      messages: [{ role: "user", content: `Plan the response for this case:\n${JSON.stringify(context, null, 2)}` }],
    },
    { timeout: PLANNER_TIMEOUT_MS, maxRetries: 0 },
  );
  if (response.stop_reason === "refusal") throw new Error("model refused");
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) throw new Error("model returned no propose_gameplan call");
  return RawPlanSchema.parse(block.input);
}

// ---------------------------------------------------------------------------
// Post-processing (both paths)
// ---------------------------------------------------------------------------

const ALERT_ROLES = new Set<Alert["role"]>(["technician", "ops", "engineer", "admin", "driver"]);

export function alertsFor(level: PlannedStep["level"], steps: PlannedStep[]): Alert[] {
  const r = (role: Alert["role"], reason: string): Alert => ({ role, reason });
  switch (level) {
    case "L0":
      return [r("engineer", "Safety (L0) case: no remote actuation, review required."), r("ops", "Safety (L0) case opened.")];
    case "L1":
      return [r("engineer", "L1 case: informational.")];
    case "L2":
      return [r("ops", "L2 remote action awaiting approval.")];
    case "L3":
      return [r("engineer", "L3 OTA awaiting engineer approval.")];
    case "L4": {
      const alerts = [r("technician", "Field visit likely."), r("ops", "L4 case: field work planned.")];
      if (steps.some((s) => s.action === "hq_recovery")) alerts.splice(1, 0, r("driver", "HQ recovery may be needed."));
      return alerts;
    }
  }
}

export function postProcess(raw: RawPlan, input: PlannerInput, source: Gameplan["source"]): PlanResult {
  const c = input.rcaCase;
  const safety = isSafetyCase(c, input.status);
  const target = input.allowlist[0];

  let steps: PlannedStep[] = raw.steps
    .filter((s) => isCatalogAction(s.action))
    .map((s) => {
      const action = s.action as ActionType;
      const entry = CATALOG[action];
      const params = { ...(s.params ?? {}) };
      if (action === "ota_to_allowlisted" && !params.target_fw && target) params.target_fw = target;
      return {
        step_id: input.newStepId(),
        action,
        params,
        level: entry.level,
        requires: entry.requires,
        expected_effect: s.expected_effect ?? "",
        rationale: s.rationale ?? "",
        state: "planned" as const,
        approvals: [],
      };
    });

  // hq_recovery goes last unless it's allowed first (L0, or hardware confirmed on site).
  if (!safety && !input.onSiteConfirmed) {
    steps = [...steps.filter((s) => s.action !== "hq_recovery"), ...steps.filter((s) => s.action === "hq_recovery")];
  }

  // Gate every step. Remote actuation on L0 / unknown / low confidence, off-allow-list OTAs, etc.
  // are kept on the plan as `denied` (visible, logged) rather than silently dropped.
  const ctx = { rcaCase: c, status: input.status, allowlist: input.allowlist, onSiteConfirmed: input.onSiteConfirmed, phase: "plan" as const };
  const denials: PlanResult["denials"] = [];
  for (const s of steps) {
    const g = gate(s, ctx, []);
    if (g.kind === "deny") {
      s.state = "denied";
      denials.push({ step: s, reason: g.reason });
    }
  }

  const live = steps.filter((s) => s.state !== "denied");
  const level = safety ? "L0" : maxLevel(live.map((s) => s.level));
  const alerts = alertsFor(level, live);
  for (const a of raw.alerts ?? []) {
    const role = a.role as Alert["role"];
    if (ALERT_ROLES.has(role) && !alerts.some((x) => x.role === role)) alerts.push({ role, reason: a.reason });
  }

  return {
    gameplan: {
      case_id: c.case_id,
      level,
      steps,
      alerts,
      summary: raw.summary,
      source,
      created_at: input.now,
    },
    denials,
  };
}

/** Escalation fallback when a re-plan has nothing new: a visit, or HQ recovery if one already happened. */
function withEscalationFallback(raw: RawPlan, input: PlannerInput): RawPlan {
  if (!input.replan) return raw;
  const tried = new Set(input.history.map((s) => s.action));
  const fresh = raw.steps.filter((s) => isCatalogAction(s.action) && !tried.has(s.action as ActionType));
  const actuationBlocked = isLowConfidence(input.rcaCase) || isSafetyCase(input.rcaCase, input.status);
  const runnable = fresh.filter((s) => !(actuationBlocked && CATALOG[s.action as ActionType].remoteActuation));
  if (runnable.length > 0) return { ...raw, steps: fresh };
  const next: ActionType = input.visitCompleted ? "hq_recovery" : "dispatch_tech";
  return {
    summary: `${raw.summary} Plan exhausted; escalating to ${next}.`,
    steps: [
      {
        action: next,
        rationale: input.visitCompleted ? "Remote and on-site steps exhausted." : "Remote steps exhausted; needs hands on site.",
        expected_effect: input.visitCompleted ? "Unit replaced." : "Tech resolves or confirms the fault.",
      },
    ],
    alerts: raw.alerts,
  };
}

export class Planner {
  constructor(
    private readonly mode: "claude" | "playbook",
    private readonly call?: ClaudeCaller,
  ) {}

  get source(): Gameplan["source"] {
    return this.mode;
  }

  async plan(input: PlannerInput): Promise<PlanResult> {
    if (this.mode === "claude" && this.call) {
      try {
        const raw = await claudePlan(input, this.call);
        return postProcess(withEscalationFallback(raw, input), input, "claude");
      } catch (err) {
        const result = postProcess(withEscalationFallback(playbook(input), input), input, "playbook");
        return { ...result, fallbackReason: err instanceof Error ? err.message : String(err) };
      }
    }
    return postProcess(withEscalationFallback(playbook(input), input), input, "playbook");
  }
}
