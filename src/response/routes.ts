// HTTP routes for the Response Agent (design doc §11). Mounted by dashboard-server.ts.
// Two fleets: "core" = the team's Base Core telemetry pack (data_input/, diagnosed by the
// Task 1 detectors) and "demo" = the hand-built 12-unit fleet (data/sim-fleet.seed.json, stub
// diagnosis). Pick the startup fleet with RESPONSE_FLEET=core|demo; switch live via /reset.

import "dotenv/config"; // ANTHROPIC_API_KEY switches the planner to Claude
import type http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_INPUT_DIR, loadCorePack } from "../sim/core-pack.js";
import { FleetSim } from "../sim/fleet-sim.js";
import { DetectorHypothesisSource } from "./detector-hypothesis.js";
import { DefaultResponseEngine } from "./engine.js";
import { StubHypothesisSource } from "./hypothesis-source.js";
import { loadSeed, type FleetSeed } from "./seed.js";
import type { FleetSource, GateResult, PlantableFault, ResponseEngine, User, VisitOutcome } from "./types.js";

const seed = loadSeed();
const RUNTIME = fileURLToPath(new URL("../../data/runtime", import.meta.url));

function build(source: FleetSource): ResponseEngine {
  if (source === "demo") {
    const fleet = new FleetSim({ runtimePath: join(RUNTIME, "demo", "sim-fleet.json") });
    return new DefaultResponseEngine(fleet, new StubHypothesisSource(fleet, seed.misdiagnose), {
      runtimeDir: join(RUNTIME, "demo"),
      planner: "auto",
      seed,
      fleetSource: "demo",
    });
  }
  const { units: _units, ...base } = seed;
  const pack = loadCorePack(base);
  const fleet = new FleetSim({ seed: pack.seed, runtimePath: join(RUNTIME, "core", "sim-fleet.json") });
  const manifest = JSON.parse(readFileSync(join(DATA_INPUT_DIR, "fw_allowlist.json"), "utf8"));
  const diagnosis = new DetectorHypothesisSource(pack.packets, pack.events, manifest, new StubHypothesisSource(fleet, {}), fleet);
  return new DefaultResponseEngine(fleet, diagnosis, {
    runtimeDir: join(RUNTIME, "core"),
    planner: "auto",
    seed: pack.seed as FleetSeed,
    fleetSource: "core",
  });
}

// Default "demo": /fleet, /case and /technician treat /api/response/* as the demo fleet and read the
// Core pack through the separate Austin engine (austin-routes.ts). The Core pack + answer-key
// scorecard stay one dropdown away on /response, or start with RESPONSE_FLEET=core.
let source: FleetSource = process.env.RESPONSE_FLEET === "core" ? "core" : "demo";
/** The active engine. Reassigned when the UI switches fleets. */
export let engine: ResponseEngine = build(source);

const USERS: User[] = [...seed.users, ...seed.drivers];
const TICK_MS = 2000;
const PLANTABLE: PlantableFault[] = [
  "fw_version_mismatch",
  "fw_soft_fault_reboot_candidate",
  "can_link_unreliable",
  "install_commissioning_incomplete",
  "install_wiring_or_sense_error",
  "grid_or_home_side_condition",
  "thermal_or_safety_event",
  "true_hardware_defect",
  "no_fault_found",
];

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

/** Returns true when the request was a response/sim API route and has been answered. */
export async function handleResponseRoutes(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (!p.startsWith("/api/response/") && !p.startsWith("/api/sim/")) return false;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && p === "/api/response/state") {
      send(res, 200, engine.getState());
      return true;
    }
    if (method !== "POST") throw new HttpError(p === "/api/response/state" ? 405 : 404, `no route ${method} ${p}`);

    const body = await readBody(req);
    switch (p) {
      case "/api/response/ingest":
        send(res, 200, { cases: await engine.ingestFaults() });
        return true;
      case "/api/response/approve": {
        const gate = await engine.approve(str(body, "case_id"), str(body, "step_id"), user(body));
        if (gate.kind === "deny") throw new HttpError(403, gate.reason, gate);
        send(res, 200, gate);
        return true;
      }
      case "/api/response/reject":
        await engine.reject(str(body, "case_id"), str(body, "step_id"), user(body), str(body, "reason", true));
        send(res, 200, { ok: true });
        return true;
      case "/api/response/visit": {
        const outcome = body.outcome as VisitOutcome | undefined;
        if (!outcome || typeof outcome !== "object" || typeof outcome.completed !== "boolean") {
          throw new HttpError(400, `missing or invalid "outcome"`);
        }
        await engine.completeVisit(str(body, "visit_id"), user(body), {
          completed: outcome.completed,
          photos_attached: outcome.photos_attached === true,
          incomplete_reason: outcome.incomplete_reason,
          notes: outcome.notes,
        });
        send(res, 200, { ok: true });
        return true;
      }
      case "/api/response/close":
        await engine.closeCase(str(body, "case_id"), user(body), str(body, "note", true));
        send(res, 200, { ok: true });
        return true;
      case "/api/sim/plant": {
        const fault = str(body, "fault") as PlantableFault;
        if (!PLANTABLE.includes(fault)) throw new HttpError(400, `unknown fault "${fault}"`);
        await engine.plantFault(str(body, "vin"), fault);
        send(res, 200, { cases: await engine.ingestFaults() });
        return true;
      }
      case "/api/response/reset": {
        const want = str(body, "fleet", true);
        if (want && want !== "core" && want !== "demo") throw new HttpError(400, `unknown fleet "${want}"`);
        if (want && want !== source) {
          source = want as FleetSource;
          engine = build(source);
        }
        await engine.reset();
        await engine.ingestFaults();
        send(res, 200, { ok: true });
        return true;
      }
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

/** Ingest on startup, then tick every 2 s (design doc §11). */
export function startResponseEngine(): void {
  if (started) return;
  started = true;
  engine.ingestFaults().catch((err) => console.error("response engine ingest failed:", err));
  setInterval(() => {
    engine.tick().catch((err) => console.error("response engine tick failed:", err));
  }, TICK_MS);
}
