/**
 * Comparison limits for the deterministic detectors.
 * REAL numbers are from Base's DC ESS manual (Core pack).
 * ASSUMED numbers are hackathon policy, not Base telemetry spec.
 */

/** REAL. Manual protective function: max cell temp > 65C AND |current| > 0.5A. */
export const CELL_OVERTEMP_C = 65;
export const CELL_OVERTEMP_CURRENT_A = 0.5;

/**
 * ASSUMED. One dropped frame is not a link fault (the Core fixture's nominal
 * unit reports 1 drop/min). These are window totals, not per-second rates.
 */
export const CAN_DROPPED_FRAMES_MIN = 10;
export const CAN_ERROR_FRAMES_MIN = 20;
/** ASSUMED. A single drop-and-return is not a flap pattern. */
export const CAN_LINK_FLAPS_MIN = 2;

/** Caller-specified. House load above this AND an islanding failure → grid/home. */
export const HOUSE_LOAD_ISLANDING_KW = 11;

/**
 * ASSUMED split-phase window around 240 V / 60 Hz.
 * 211 V is 88% of 240, 264 V is 110% of 240. Not a Base spec.
 */
export const GRID_VOLTAGE_MIN_V = 211;
export const GRID_VOLTAGE_MAX_V = 264;
export const GRID_HZ_MIN = 59.3;
export const GRID_HZ_MAX = 60.5;
