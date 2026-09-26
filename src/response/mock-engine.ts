// MOCKED in-memory ResponseEngine for building the /response UI in parallel with the real engine.
// Design: docs/field-rca/response-agent.md. It implements a compact version of the §4 response
// table, the §5 gate, and the §6 playbook so every button on the page does something plausible.
// At integration, routes.ts swaps this for the real engine with a one-line change.

import fs from "node:fs";
import path from "node:path";
import type {
  ActionResult,
  ActionType,
  Alert,
  Approval,
  BugReport,
  CaseEvent,
  CaseEventKind,
  CaseStatus,
  DeviceStatus,
  GateResult,
  Hypothesis,
  Level,
  PlannedStep,
  PlantableFault,
  RcaCase,
  ResponseEngine,
  ResponseState,
  Role,
  RootCause,
  ScheduledVisit,
  UnitState,
  User,
  VisitOutcome,
} from "./types.js";

export interface SeedFile {
  fw_allowlist: string[];
  misdiagnose: Record<string, { root_cause: RootCause; confidence: number; why: string }>;
  users: User[];
  tech_roster: { user_id: string; skills: RootCause[]; zone: string }[];
  drivers: User[];
  units: UnitState[];
}

export function loadSeed(): SeedFile {
  const p = path.join(process.cwd(), "data", "sim-fleet.seed.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as SeedFile;
}

const FAULT_CODES: Record<PlantableFault, string> = {
  fw_soft_fault_reboot_candidate: "INV-F101 WDT_RESET_LOOP",
  fw_version_mismatch: "INV-F120 FW_COMPAT",
  can_link_unreliable: "INV-F210 CAN_COMM_LOSS",
  install_commissioning_incomplete: "INV-F310 COMMISSIONING",
  install_wiring_or_sense_error: "INV-F320 CT_SENSE",
  grid_or_home_side_condition: "INV-F410 GRID_OOR",
  thermal_or_safety_event: "INV-F900 OVERTEMP",
  true_hardware_defect: "INV-F510 POWER_STAGE",
  no_fault_found: "INV-F050 TRANSIENT",
};

const CATALOG: Record<ActionType, { level: Level; requires: Approval }> = {
  monitor: { level: "L1", requires: "none" },
  engineer_bug_report: { level: "L1", requires: "none" },
  request_log_dump: { level: "L2", requires: "ops_or_engineer" },
  can_health_query: { level: "L2", requires: "ops_or_engineer" },
  reboot: { level: "L2", requires: "ops_or_engineer" },
  ota_to_allowlisted: { level: "L3", requires: "engineer" },
  dispatch_tech: { level: "L4", requires: "ops_or_engineer" },
  hq_recovery: { level: "L4", requires: "ops_and_engineer" },
};

const LEVEL_RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const HW_FAULTS: (PlantableFault | null)[] = ["true_hardware_defect", "thermal_or_safety_event"];

type StepDraft = Pick<PlannedStep, "action" | "params" | "expected_effect" | "rationale">;

const CHECKLISTS: Partial<Record<RootCause, string[]>> = {
  can_link_unreliable: ["Photograph CAN connector before touching", "Reseat CAN connector and check pin seating", "Inspect harness for strain or abrasion", "Confirm CAN link stable for 5 min", "Photograph after reseat"],
  install_commissioning_incomplete: ["Verify commissioning steps in installer app", "Confirm CT orientation and pairing", "Run commissioning self-test", "Photograph panel and labels"],
  install_wiring_or_sense_error: ["Photograph CT placement", "Verify CT orientation against install guide", "Check sense wiring torque", "Confirm readings match utility meter"],
  thermal_or_safety_event: ["Do not power-cycle before inspection (L0)", "Engineer on the line before opening enclosure", "Isolate unit and verify zero energy", "Photograph thermal damage", "Tag unit for HQ recovery"],
  true_hardware_defect: ["Pull last fault log locally", "Confirm power-stage fault on service port", "Isolate unit for recovery", "Photograph serial label"],
  fw_version_mismatch: ["Confirm FW version on local display", "Do not flash locally; OTA is engineer-approved", "Check network link for OTA"],
  no_fault_found: ["Check for latched transient code", "Inspect for environmental cause", "Confirm unit operating normally"],
  grid_or_home_side_condition: ["Measure grid voltage at service entrance", "Check home-side breaker and wiring", "Notify customer of home-side issue"],
  fw_soft_fault_reboot_candidate: ["Power-cycle unit per procedure", "Confirm watchdog resets stopped", "Note uptime after restart"],
};

function nowIso(): string {
  return new Date().toISOString();
}

export class MockResponseEngine implements ResponseEngine {
  private seed: SeedFile;
  private units: UnitState[] = [];
  private cases: RcaCase[] = [];
  private visits: ScheduledVisit[] = [];
  private bugReports: BugReport[] = [];
  private unnecessaryPulls = 0;
  private seq = { case: 1000, event: 0, visit: 100, report: 0 };

  constructor(seed: SeedFile = loadSeed()) {
    this.seed = seed;
    this.init();
  }

  // ---------------------------------------------------------------- public API

  getState(): ResponseState {
    const fleet = this.units.map((u) => this.status(u));
    return {
      fleet,
      cases: structuredClone(this.cases),
      visits: structuredClone(this.visits),
      bug_reports: structuredClone(this.bugReports),
      users: this.seed.users,
      metrics: {
        open_cases: this.cases.filter((c) => c.status !== "Closed").length,
        closed_cases: this.cases.filter((c) => c.status === "Closed").length,
        fixed_remote: this.cases.filter((c) => c.outcome === "fixed_remote").length,
        avoided_false_pulls: this.cases.filter((c) => c.outcome === "avoided_false_pull").length,
        truck_rolls: this.visits.filter((v) => v.state === "completed").length,
        unnecessary_pulls: this.unnecessaryPulls,
        gate_denials: this.cases.reduce((n, c) => n + c.timeline.filter((e) => e.kind === "gate_denied").length, 0),
      },
      planner: "playbook",
      mocked: true,
    };
  }

  async ingestFaults(): Promise<RcaCase[]> {
    return this.ingestSync();
  }

  async tick(): Promise<void> {
    this.tickSync();
  }

  async approve(caseId: string, stepId: string, user: User): Promise<GateResult> {
    return this.approveSync(caseId, stepId, user);
  }

  async reject(caseId: string, stepId: string, user: User, reason: string): Promise<void> {
    const c = this.getCase(caseId);
    const step = this.getStep(c, stepId);
    if (step.state !== "awaiting_approval") throw new Error(`step ${stepId} is not awaiting approval`);
    if (user.role !== "ops" && user.role !== "engineer") throw new Error(`${user.role} cannot reject actions`);
    step.state = "rejected";
    this.event(c, "rejected", user, `${user.name} rejected ${step.action}${reason ? `: ${reason}` : ""}`);
    this.advance(c);
  }

  async completeVisit(visitId: string, user: User, outcome: VisitOutcome): Promise<void> {
    const v = this.visits.find((x) => x.visit_id === visitId);
    if (!v) throw new Error(`unknown visit ${visitId}`);
    if (v.state !== "scheduled") throw new Error(`visit ${visitId} is already ${v.state}`);
    if (user.role !== "technician") throw new Error("only a technician can complete a visit");
    if (outcome.completed && v.photos_required && !outcome.photos_attached) {
      throw new Error("photos are required for this visit");
    }
    if (!outcome.completed && !outcome.incomplete_reason) throw new Error("incomplete_reason is required");
    const c = this.getCase(v.case_id);
    const step = c.gameplan?.steps.find((s) => s.state === "running" && (s.action === "dispatch_tech" || s.action === "hq_recovery"));
    v.outcome = outcome;

    if (!outcome.completed) {
      v.state = "incomplete";
      this.event(c, "visit_incomplete", user, `${user.name} marked visit ${v.visit_id} incomplete: ${outcome.incomplete_reason}`);
      if (step) {
        step.state = "failed";
        step.result = this.result(this.unit(c.vin), "tech_visit", "no_change", `Visit incomplete (${outcome.incomplete_reason}); no state change.`);
      }
      // Bounce: re-plan a fresh visit that needs approval again.
      this.appendStep(c, this.draft(v.kind === "hq_recovery" ? "hq_recovery" : "dispatch_tech", c, "Previous visit incomplete; reschedule."));
      this.advance(c);
      return;
    }

    v.state = "completed";
    const u = this.unit(c.vin);
    const res = v.kind === "hq_recovery" ? this.apply(u, "hq_recovery") : this.techVisit(u);
    this.event(c, "visit_completed", user, `${user.name} completed ${v.kind === "hq_recovery" ? "HQ recovery" : "visit"} ${v.visit_id}: ${res.detail}`);
    if (step) step.result = res;
    this.verify(c, step, res);
  }

  async closeCase(caseId: string, user: User, note: string): Promise<void> {
    const c = this.getCase(caseId);
    if (user.role !== "engineer") throw new Error("only an engineer can close a case");
    const l0Ready = c.status === "Escalated L0" && (c.outcome === "l0_made_safe" || c.outcome === "pulled_justified");
    if (c.status !== "Engineer review" && !l0Ready) throw new Error(`case is ${c.status}; close from Engineer review, or Escalated L0 once made safe`);
    this.setStatus(c, "Closed", user);
    this.event(c, "closed", user, `${user.name} closed the case${note ? `: ${note}` : ""}`);
  }

  async plantFault(vin: string, fault: PlantableFault): Promise<void> {
    const u = this.unit(vin);
    u.fault = fault;
    u.fault_time = nowIso();
  }

  async reset(): Promise<void> {
    this.init();
  }

  // ---------------------------------------------------------------- seeded demo state

  private init(): void {
    this.units = structuredClone(this.seed.units);
    this.cases = [];
    this.visits = [];
    this.bugReports = [];
    this.unnecessaryPulls = 0;
    this.seq = { case: 1000, event: 0, visit: 100, report: 0 };
    this.ingestSync();
    // Pre-advance a few cases so every panel has something in it on first load.
    const ops = this.seed.users.find((u) => u.role === "ops")!;
    const hw = this.cases.find((c) => c.vin === "INV-5012");
    if (hw) {
      this.approveSync(hw.case_id, hw.gameplan!.steps[0].step_id, ops); // log dump
      this.tickSync();
      const dispatch = hw.gameplan!.steps.find((s) => s.action === "dispatch_tech");
      if (dispatch) this.approveSync(hw.case_id, dispatch.step_id, ops);
    }
    this.tickSync(); // INV-5002 monitor runs → clears → Engineer review
  }

  // ---------------------------------------------------------------- ingest + plan

  private ingestSync(): RcaCase[] {
    const opened: RcaCase[] = [];
    for (const u of this.units) {
      if (!u.fault) continue;
      if (this.cases.some((c) => c.vin === u.vin && c.status !== "Closed")) continue;
      const c: RcaCase = {
        case_id: `RCA-${++this.seq.case}`,
        vin: u.vin,
        asset_id: u.asset_id,
        site: u.site,
        fw_version: u.fw_version,
        trigger: "fault_flag",
        opened_at: u.fault_time ?? nowIso(),
        status: "Open",
        visits: [],
        timeline: [],
      };
      this.cases.push(c);
      this.event(c, "case_opened", "system", `Case opened: ${u.vin} reports ${FAULT_CODES[u.fault]}`);
      c.hypothesis = this.diagnose(c, u);
      this.event(c, "hypothesis", "agent", `Hypothesis ${c.hypothesis.root_cause} (${Math.round(c.hypothesis.confidence * 100)}%, stub)`);
      this.plan(c);
      opened.push(c);
    }
    this.checkBugReports();
    return opened;
  }

  private diagnose(c: RcaCase, u: UnitState): Hypothesis {
    const mis = this.seed.misdiagnose[u.vin];
    const root: RootCause = mis?.root_cause ?? (u.fault as RootCause);
    return {
      case_id: c.case_id,
      vin: u.vin,
      root_cause: root,
      confidence: mis?.confidence ?? 0.86,
      evidence: [`active code ${FAULT_CODES[u.fault!]}`, `fw ${u.fw_version}`, `last boot ${u.last_boot_reason}`],
      fw_version: u.fw_version,
      source: "stub",
    };
  }

  private plan(c: RcaCase): void {
    const h = c.hypothesis!;
    const u = this.unit(c.vin);
    const allow = this.seed.fw_allowlist;
    const d = (a: ActionType, why: string) => this.draft(a, c, why);
    let drafts: StepDraft[];
    switch (h.confidence < 0.5 ? "unknown" : h.root_cause) {
      case "fw_soft_fault_reboot_candidate":
        drafts = [d("reboot", "Watchdog reset loop usually clears on a clean reboot.")];
        if (!allow.includes(u.fw_version)) drafts.push(d("ota_to_allowlisted", `fw ${u.fw_version} is off the allow-list.`));
        drafts.push(d("dispatch_tech", "Remote fixes exhausted."));
        break;
      case "fw_version_mismatch":
        drafts = [d("ota_to_allowlisted", `fw ${u.fw_version} is incompatible; move to ${allow[0]}.`), d("dispatch_tech", "OTA did not clear the fault.")];
        break;
      case "can_link_unreliable":
        drafts = [d("can_health_query", "Confirm link flaps before rolling a truck."), d("dispatch_tech", "Connector reseat needs hands on site.")];
        break;
      case "install_commissioning_incomplete":
      case "install_wiring_or_sense_error":
        drafts = [d("dispatch_tech", "Install issue; needs a site visit with photos.")];
        break;
      case "grid_or_home_side_condition":
      case "no_fault_found":
        drafts = [d("monitor", "Likely transient; watch for recurrence first."), d("dispatch_tech", "Fault recurred.")];
        break;
      case "true_hardware_defect":
        drafts = [d("request_log_dump", "Capture power-stage logs before the visit."), d("dispatch_tech", "Confirm the defect on site."), d("hq_recovery", "Hardware confirmed; replace unit.")];
        break;
      case "thermal_or_safety_event":
        // Reboot is included so the gate visibly denies it (demo scene 3).
        drafts = [d("reboot", "Proposed by the planner; the gate must refuse it on L0."), d("dispatch_tech", "Tech with engineer on the line makes the unit safe."), d("hq_recovery", "Safety event; unit comes back to HQ.")];
        break;
      default:
        drafts = [d("request_log_dump", "Low confidence; gather logs."), d("can_health_query", "Rule out CAN link."), d("dispatch_tech", "Still unknown; look on site.")];
    }
    const steps = drafts.map((s, i) => this.toStep(c, s, i + 1));
    const level: Level = this.isSafety(c) ? "L0" : steps.reduce<Level>((m, s) => (LEVEL_RANK[s.level] > LEVEL_RANK[m] ? s.level : m), "L1");
    c.gameplan = {
      case_id: c.case_id,
      level,
      steps,
      alerts: this.alertsFor(level, steps),
      summary: `${h.root_cause.replace(/_/g, " ")}: ${steps.map((s) => s.action).join(" → ")}`,
      source: "playbook",
      created_at: nowIso(),
    };
    this.event(c, "gameplan", "agent", `Gameplan (${level}, playbook): ${steps.map((s) => s.action).join(" → ")}`);
    for (const a of c.gameplan.alerts) this.event(c, "alert_sent", "system", `Alert → ${a.role}: ${a.reason} (MOCKED)`);
    this.setStatus(c, level === "L0" ? "Escalated L0" : "Investigating", "agent");
    this.advance(c);
  }

  private draft(action: ActionType, c: RcaCase, rationale: string): StepDraft {
    const effects: Record<ActionType, string> = {
      monitor: "No recurrence within the watch window",
      engineer_bug_report: "Engineers see the cluster",
      request_log_dump: "Logs attached to the case",
      can_health_query: "CAN bus error counters returned",
      reboot: "Fault clears after reboot",
      ota_to_allowlisted: `Unit on ${this.seed.fw_allowlist[0]}, fault clears`,
      dispatch_tech: "Tech confirms or fixes on site",
      hq_recovery: "Unit replaced and returned to HQ",
    };
    return {
      action,
      params: action === "ota_to_allowlisted" ? { target_fw: this.seed.fw_allowlist[0] } : {},
      expected_effect: effects[action],
      rationale,
    };
  }

  private toStep(c: RcaCase, s: StepDraft, n: number): PlannedStep {
    return { step_id: `${c.case_id}-s${n}`, ...s, ...CATALOG[s.action], state: "planned", approvals: [] };
  }

  private appendStep(c: RcaCase, s: StepDraft): void {
    const steps = c.gameplan!.steps;
    steps.push(this.toStep(c, s, steps.length + 1));
    this.event(c, "escalated", "agent", `Plan extended with ${s.action}: ${s.rationale}`);
  }

  private alertsFor(level: Level, steps: PlannedStep[]): Alert[] {
    switch (level) {
      case "L0": return [{ role: "engineer", reason: "Safety case" }, { role: "ops", reason: "Safety case" }];
      case "L1": return [{ role: "engineer", reason: "Low-risk case for awareness" }];
      case "L2": return [{ role: "ops", reason: "Remote action needs approval" }];
      case "L3": return [{ role: "engineer", reason: "OTA needs engineer approval" }];
      default: {
        const a: Alert[] = [{ role: "technician", reason: "Field visit likely" }, { role: "ops", reason: "Truck roll planned" }];
        if (steps.some((s) => s.action === "hq_recovery")) a.push({ role: "driver", reason: "HQ recovery planned" });
        return a;
      }
    }
  }

  // ---------------------------------------------------------------- gate

  private isSafety(c: RcaCase): boolean {
    const u = this.units.find((x) => x.vin === c.vin);
    return c.hypothesis?.root_cause === "thermal_or_safety_event" || u?.fault === "thermal_or_safety_event" || c.status === "Escalated L0";
  }

  private gate(step: PlannedStep, c: RcaCase, user?: User): GateResult {
    const h = c.hypothesis;
    const remote = step.action === "reboot" || step.action === "ota_to_allowlisted";
    if (remote && this.isSafety(c)) return { kind: "deny", reason: "safety (L0) case: no remote actuation" };
    if (remote && (!h || h.root_cause === "unknown" || h.confidence < 0.5)) return { kind: "deny", reason: "hypothesis unknown or confidence < 0.5" };
    if (step.action === "ota_to_allowlisted" && !this.seed.fw_allowlist.includes(step.params.target_fw)) {
      return { kind: "deny", reason: `target_fw ${step.params.target_fw} is not on the allow-list` };
    }
    if (step.action === "hq_recovery" && !this.isSafety(c) && !this.onSiteConfirmed(c)) {
      return { kind: "deny", reason: "HQ recovery needs on-site confirmation first" };
    }
    if (user?.role === "technician") return { kind: "deny", reason: "technicians complete visits; they don't approve actions" };
    if (user?.role === "admin") return { kind: "deny", reason: "admin doesn't bypass safety" };

    const have = new Set<Role>(step.approvals.map((a) => a.user.role));
    const need = (roles: Role[]): GateResult => ({ kind: "needs_approval", requires: step.requires, missing: roles });
    switch (step.requires) {
      case "none":
        return { kind: "allow" };
      case "ops_or_engineer":
        if (!user) return have.size ? { kind: "allow" } : need(["ops", "engineer"]);
        return { kind: "allow" };
      case "engineer":
        if (!user) return have.has("engineer") ? { kind: "allow" } : need(["engineer"]);
        return user.role === "engineer" ? { kind: "allow" } : { kind: "deny", reason: "engineer only: OTA needs an engineer's approval" };
      case "ops_and_engineer": {
        if (user) {
          if (step.approvals.some((a) => a.user.id === user.id)) return { kind: "deny", reason: "already approved by you; needs a second, distinct user" };
          if (have.has(user.role)) return { kind: "deny", reason: `already approved by ${user.role}; needs the other role` };
          have.add(user.role);
        }
        const missing = (["ops", "engineer"] as Role[]).filter((r) => !have.has(r));
        return missing.length ? need(missing) : { kind: "allow" };
      }
    }
  }

  private onSiteConfirmed(c: RcaCase): boolean {
    return !!c.gameplan?.steps.some(
      (s) => s.action === "dispatch_tech" && (s.result?.outcome === "no_change" || s.result?.outcome === "made_safe"),
    );
  }

  private approveSync(caseId: string, stepId: string, user: User): GateResult {
    const c = this.getCase(caseId);
    const step = this.getStep(c, stepId);
    if (step.state !== "awaiting_approval") throw new Error(`step ${stepId} is not awaiting approval (${step.state})`);
    const g = this.gate(step, c, user);
    if (g.kind === "deny") {
      this.event(c, "gate_denied", user, `Gate denied ${user.name} approving ${step.action}: ${g.reason}`);
      return g;
    }
    step.approvals.push({ user, ts: nowIso() });
    this.event(c, "approved", user, `${user.name} (${user.role}) approved ${step.action}`);
    if (g.kind === "allow") {
      step.state = "approved";
      this.setStatus(c, "In progress", "system");
    }
    return g;
  }

  // ---------------------------------------------------------------- runner + verifier

  private tickSync(): void {
    for (const c of this.cases) {
      if (c.status === "Closed" || !c.gameplan) continue;
      const step = c.gameplan.steps.find((s) => s.state === "approved");
      if (!step) continue;
      if (step.action === "dispatch_tech" || step.action === "hq_recovery") {
        step.state = "running";
        this.schedule(c, step.action === "hq_recovery" ? "hq_recovery" : "tech_visit");
        continue;
      }
      if (step.action === "engineer_bug_report") {
        step.state = "done";
        this.advance(c);
        continue;
      }
      step.state = "running";
      const res = this.apply(this.unit(c.vin), step.action, step.params);
      step.result = res;
      this.event(c, "action_run", "system", `${step.action}: ${res.outcome}. ${res.detail}`);
      this.verify(c, step, res);
    }
  }

  private verify(c: RcaCase, step: PlannedStep | undefined, res: ActionResult): void {
    const u = this.unit(c.vin);
    const wasHw = HW_FAULTS.includes(c.hypothesis?.root_cause as PlantableFault);
    const finish = (outcome: RcaCase["outcome"], note: string) => {
      if (step) step.state = "done";
      for (const s of c.gameplan!.steps) if (s.state === "planned" || s.state === "awaiting_approval") s.state = "skipped";
      c.outcome = outcome;
      this.event(c, "verify_pass", "system", note);
      if (c.status !== "Escalated L0") this.setStatus(c, "Engineer review", "system");
    };
    switch (res.outcome) {
      case "info_only":
        if (step) step.state = "done";
        this.advance(c);
        break;
      case "cleared":
        finish(res.action === "tech_visit" ? "fixed_on_site" : res.action === "monitor" && c.hypothesis?.root_cause === "no_fault_found" ? "avoided_false_pull" : "fixed_remote", `Verified: ${u.vin} no longer faulted`);
        break;
      case "nothing_found":
        finish("avoided_false_pull", "Tech found nothing wrong: false pull avoided");
        break;
      case "replaced":
        if (!wasHw) this.unnecessaryPulls++;
        finish(wasHw ? "pulled_justified" : undefined, wasHw ? "Unit replaced at HQ (justified pull)" : "Unit replaced at HQ (unnecessary pull)");
        break;
      case "made_safe":
        if (step) step.state = "done";
        c.outcome = "l0_made_safe";
        this.event(c, "verify_pass", "system", "Unit made safe on site; HQ recovery unlocked");
        this.advance(c);
        break;
      case "refused_interlock":
        if (step) step.state = "failed";
        this.event(c, "verify_fail", "system", "Device refused: safety interlock");
        this.setStatus(c, "Escalated L0", "system");
        this.event(c, "alert_sent", "system", "Alert → engineer, ops: interlock refusal (MOCKED)");
        this.advance(c);
        break;
      default:
        if (step) step.state = "failed";
        this.event(c, "verify_fail", "system", `Verify failed: ${u.vin} still reports ${this.status(u).active_fault_codes.join(", ")}`);
        this.advance(c);
    }
    this.checkBugReports();
  }

  /** Move the case to its next runnable step, or escalate when the plan runs out. */
  private advance(c: RcaCase): void {
    const steps = c.gameplan!.steps;
    if (steps.some((s) => s.state === "awaiting_approval" || s.state === "approved" || s.state === "running")) return;
    for (const step of steps) {
      if (step.state !== "planned") continue;
      const g = this.gate(step, c);
      if (g.kind === "deny") {
        step.state = "denied";
        this.event(c, "gate_denied", "system", `Gate denied ${step.action}: ${g.reason}`);
        continue;
      }
      if (g.kind === "allow") {
        step.state = "approved";
        this.setStatus(c, "In progress", "system");
      } else {
        step.state = "awaiting_approval";
        this.event(c, "approval_requested", "agent", `${step.action} needs approval from ${g.missing.join(" / ")}`);
        this.setStatus(c, "Action pending", "system");
      }
      return;
    }
    // Plan exhausted and still faulted → escalate.
    if (!this.status(this.unit(c.vin)).faulted || c.outcome) return;
    const hadVisit = this.visits.some((v) => v.case_id === c.case_id && v.state === "completed");
    this.appendStep(c, this.draft(hadVisit ? "hq_recovery" : "dispatch_tech", c, hadVisit ? "Visit did not clear the fault." : "Remote steps did not clear the fault."));
    this.advance(c);
  }

  private schedule(c: RcaCase, kind: ScheduledVisit["kind"]): void {
    const h = c.hypothesis!;
    let assignee: User;
    if (kind === "hq_recovery") {
      assignee = this.seed.drivers[0];
    } else {
      const r = this.seed.tech_roster.find((t) => t.skills.includes(h.root_cause)) ?? this.seed.tech_roster[0];
      assignee = this.seed.users.find((u) => u.id === r.user_id)!;
    }
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 2 * 3600_000);
    const cause = h.root_cause.replace(/_/g, " ");
    const v: ScheduledVisit = {
      visit_id: `V-${++this.seq.visit}`,
      case_id: c.case_id,
      vin: c.vin,
      kind,
      assignee,
      slot_start: start.toISOString(),
      slot_end: end.toISOString(),
      brief:
        kind === "hq_recovery"
          ? `Recover ${c.vin} from ${c.site} and bring it to Base HQ. On-site work confirmed it cannot stay in the field.`
          : `${c.vin} is faulted and the agent suspects ${cause} (${Math.round(h.confidence * 100)}%). Remote steps are exhausted or not applicable, so confirm and fix on site.`,
      checklist: kind === "hq_recovery" ? ["Verify unit isolated and tagged", "Load with handling kit", "Install swap unit", "Confirm swap unit online"] : (CHECKLISTS[h.root_cause] ?? ["Inspect unit", "Capture fault log", "Photograph install"]),
      photos_required: h.root_cause === "can_link_unreliable" || h.root_cause.startsWith("install_"),
      state: "scheduled",
    };
    this.visits.push(v);
    c.visits.push(v.visit_id);
    this.event(c, "visit_scheduled", "agent", `${kind === "hq_recovery" ? "HQ recovery" : "Visit"} ${v.visit_id} scheduled: ${assignee.name}, ${start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })} CT`);
    if (c.status !== "Escalated L0") this.setStatus(c, "Field visit", "system");
  }

  // ---------------------------------------------------------------- tiny fleet sim (§4 table)

  private status(u: UnitState): DeviceStatus {
    return {
      vin: u.vin,
      asset_id: u.asset_id,
      fw_version: u.fw_version,
      online: u.online,
      faulted: u.fault !== null,
      active_fault_codes: u.fault ? [FAULT_CODES[u.fault]] : [],
      uptime_s: u.uptime_s,
      last_boot_reason: u.last_boot_reason,
      last_seen: nowIso(),
    };
  }

  private result(u: UnitState, action: ActionResult["action"], outcome: ActionResult["outcome"], detail: string): ActionResult {
    u.action_history.push({ action, ts: nowIso(), result: outcome });
    return { vin: u.vin, action, outcome, detail, status_after: this.status(u) };
  }

  private apply(u: UnitState, action: ActionType, params: Record<string, string> = {}): ActionResult {
    const f = u.fault;
    switch (action) {
      case "request_log_dump":
        return this.result(u, action, "info_only", `Log dump captured (MOCKED): ${f ? FAULT_CODES[f] : "no active codes"}, uptime ${u.uptime_s}s.`);
      case "can_health_query":
        return this.result(u, action, "info_only", f === "can_link_unreliable" ? "CAN link flapping: 41 bus-off events in 24 h." : "CAN link healthy: 0 bus-off events in 24 h.");
      case "monitor":
        if (f === "no_fault_found") { u.fault = null; return this.result(u, action, "cleared", "No recurrence in watch window; latch cleared (demo shortcut)."); }
        return this.result(u, action, "no_change", "Fault recurred during the watch window.");
      case "reboot":
        if (f === "thermal_or_safety_event") return this.result(u, action, "refused_interlock", "Device refused reboot: safety interlock.");
        u.uptime_s = 0;
        u.last_boot_reason = "reboot_cmd";
        if (f === "fw_soft_fault_reboot_candidate" || f === "no_fault_found") { u.fault = null; return this.result(u, action, "cleared", "Rebooted; watchdog loop gone."); }
        return this.result(u, action, "no_change", "Rebooted; fault returned after boot.");
      case "ota_to_allowlisted": {
        if (!this.seed.fw_allowlist.includes(params.target_fw)) throw new Error(`target_fw ${params.target_fw} not allow-listed`);
        if (f === "thermal_or_safety_event") return this.result(u, action, "refused_interlock", "Device refused OTA: safety interlock.");
        u.fw_version = params.target_fw;
        u.last_boot_reason = "ota";
        u.uptime_s = 0;
        if (f === "fw_soft_fault_reboot_candidate" || f === "fw_version_mismatch" || f === "no_fault_found") { u.fault = null; return this.result(u, action, "cleared", `Updated to ${params.target_fw}; fault cleared.`); }
        return this.result(u, action, "no_change", `Updated to ${params.target_fw}; fault still present.`);
      }
      case "hq_recovery":
        u.fault = null;
        u.fw_version = this.seed.fw_allowlist[0];
        return this.result(u, "hq_recovery", "replaced", "Unit swapped; replacement online.");
      default:
        return this.result(u, action, "info_only", "No device command.");
    }
  }

  private techVisit(u: UnitState): ActionResult {
    const f = u.fault;
    const done = (detail: string) => { u.fault = null; return this.result(u, "tech_visit", "cleared", detail); };
    switch (f) {
      case "fw_soft_fault_reboot_candidate": return done("Tech power-cycled the unit; fault cleared.");
      case "can_link_unreliable": return done("CAN connector reseated; link stable.");
      case "install_commissioning_incomplete": return done("Commissioning completed on site.");
      case "install_wiring_or_sense_error": return done("CT sense wiring corrected.");
      case "fw_version_mismatch": return this.result(u, "tech_visit", "no_change", "Needs engineer-approved OTA.");
      case "true_hardware_defect": return this.result(u, "tech_visit", "no_change", "Power stage failure confirmed.");
      case "thermal_or_safety_event": return this.result(u, "tech_visit", "made_safe", "Unit isolated and made safe; needs HQ recovery.");
      case "grid_or_home_side_condition": u.fault = null; return this.result(u, "tech_visit", "nothing_found", "Home-side issue; customer notified. Unit fault cleared.");
      default: u.fault = null; return this.result(u, "tech_visit", "nothing_found", "Nothing wrong with the unit.");
    }
  }

  // ---------------------------------------------------------------- bug reports (§9)

  private checkBugReports(): void {
    const groups = new Map<string, RcaCase[]>();
    for (const c of this.cases) {
      if (!c.hypothesis) continue;
      const k = `${c.fw_version}|${c.hypothesis.root_cause}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    for (const [k, cs] of groups) {
      if (cs.length < 3) continue;
      const [fw, root] = k.split("|") as [string, RootCause];
      if (this.bugReports.some((r) => r.fw_version === fw && r.root_cause === root)) continue;
      const target = this.seed.fw_allowlist[0];
      const recommendation = `OTA affected units to allow-listed ${target}, engineer approval required.`;
      const report: BugReport = {
        report_id: `BUG-${String(++this.seq.report).padStart(3, "0")}`,
        fw_version: fw,
        root_cause: root,
        case_ids: cs.map((c) => c.case_id),
        vins: cs.map((c) => c.vin),
        title: `${root.replace(/_/g, " ")} cluster on fw ${fw} (${cs.length} units)`,
        body_md: [
          `## ${root} on fw ${fw}`,
          "",
          `${cs.length} units on **${fw}** opened cases with the same hypothesis. Units on ${target} do not show this pattern.`,
          "",
          "### Evidence",
          ...cs.map((c) => `- \`${c.case_id}\` ${c.vin} (${c.site}): ${c.hypothesis!.evidence.join("; ")}`),
          "",
          "### Recommendation",
          recommendation,
          "",
          "_Documentation only. The agent never writes or patches firmware. MOCKED template._",
        ].join("\n"),
        recommendation,
        source: "template",
        created_at: nowIso(),
      };
      this.bugReports.push(report);
      for (const c of cs) this.event(c, "bug_report_linked", "agent", `Linked to ${report.report_id}: ${report.title}`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private event(c: RcaCase, kind: CaseEventKind, actor: CaseEvent["actor"], summary: string): void {
    c.timeline.push({ event_id: `E-${++this.seq.event}`, case_id: c.case_id, ts: nowIso(), kind, actor, summary });
  }

  private setStatus(c: RcaCase, s: CaseStatus, actor: CaseEvent["actor"]): void {
    if (c.status === s) return;
    if (c.status === "Escalated L0" && s !== "Closed") return; // L0 is sticky until an engineer closes
    this.event(c, "status_changed", actor, `${c.status} → ${s}`);
    c.status = s;
  }

  private getCase(id: string): RcaCase {
    const c = this.cases.find((x) => x.case_id === id);
    if (!c) throw new Error(`unknown case ${id}`);
    return c;
  }

  private getStep(c: RcaCase, id: string): PlannedStep {
    const s = c.gameplan?.steps.find((x) => x.step_id === id);
    if (!s) throw new Error(`unknown step ${id}`);
    return s;
  }

  private unit(vin: string): UnitState {
    const u = this.units.find((x) => x.vin === vin);
    if (!u) throw new Error(`unknown vin ${vin}`);
    return u;
  }
}
