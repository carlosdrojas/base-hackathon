// Read-only technician counterpart to case-workspace.ts / fleet-dashboard.ts.
// Per docs/field-rca/software-features.md: a technician sees the job they
// were sent on, a simple "what we think is wrong," and cannot approve/reject
// or close a case — direction comes from an engineer's decision on /case.
import { allCases, sevColors, type CaseRow } from "./fleet-dashboard.js";
import { renderCaseThread } from "./case-workspace.js";
import { deriveCaseStatus, type Decision } from "../session-store.js";

const HEAD = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;500&display=swap">
<style>
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; }
  a { color: #1E4D2B; }
  a:hover { color: #163A20; }
  .mono { font-family: 'Space Mono', monospace; }
  .caseRow:hover { background: #FAFAF8; }
</style>`;

function header(subtitle: string): string {
  return `<div style="position: sticky; top: 0; z-index: 10; background: #F0EEEB; padding: 20px 40px 0;">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
        <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
        <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">Field RCA</span>
      </div>
      <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">Technician</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
    </div>
    <div style="font-size: 24px; font-weight: 600; color: #292826;">Technician Dashboard</div>
    <div style="font-size: 15px; color: #6B6A64; margin-top: 2px; padding-bottom: 20px;">${subtitle}</div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>`;
}

function renderTechCaseRow(c: CaseRow): string {
  const sc = sevColors[c.sev];
  return `<div class="caseRow" onclick="window.location.href='/technician/case'" style="display:grid;grid-template-columns:70px 100px 1fr 60px 220px 160px 60px;gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;cursor:pointer;">
    <span class="mono">${c.id}</span>
    <span class="mono">${c.asset}</span>
    <span>${c.site}</span>
    <span style="background:${sc.bg};color:${sc.color};font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;width:fit-content;">${c.sev}</span>
    <span class="mono" style="font-size:14px;color:#4A4944;">${c.rootCause}</span>
    <span style="color:#4A4944;">${c.status}</span>
    <span style="color:#8A8880;">${c.age}</span>
  </div>`;
}

export function renderTechnicianDashboard(decision: Decision, caseClosed: boolean): string {
  const cases = allCases.map((c) => (c.id === "#1234" ? { ...c, status: deriveCaseStatus(decision, caseClosed) } : c));
  const openCases = cases.filter((c) => c.status !== "Closed");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Technician Dashboard — Field RCA</title>
${HEAD}
</head>
<body>
<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">
  ${header("Open jobs assigned across the fleet — read-only. Click a job to see its case.")}
  <div style="padding: 32px 40px 80px;">
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Open cases</div>
      <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
        <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
      </div>
      <div>${openCases.map(renderTechCaseRow).join("")}</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

export function renderTechnicianCasePage(decision: Decision, closed: boolean): string {
  const isApproved = decision === "approved";
  const isRejected = decision === "rejected";

  const direction = !isApproved && !isRejected
    ? { bg: "#FFF3E0", color: "#9A5B00", text: "Awaiting engineer approval &mdash; no action authorized yet." }
    : isApproved
    ? { bg: "#EAF3EA", color: "#1E4D2B", text: "Approved: <strong>reboot_firmware</strong> &mdash; proceed with this action." }
    : { bg: "#FDECEC", color: "#B42318", text: "Rejected &mdash; escalated to engineer, do not proceed." };

  if (closed) {
    direction.text += " This case is now closed.";
  }

  const caseStatusLabel = deriveCaseStatus(decision, closed);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Case #1234 — Technician</title>
${HEAD}
</head>
<body>
<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">
  ${header("Read-only case view. Approve/reject is engineer-only.")}
  <div style="padding: 28px 40px 80px; max-width: 1200px;">

    <div style="margin-bottom: 24px;">
      <a href="/technician" style="font-size: 15px; color: #6B6A64; text-decoration: none;">&larr; Open jobs</a>
      <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 10px;">
        <span class="mono" style="font-size: 22px; font-weight: 600;">Case #1234</span>
        <span style="font-size: 16px; color: #6B6A64;">INV-4021 &middot; 118 Maple Ct, Round Rock TX</span>
      </div>
      <div style="margin-top: 6px; font-size: 15px;"><span style="background: #FFF3E0; color: #9A5B00; font-size: 13px; font-weight: 600; padding: 2px 8px; border-radius: 4px;">L2</span> <span style="color: #6B6A64;">${caseStatusLabel}</span></div>
    </div>

    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 10px;">Why you're here</div>
      <div class="mono" style="font-size: 20px; font-weight: 600;">can_link_unreliable</div>
      <div style="font-size: 15px; color: #333230; line-height: 1.6; margin-top: 6px;">81% confidence &mdash; connector J3 suspected not fully mated. Second bus-off cluster on this site this month; last visit here was left incomplete for lack of a second technician.</div>
    </div>

    <div style="background: ${direction.bg}; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 6px;">Direction</div>
      <div style="font-size: 16px; font-weight: 600; color: ${direction.color};">${direction.text}</div>
    </div>

    <div style="font-size: 20px; font-weight: 600; margin-bottom: 14px;">Timeline &amp; Notes</div>
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
      ${renderCaseThread()}
    </div>

  </div>
</div>
</body>
</html>`;
}
