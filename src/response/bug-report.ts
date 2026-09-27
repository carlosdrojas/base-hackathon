// Engineer bug reports (design doc §9). When ≥3 cases share (fw_version, root_cause), document it
// for engineering. Claude writes the prose when a key is present, otherwise a template. The
// recommendation is always computed here: at most an OTA to an allow-listed version. Never a patch.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { BugReport, RcaCase, RootCause } from "./types.js";
import type { ClaudeCaller } from "./planner.js";

export const BUG_REPORT_MODEL = "claude-sonnet-5";
export const BUG_REPORT_TIMEOUT_MS = 8000;
export const BUG_GROUP_MIN = 3;

export interface BugGroup {
  fw_version: string;
  root_cause: RootCause;
  cases: RcaCase[];
}

const key = (fw: string, rc: string) => `${fw}|${rc}`;

/**
 * Only causes a firmware build can plausibly own. A cluster of install, thermal or "no fault" cases
 * on one version is a fleet pattern (installer, site, detector tuning), not a firmware bug.
 */
const FIRMWARE_CAUSES = new Set<RootCause>(["fw_soft_fault_reboot_candidate", "fw_version_mismatch", "can_link_unreliable"]);

/** Groups of ≥3 cases sharing (fw_version, root_cause), with no failed fix, that have no report yet. */
export function findBugGroups(cases: RcaCase[], existing: BugReport[]): BugGroup[] {
  const reported = new Set(existing.map((r) => key(r.fw_version, r.root_cause)));
  const groups = new Map<string, BugGroup>();
  for (const c of cases) {
    const rc = c.hypothesis?.root_cause;
    if (!rc || !FIRMWARE_CAUSES.has(rc)) continue;
    // A failed remote fix means the diagnosis is suspect (e.g. a "soft fault" that was really a
    // loose connector), so it isn't evidence of a firmware-wide problem.
    if (c.gameplan?.steps.some((s) => s.state === "failed")) continue;
    const k = key(c.fw_version, rc);
    if (reported.has(k)) continue;
    const g = groups.get(k) ?? { fw_version: c.fw_version, root_cause: rc, cases: [] };
    g.cases.push(c);
    groups.set(k, g);
  }
  return [...groups.values()].filter((g) => g.cases.length >= BUG_GROUP_MIN);
}

export function recommendationFor(g: BugGroup, allowlist: string[]): string {
  const target = allowlist[0];
  if (!allowlist.includes(g.fw_version) && target) {
    return `OTA affected units to allow-listed ${target}, engineer approval required. Engineering owns any firmware fix; no patch proposed.`;
  }
  return `Engineering to investigate ${g.root_cause} on fw ${g.fw_version}. No OTA target beyond the allow-list; no patch proposed.`;
}

function evidenceLines(g: BugGroup): string[] {
  return g.cases.map((c) => {
    const tried = (c.gameplan?.steps ?? [])
      .filter((s) => s.result)
      .map((s) => `${s.action} → ${s.result!.outcome}`)
      .join(", ");
    const ev = c.hypothesis?.evidence[0] ?? "";
    return `- **${c.case_id}** ${c.vin} (${c.site}): ${ev}${tried ? `; ${tried}` : ""}; status ${c.status}`;
  });
}

export function templateReport(g: BugGroup, allowlist: string[], reportId: string, now: string): BugReport {
  const title = `fw ${g.fw_version}: ${g.cases.length} units with ${g.root_cause}`;
  const recommendation = recommendationFor(g, allowlist);
  const body_md = [
    `# ${title}`,
    "",
    "_MOCKED demo data. Written from a template._",
    "",
    `**Firmware:** ${g.fw_version} ${allowlist.includes(g.fw_version) ? "(allow-listed)" : "(not on the allow-list)"}`,
    `**Root cause (hypothesis):** ${g.root_cause}`,
    `**Affected VINs:** ${g.cases.map((c) => c.vin).join(", ")}`,
    "",
    "## Evidence",
    ...evidenceLines(g),
    "",
    "## Recommendation",
    recommendation,
  ].join("\n");
  return {
    report_id: reportId,
    fw_version: g.fw_version,
    root_cause: g.root_cause,
    case_ids: g.cases.map((c) => c.case_id),
    vins: g.cases.map((c) => c.vin),
    title,
    body_md,
    recommendation,
    source: "template",
    created_at: now,
  };
}

const REPORT_TOOL: Anthropic.Tool = {
  name: "write_bug_report",
  description: "Write an engineering bug report for a cluster of field faults.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "One line." },
      body_md: { type: "string", description: "Markdown body: summary, evidence per case, suspected mechanism, open questions." },
    },
    required: ["title", "body_md"],
  },
};

const ReportSchema = z.object({ title: z.string().min(1), body_md: z.string().min(1) });

export async function claudeReport(
  g: BugGroup,
  allowlist: string[],
  reportId: string,
  now: string,
  call: ClaudeCaller,
): Promise<BugReport> {
  const base = templateReport(g, allowlist, reportId, now);
  const response = await call(
    {
      model: BUG_REPORT_MODEL,
      max_tokens: 4096,
      thinking: { type: "disabled" },
      system:
        "You write concise engineering bug reports about clusters of residential inverter faults in a simulated fleet (MOCKED data). " +
        "Base engineers own firmware: never propose code, patches, or firmware changes. State that the data is mocked. Call write_bug_report once.",
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: REPORT_TOOL.name },
      messages: [
        {
          role: "user",
          content: `Cluster: fw ${g.fw_version}, root cause ${g.root_cause}, ${g.cases.length} cases.\nAllow-listed firmware: ${allowlist.join(", ")}\n\nEvidence:\n${evidenceLines(g).join("\n")}\n\nThe recommendation section is fixed and will be appended verbatim: "${base.recommendation}"`,
        },
      ],
    },
    { timeout: BUG_REPORT_TIMEOUT_MS, maxRetries: 0 },
  );
  if (response.stop_reason === "refusal") throw new Error("model refused");
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) throw new Error("model returned no write_bug_report call");
  const out = ReportSchema.parse(block.input);
  return {
    ...base,
    title: out.title,
    body_md: `${out.body_md}\n\n## Recommendation\n${base.recommendation}`,
    source: "claude",
  };
}

export async function writeBugReport(
  g: BugGroup,
  allowlist: string[],
  reportId: string,
  now: string,
  call?: ClaudeCaller,
): Promise<BugReport> {
  if (call) {
    try {
      return await claudeReport(g, allowlist, reportId, now, call);
    } catch {
      // fall through to the template
    }
  }
  return templateReport(g, allowlist, reportId, now);
}
