/**
 * Observable window the detectors compare. This is not the simulator's hidden fault.
 * Absent blocks mean "not observed", not "healthy".
 */

export interface FwManifest {
  /** Used when `byHwRev` has no entry for this rev. */
  signedForAllRevs?: readonly string[];
  /** When this rev has an entry, only that list is signed. An empty list allows nothing. */
  byHwRev?: Readonly<Record<string, readonly string[]>>;
}

export type BootReason = "power_on" | "WDT" | "reboot_cmd" | "ota" | "panic";

export interface BootEvidence {
  reason: BootReason | null;
  watchdogResets: number;
  panicCount: number;
  repeatedSoftReset: boolean;
}

export interface RailEvidence {
  allPresent: boolean;
  /** A rail that should be present on a mated connector is missing. */
  missingWhenMated: boolean;
  healthy: boolean;
}

export interface CanEvidence {
  errorFrames: number;
  droppedFrames: number;
  busOffCount: number;
  missingNodes: readonly string[];
  linkFlapCount: number;
}

export interface CommissioningEvidence {
  checklistComplete: boolean;
  firstBootSelfTestPass: boolean;
}

export interface SenseEvidence {
  gridSenseImplausible: boolean;
  ctPolarityReversed: boolean;
}

export interface GridEvidence {
  voltageOutsideWindow?: boolean;
  freqOutsideWindow?: boolean;
  /** Compared with GRID_VOLTAGE_MIN_V / MAX_V when set. */
  voltageV?: number | null;
  freqHz?: number | null;
  houseLoadKw?: number | null;
  islandingFailed?: boolean;
}

export interface SafetyEvidence {
  overtemp?: boolean;
  /** BMS warning bit below the 65C trip. Still an L0 signature. */
  overtempWarning?: boolean;
  cellTempMaxC?: number | null;
  packCurrentA?: number | null;
  insulationFault?: boolean;
  unexpectedHv?: boolean;
  thermalOrSmoke?: boolean;
  /** Irreversible pyro disconnect. Remote reboot and OTA stay blocked. */
  pyroFuseActivated?: boolean;
}

/** Both playbooks must already have been run, and the fault must still be there. */
export interface PlaybookAttempts {
  rebootPlaybookDone: boolean;
  reseatPlaybookDone: boolean;
  faultRepeatedAfterBoth: boolean;
}

export interface DetectorEvidence {
  caseId: string;
  vin: string;
  observedAt: string;
  hwRev: string | null;
  fwVersion: string | null;
  faulted: boolean;
  /** Reported codes. They are evidence lines, not a class lookup. */
  activeFaultCodes: readonly string[];
  repeatFaultCode: boolean;
  offline?: boolean;
  boot?: BootEvidence;
  rails?: RailEvidence;
  can?: CanEvidence;
  commissioning?: CommissioningEvidence;
  sense?: SenseEvidence;
  grid?: GridEvidence;
  safety?: SafetyEvidence;
  attempts?: PlaybookAttempts;
}

export function signedVersionsFor(manifest: FwManifest, hwRev: string | null): readonly string[] {
  if (hwRev && manifest.byHwRev && Object.prototype.hasOwnProperty.call(manifest.byHwRev, hwRev)) {
    return manifest.byHwRev[hwRev] ?? [];
  }
  return manifest.signedForAllRevs ?? [];
}

export function fwIsSigned(manifest: FwManifest, hwRev: string | null, fwVersion: string | null): boolean {
  if (!fwVersion) return false;
  return signedVersionsFor(manifest, hwRev).includes(fwVersion);
}
