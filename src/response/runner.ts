// Runner (design doc §7). Sends an allowed device action to the fleet. Visits and bug-report steps
// are handled by the engine (scheduler / bug-report); this only touches FleetGateway.apply.

import { CATALOG } from "./catalog.js";
import type { ActionResult, FleetGateway, PlannedStep } from "./types.js";

export function isDeviceStep(step: PlannedStep): boolean {
  return CATALOG[step.action].deviceAction;
}

export function runDeviceStep(gateway: FleetGateway, vin: string, step: PlannedStep): ActionResult {
  if (!isDeviceStep(step)) throw new Error(`${step.action} is not a device action`);
  return gateway.apply(vin, step.action, step.params);
}
