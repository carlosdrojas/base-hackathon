// Response engine (design doc §3, §7–§10). Ties together diagnosis, planner, gate, runner,
// verifier, scheduler, bug reports and the case store behind the ResponseEngine interface.
// Codes only against FleetGateway; never reads UnitState except for the (labeled) metric of
// unnecessary pulls, which needs the true fault.

import { CaseStore } from "./case-store.js";
import { findBugGroups, writeBugReport } from "./bug-report.js";
import { gate, isSafetyCase, type GateContext } from "./policy-gate.js";
import { defaultClaudeCaller, Planner, type ClaudeCaller, type PlanResult } from "./planner.js";
import { isDeviceStep, runDeviceStep } from "./runner.js";
import { scheduleVisit } from "./scheduler.js";
import { computeScorecard } from "./scorecard.js";
import { loadSeed, type FleetSeed } from "./seed.js";
import { verify, type Verdict } from "./verifier.js";
import type {
  FleetSource,
  ActionResult,
  CaseEvent,
  CaseStatus,
  FleetGateway,
  GateResult,
  HypothesisSource,
  PlannedStep,
  PlantableFault,
  RcaCase,
  ResponseEngine,
  ResponseMetrics,
  ResponseState,
  User,
  VisitOutcome,
} from "./types.js";

export interface EngineOptions {
  runtimeDir: string;
  /** Which fleet this engine runs on; echoed in state for the UI. */
  fleetSource?: FleetSource;
  /** "auto" = Claude when ANTHROPIC_API_KEY is set, else playbook. */
  planner: "auto" | "playbook";
  seed?: FleetSeed;
  clock?: () => Date;
  /** Test seam: replaces the Anthropic client call. Only used when the Claude planner is active. */
  claudeCaller?: ClaudeCaller;
}

const PENDING = new Set<PlannedStep["state"]>(["planned", "awaiting_approval", "approved"]);
const MAX_ESCALATIONS = 3;

export class EngineError extends Error {}

export class DefaultResponseEngine implements ResponseEngine {
  private readonly store: CaseStore;
  private readonly seed: FleetSeed;
  private readonly clock: () => Date;
  private readonly fleetSource?: FleetSource;
  private readonly planner: Planner;
  private readonly claude?: ClaudeCaller;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly gateway: FleetGateway,
    private readonly hypotheses: HypothesisSource,
    options: EngineOptions,
  ) {
    this.seed = options.seed ?? loadSeed();
    this.clock = options.clock ?? (() => new Date());
    this.fleetSource = options.fleetSource;
    this.store = new CaseStore(options.runtimeDir, this.clock);
    const useClaude = options.planner === "auto" && !!process.env.ANTHROPIC_API_KEY;
    this.claude = useClaude ? (options.claudeCaller ?? defaultClaudeCaller()) : undefined;
    this.planner = new Planner(useClaude ? "claude" : "playbook", this.claude);
  }

  // -------------------------------------------------------------------------
  // ResponseEngine
  // -------------------------------------------------------------------------

  getState(): ResponseState {
    const d = this.store.data;
    return {
      fleet: this.gateway.list(),
      cases: d.cases,
      visits: d.visits,
      bug_reports: d.bug_reports,
      users: [...this.seed.users, ...this.seed.drivers],
      metrics: this.metrics(),
      planner: this.planner.source,
      fleet_source: this.fleetSource,
      fw_allowlist: [...this.seed.fw_allowlist],
      scorecard: computeScorecard(d.cases, d.visits, (vin) => {
        try {
          return this.gateway.getUnitState(vin).answer_key;
        } catch {
          return undefined;
        }
      }),
      mocked: true,
    };
  }

  ingestFaults(): Promise<RcaCase[]> {
    return this.exclusive(async () => {
      const opened: RcaCase[] = [];
      for (const status of this.gateway.list()) {
        if (!status.faulted || this.store.openCaseFor(status.vin)) continue;
        opened.push(await this.openCase(status.vin, "fault_flag"));
      }
      await this.checkBugReports();
      this.store.save();
      return opened;
    });
  }

  tick(): Promise<void> {
    return this.exclusive(async () => {
      for (const c of this.store.data.cases) {
        if (c.status !== "Closed") await this.advance(c, true);
      }
      await this.checkBugReports();
      this.store.save();
    });
  }

  approve(caseId: string, stepId: string, user: User): Promise<GateResult> {
    return this.exclusive(async () => {
      const actor = this.resolveUser(user);
      const c = this.store.getCase(caseId);
      const step = this.findStep(c, stepId);
      if (step.state !== "awaiting_approval") {
        return { kind: "deny", reason: `Step is ${step.state}, not awaiting approval.` } as GateResult;
      }
      const g = gate(step, this.ctx(c), step.approvals, actor);
      if (g.kind === "deny") {
        this.store.event(c, "gate_denied", actor, `Gate denied ${actor.name} approving ${step.action}: ${g.reason}`, {
          step_id: step.step_id,
          action: step.action,
          reason: g.reason,
        });
        this.store.save();
        return g;
      }
      step.approvals.push({ user: actor, ts: this.store.now() });
      this.store.event(c, "approved", actor, `${actor.name} (${actor.role}) approved ${step.action}`, { step_id: step.step_id });
      if (g.kind === "allow") {
        step.state = "approved";
        await this.advance(c, true);
      } else {
        this.store.event(c, "approval_requested", "system", `${step.action} still needs: ${g.missing.join(" + ")}`, {
          step_id: step.step_id,
          missing: g.missing,
        });
      }
      await this.checkBugReports();
      this.store.save();
      return g;
    });
  }

  reject(caseId: string, stepId: string, user: User, reason: string): Promise<void> {
    return this.exclusive(async () => {
      const actor = this.resolveUser(user);
      if (actor.role !== "ops" && actor.role !== "engineer") {
        throw new EngineError(`${actor.role} cannot reject steps`);
      }
      const c = this.store.getCase(caseId);
      const step = this.findStep(c, stepId);
      if (!PENDING.has(step.state)) throw new EngineError(`step is ${step.state}; cannot reject`);
      step.state = "rejected";
      this.store.event(c, "rejected", actor, `${actor.name} rejected ${step.action}: ${reason}`, { step_id: step.step_id, reason });
      await this.advance(c, true);
      this.store.save();
    });
  }

  completeVisit(visitId: string, user: User, outcome: VisitOutcome): Promise<void> {
    return this.exclusive(async () => {
      const actor = this.resolveUser(user);
      if (actor.role !== "technician") throw new EngineError("Only a technician can complete or mark a visit incomplete.");
      const visit = this.store.getVisit(visitId);
      if (visit.state !== "scheduled") throw new EngineError(`visit ${visitId} is already ${visit.state}`);
      if (outcome.completed && visit.photos_required && !outcome.photos_attached) {
        throw new EngineError("Photos are required for this visit before it can be completed.");
      }
      if (!outcome.completed && !outcome.incomplete_reason) {
        throw new EngineError("An incomplete visit needs an incomplete_reason.");
      }
      const c = this.store.getCase(visit.case_id);
      const step = c.gameplan?.steps.find((s) => s.state === "running" && s.params.visit_id === visitId);
      if (!step) throw new EngineError(`no running step for visit ${visitId}`);
      visit.outcome = outcome;

      if (!outcome.completed) {
        visit.state = "incomplete";
        const result = this.gateway.techVisit(c.vin, outcome);
        step.result = result;
        step.state = "failed";
        const bounces = this.store.data.visits.filter((v) => v.case_id === c.case_id && v.state === "incomplete").length;
        this.store.event(c, "visit_incomplete", actor, `${actor.name} marked ${visit.visit_id} incomplete: ${outcome.incomplete_reason}`, {
          visit_id: visit.visit_id,
          reason: outcome.incomplete_reason,
          notes: outcome.notes,
          bounces,
        });
        // A bounce: queue the same kind of visit again (needs approval again).
        this.insertAfter(c, step, this.copyStep(c, step, `Re-schedule after incomplete visit (${outcome.incomplete_reason}).`));
        await this.advance(c, true);
        this.store.save();
        return;
      }

      visit.state = "completed";
      let result: ActionResult;
      if (visit.kind === "hq_recovery") {
        const truth = this.gateway.getUnitState(c.vin).fault;
        result = this.gateway.apply(c.vin, "hq_recovery");
        const justified = truth === "true_hardware_defect" || truth === "thermal_or_safety_event";
        if (justified) c.outcome = "pulled_justified";
        else this.store.data.unnecessary_pulls++;
      } else {
        result = this.gateway.techVisit(c.vin, outcome);
      }
      step.result = result;
      this.store.event(c, "visit_completed", actor, `${actor.name} completed ${visit.visit_id}: ${result.detail}`, {
        visit_id: visit.visit_id,
        outcome: result.outcome,
        photos_attached: outcome.photos_attached,
        notes: outcome.notes,
      });
      this.handleVerdict(c, step, result, verify(this.gateway, result), actor);
      await this.advance(c, true);
      await this.checkBugReports();
      this.store.save();
    });
  }

  closeCase(caseId: string, user: User, note: string): Promise<void> {
    return this.exclusive(async () => {
      const actor = this.resolveUser(user);
      if (actor.role !== "engineer") throw new EngineError("Only an engineer can close a case.");
      const c = this.store.getCase(caseId);
      const safeOrReplaced = c.outcome === "l0_made_safe" || c.outcome === "pulled_justified" || !this.gateway.getStatus(c.vin).faulted;
      const ok = c.status === "Engineer review" || (c.status === "Escalated L0" && safeOrReplaced);
      if (!ok) throw new EngineError(`Case is ${c.status}; it can be closed from Engineer review, or from Escalated L0 once made safe.`);
      for (const s of c.gameplan?.steps ?? []) if (PENDING.has(s.state)) s.state = "skipped";
      this.store.event(c, "closed", actor, `${actor.name} closed the case: ${note}`, { note });
      this.store.setStatus(c, "Closed", actor);
      this.store.save();
    });
  }

  plantFault(vin: string, fault: PlantableFault): Promise<void> {
    return this.exclusive(async () => {
      this.gateway.plantFault(vin, fault);
    });
  }

  reset(): Promise<void> {
    return this.exclusive(async () => {
      this.gateway.reset();
      this.store.reset();
    });
  }

  // -------------------------------------------------------------------------
  // Case lifecycle
  // -------------------------------------------------------------------------

  private async openCase(vin: string, trigger: RcaCase["trigger"]): Promise<RcaCase> {
    const status = this.gateway.getStatus(vin);
    const unit = this.gateway.getUnitState(vin); // display fields only (site); fault is not read here
    const c: RcaCase = {
      case_id: this.store.newCaseId(),
      vin,
      asset_id: status.asset_id,
      site: unit.site,
      fw_version: status.fw_version,
      trigger,
      opened_at: this.store.now(),
      status: "Open",
      visits: [],
      timeline: [],
    };
    this.store.data.cases.push(c);
    this.store.event(c, "case_opened", "system", `Case opened: ${vin} reports ${status.active_fault_codes.join(", ")}`, {
      fault_codes: status.active_fault_codes,
    });

    c.hypothesis = await this.hypotheses.diagnose(c.case_id, status);
    this.store.event(c, "hypothesis", "agent", `Hypothesis: ${c.hypothesis.root_cause} (${c.hypothesis.confidence.toFixed(2)}, ${c.hypothesis.source})`, {
      root_cause: c.hypothesis.root_cause,
      confidence: c.hypothesis.confidence,
      evidence: c.hypothesis.evidence,
    });

    const result = await this.planner.plan(this.plannerInput(c, false));
    c.gameplan = result.gameplan;
    this.logPlan(c, result, false);
    this.store.setStatus(c, "Investigating", "agent");
    if (isSafetyCase(c, status)) this.escalateL0(c, "Safety event diagnosed: no remote actuation.");
    await this.advance(c, false);
    return c;
  }

  private logPlan(c: RcaCase, r: PlanResult, replan: boolean): void {
    const g = r.gameplan;
    this.store.event(c, "gameplan", "agent", `${replan ? "Re-plan" : "Plan"} (${g.source}, ${g.level}): ${g.steps.map((s) => s.action).join(" → ")}`, {
      source: g.source,
      level: g.level,
      summary: g.summary,
      steps: g.steps.map((s) => s.step_id),
      ...(r.fallbackReason ? { claude_fallback: r.fallbackReason } : {}),
    });
    for (const d of r.denials) {
      this.store.event(c, "gate_denied", "system", `Gate denied ${d.step.action}: ${d.reason}`, {
        step_id: d.step.step_id,
        action: d.step.action,
        reason: d.reason,
      });
    }
    for (const a of g.alerts) {
      this.store.event(c, "alert_sent", "system", `Alert → ${a.role}: ${a.reason}`, { ...a });
    }
  }

  private escalateL0(c: RcaCase, reason: string): void {
    if (c.status === "Escalated L0") return;
    this.store.event(c, "escalated", "system", `Escalated L0: ${reason}`, { level: "L0" });
    this.store.setStatus(c, "Escalated L0");
    if (c.gameplan) c.gameplan.level = "L0";
    for (const role of ["engineer", "ops"] as const) {
      this.store.event(c, "alert_sent", "system", `Alert → ${role}: L0 safety escalation`, { role, reason });
    }
  }

  /** Status change that doesn't override the Escalated L0 side state. */
  private softStatus(c: RcaCase, s: CaseStatus): void {
    if (c.status === "Escalated L0" || c.status === "Closed") return;
    this.store.setStatus(c, s);
  }

  /**
   * Walk the plan: deny what the gate denies, stop at steps needing approval, run allowed steps
   * (when `run`), escalate when the plan is exhausted.
   */
  private async advance(c: RcaCase, run: boolean): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      if (c.status === "Closed" || c.status === "Engineer review" || !c.gameplan) return;
      const steps = c.gameplan.steps;
      if (steps.some((s) => s.state === "running")) return; // waiting on a visit
      const step = steps.find((s) => PENDING.has(s.state));
      if (!step) {
        if (!(await this.replan(c))) return;
        continue;
      }
      const g = gate(step, this.ctx(c), step.approvals);
      if (g.kind === "deny") {
        step.state = "denied";
        this.store.event(c, "gate_denied", "system", `Gate denied ${step.action}: ${g.reason}`, {
          step_id: step.step_id,
          action: step.action,
          reason: g.reason,
        });
        continue;
      }
      if (g.kind === "needs_approval") {
        if (step.state !== "awaiting_approval") {
          step.state = "awaiting_approval";
          this.store.event(c, "approval_requested", "system", `${step.action} (${step.level}) needs approval: ${g.missing.join(g.requires === "ops_and_engineer" ? " + " : " or ")}`, {
            step_id: step.step_id,
            requires: g.requires,
            missing: g.missing,
          });
        }
        this.softStatus(c, "Action pending");
        return;
      }
      if (!run) return;
      this.runStep(c, step);
    }
  }

  private runStep(c: RcaCase, step: PlannedStep): void {
    if (step.action === "dispatch_tech" || step.action === "hq_recovery") {
      const remoteFailed = c.gameplan!.steps.some((s) => s.state === "failed" && s.result?.action !== "tech_visit");
      const visit = scheduleVisit({
        rcaCase: c,
        kind: step.action === "hq_recovery" ? "hq_recovery" : "tech_visit",
        visitId: this.store.newVisitId(),
        seed: this.seed,
        now: this.clock(),
        photosRequired: step.params.photos_required === "true" || remoteFailed ? true : undefined,
        withEngineer: step.params.with_engineer === "true",
      });
      this.store.data.visits.push(visit);
      c.visits.push(visit.visit_id);
      step.params = { ...step.params, visit_id: visit.visit_id };
      step.state = "running";
      this.store.event(c, "visit_scheduled", "agent", `${visit.kind === "hq_recovery" ? "HQ recovery" : "Tech visit"} ${visit.visit_id} → ${visit.assignee.name}, ${visit.slot_start}${visit.photos_required ? " (photos required)" : ""}`, {
        visit_id: visit.visit_id,
        assignee: visit.assignee.id,
        slot_start: visit.slot_start,
        photos_required: visit.photos_required,
      });
      this.softStatus(c, "Field visit");
      return;
    }
    if (!isDeviceStep(step)) {
      // engineer_bug_report: documentation only; reports are written by checkBugReports().
      step.state = "done";
      this.store.event(c, "action_run", "agent", `${step.action}: noted for the bug-report pass`, { step_id: step.step_id });
      return;
    }
    step.state = "running";
    this.softStatus(c, "In progress");
    const result = runDeviceStep(this.gateway, c.vin, step);
    step.result = result;
    this.store.event(c, "action_run", "agent", `${step.action}${step.params.target_fw ? ` → ${step.params.target_fw}` : ""}: ${result.detail}`, {
      step_id: step.step_id,
      outcome: result.outcome,
      ...(step.action === "monitor" ? { note: "Monitor window evaluated immediately (demo time-compression)" } : {}),
    });
    this.handleVerdict(c, step, result, verify(this.gateway, result), "agent");
  }

  private handleVerdict(c: RcaCase, step: PlannedStep, result: ActionResult, v: Verdict, actor: CaseEvent["actor"]): void {
    const onSite = result.action === "tech_visit";
    const resolve = (outcome: NonNullable<RcaCase["outcome"]>, summary: string) => {
      step.state = "done";
      this.store.event(c, "verify_pass", "system", summary, { step_id: step.step_id, fault_codes: result.status_after.active_fault_codes });
      for (const s of c.gameplan!.steps) if (PENDING.has(s.state)) s.state = "skipped";
      c.outcome = outcome;
      this.store.setStatus(c, "Engineer review", actor);
    };
    switch (v) {
      case "info":
        step.state = "done";
        return;
      case "pass":
        if (step.action === "monitor") resolve("avoided_false_pull", "Verified: no recurrence while monitoring; no truck needed.");
        else if (onSite) resolve("fixed_on_site", "Verified: device reports no fault after the visit.");
        else resolve("fixed_remote", `Verified: device reports no fault after ${step.action}. No truck rolled.`);
        return;
      case "nothing_found":
        resolve("avoided_false_pull", "Tech found nothing wrong; unit stays in the field (avoided false pull).");
        return;
      case "replaced":
        step.state = "done";
        this.store.event(c, "verify_pass", "system", `Unit replaced at HQ; replacement reports no fault.`, { step_id: step.step_id });
        for (const s of c.gameplan!.steps) if (PENDING.has(s.state)) s.state = "skipped";
        this.store.setStatus(c, "Engineer review", actor);
        return;
      case "made_safe":
        step.state = "done";
        c.outcome = "l0_made_safe";
        this.store.event(c, "verify_fail", "system", "Unit made safe on site; fault remains. HQ recovery unlocked.", { step_id: step.step_id });
        return;
      case "interlock":
        step.state = "failed";
        this.store.event(c, "verify_fail", "system", `${step.action} refused by the device's safety interlock.`, { step_id: step.step_id });
        this.escalateL0(c, "Device refused remote actuation (safety interlock).");
        return;
      case "fail":
        step.state = "failed";
        this.store.event(c, "verify_fail", "system", `Still faulted after ${onSite ? "the visit" : step.action}: ${result.status_after.active_fault_codes.join(", ")}`, {
          step_id: step.step_id,
          fault_codes: result.status_after.active_fault_codes,
        });
        return;
    }
  }

  /** Plan exhausted: re-plan with history. Returns false when there's nothing more to do. */
  private async replan(c: RcaCase): Promise<boolean> {
    const escalations = c.timeline.filter((e) => e.kind === "escalated" && e.detail?.replan).length;
    if (escalations >= MAX_ESCALATIONS) return false;
    const result = await this.planner.plan(this.plannerInput(c, true));
    const fresh = result.gameplan.steps;
    if (fresh.length === 0 || fresh.every((s) => s.state === "denied")) {
      this.logPlan(c, result, true);
      return false;
    }
    const plan = c.gameplan!;
    plan.steps.push(...fresh);
    plan.level = c.status === "Escalated L0" ? "L0" : result.gameplan.level;
    plan.summary = `${plan.summary} | Re-plan: ${result.gameplan.summary}`;
    this.store.event(c, "escalated", "agent", `Plan exhausted; escalating: ${fresh.map((s) => s.action).join(" → ")}`, { replan: true });
    this.logPlan(c, result, true);
    return true;
  }

  private async checkBugReports(): Promise<void> {
    for (const g of findBugGroups(this.store.data.cases, this.store.data.bug_reports)) {
      const report = await writeBugReport(g, this.seed.fw_allowlist, this.store.newBugId(), this.store.now(), this.claude);
      this.store.data.bug_reports.push(report);
      for (const c of g.cases) {
        this.store.event(c, "bug_report_linked", "agent", `Linked to ${report.report_id}: ${report.title}`, { report_id: report.report_id });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private plannerInput(c: RcaCase, replan: boolean) {
    const steps = c.gameplan?.steps ?? [];
    return {
      rcaCase: c,
      status: this.gateway.getStatus(c.vin),
      allowlist: this.seed.fw_allowlist,
      history: steps,
      onSiteConfirmed: this.onSiteConfirmed(c),
      visitCompleted: this.store.data.visits.some((v) => v.case_id === c.case_id && v.kind === "tech_visit" && v.state === "completed"),
      replan,
      newStepId: () => this.store.newStepId(c.case_id),
      now: this.store.now(),
    };
  }

  private onSiteConfirmed(c: RcaCase): boolean {
    return (c.gameplan?.steps ?? []).some(
      (s) => s.result?.action === "tech_visit" && (s.result.outcome === "no_change" || s.result.outcome === "made_safe") &&
        this.store.data.visits.some((v) => v.visit_id === s.params.visit_id && v.state === "completed"),
    );
  }

  private ctx(c: RcaCase): GateContext {
    return {
      rcaCase: c,
      status: this.gateway.getStatus(c.vin),
      allowlist: this.seed.fw_allowlist,
      onSiteConfirmed: this.onSiteConfirmed(c),
    };
  }

  private findStep(c: RcaCase, stepId: string): PlannedStep {
    const s = c.gameplan?.steps.find((x) => x.step_id === stepId);
    if (!s) throw new EngineError(`unknown step ${stepId} on ${c.case_id}`);
    return s;
  }

  private copyStep(c: RcaCase, s: PlannedStep, rationale: string): PlannedStep {
    const { visit_id: _drop, ...params } = s.params;
    return { ...s, step_id: this.store.newStepId(c.case_id), params, rationale, state: "planned", approvals: [], result: undefined };
  }

  private insertAfter(c: RcaCase, after: PlannedStep, s: PlannedStep): void {
    const steps = c.gameplan!.steps;
    steps.splice(steps.indexOf(after) + 1, 0, s);
  }

  /** Users are resolved against the seed by id so a caller can't claim a role it doesn't have. */
  private resolveUser(user: User): User {
    const found = [...this.seed.users, ...this.seed.drivers].find((u) => u.id === user.id);
    if (!found) throw new EngineError(`unknown user ${user.id}`);
    return found;
  }

  private metrics(): ResponseMetrics {
    const d = this.store.data;
    const count = (o: RcaCase["outcome"]) => d.cases.filter((c) => c.outcome === o).length;
    return {
      open_cases: d.cases.filter((c) => c.status !== "Closed").length,
      closed_cases: d.cases.filter((c) => c.status === "Closed").length,
      fixed_remote: count("fixed_remote"),
      avoided_false_pulls: count("avoided_false_pull"),
      truck_rolls: d.visits.filter((v) => v.state === "completed").length,
      unnecessary_pulls: d.unnecessary_pulls,
      gate_denials: d.cases.reduce((n, c) => n + c.timeline.filter((e) => e.kind === "gate_denied").length, 0),
    };
  }

  /** Serialize public mutations: tick() runs on a timer and must not interleave with approvals. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
