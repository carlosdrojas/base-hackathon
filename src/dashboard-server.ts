import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URLSearchParams } from "node:url";
import { renderCaseWorkspacePage } from "./pages/case-workspace.js";
import { renderFleetDashboardPage, renderTechnicianAppointmentsPage } from "./pages/fleet-dashboard.js";
import { renderTechnicianDashboard, renderTechnicianCasePage } from "./pages/technician-dashboard.js";
import { renderLoginPage } from "./pages/login.js";
import {
  checkLogin,
  createSession,
  destroySession,
  getRole,
  getSessionToken,
  readBody,
  homeFor,
  caseDecisions,
  caseClosed,
  type Decision,
} from "./session-store.js";

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

  // --- Shared decision API (staff only) ---
  if (pathname === "/api/case/1234/decision" && req.method === "POST") {
    if (role !== "staff") {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const decision = params.get("decision");
    if (decision === "approved" || decision === "rejected" || decision === "pending") {
      caseDecisions.set("1234", decision as Decision);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/case/1234/close" && req.method === "POST") {
    if (role !== "staff") {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (caseDecisions.get("1234") === "pending") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "case has no decision yet" }));
      return;
    }
    caseClosed.set("1234", true);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Staff-only pages ---
  if (pathname === "/" || pathname === "/case" || pathname === "/fleet" || pathname === "/fleet/technician") {
    if (role !== "staff") {
      redirect(res, homeFor(role));
      return;
    }
    if (pathname === "/") {
      redirect(res, "/fleet");
      return;
    }
    if (pathname === "/case") {
      html(res, renderCaseWorkspacePage(caseDecisions.get("1234") ?? "pending", caseClosed.get("1234") ?? false));
      return;
    }
    if (pathname === "/fleet/technician") {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      html(res, renderTechnicianAppointmentsPage(query.get("name") ?? "", caseClosed.get("1234") ?? false));
      return;
    }
    html(res, renderFleetDashboardPage(caseClosed.get("1234") ?? false));
    return;
  }

  // --- Technician-only pages ---
  if (pathname === "/technician" || pathname === "/technician/case") {
    if (role !== "technician") {
      redirect(res, homeFor(role));
      return;
    }
    if (pathname === "/technician") {
      html(res, renderTechnicianDashboard(caseClosed.get("1234") ?? false));
      return;
    }
    html(res, renderTechnicianCasePage(caseDecisions.get("1234") ?? "pending", caseClosed.get("1234") ?? false));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Fleet RCA dashboard running at http://localhost:${PORT}`);
});
