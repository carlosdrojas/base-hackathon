// Minimal in-memory auth + shared case-decision state for the Field RCA demo.
// Two hardcoded accounts, no database, no password hashing — intentional scope
// for a hackathon demo. Sessions and decisions are lost on server restart.
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { CaseStatus } from "./field-rca/index.js";
export type { CaseStatus };

export type Role = "staff" | "technician";
export type Decision = "pending" | "approved" | "rejected";

const ACCOUNTS: Record<string, { password: string; role: Role }> = {
  staff: { password: "basehq2026", role: "staff" },
  tech: { password: "basehq2026", role: "technician" },
};

const sessions = new Map<string, Role>();

// Shared across staff and technician views: an engineer's decision on /case
// made via /api/case/1234/decision must be visible to the technician on
// /technician/case without any shared browser session.
export const caseDecisions = new Map<string, Decision>([["1234", "pending"]]);

// Engineer sign-off that a case is fully closed — a separate, later step from
// the approve/reject decision above. Only meaningful once a decision exists.
export const caseClosed = new Map<string, boolean>([["1234", false]]);

export function checkLogin(username: string, password: string): Role | null {
  const account = ACCOUNTS[username];
  if (account && account.password === password) return account.role;
  return null;
}

export function createSession(role: Role): string {
  const token = crypto.randomBytes(16).toString("hex");
  sessions.set(token, role);
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

export function getSessionToken(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)["session"] ?? null;
}

export function getRole(req: IncomingMessage): Role | null {
  const token = getSessionToken(req);
  if (!token) return null;
  return sessions.get(token) ?? null;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function homeFor(role: Role): string {
  return role === "staff" ? "/fleet" : "/technician";
}

// Real case-lifecycle status (src/field-rca/contracts.ts's CaseStatus, the
// frozen closed set tied to the design doc) derived from the two booleans we
// actually track. One place computing this so /case, /fleet, and /technician
// can't drift into showing three different statuses for the same case.
export function deriveCaseStatus(decision: Decision, closed: boolean): CaseStatus {
  if (closed) return "Closed";
  if (decision === "approved") return "Action in progress";
  if (decision === "rejected") return "Awaiting engineer review";
  return "Action pending approval";
}
