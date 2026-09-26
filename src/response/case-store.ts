// Case store (design doc §3). Holds cases, visits, bug reports and id counters; persists to
// <runtimeDir>/response-cases.json after every mutation.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BugReport, CaseEvent, CaseStatus, RcaCase, ScheduledVisit } from "./types.js";

export interface StoreData {
  cases: RcaCase[];
  visits: ScheduledVisit[];
  bug_reports: BugReport[];
  unnecessary_pulls: number;
  seq: { case: number; step: number; visit: number; bug: number; event: number };
}

function empty(): StoreData {
  return { cases: [], visits: [], bug_reports: [], unnecessary_pulls: 0, seq: { case: 0, step: 0, visit: 0, bug: 0, event: 0 } };
}

export class CaseStore {
  readonly file: string;
  data: StoreData;

  constructor(runtimeDir: string, private readonly clock: () => Date = () => new Date()) {
    mkdirSync(runtimeDir, { recursive: true });
    this.file = join(runtimeDir, "response-cases.json");
    this.data = existsSync(this.file) ? { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as StoreData) } : empty();
  }

  now(): string {
    return this.clock().toISOString();
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  reset(): void {
    this.data = empty();
    this.save();
  }

  private next(kind: keyof StoreData["seq"]): number {
    return ++this.data.seq[kind];
  }

  newCaseId(): string {
    return `RCA-${String(this.next("case")).padStart(4, "0")}`;
  }
  newStepId(caseId: string): string {
    return `${caseId}-S${this.next("step")}`;
  }
  newVisitId(): string {
    return `V-${String(this.next("visit")).padStart(4, "0")}`;
  }
  newBugId(): string {
    return `BUG-${String(this.next("bug")).padStart(4, "0")}`;
  }

  getCase(caseId: string): RcaCase {
    const c = this.data.cases.find((x) => x.case_id === caseId);
    if (!c) throw new Error(`unknown case ${caseId}`);
    return c;
  }

  getVisit(visitId: string): ScheduledVisit {
    const v = this.data.visits.find((x) => x.visit_id === visitId);
    if (!v) throw new Error(`unknown visit ${visitId}`);
    return v;
  }

  openCaseFor(vin: string): RcaCase | undefined {
    return this.data.cases.find((c) => c.vin === vin && c.status !== "Closed");
  }

  event(c: RcaCase, kind: CaseEvent["kind"], actor: CaseEvent["actor"], summary: string, detail?: Record<string, unknown>): CaseEvent {
    const e: CaseEvent = {
      event_id: `E-${String(this.next("event")).padStart(6, "0")}`,
      case_id: c.case_id,
      ts: this.now(),
      kind,
      actor,
      summary,
      ...(detail ? { detail } : {}),
    };
    c.timeline.push(e);
    return e;
  }

  setStatus(c: RcaCase, status: CaseStatus, actor: CaseEvent["actor"] = "system"): void {
    if (c.status === status) return;
    const from = c.status;
    c.status = status;
    this.event(c, "status_changed", actor, `${from} → ${status}`, { from, to: status });
  }
}
