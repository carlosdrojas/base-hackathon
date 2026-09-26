/**
 * Host ports the triaging agent is allowed to call.
 * The Issue Router dashboard does not implement these yet.
 * Raw packet bytes are reachable only through getRaw(eventId).
 */

import type { AssetHeader, FieldEvent, PriorCaseRef } from "./contracts.js";

export interface RawSlice {
  eventId: string;
  text: string;
}

export interface FieldRcaHost {
  getAsset(vin: string): Promise<AssetHeader | null>;
  getEvents(caseId: string): Promise<FieldEvent[]>;
  getPriorCases(vin: string): Promise<PriorCaseRef[]>;
  getRaw(eventId: string): Promise<RawSlice | null>;
}
