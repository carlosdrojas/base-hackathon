// Back-compat alias. There used to be a second engine instance for Austin; there is now ONE
// engine for the whole app (routes.ts), and Austin is a view filter in the pages. Old
// /api/response-austin/* URLs and "austin:"-prefixed case ids keep working through this file.
import type http from "node:http";
import { engine, handleResponseRoutes } from "./routes.js";
import type { ResponseEngine } from "./types.js";

/** Same object as routes.ts's `engine`. */
export const austinEngine: ResponseEngine = engine;

export async function handleAustinResponseRoutes(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (!req.url?.startsWith("/api/response-austin/")) return false;
  req.url = req.url.replace("/api/response-austin/", "/api/response/");
  return handleResponseRoutes(req, res);
}

/** No-op: routes.ts's startResponseEngine() ticks the one engine. */
export function startAustinResponseEngine(): void {}
