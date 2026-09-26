// Scheduler (design doc §8). Turns an approved dispatch_tech / hq_recovery into a ScheduledVisit
// with an assignee, a 2-hour slot at the next hour, a brief and a checklist. MOCKED.

import type { RcaCase, RootCause, ScheduledVisit, User } from "./types.js";
import type { FleetSeed } from "./seed.js";

const CHECKLISTS: Record<RootCause, string[]> = {
  fw_soft_fault_reboot_candidate: ["Confirm WDT reset-loop code on the display", "Power-cycle the inverter", "Confirm fault clears after boot", "Note firmware version"],
  fw_version_mismatch: ["Read firmware version on the unit", "Do not flash firmware locally", "Confirm comms so an engineer-approved OTA can run", "Note any other active codes"],
  can_link_unreliable: ["Photo the CAN connector before touching it", "Reseat the CAN connector", "Check cable for damage or strain", "Confirm link stable for 10 minutes", "Photo after reseat"],
  install_commissioning_incomplete: ["Photo the install", "Complete the commissioning steps", "Verify settings against the install record", "Confirm the unit reports online"],
  install_wiring_or_sense_error: ["Photo CT placement and wiring", "Check CT orientation and polarity", "Correct wiring or sense leads", "Confirm readings match the meter", "Photo after correction"],
  grid_or_home_side_condition: ["Measure grid voltage and frequency at the panel", "Inspect home-side wiring and loads", "Explain findings to the customer", "Clear the fault on the unit"],
  thermal_or_safety_event: ["Follow the safety procedure; engineer on the line", "Isolate the unit", "Photo the unit and surroundings", "Confirm the unit is made safe", "Prepare for HQ recovery"],
  true_hardware_defect: ["Confirm the power-stage fault code", "Run the on-site hardware check", "Photo the unit label and fault", "Record whether HQ recovery is needed"],
  no_fault_found: ["Check the unit's fault history", "Inspect for visible issues", "Clear the latched fault", "Confirm normal operation"],
  unknown: ["Photo the unit and install", "Record all active fault codes", "Check CAN and CT connections", "Call engineering with findings"],
};

const PHOTO_CAUSES = new Set<RootCause>(["can_link_unreliable", "install_commissioning_incomplete", "install_wiring_or_sense_error"]);

export function photosRequiredFor(cause: RootCause): boolean {
  return PHOTO_CAUSES.has(cause);
}

/** Next top of the hour. */
export function nextSlot(now: Date): { start: string; end: string } {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 2 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function pickTechnician(cause: RootCause, seed: FleetSeed): User {
  const users = [...seed.users, ...seed.drivers];
  const entry = seed.tech_roster.find((t) => t.skills.includes(cause)) ?? seed.tech_roster[0];
  const user = users.find((u) => u.id === entry.user_id);
  if (!user) throw new Error(`tech_roster user ${entry.user_id} not in users`);
  return user;
}

export interface ScheduleArgs {
  rcaCase: RcaCase;
  kind: ScheduledVisit["kind"];
  visitId: string;
  seed: FleetSeed;
  now: Date;
  /** Forces photos (e.g. a remote fix already failed, so the diagnosis is in doubt). */
  photosRequired?: boolean;
  withEngineer?: boolean;
}

export function scheduleVisit(a: ScheduleArgs): ScheduledVisit {
  const c = a.rcaCase;
  const cause = c.hypothesis?.root_cause ?? "unknown";
  const slot = nextSlot(a.now);
  if (a.kind === "hq_recovery") {
    const driver = a.seed.drivers[0];
    if (!driver) throw new Error("no driver in seed");
    return {
      visit_id: a.visitId,
      case_id: c.case_id,
      vin: c.vin,
      kind: "hq_recovery",
      assignee: driver,
      slot_start: slot.start,
      slot_end: slot.end,
      brief: `Recover ${c.vin} (${c.asset_id}) from ${c.site} to Base HQ. Replacement approved by ops and engineering after ${cause.replace(/_/g, " ")}.`,
      checklist: ["Bring a replacement unit on allow-listed firmware", "Confirm the unit is isolated before removal", "Photo the unit before and after swap", "Confirm the replacement reports online"],
      photos_required: false,
      state: "scheduled",
    };
  }
  const assignee = pickTechnician(cause, a.seed);
  const failed = c.gameplan?.steps.filter((s) => s.state === "failed").map((s) => s.action) ?? [];
  const tried = failed.length ? ` Remote ${failed.join(", ")} did not clear it.` : "";
  return {
    visit_id: a.visitId,
    case_id: c.case_id,
    vin: c.vin,
    kind: "tech_visit",
    assignee,
    slot_start: slot.start,
    slot_end: slot.end,
    brief: `${c.vin} at ${c.site} is faulted; working hypothesis ${cause.replace(/_/g, " ")} (confidence ${(c.hypothesis?.confidence ?? 0).toFixed(2)}).${tried}${a.withEngineer ? " Engineer joins by phone." : ""}`,
    checklist: CHECKLISTS[cause],
    photos_required: a.photosRequired ?? photosRequiredFor(cause),
    state: "scheduled",
  };
}
