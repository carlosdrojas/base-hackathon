// Real per-case detail page, driven by ?case_id=<id>. There is no example or
// mock case here — the only cases that exist are real RcaCase objects from
// Carlos's response engine (src/response/*), created when a fault is planted
// (POST /api/sim/plant → engine.ingestFaults()). This page's rendering logic
// is ported from response-page.ts's renderDetail/renderStep/renderCase, then
// adapted from a client-rendered single-page app into a server-rendered page
// plus a small amount of inline JS for the interactive (approve/reject/close)
// parts. Staff can approve/reject/close; a technician sees the same data
// fully read-only (no approve/reject/close controls rendered at all — the
// underlying /api/response/* actions are staff-only regardless).
import type { Role } from "../session-store.js";
import { engine } from "../response/routes.js";
import type { RcaCase, PlannedStep, User } from "../response/types.js";

const STATUS: Record<string, [string, string]> = {
  Open: ["#EFEDE7", "#4A4944"],
  Investigating: ["#EFEDE7", "#4A4944"],
  "Action pending": ["#FFF3E0", "#9A5B00"],
  "In progress": ["#EAF1FF", "#1E4FBE"],
  "Field visit": ["#EAF1FF", "#1E4FBE"],
  "Engineer review": ["#E7F2EA", "#1D6F3E"],
  "Escalated L0": ["#FDECEC", "#B42318"],
  Closed: ["#F4F3EF", "#8A8880"],
};
const LEVEL: Record<string, [string, string]> = {
  L0: ["#FDECEC", "#B42318"],
  L1: ["#FFF3E0", "#9A5B00"],
  L2: ["#FFF3E0", "#9A5B00"],
  L3: ["#EAF1FF", "#1E4FBE"],
  L4: ["#EFEDE7", "#4A4944"],
};
const STEP: Record<string, [string, string]> = {
  planned: ["#F4F3EF", "#8A8880"],
  awaiting_approval: ["#FFF3E0", "#9A5B00"],
  approved: ["#EAF1FF", "#1E4FBE"],
  running: ["#EAF1FF", "#1E4FBE"],
  done: ["#E7F2EA", "#1D6F3E"],
  failed: ["#FDECEC", "#B42318"],
  denied: ["#FDECEC", "#B42318"],
  rejected: ["#F4F3EF", "#6B6A64"],
  skipped: ["#F4F3EF", "#8A8880"],
};
const REQUIRES: Record<string, string> = {
  none: "auto",
  ops_or_engineer: "ops or engineer",
  engineer: "engineer only",
  ops_and_engineer: "ops + engineer",
};
const ALLOWLIST = ["3.4.0"];

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
function pretty(s: string): string {
  return s.replace(/_/g, " ");
}
function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}
function chip(text: string, c: [string, string] | undefined, extra = ""): string {
  const [bg, color] = c ?? ["#EFEDE7", "#4A4944"];
  return `<span style="display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap;background:${bg};color:${color};${extra}">${esc(text)}</span>`;
}
function actorName(a: PlannedStep["approvals"][number]["user"] | string): string {
  return typeof a === "string" ? a : a.name;
}

// Same gate as response-page.ts's client-side mirror (real fault/hypothesis
// logic from src/response/*), used only to disable buttons with a reason —
// the real enforcement is the server's /api/response/* gate.
function isSafety(c: RcaCase): boolean {
  const dev = engine.getState().fleet.find((d) => d.vin === c.vin);
  return (
    c.hypothesis?.root_cause === "thermal_or_safety_event" ||
    (dev?.active_fault_codes ?? []).some((x) => x.startsWith("INV-F900")) ||
    c.status === "Escalated L0"
  );
}
function gateFor(step: PlannedStep, c: RcaCase, u: User): string | null {
  const remote = step.action === "reboot" || step.action === "ota_to_allowlisted";
  if (remote && isSafety(c)) return "safety (L0) case: no remote actuation";
  if (remote && (!c.hypothesis || c.hypothesis.root_cause === "unknown" || c.hypothesis.confidence < 0.5)) return "hypothesis unknown or confidence < 0.5";
  if (step.action === "ota_to_allowlisted" && !ALLOWLIST.includes(step.params?.target_fw)) return "target fw not on the allow-list";
  if (u.role === "technician") return "technicians complete visits; they don't approve actions";
  if (u.role === "admin") return "admin doesn't bypass safety";
  if (step.requires === "engineer" && u.role !== "engineer") return "engineer only: OTA needs an engineer's approval";
  if (step.requires === "ops_and_engineer") {
    if (step.approvals.some((a) => a.user.id === u.id)) return "you already approved; needs a second, distinct user";
    if (step.approvals.some((a) => a.user.role === u.role)) return `already approved by ${u.role}; needs the other role`;
  }
  return null;
}
function closeBlock(c: RcaCase, u: User): string | null {
  if (u.role !== "engineer") return "only an engineer can close a case";
  if (c.status === "Engineer review") return null;
  if (c.status === "Escalated L0" && (c.outcome === "l0_made_safe" || c.outcome === "pulled_justified")) return null;
  return `case is ${c.status}`;
}

function renderStep(s: PlannedStep, i: number, c: RcaCase, u: User, readOnly: boolean): string {
  let actions = "";
  if (!readOnly && s.state === "awaiting_approval" && c.status !== "Closed") {
    const why = gateFor(s, c, u);
    const dis = why ? ` disabled title="${esc(why)}"` : "";
    actions = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
      <button class="btn btnPrimary" data-act="approve" data-step="${esc(s.step_id)}"${dis}>Approve</button>
      <button class="btn btnGhost" data-act="rejectOpen" data-step="${esc(s.step_id)}"${dis}>Reject</button>
      ${why ? `<span style="font-size:12px;color:#9A5B00;">&#9888; ${esc(why)}</span>` : ""}
    </div>
    <div id="rejectRow-${esc(s.step_id)}" hidden style="display:flex;gap:6px;margin-top:6px;">
      <input class="input" id="rejectInput-${esc(s.step_id)}" placeholder="Reason (required)" style="flex:1;">
      <button class="btn btnDanger" data-act="reject" data-step="${esc(s.step_id)}">Confirm reject</button>
      <button class="btn btnGhost" data-act="rejectCancel" data-step="${esc(s.step_id)}">Cancel</button>
    </div>`;
  }
  const approvals = s.approvals.length ? `<span style="font-size:12px;color:#6B6A64;"> &middot; approved by ${s.approvals.map((a) => esc(actorName(a.user))).join(", ")}</span>` : "";
  const result = s.result ? `<div style="font-size:12px;color:#4A4944;margin-top:3px;"><span class="mono">${esc(s.result.outcome)}</span> &middot; ${esc(s.result.detail)}</div>` : "";
  const params = s.params?.target_fw ? ` <span class="mono" style="font-size:12px;color:#6B6A64;">&rarr; ${esc(s.params.target_fw)}</span>` : "";
  return `<div class="step">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span class="mono" style="color:#8A8880;font-size:12px;width:16px;">${i + 1}</span>
      <span class="mono" style="font-size:14px;font-weight:500;">${esc(s.action)}</span>${params}
      ${chip(s.level, LEVEL[s.level], "font-size:11px;")}
      <span style="font-size:12px;color:#6B6A64;">${esc(REQUIRES[s.requires] ?? s.requires)}</span>
      <span style="flex:1;"></span>
      ${chip(pretty(s.state), STEP[s.state], "font-size:11px;")}
    </div>
    <div style="font-size:12px;color:#8A8880;margin:2px 0 0 24px;">${esc(s.rationale)}${approvals}</div>
    <div style="margin-left:24px;">${result}${actions}</div>
  </div>`;
}

function levelChips(gp: RcaCase["gameplan"]): string {
  if (!gp) return "";
  if (gp.level === "L0") return chip("L0", LEVEL.L0);
  const live = ["running", "awaiting_approval", "approved", "planned"];
  const cur = gp.steps.find((s) => live.includes(s.state)) ?? [...gp.steps].reverse().find((s) => s.state === "done" || s.state === "failed");
  const lvl = cur ? cur.level : gp.level;
  const tail = lvl !== gp.level ? `<span style="color:#8A8880;font-size:12px;">up to ${esc(gp.level)}</span>` : "";
  return `${chip("now " + lvl, LEVEL[lvl])}${tail}`;
}

function renderNotFound(fleetHref: string): string {
  return `<div style="padding: 40px; font-size: 16px; color: #6B6A64;">
    <a href="${fleetHref}" style="font-size: 15px; color: #6B6A64; text-decoration: none;">&larr; Open cases</a>
    <div style="margin-top: 16px; font-size: 20px; font-weight: 600; color: #292826;">Case not found</div>
    <div style="margin-top: 6px;">No case matches this id. Cases only exist once a fault is planted on a unit &mdash; see the Response agent page.</div>
  </div>`;
}

export function renderCaseWorkspacePage(caseId: string | undefined, role: Role): string {
  const fleetHref = role === "staff" ? "/fleet" : "/technician";
  const c = caseId ? engine.getState().cases.find((x) => x.case_id === caseId) : undefined;

  if (!c) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Case not found — ARCA</title>
${HEAD}
</head>
<body>
<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">
  ${header(role, undefined)}
  ${renderNotFound(fleetHref)}
</div>
</body>
</html>`;
  }

  // Fixed to the engineer for staff, matching response-page.ts's own choice
  // (the account has the most authority: OTA approval and closing cases).
  // A technician viewing this page never sends any action, so their "user"
  // is only used to compute (and hide behind) gateFor()/closeBlock() text.
  const seedUsers = engine.getState().users;
  const actingUser: User = role === "staff" ? seedUsers.find((u) => u.id === "u-park") ?? seedUsers[0] : seedUsers.find((u) => u.role === "technician") ?? seedUsers[0];
  const readOnly = role !== "staff";

  const gp = c.gameplan;
  const h = c.hypothesis;
  const block = closeBlock(c, actingUser);
  const closeUi =
    !readOnly && c.status !== "Closed"
      ? `<div style="border-top:1px solid #F0EEE9;padding-top:14px;margin-top:14px;">
          <div style="display:flex;gap:6px;">
            <input id="closeNote" class="input" placeholder="Close note" style="flex:1;"${block ? " disabled" : ""}>
            <button class="btn btnPrimary" data-act="close"${block ? ` disabled title="${esc(block)}"` : ""}>Close case</button>
          </div>
          ${block ? `<div style="font-size:12px;color:#8A8880;margin-top:4px;">${esc(block)}</div>` : ""}
        </div>`
      : "";

  const events = [...c.timeline].reverse().map(
    (e) => `<div class="event">
      <span class="mono" style="font-size:11px;color:#8A8880;width:62px;flex-shrink:0;">${time(e.ts)}</span>
      <div style="min-width:0;">
        <div style="font-size:13px;color:#292826;">${esc(e.summary)}</div>
        <div style="font-size:11px;color:#8A8880;"><span class="mono">${esc(e.kind)}</span> &middot; ${esc(actorName(e.actor))}</div>
      </div>
    </div>`
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(c.case_id)} — ARCA</title>
${HEAD}
</head>
<body>

<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">
  ${header(role, c)}

  <div style="padding: 28px 40px 80px; max-width: 900px;">

    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${gp ? levelChips(gp) : ""}
        ${chip(c.status, STATUS[c.status])}
        ${c.outcome ? chip(pretty(c.outcome), ["#E7F2EA", "#1D6F3E"]) : ""}
      </div>
      ${h
        ? `<div style="font-size:15px;margin-top:10px;">
            <span class="mono" style="font-weight:600;font-size:18px;">${esc(h.root_cause)}</span>
            <span style="color:#6B6A64;"> &middot; ${Math.round(h.confidence * 100)}% confidence &middot; ${esc(h.source)} &middot; fw ${esc(h.fw_version)}</span>
          </div>
          <div style="font-size:13px;color:#8A8880;margin-top:6px;">Evidence: ${h.evidence.map(esc).join(" &middot; ")}</div>`
        : `<div style="font-size:15px;color:#6B6A64;margin-top:10px;">No hypothesis yet &mdash; the engine hasn't diagnosed this case.</div>`}
      ${gp ? `<div style="font-size:13px;color:#6B6A64;margin-top:10px;">${esc(gp.summary)} <span style="color:#8A8880;">&middot; plan: ${esc(gp.source)}</span></div>` : ""}
    </div>

    ${gp
      ? `<div style="margin-bottom: 24px;">
          <div style="font-size: 18px; font-weight: 600; margin-bottom: 10px;">Gameplan</div>
          <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 8px 20px;">
            ${gp.steps.map((s, i) => renderStep(s, i, c, actingUser, readOnly)).join("")}
          </div>
        </div>`
      : ""}

    <div style="margin-bottom: 24px;">
      <div style="font-size: 18px; font-weight: 600; margin-bottom: 10px;">Timeline</div>
      <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 10px 20px; max-height: 420px; overflow-y: auto;">
        ${events}
      </div>
    </div>

    ${readOnly
      ? ""
      : `<div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
          <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Close case</div>
          ${closeUi}
        </div>`}

  </div>
</div>

<script>
(function () {
  var caseId = ${JSON.stringify(c.case_id)};
  var userId = ${JSON.stringify(actingUser.id)};
  var busy = false;

  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { if (!r.ok) throw new Error(data.error || ("HTTP " + r.status)); return data; }); });
  }
  function act(path, body) {
    if (busy) return;
    busy = true;
    api(path, body)
      .catch(function (e) { alert(e.message); })
      .then(function () { busy = false; location.reload(); });
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-act]");
    if (!el) return;
    var d = el.dataset;
    if (d.act === "approve") {
      act("/api/response/approve", { case_id: caseId, step_id: d.step, user_id: userId });
    } else if (d.act === "rejectOpen") {
      document.getElementById("rejectRow-" + d.step).hidden = false;
    } else if (d.act === "rejectCancel") {
      document.getElementById("rejectRow-" + d.step).hidden = true;
    } else if (d.act === "reject") {
      var input = document.getElementById("rejectInput-" + d.step);
      var reason = input ? input.value.trim() : "";
      if (!reason) { alert("Give a reason to reject"); return; }
      act("/api/response/reject", { case_id: caseId, step_id: d.step, user_id: userId, reason: reason });
    } else if (d.act === "close") {
      var note = document.getElementById("closeNote");
      act("/api/response/close", { case_id: caseId, user_id: userId, note: note ? note.value : "" });
    }
  });
})();
</script>
</body>
</html>`;
}

const HEAD = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;500&display=swap">
<style>
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; }
  a { color: #1E4D2B; }
  a:hover { color: #163A20; }
  .mono { font-family: 'Space Mono', monospace; }
  .btn { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 6px; padding: 6px 14px; cursor: pointer; border: 1px solid transparent; }
  .btn:disabled { cursor: not-allowed; opacity: 0.45; }
  .btnPrimary { background: #1E4D2B; color: #FFFFFF; border-color: #1E4D2B; }
  .btnPrimary:hover:not(:disabled) { background: #163A20; }
  .btnGhost { background: #FFFFFF; color: #4A4944; border-color: #D8D5CC; }
  .btnGhost:hover:not(:disabled) { background: #FAFAF8; }
  .btnDanger { background: #B42318; color: #FFFFFF; border-color: #B42318; }
  .input { font-family: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid #D8D5CC; border-radius: 6px; background: #FFFFFF; color: #292826; }
  .step { padding: 10px 0; border-bottom: 1px solid #F0EEE9; }
  .step:last-child { border-bottom: 0; }
  .event { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #F4F3EF; }
  .event:last-child { border-bottom: 0; }
</style>`;

function header(role: Role, c: RcaCase | undefined): string {
  const fleetHref = role === "staff" ? "/fleet" : "/technician";
  const roleLabel = role === "staff" ? "Staff" : "Technician";
  const nav =
    role === "staff"
      ? `<nav style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 10px; background: #EFEDE7; padding: 5px; border-radius: 8px;" aria-label="Dashboard">
          <a href="/fleet" style="font-size: 17px; font-weight: 600; text-decoration: none; padding: 9px 22px; border-radius: 6px; background: transparent; color: #6B6A64;">Fleet</a>
          <a href="/case" style="font-size: 17px; font-weight: 600; text-decoration: none; padding: 9px 22px; border-radius: 6px; background: #1E4D2B; color: #FFFFFF;">Case</a>
          <a href="/response" style="font-size: 17px; font-weight: 600; text-decoration: none; padding: 9px 22px; border-radius: 6px; background: transparent; color: #6B6A64;">Response</a>
        </nav>`
      : "";
  return `<div style="position: sticky; top: 0; z-index: 10; background: #F0EEEB; padding: 20px 40px 0;">
    <div style="position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
        <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
        <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">ARCA</span>
      </div>
      ${nav}
      <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">${roleLabel}</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
    </div>
    <a href="${fleetHref}" style="font-size: 15px; color: #6B6A64; text-decoration: none;">&larr; Open cases</a>
    <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 6px; padding-bottom: 20px;">
      <span class="mono" style="font-size: 24px; font-weight: 600; color: #292826;">${c ? esc(c.case_id) : "Case"}</span>
      ${c ? `<span style="font-size: 17px; color: #6B6A64;">${esc(c.vin)} &middot; ${esc(c.site)}</span>` : ""}
    </div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>`;
}
