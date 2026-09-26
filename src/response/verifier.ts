// Verifier (design doc §7). After an action, re-read what the device reports to decide whether
// the fault actually cleared. Never trusts the action's own claim for device actions.

import type { ActionResult, FleetGateway } from "./types.js";

export type Verdict =
  | "pass" //          device no longer faulted
  | "fail" //          still faulted
  | "info" //          read-only: advances, never passes or fails
  | "interlock" //     device refused on safety grounds → Escalated L0
  | "nothing_found" // tech found nothing wrong → avoided false pull
  | "made_safe" //     safety unit made safe; unlocks HQ recovery
  | "replaced"; //     unit swapped at HQ

export function verify(gateway: FleetGateway, result: ActionResult): Verdict {
  switch (result.outcome) {
    case "info_only":
      return "info";
    case "refused_interlock":
      return "interlock";
    case "nothing_found":
      return "nothing_found";
    case "made_safe":
      return "made_safe";
    case "replaced":
      return "replaced";
    default:
      return gateway.getStatus(result.vin).faulted ? "fail" : "pass";
  }
}
