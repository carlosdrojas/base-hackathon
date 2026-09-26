// Loader for data/sim-fleet.seed.json (read-only). The engine needs the allow-list, users, tech
// roster and drivers; the hypothesis stub needs the planted misdiagnoses.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RootCause, UnitState, User } from "./types.js";

export interface FleetSeed {
  fw_allowlist: string[];
  misdiagnose: Record<string, { root_cause: RootCause; confidence: number; why: string }>;
  users: User[];
  tech_roster: { user_id: string; skills: RootCause[]; zone: string }[];
  drivers: User[];
  units: UnitState[];
}

// src/response/seed.ts and dist/response/seed.js both sit two levels below the repo root.
export const DEFAULT_SEED_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "sim-fleet.seed.json");

export function loadSeed(path = DEFAULT_SEED_PATH): FleetSeed {
  return JSON.parse(readFileSync(path, "utf8")) as FleetSeed;
}
