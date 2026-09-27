// Minimal in-memory auth for the Field RCA demo. Two hardcoded accounts, no
// database, no password hashing — intentional scope for a hackathon demo.
// Sessions are lost on server restart. All case data lives in Carlos's real
// response engine (src/response/*) — this file no longer tracks any mock
// case/appointment/visit state of its own.
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export type Role = "staff" | "technician";

// Username signals which region a staff account belongs to (only Austin exists today, but the
// naming leaves room for other regions' staff to log into their own scope later) — role stays
// the generic "staff" internally, this is just the login identity.
const ACCOUNTS: Record<string, { password: string; role: Role }> = {
  staffAustin: { password: "basehq2026", role: "staff" },
  tech: { password: "basehq2026", role: "technician" },
};

const sessions = new Map<string, Role>();

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
