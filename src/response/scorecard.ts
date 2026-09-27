// Grades case outcomes against the telemetry pack's answer key (inventory.csv recommended_action +
// do_not_return_hardware). Evaluation only: the planner and diagnosis never see the key.

import type { AnswerKey, RcaCase, ScheduledVisit, Scorecard, Verdict } from "./types.js";

const RESOLVED = new Set<RcaCase["status"]>(["Engineer review", "Closed"]);

export function computeScorecard(
  cases: RcaCase[],
  visits: ScheduledVisit[],
  keyFor: (vin: string) => AnswerKey | undefined,
): Scorecard | undefined {
  const card: Scorecard = {
    graded: 0, matched: 0, pending: 0, dnr_resolved: 0, dnr_kept: 0,
    wrong_pulls: 0, extra_trucks: 0, missed_pulls: 0, per_case: {},
  };
  let anyKey = false;

  for (const c of cases) {
    const key = keyFor(c.vin);
    if (!key || key.expect === "none") continue;
    anyKey = true;
    const pulled = (c.gameplan?.steps ?? []).some((s) => s.action === "hq_recovery" && s.state === "done");
    const truck = visits.some((v) => v.case_id === c.case_id && v.kind === "tech_visit" && v.state === "completed");
    const base = {
      recommended_action: key.recommended_action, expect: key.expect, dnr: key.do_not_return_hardware,
      wrong_pull: pulled && key.do_not_return_hardware, extra_truck: false, missed_pull: false,
    };

    if (pulled && key.do_not_return_hardware) card.wrong_pulls++;
    if (!RESOLVED.has(c.status) && !pulled) {
      card.pending++;
      card.per_case[c.case_id] = { ...base, verdict: "pending", note: "not resolved yet" };
      continue;
    }

    card.graded++;
    let verdict: Verdict;
    let note: string;
    if (key.expect === "pull") {
      verdict = pulled ? "match" : "miss";
      note = pulled ? "pulled to HQ, as the key says" : "key says this unit should come back to HQ";
      if (!pulled) { card.missed_pulls++; base.missed_pull = true; }
    } else if (pulled) {
      verdict = "miss";
      note = "pulled hardware the key says to keep in the field";
    } else if (key.expect === "no_truck" && truck) {
      verdict = "miss";
      note = "fixed, but rolled a truck the key says wasn't needed";
      card.extra_trucks++;
      base.extra_truck = true;
    } else {
      verdict = "match";
      note = key.expect === "no_truck" ? "resolved with no truck roll" : "fixed on site, hardware kept";
    }
    if (key.do_not_return_hardware) {
      card.dnr_resolved++;
      if (!pulled) card.dnr_kept++;
    }
    if (verdict === "match") card.matched++;
    card.per_case[c.case_id] = { ...base, verdict, note };
  }
  return anyKey ? card : undefined;
}
