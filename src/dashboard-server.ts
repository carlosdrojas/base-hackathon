import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URLSearchParams } from "node:url";
import { renderCaseWorkspacePage } from "./pages/case-workspace.js";
import { renderFleetDashboardPage, renderTechnicianAppointmentsPage } from "./pages/fleet-dashboard.js";
import { renderTechnicianDashboard } from "./pages/technician-dashboard.js";
import { renderLoginPage } from "./pages/login.js";
import { checkLogin, createSession, destroySession, getRole, getSessionToken, readBody, homeFor } from "./session-store.js";
import { createFieldRcaWorkspace } from "./field-rca/index.js";
import { RESPONSE_PAGE } from "./pages/response-page.js";
import { handleResponseRoutes, startResponseEngine } from "./response/routes.js";

/** Field RCA auto-triage seam. Not the Issue Router mock fleet below. */
const fieldRca = createFieldRcaWorkspace();

const LOGO_PATH = path.join(process.cwd(), "public", "base_logo.png");
const logoBuffer = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const [pathname] = url.split("?");

  if (pathname === "/api/field-rca") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fieldRca.describe()));
    return;
  }

  if (pathname === "/base_logo.png") {
    if (logoBuffer) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(logoBuffer);
    } else {
      res.writeHead(404);
      res.end("logo not found");
    }
    return;
  }

  // --- Auth routes (unprotected) ---
  if (pathname === "/login" && req.method === "GET") {
    const error = url.includes("error=1");
    html(res, renderLoginPage(error));
    return;
  }

  if (pathname === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const role = checkLogin(params.get("username") ?? "", params.get("password") ?? "");
    if (!role) {
      redirect(res, "/login?error=1");
      return;
    }
    const token = createSession(role);
    res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/`);
    redirect(res, homeFor(role));
    return;
  }

  if (pathname === "/logout") {
    const token = getSessionToken(req);
    if (token) destroySession(token);
    res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
    redirect(res, "/login");
    return;
  }

  // --- Everything below requires a session ---
  const role = getRole(req);
  if (!role) {
    redirect(res, "/login");
    return;
  }

  // --- Response agent: staff can reach everything; a technician may only read state and
  // complete/mark-incomplete their own visit (no approve/reject/close, no plant/reset) ---
  if (pathname.startsWith("/api/response/") || pathname.startsWith("/api/sim/")) {
    const technicianAllowed =
      (pathname === "/api/response/state" && req.method === "GET") ||
      (pathname === "/api/response/visit" && req.method === "POST");
    if (role !== "staff" && !(role === "technician" && technicianAllowed)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: role === "technician" ? "technician: read state or complete a visit only" : "staff only" }));
      return;
    }
    if (await handleResponseRoutes(req, res)) return;
  }
  if (pathname === "/response") {
    if (role !== "staff") {
      redirect(res, homeFor(role));
      return;
    }
    html(res, RESPONSE_PAGE);
    return;
  }

  // --- Case detail: reachable by both roles (staff can act via /api/response/*
  // above, which stays staff-only; a technician sees the same real case
  // read-only). No example/mock case ever renders here — case_id must match
  // a real RcaCase from Carlos's engine, or the page says "Case not found". ---
  if (pathname === "/case") {
    const query = new URLSearchParams(url.split("?")[1] ?? "");
    html(res, renderCaseWorkspacePage(query.get("case_id") ?? undefined, role));
    return;
  }

  // --- Staff-only pages ---
  if (pathname === "/" || pathname === "/fleet" || pathname === "/fleet/technician") {
    if (role !== "staff") {
      redirect(res, homeFor(role));
      return;
    }
    if (pathname === "/") {
      redirect(res, "/fleet");
      return;
    }
    const query = new URLSearchParams(url.split("?")[1] ?? "");
    if (pathname === "/fleet/technician") {
      html(res, renderTechnicianAppointmentsPage(query.get("name") ?? ""));
      return;
    }
    html(res, renderFleetDashboardPage(query.get("region") ?? "ALL"));
    return;
  }

  // --- Technician-only pages ---
  if (pathname === "/technician") {
    if (role !== "technician") {
      redirect(res, homeFor(role));
      return;
    }
    html(res, renderTechnicianDashboard());
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  startResponseEngine();
  console.log(`Fleet RCA dashboard running at http://localhost:${PORT}`);
});
