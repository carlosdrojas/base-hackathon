// Read-only technician counterpart to case-workspace.ts / fleet-dashboard.ts.
// A technician sees the real open cases across the fleet and their own
// assigned Visits — no example/mock case data, no approve/reject/close.
import { engine } from "../response/routes.js";
import { pickTechnician } from "../response/scheduler.js";
import { loadSeed, type FleetSeed } from "../response/seed.js";
import type { RcaCase } from "../response/types.js";

interface CaseRow {
  id: string;
  asset: string;
  site: string;
  sev: "L0" | "L1" | "L2" | "L3" | "L4";
  rootCause: string;
  status: string;
  age: string;
}

const sevColors: Record<CaseRow["sev"], { bg: string; color: string }> = {
  L0: { bg: "#FDECEC", color: "#B42318" },
  L1: { bg: "#FFF3E0", color: "#9A5B00" },
  L2: { bg: "#FFF3E0", color: "#9A5B00" },
  L3: { bg: "#EAF3E7", color: "#1E4D2B" },
  L4: { bg: "#EAF3E7", color: "#1E4D2B" },
};

function relativeAge(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

let liveSeed: FleetSeed | null = null;

function deriveRow(c: RcaCase): CaseRow {
  liveSeed ??= loadSeed();
  const rootCause = c.hypothesis?.root_cause ?? "unknown";
  const sev: CaseRow["sev"] = c.status === "Escalated L0" ? "L0" : c.gameplan?.level ?? "L1";
  return {
    id: c.case_id,
    asset: c.vin,
    site: c.site,
    sev,
    rootCause,
    status: c.status,
    age: relativeAge(c.opened_at),
  };
}

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
        <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">ARCA</span>
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
  return `<div class="caseRow" onclick="window.location.href='/case?case_id=${encodeURIComponent(c.id)}'" style="display:grid;grid-template-columns:70px 100px 1fr 60px 220px 160px 60px;gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;cursor:pointer;">
    <span class="mono">${c.id}</span>
    <span class="mono">${c.asset}</span>
    <span>${c.site}</span>
    <span style="background:${sc.bg};color:${sc.color};font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;width:fit-content;">${c.sev}</span>
    <span class="mono" style="font-size:14px;color:#4A4944;">${c.rootCause}</span>
    <span style="color:#4A4944;">${c.status}</span>
    <span style="color:#8A8880;">${c.age}</span>
  </div>`;
}

export function renderTechnicianDashboard(): string {
  const openCases = engine
    .getState()
    .cases.map(deriveRow)
    .filter((c) => c.status !== "Closed");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Technician Dashboard — ARCA</title>
${HEAD}
</head>
<body>
<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">
  ${header("Open cases across the fleet, read-only — click a case to see its details. Your assigned visits are below.")}
  <div style="padding: 32px 40px 80px;">
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Open cases</div>
      <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
        <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
      </div>
      <div>${openCases.length ? openCases.map(renderTechCaseRow).join("") : `<div style="padding: 16px 6px; color: #8A8880;">No open cases yet.</div>`}</div>
    </div>
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px; margin-top: 24px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Visits &mdash; appointments assigned to you<span class="mocked" style="margin-left: 8px; background: #292826; color: #FFFFFF; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; padding: 2px 7px; border-radius: 4px;">MOCKED</span></div>
      <div id="visits" style="color: #8A8880; font-size: 14px;">Loading visits&hellip;</div>
    </div>
  </div>
</div>
<script>
(function () {
  var INCOMPLETE_REASONS = ["parts", "access", "did_not_know", "unsafe", "needs_engineer"];
  var visitForm = {};
  var state = null;
  var busy = false;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  function pretty(s) { return s.replace(/_/g, " "); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }); }
  function chip(text, bg, color) { return '<span style="display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap;background:' + bg + ';color:' + color + ';">' + esc(text) + '</span>'; }
  function form(id) { return (visitForm[id] = visitForm[id] || { photos: false, reason: "" }); }

  function api(path, body) {
    return fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { if (!r.ok) throw new Error(data.error || ("HTTP " + r.status)); return data; }); });
  }

  function visitCard(v, showControls) {
    var f = form(v.visit_id);
    var controls = "";
    if (showControls && v.state === "scheduled") {
      controls = '<div style="border-top:1px solid #F0EEE9;margin-top:10px;padding-top:10px;display:flex;flex-direction:column;gap:8px;">'
        + '<label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-act="photos" data-visit="' + esc(v.visit_id) + '"' + (f.photos ? " checked" : "") + '> Photos attached' + (v.photos_required ? ' <span style="color:#B42318;">(required)</span>' : "") + '</label>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
        + '<button data-act="visitDone" data-visit="' + esc(v.visit_id) + '"' + (v.photos_required && !f.photos ? ' disabled title="photos are required for this visit"' : "") + ' style="font-family:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:6px 14px;cursor:pointer;background:#1E4D2B;color:#FFFFFF;border:1px solid #1E4D2B;">Complete visit</button>'
        + '<select data-act="reason" data-visit="' + esc(v.visit_id) + '" style="flex:1;min-width:120px;font-family:inherit;font-size:13px;padding:5px 8px;border:1px solid #D8D5CC;border-radius:6px;"><option value="">Incomplete reason&hellip;</option>' + INCOMPLETE_REASONS.map(function (r) { return '<option value="' + r + '"' + (f.reason === r ? " selected" : "") + '>' + pretty(r) + '</option>'; }).join("") + '</select>'
        + '<button data-act="visitIncomplete" data-visit="' + esc(v.visit_id) + '"' + (f.reason ? "" : ' disabled title="pick a reason first"') + ' style="font-family:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:6px 14px;cursor:pointer;background:#FFFFFF;color:#4A4944;border:1px solid #D8D5CC;">Mark incomplete</button>'
        + '</div></div>';
    }
    var vs = v.state === "completed" ? ["#E7F2EA", "#1D6F3E"] : v.state === "incomplete" ? ["#FFF3E0", "#9A5B00"] : ["#EAF1FF", "#1E4FBE"];
    return '<div style="background:#FFFFFF;border:1px solid #DEDAD2;border-radius:8px;padding:12px 14px;margin-bottom:10px;' + (v.state !== "scheduled" ? "opacity:0.75;" : "") + '">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="mono" style="font-weight:500;">' + esc(v.visit_id) + '</span><span style="font-size:13px;color:#4A4944;">' + (v.kind === "hq_recovery" ? "HQ recovery" : "Tech visit") + '</span><span class="mono" style="font-size:12px;color:#6B6A64;">' + esc(v.vin) + ' &middot; ' + esc(v.case_id) + '</span><span style="flex:1;"></span>' + chip(v.state, vs[0], vs[1]) + '</div>'
      + '<div style="font-size:13px;color:#4A4944;margin-top:4px;">' + esc(v.assignee.name) + ' &middot; ' + fmtTime(v.slot_start) + '&ndash;' + fmtTime(v.slot_end) + ' CT' + (v.photos_required ? " &middot; photos required" : "") + '</div>'
      + '<div style="font-size:13px;color:#6B6A64;margin-top:6px;">' + esc(v.brief) + '</div>'
      + '<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#4A4944;">' + v.checklist.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul>'
      + (v.outcome && !v.outcome.completed ? '<div style="font-size:12px;color:#9A5B00;margin-top:6px;">Incomplete: ' + esc(pretty(v.outcome.incomplete_reason || "")) + '</div>' : "")
      + controls + '</div>';
  }

  function render() {
    var active = state.visits.filter(function (v) { return v.state !== "completed"; })
      .sort(function (a, b) { return (a.state === "scheduled" ? 0 : 1) - (b.state === "scheduled" ? 0 : 1); });

    var activeEl = document.getElementById("visits");
    activeEl.innerHTML = active.length
      ? active.map(function (v) { return visitCard(v, true); }).join("")
      : '<div style="color:#8A8880;font-size:14px;">No visits scheduled.</div>';
  }

  function refresh() {
    api("/api/response/state").then(function (s) { state = s; render(); }).catch(function (e) {
      document.getElementById("visits").innerHTML = '<div style="color:#8A8880;font-size:14px;">Could not load visits: ' + esc(e.message) + '</div>';
    });
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-act]");
    if (!el || busy || !state) return;
    var d = el.dataset;
    var visit = state.visits.find(function (v) { return v.visit_id === d.visit; });
    if (!visit) return;
    if (d.act === "visitDone" || d.act === "visitIncomplete") {
      var f = form(d.visit);
      var outcome = d.act === "visitDone"
        ? { completed: true, photos_attached: !!f.photos }
        : { completed: false, photos_attached: !!f.photos, incomplete_reason: f.reason };
      busy = true;
      api("/api/response/visit", { visit_id: d.visit, user_id: visit.assignee.id, outcome: outcome })
        .catch(function (e) { alert(e.message); })
        .then(function () { busy = false; refresh(); });
    }
  });
  document.addEventListener("change", function (ev) {
    var el = ev.target;
    var d = el.dataset;
    if (d.act === "photos") { form(d.visit).photos = el.checked; render(); }
    else if (d.act === "reason") { form(d.visit).reason = el.value; render(); }
  });

  refresh();
  setInterval(refresh, 4000);
})();
</script>
</body>
</html>`;
}
