// Plain HTML/CSS/vanilla-JS port of the Fleet RCA Dashboard Claude Artifact
// mockup (Field RCA design doc §8.3). See case-workspace.ts for the sibling
// Case Workspace port and porting notes.
import { deriveCaseStatus, type Decision } from "../session-store.js";

const rootCauseData = [
  { label: "can_link_unreliable", count: 14, max: 14 },
  { label: "fw_version_mismatch", count: 9, max: 14 },
  { label: "install_commissioning_incomplete", count: 7, max: 14 },
  { label: "no_fault_found", count: 6, max: 14 },
  { label: "true_hardware_defect", count: 3, max: 14 },
  { label: "thermal_or_safety_event", count: 2, max: 14 },
  { label: "unknown", count: 2, max: 14 },
];

const fwClusterData = [
  { version: "3.2.1", count: 18, max: 18, stale: true },
  { version: "3.3.0", count: 9, max: 18, stale: true },
  { version: "3.4.0", count: 6, max: 18, stale: false },
];

const trendVals = [34, 31, 29, 25, 22, 19, 15, 12];
const trendMax = 34;

export interface CaseRow {
  id: string;
  asset: string;
  site: string;
  sev: "L0" | "L1" | "L2" | "L3" | "L4";
  rootCause: string;
  status: string;
  age: string;
  assignedTech: string;
}

export const allCases: CaseRow[] = [
  { id: "#1234", asset: "INV-4021", site: "118 Maple Ct", sev: "L2", rootCause: "can_link_unreliable", status: "Investigating", age: "2h", assignedTech: "D. Osei" },
  { id: "#1235", asset: "COR-0092", site: "44 Birch Ln", sev: "L0", rootCause: "thermal_or_safety_event", status: "Escalated L0", age: "11m", assignedTech: "R. Fenwick" },
  { id: "#1229", asset: "INV-3987", site: "9 Larkspur Way", sev: "L1", rootCause: "install_commissioning_incomplete", status: "Awaiting engineer review", age: "1d", assignedTech: "K. Nguyen" },
  { id: "#1230", asset: "INV-4102", site: "118 Maple Ct", sev: "L3", rootCause: "fw_version_mismatch", status: "Action pending approval", age: "4h", assignedTech: "D. Osei" },
  { id: "#1231", asset: "COR-0071", site: "7 Cedar Ct", sev: "L4", rootCause: "true_hardware_defect", status: "Awaiting field visit", age: "3d", assignedTech: "R. Fenwick" },
  { id: "#1227", asset: "INV-3987", site: "9 Larkspur Way", sev: "L1", rootCause: "no_fault_found", status: "Closed", age: "6d", assignedTech: "K. Nguyen" },
];

const techs = [
  { name: "D. Osei", completion: "88%", tags: "connector-class refresher" },
  { name: "R. Fenwick", completion: "95%", tags: "—" },
  { name: "K. Nguyen", completion: "79%", tags: "install checklist, panel access" },
];

function renderRootCauses(): string {
  return rootCauseData
    .map(
      (r) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span class="mono" style="width:168px;flex-shrink:0;font-size:13px;color:#4A4944;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.label}</span>
      <div style="flex:1;height:10px;background:#EFEDE7;border-radius:3px;">
        <div style="height:10px;background:#4A4944;border-radius:3px;width:${Math.round((r.count / r.max) * 100)}%;"></div>
      </div>
      <span class="mono" style="width:20px;font-size:13px;color:#6B6A64;text-align:right;">${r.count}</span>
    </div>`
    )
    .join("");
}

function renderFwClusters(): string {
  return fwClusterData
    .map(
      (f) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <span class="mono" style="width:60px;flex-shrink:0;font-size:14px;color:#292826;">${f.version}</span>
      <div style="flex:1;height:14px;background:#EFEDE7;border-radius:3px;">
        <div style="height:14px;background:${f.stale ? "#DC2626" : "#1E4D2B"};border-radius:3px;width:${Math.round((f.count / f.max) * 100)}%;"></div>
      </div>
      <span class="mono" style="width:24px;font-size:13px;color:#6B6A64;text-align:right;">${f.count}</span>
    </div>`
    )
    .join("");
}

function renderTrend(): string {
  const width = 300;
  const height = 340;
  const leftPad = 30;
  const rightPad = 8;
  const topPad = 12;
  const bottomPad = 24;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;
  const yMax = 40; // clean round scale above the 34% starting value
  const n = trendVals.length;

  const xFor = (i: number) => leftPad + (plotW * i) / (n - 1);
  const yFor = (v: number) => topPad + plotH - (v / yMax) * plotH;

  const gridVals = [0, 10, 20, 30, 40];
  const gridLines = gridVals
    .map((g) => {
      const y = yFor(g);
      return `<line x1="${leftPad}" y1="${y}" x2="${width - rightPad}" y2="${y}" stroke="#EFEDE7" stroke-width="1"></line>
      <text x="${leftPad - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#8A8880">${g}%</text>`;
    })
    .join("");

  const points = trendVals.map((v, i) => ({ x: xFor(i), y: yFor(v), v }));
  const linePoints = points.map((p) => `${p.x},${p.y}`).join(" ");

  const dots = points
    .map((p, i) => {
      const weeksAgo = n - 1 - i;
      const label = weeksAgo === 0 ? "now" : `${weeksAgo} week${weeksAgo === 1 ? "" : "s"} ago`;
      return `<circle cx="${p.x}" cy="${p.y}" r="6" fill="#FFFFFF"></circle>
      <circle cx="${p.x}" cy="${p.y}" r="4" fill="#1E4D2B"><title>${label}: ${p.v}% false-pull rate</title></circle>`;
    })
    .join("");

  const xTicks = points
    .map((p, i) => {
      const weeksAgo = n - 1 - i;
      const label = weeksAgo === 0 ? "now" : `-${weeksAgo}w`;
      return `<text x="${p.x}" y="${height - 4}" text-anchor="middle" font-size="9" fill="#8A8880">${label}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px;overflow:visible;">
    ${gridLines}
    <polyline points="${linePoints}" fill="none" stroke="#1E4D2B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
    ${dots}
    ${xTicks}
  </svg>`;
}

export const sevColors: Record<CaseRow["sev"], { bg: string; color: string }> = {
  L0: { bg: "#FDECEC", color: "#B42318" },
  L1: { bg: "#FFF3E0", color: "#9A5B00" },
  L2: { bg: "#FFF3E0", color: "#9A5B00" },
  L3: { bg: "#EAF3E7", color: "#1E4D2B" },
  L4: { bg: "#EAF3E7", color: "#1E4D2B" },
};

function repeatTag(site: string): string {
  const count = allCases.filter((c) => c.site === site).length;
  return count > 1 ? " ⟳ repeat site" : "";
}

function renderCaseRow(c: CaseRow): string {
  const sc = sevColors[c.sev];
  return `<div class="caseRow" data-sev="${c.sev}" onclick="window.location.href='/case'" style="display:grid;grid-template-columns:70px 100px 1fr 60px 220px 160px 60px;gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;cursor:pointer;">
    <span class="mono">${c.id}</span>
    <span class="mono">${c.asset}</span>
    <span>${c.site} <span style="color:#9A5B00;font-size:13px;">${repeatTag(c.site)}</span></span>
    <span style="background:${sc.bg};color:${sc.color};font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;width:fit-content;">${c.sev}</span>
    <span class="mono" style="font-size:14px;color:#4A4944;">${c.rootCause}</span>
    <span style="color:#4A4944;">${c.status}</span>
    <span style="color:#8A8880;">${c.age}</span>
  </div>`;
}

const severities = ["ALL", "L0", "L1", "L2", "L3", "L4"];

function renderFilters(): string {
  return severities
    .map((s) => {
      const active = s === "ALL";
      return `<button class="sevFilter" data-sev="${s}" onclick="filterCases('${s}')" style="background:${active ? "#292826" : "#FFFFFF"};color:${active ? "#FFFFFF" : "#4A4944"};border:1px solid ${active ? "#292826" : "#D8D5CC"};border-radius:14px;padding:5px 12px;font-size:14px;font-weight:600;cursor:pointer;">${s}</button>`;
    })
    .join("");
}

export function renderFleetDashboardPage(decision: Decision, caseClosed: boolean): string {
  const rows = allCases.map((c) => (c.id === "#1234" ? { ...c, status: deriveCaseStatus(decision, caseClosed) } : c));
  const openRows = rows.filter((c) => c.status !== "Closed");
  const closedRows = rows.filter((c) => c.status === "Closed");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fleet RCA Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;500&display=swap">
<style>
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; }
  a { color: #1E4D2B; }
  a:hover { color: #163A20; }
  .mono { font-family: 'Space Mono', monospace; }
  .caseRow:hover { background: #FAFAF8; }
  .tip { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border: 1px solid #2F6FED; border-radius: 50%; font-size: 10px; line-height: 1; color: #2F6FED; cursor: help; margin-left: 5px; }
  .tip:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: 130%;
    left: 50%;
    transform: translateX(-50%);
    background: #292826;
    color: #FFFFFF;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.4;
    white-space: normal;
    width: 220px;
    z-index: 20;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }
  .tip:hover::before {
    content: '';
    position: absolute;
    bottom: 118%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: #292826;
    z-index: 20;
  }
</style>
</head>
<body>

<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">

  <!-- HEADER -->
  <div style="position: sticky; top: 0; z-index: 10; background: #F0EEEB; padding: 20px 40px 0;">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
        <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
        <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">Field RCA</span>
      </div>
      <div style="display: flex; align-items: center; gap: 18px;">
        <nav style="display: flex; gap: 12px;">
          <a href="/fleet" style="font-size: 14px; color: #1E4D2B; font-weight: 600; text-decoration: none;">Fleet</a>
          <a href="/case" style="font-size: 14px; color: #6B6A64; text-decoration: none;">Case</a>
          <a href="/response" style="font-size: 14px; color: #6B6A64; text-decoration: none;">Response</a>
        </nav>
        <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">Staff</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
      </div>
    </div>
    <div style="font-size: 24px; font-weight: 600; color: #292826;">Fleet RCA dashboard</div>
    <div style="font-size: 15px; color: #6B6A64; margin-top: 2px; padding-bottom: 20px;">Entry point into individual Cases &mdash; click a row to open its Case workspace.</div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>

  <!-- BODY -->
  <div style="padding: 32px 40px 80px;">

  <!-- RESPONSE AGENT BANNER (live from /api/response/state; hidden if the engine is unavailable) -->
  <a id="respBanner" href="/response" style="display: none; align-items: center; gap: 14px; background: #FFFFFF; border: 1px solid #DEDAD2; border-left: 4px solid #1E4D2B; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; text-decoration: none; color: #292826;">
    <div style="flex: 1;">
      <div style="font-size: 15px; font-weight: 600;">Response agent</div>
      <div id="respBannerText" style="font-size: 14px; color: #6B6A64; margin-top: 2px;"></div>
    </div>
    <span style="font-size: 14px; font-weight: 600; color: #1E4D2B; white-space: nowrap;">Open Response agent &rarr;</span>
  </a>
  <script>
  (function () {
    function load() {
      fetch("/api/response/state").then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
        if (!s) return;
        var waiting = 0, l0 = 0;
        s.cases.forEach(function (c) {
          if (c.status === "Escalated L0") l0++;
          (c.gameplan ? c.gameplan.steps : []).forEach(function (st) { if (st.state === "awaiting_approval") waiting++; });
        });
        var parts = [waiting + " action" + (waiting === 1 ? "" : "s") + " waiting for approval"];
        if (l0) parts.push(l0 + " safety case" + (l0 === 1 ? "" : "s"));
        parts.push(s.metrics.fixed_remote + " fixed remotely", s.metrics.avoided_false_pulls + " false pull" + (s.metrics.avoided_false_pulls === 1 ? "" : "s") + " avoided");
        document.getElementById("respBannerText").textContent = parts.join(" · ") + " (MOCKED fleet)";
        document.getElementById("respBanner").style.display = "flex";
      }).catch(function () { /* engine not running: keep the banner hidden */ });
    }
    load();
    setInterval(load, 5000);
  })();
  </script>

  <!-- KPI ROW -->
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px;">
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Open cases<span class="tip" data-tip="Cases currently active across the fleet — detected and not yet closed, at any severity or stage.">?</span></div>
      <div style="font-size: 30px; font-weight: 600; margin-top: 6px;">43</div>
    </div>
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Agent / eng agreement<span class="tip" data-tip="Share of cases where the agent's root-cause hypothesis matched what the reviewing engineer concluded.">?</span></div>
      <div style="font-size: 30px; font-weight: 600; margin-top: 6px;">74%</div>
    </div>
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Median time-to-action<span class="tip" data-tip="Median time from a case being opened to the first human action on it — approve, reject, or dispatch.">?</span></div>
      <div style="font-size: 30px; font-weight: 600; margin-top: 6px;">2.1h</div>
    </div>
  </div>

  <!-- CHARTS ROW -->
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px;">

    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 12px;">Root-cause histogram<span class="tip" data-tip="Closed cases across the fleet, grouped by the confirmed root-cause classification — shows which failure modes are actually driving volume.">?</span></div>
      ${renderRootCauses()}
    </div>

    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 12px;">FW version clusters<span class="tip" data-tip="How many units in the fleet are running each firmware version — surfaces stale or unpatched clusters against the current allow-listed version.">?</span></div>
      ${renderFwClusters()}
      <div style="font-size: 13px; color: #8A8880; margin-top: 4px;">3.4.0 is the current allow-listed version</div>
    </div>

    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px;">
        <div style="font-size: 14px; font-weight: 600; color: #4A4944;">False-pull rate &mdash; 8 week trend<span class="tip" data-tip="Share of technician dispatches that turned out to be unnecessary, charted week over week — shows whether triage accuracy is trending better or worse over time. Hover a point for its exact value.">?</span></div>
        <div><span style="font-size: 20px; font-weight: 600;">12%</span></div>
      </div>
      ${renderTrend()}
    </div>

  </div>

  <!-- OPEN CASES TABLE -->
  <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944;">Open cases</div>
      <div id="sevFilters" style="display: flex; gap: 6px;">${renderFilters()}</div>
    </div>

    <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
      <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
    </div>

    <div id="caseRows">${openRows.map(renderCaseRow).join("")}</div>

    <details style="margin-top: 16px; border-top: 1px solid #DEDAD2; padding-top: 12px;">
      <summary style="cursor: pointer; font-size: 14px; font-weight: 600; color: #6B6A64; list-style: revert;">Closed cases (${closedRows.length})</summary>
      <div style="margin-top: 10px;">
        <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
          <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
        </div>
        ${closedRows.length ? closedRows.map(renderCaseRow).join("") : `<div style="padding: 16px 6px; color: #8A8880;">No closed cases yet.</div>`}
      </div>
    </details>
  </div>

  <!-- TECHNICIAN VIEW -->
  <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px;">
    <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 4px;">Technician view</div>
    <div style="font-size: 13px; color: #8A8880; margin-bottom: 14px;">Role-gated, coaching record &mdash; not a public leaderboard. Click a technician to see their assigned appointments.</div>
    <div style="display: grid; grid-template-columns: 160px 130px 1fr; gap: 10px; padding: 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
      <span>Tech</span><span>Completion</span><span>Retraining tags</span>
    </div>
    ${techs
      .map(
        (t) => `<div class="caseRow" onclick="window.location.href='/fleet/technician?name=${encodeURIComponent(t.name)}'" style="display:grid;grid-template-columns:160px 130px 1fr;gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;cursor:pointer;">
      <span>${t.name}</span>
      <span class="mono">${t.completion}</span>
      <span style="color:#6B6A64;font-size:14px;">${t.tags}</span>
    </div>`
      )
      .join("")}
  </div>

  </div>
</div>

<script>
function filterCases(sev) {
  document.querySelectorAll('.sevFilter').forEach((btn) => {
    const active = btn.dataset.sev === sev;
    btn.style.background = active ? '#292826' : '#FFFFFF';
    btn.style.color = active ? '#FFFFFF' : '#4A4944';
    btn.style.borderColor = active ? '#292826' : '#D8D5CC';
  });
  document.querySelectorAll('#caseRows .caseRow').forEach((row) => {
    row.style.display = sev === 'ALL' || row.dataset.sev === sev ? 'grid' : 'none';
  });
}
</script>
</body>
</html>`;
}

// Staff-facing drill-down from the Technician view table: all appointments
// (cases) currently assigned to one technician.
export function renderTechnicianAppointmentsPage(techName: string, decision: Decision, caseClosed: boolean): string {
  const tech = techs.find((t) => t.name === techName);
  const assigned = allCases
    .filter((c) => c.assignedTech === techName)
    .map((c) => (c.id === "#1234" ? { ...c, status: deriveCaseStatus(decision, caseClosed) } : c));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${techName || "Technician"} — Appointments — Field RCA</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;500&display=swap">
<style>
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; }
  a { color: #1E4D2B; }
  a:hover { color: #163A20; }
  .mono { font-family: 'Space Mono', monospace; }
  .caseRow:hover { background: #FAFAF8; }
</style>
</head>
<body>
<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">

  <!-- HEADER -->
  <div style="position: sticky; top: 0; z-index: 10; background: #F0EEEB; padding: 20px 40px 0;">
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
      <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
      <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
      <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">Field RCA</span>
    </div>
    <a href="/fleet" style="font-size: 15px; color: #6B6A64; text-decoration: none;">&larr; Fleet RCA dashboard</a>
    <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 10px; padding-bottom: 20px;">
      <span style="font-size: 24px; font-weight: 600;">${techName || "Unknown technician"}</span>
      ${tech ? `<span style="font-size: 15px; color: #6B6A64;">${tech.completion} completion &middot; ${tech.tags}</span>` : ""}
    </div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>

  <!-- BODY -->
  <div style="padding: 32px 40px 80px;">
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Assigned appointments (${assigned.length})</div>
      <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
        <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
      </div>
      ${assigned.length ? assigned.map(renderCaseRow).join("") : `<div style="padding: 24px 6px; color: #8A8880;">No appointments currently assigned.</div>`}
    </div>
  </div>

</div>
</body>
</html>`;
}
