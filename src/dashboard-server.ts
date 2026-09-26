import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { CASE_WORKSPACE_PAGE } from "./pages/case-workspace.js";
import { FLEET_DASHBOARD_PAGE } from "./pages/fleet-dashboard.js";

const LOGO_PATH = path.join(process.cwd(), "public", "base_logo.png");
const logoBuffer = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);

const server = http.createServer((req, res) => {
  if (req.url === "/base_logo.png") {
    if (logoBuffer) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(logoBuffer);
    } else {
      res.writeHead(404);
      res.end("logo not found");
    }
    return;
  }
  if (req.url === "/case") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(CASE_WORKSPACE_PAGE);
    return;
  }
  if (req.url === "/fleet") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(FLEET_DASHBOARD_PAGE);
    return;
  }
  if (req.url === "/") {
    res.writeHead(302, { Location: "/fleet" });
    res.end();
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Fleet RCA dashboard running at http://localhost:${PORT}`);
});
