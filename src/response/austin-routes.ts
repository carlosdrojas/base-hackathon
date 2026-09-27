// HTTP routes for the Austin response engine -- a second, independent instantiation of
// Carlos's real DefaultResponseEngine (see engine.ts), running over a real Austin fleet
// (see austin-seed.ts) instead of his simulated one. Mirrors routes.ts's shape closely but
// does not edit it: routes.ts's own `engine` singleton and /api/response/* routes are
// untouched and keep meaning Carlos's simulated fleet only. Mounted by dashboard-server.ts
// at a distinct prefix, /api/response-austin/*.
//
// case_id collision note: CaseStore.newCaseId() (case-store.ts, untouched) mints "RCA-0001",
// "RCA-0002", ... independently per engine instance, so this engine's cases WILL collide with
// Carlos's on raw case_id the moment both have opened at least one case. That is handled at
// the link/route layer (see the "austin:" case_id prefix in fleet-dashboard.ts /
// technician-dashboard.ts / case-workspace.ts / dashboard-server.ts), not here.
import "dotenv/config"; // ANTHROPIC_API_KEY switches the planner to Claude, same as routes.ts
import type http from "node:http";
import { FleetSim } from "../sim/fleet-sim.js";
import { DefaultResponseEngine } from "./engine.js";
import { AustinHypothesisSource } from "./austin-hypothesis-source.js";
import { AUSTIN_RUNTIME_DIR, AUSTIN_RUNTIME_FLEET_PATH, AUSTIN_SEED_PATH, writeAustinSeedFile } from "./austin-seed.js";
import { loadSeed } from "./seed.js";
import type { GateResult, ResponseEngine, User, VisitOutcome } from "./types.js";

// Regenerate the Austin seed fresh from data_input/*.csv on every process start, so it always
// reflects the current fixture CSVs (see austin-seed.ts's header comment for why this can't
// just be a static hand-authored JSON file).
const { skipped } = writeAustinSeedFile(AUSTIN_SEED_PATH);
for (const s of skipped) {
  console.warn(`[austin-seed] left ${s.vin} out of the Austin seed: ${s.reason}`);
}

const seed = loadSeed(AUSTIN_SEED_PATH);
const fleet = new FleetSim({ seedPath: AUSTIN_SEED_PATH, runtimePath: AUSTIN_RUNTIME_FLEET_PATH });

export const austinEngine: ResponseEngine = new DefaultResponseEngine(fleet, new AustinHypothesisSource(), {
  runtimeDir: AUSTIN_RUNTIME_DIR,
  planner: "auto",
  seed,
});

const USERS: User[] = [...seed.users, ...seed.drivers];
const TICK_MS = 2000;

class HttpError extends Error {
  constructor(public status: number, message: string, public gate?: GateResult) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "body must be a JSON object");
}

function str(body: Record<string, unknown>, key: string, optional = false): string {
  const v = body[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (optional && (v === undefined || v === null || v === "")) return "";
  throw new HttpError(400, `missing or invalid "${key}"`);
}

function user(body: Record<string, unknown>): User {
  const id = str(body, "user_id");
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new HttpError(400, `unknown user_id "${id}"`);
  return u;
}

/** Returns true when the request was an Austin response-engine route and has been answered. */
export async function handleAustinResponseRoutes(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (!p.startsWith("/api/response-austin/")) return false;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && p === "/api/response-austin/state") {
      send(res, 200, austinEngine.getState());
      return true;
    }
    if (method !== "POST") throw new HttpError(p === "/api/response-austin/state" ? 405 : 404, `no route ${method} ${p}`);

    const body = await readBody(req);
    switch (p) {
      case "/api/response-austin/ingest":
        send(res, 200, { cases: await austinEngine.ingestFaults() });
        return true;
      case "/api/response-austin/approve": {
        const gate = await austinEngine.approve(str(body, "case_id"), str(body, "step_id"), user(body));
        if (gate.kind === "deny") throw new HttpError(403, gate.reason, gate);
        send(res, 200, gate);
        return true;
      }
      case "/api/response-austin/reject":
        await austinEngine.reject(str(body, "case_id"), str(body, "step_id"), user(body), str(body, "reason", true));
        send(res, 200, { ok: true });
        return true;
      case "/api/response-austin/visit": {
        const outcome = body.outcome as VisitOutcome | undefined;
        if (!outcome || typeof outcome !== "object" || typeof outcome.completed !== "boolean") {
          throw new HttpError(400, `missing or invalid "outcome"`);
        }
        await austinEngine.completeVisit(str(body, "visit_id"), user(body), {
          completed: outcome.completed,
          photos_attached: outcome.photos_attached === true,
          incomplete_reason: outcome.incomplete_reason,
          notes: outcome.notes,
        });
        send(res, 200, { ok: true });
        return true;
      }
      case "/api/response-austin/close":
        await austinEngine.closeCase(str(body, "case_id"), user(body), str(body, "note", true));
        send(res, 200, { ok: true });
        return true;
      case "/api/response-austin/reset":
        await austinEngine.reset();
        send(res, 200, { ok: true });
        return true;
      default:
        throw new HttpError(404, `no route ${method} ${p}`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, err.gate ? { error: err.message, gate: err.gate } : { error: err.message });
    } else {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
}

let started = false;

/** Ingest on startup, then tick every 2 s -- same cadence as Carlos's startResponseEngine(). */
export function startAustinResponseEngine(): void {
  if (started) return;
  started = true;
  austinEngine.ingestFaults().catch((err) => console.error("austin response engine ingest failed:", err));
  setInterval(() => {
    austinEngine.tick().catch((err) => console.error("austin response engine tick failed:", err));
  }, TICK_MS);
}
