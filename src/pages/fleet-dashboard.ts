// Plain HTML/CSS/vanilla-JS port of the Fleet RCA Dashboard Claude Artifact
// mockup (Field RCA design doc §8.3). See case-workspace.ts for the sibling
// Case Workspace port and porting notes.
//
// Every case on this page is a real RcaCase from Carlos's response engine,
// created only when a fault is planted (POST /api/sim/plant → ingestFaults()).
// There is no mock/example case data — none is fabricated here.
// Read-only reuse of Carlos's live response engine (do not edit src/response/*).
// `engine` is the same singleton dashboard-server.ts already wires up — importing
// it here just gets a reference, it doesn't construct a second engine.
import { engine } from "../response/routes.js";
import { pickTechnician } from "../response/scheduler.js";
import { loadSeed, type FleetSeed } from "../response/seed.js";
import type { RcaCase } from "../response/types.js";

export const REGIONS = ["AustinX4"] as const;
export type Region = (typeof REGIONS)[number];

export interface CaseRow {
  id: string;
  asset: string;
  site: string;
  sev: "L0" | "L1" | "L2" | "L3" | "L4";
  rootCause: string;
  status: string;
  age: string;
  assignedTech: string;
  region: Region;
}

const techs = [
  { name: "D. Osei", completion: "88%", tags: "connector-class refresher" },
  { name: "R. Fenwick", completion: "95%", tags: "—" },
  { name: "K. Nguyen", completion: "79%", tags: "install checklist, panel access" },
];

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

const severities = ["ALL", "L0", "L1", "L2", "L3", "L4"];

// Server-rendered (not client JS) so the KPI counts and table genuinely
// recompute per region on the server, matching how /fleet/technician works.
function renderRegionFilter(activeRegion: string, rows: LiveCaseRow[]): string {
  const options: { label: string; value: string }[] = [
    { label: "ALL", value: "ALL" },
    ...REGIONS.map((r) => ({ label: `${r} (${rows.filter((c) => c.region === r).length})`, value: r })),
  ];
  return options
    .map(({ label, value }) => {
      const active = value === activeRegion;
      const href = value === "ALL" ? "/fleet" : `/fleet?region=${encodeURIComponent(value)}`;
      return `<a href="${href}" style="text-decoration:none;background:${active ? "#1E4D2B" : "#FFFFFF"};color:${active ? "#FFFFFF" : "#4A4944"};border:1px solid ${active ? "#1E4D2B" : "#D8D5CC"};border-radius:14px;padding:5px 12px;font-size:14px;font-weight:600;">${label}</a>`;
    })
    .join("");
}

function relativeAge(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

interface LiveCaseRow {
  id: string;
  asset: string;
  site: string;
  sev: CaseRow["sev"];
  rootCause: string;
  status: string;
  age: string;
  assignedTech: string;
  region: Region;
}

let liveSeed: FleetSeed | null = null;

// Maps one of Carlos's real RcaCase objects onto our own row concepts.
// - region: his whole simulated fleet is Austin-only (confirmed), so every
//   case is genuinely "AustinX4" — a true mapping, not an arbitrary label.
// - assignedTech: his own pickTechnician() skill-match, not reinvented here.
// - sev: his cases have no L0-L4 field directly. Escalated L0 status maps to
//   L0 (a real signal); otherwise we fall back to gameplan.level once a
//   gameplan exists. "L1" for a case with no gameplan yet is a placeholder
//   default, not an observed severity — cases open at "L1" until Task 2 runs.
function deriveLiveCaseRow(c: RcaCase): LiveCaseRow {
  liveSeed ??= loadSeed();
  const rootCause = c.hypothesis?.root_cause ?? "unknown";
  const sev: CaseRow["sev"] = c.status === "Escalated L0" ? "L0" : c.gameplan?.level ?? "L1";
  const assignedTech = pickTechnician(rootCause, liveSeed).name;
  return {
    id: c.case_id,
    asset: c.vin,
    site: c.site,
    sev,
    rootCause,
    status: c.status,
    age: relativeAge(c.opened_at),
    assignedTech,
    region: "AustinX4",
  };
}

function renderLiveCaseRow(c: LiveCaseRow): string {
  const sc = sevColors[c.sev];
  return `<div class="caseRow" data-sev="${c.sev}" onclick="window.location.href='/case?case_id=${encodeURIComponent(c.id)}'" style="display:grid;grid-template-columns:70px 100px 1fr 60px 220px 160px 60px;gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;cursor:pointer;">
    <span class="mono">${c.id}</span>
    <span class="mono">${c.asset}</span>
    <span>${c.site}</span>
    <span style="background:${sc.bg};color:${sc.color};font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;width:fit-content;">${c.sev}</span>
    <span class="mono" style="font-size:14px;color:#4A4944;">${c.rootCause}</span>
    <span style="color:#4A4944;">${c.status}</span>
    <span style="color:#8A8880;">${c.age}</span>
  </div>`;
}

function renderLiveFilters(): string {
  return severities
    .map((s) => {
      const active = s === "ALL";
      return `<button class="liveSevFilter" data-sev="${s}" onclick="filterLiveCases('${s}')" style="background:${active ? "#292826" : "#FFFFFF"};color:${active ? "#FFFFFF" : "#4A4944"};border:1px solid ${active ? "#292826" : "#D8D5CC"};border-radius:14px;padding:5px 12px;font-size:14px;font-weight:600;cursor:pointer;">${s}</button>`;
    })
    .join("");
}

// Whole table is server-rendered from a synchronous engine.getState() call —
// simpler than a client-side fetch, and just as correct: getState() isn't a
// Promise, so there's no reason to add fetch/loading-state complexity for a
// value we already have at render time. Re-renders fresh on every page load.
function renderCasesTable(rows: LiveCaseRow[], activeRegion: string): string {
  const openRows = rows.filter((c) => c.status !== "Closed");
  const closedRows = rows.filter((c) => c.status === "Closed");
  return `<div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944;">Open cases${activeRegion !== "ALL" ? ` &mdash; ${activeRegion}` : ""}<span class="tip" data-tip="Real RcaCase objects from Carlos's response engine, created only when a fault is planted — region/assignedTech/severity are derived from his real data.">?</span></div>
      <div id="liveSevFilters" style="display: flex; gap: 6px;">${renderLiveFilters()}</div>
    </div>
    <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
      <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
    </div>
    <div id="liveCaseRows">${openRows.length ? openRows.map(renderLiveCaseRow).join("") : `<div style="padding: 16px 6px; color: #8A8880;">No open cases yet &mdash; plant a fault on the Response agent page to create one.</div>`}</div>
    <details style="margin-top: 16px; border-top: 1px solid #DEDAD2; padding-top: 12px;">
      <summary style="cursor: pointer; font-size: 14px; font-weight: 600; color: #6B6A64; list-style: revert;">Closed cases (${closedRows.length})</summary>
      <div style="margin-top: 10px;">
        <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
          <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
        </div>
        ${closedRows.length ? closedRows.map(renderLiveCaseRow).join("") : `<div style="padding: 16px 6px; color: #8A8880;">No closed cases yet.</div>`}
      </div>
    </details>
  </div>`;
}

export function renderFleetDashboardPage(region: string = "ALL"): string {
  const activeRegion = (REGIONS as readonly string[]).includes(region) ? region : "ALL";
  const allRows = engine.getState().cases.map(deriveLiveCaseRow);
  const rows = activeRegion === "ALL" ? allRows : allRows.filter((c) => c.region === activeRegion);
  // Root-cause histogram / FW clusters / false-pull trend below are separate
  // illustrative fleet-wide datasets, not derived from real cases — they
  // intentionally stay fleet-wide regardless of the region filter.
  const openCasesKpi = String(rows.filter((c) => c.status !== "Closed").length);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fleet Dashboard — ARCA</title>
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
  .btn { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 6px; padding: 5px 12px; cursor: pointer; border: 1px solid transparent; }
  .btnGhost { background: #FFFFFF; color: #4A4944; border-color: #D8D5CC; }
  .btnGhost:hover:not(:disabled) { background: #FAFAF8; }
  .chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .unit { background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 10px 12px; }
  .menu { position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 30; background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); padding: 4px; min-width: 250px; }
  .menuItem { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 6px 8px; font-size: 12px; color: #292826; border-radius: 4px; cursor: pointer; }
  .menuItem:hover { background: #F0EEEB; }
</style>
</head>
<body>

<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">

  <!-- HEADER -->
  <div style="position: sticky; top: 0; z-index: 10; background: #F0EEEB; padding: 20px 40px 0;">
    <div style="position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
        <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
        <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">ARCA</span>
      </div>
      <nav style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 10px; background: #EFEDE7; padding: 5px; border-radius: 8px;" aria-label="Dashboard">
        <a href="/fleet" style="font-size: 17px; font-weight: 600; text-decoration: none; padding: 9px 22px; border-radius: 6px; background: #1E4D2B; color: #FFFFFF;">Fleet</a>
        <a href="/case" style="font-size: 17px; font-weight: 600; text-decoration: none; padding: 9px 22px; border-radius: 6px; background: transparent; color: #6B6A64;">Case</a>
        <a href="/response" style="font-size: 17px; font-weight: 600; text-decoration: none; padding: 9px 22px; border-radius: 6px; background: transparent; color: #6B6A64;">Response</a>
      </nav>
      <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">Staff</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
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

  <!-- REGION FILTER -->
  <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
    <span style="font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em;">Region</span>
    <div style="display: flex; gap: 6px;">${renderRegionFilter(activeRegion, allRows)}</div>
  </div>

  <!-- KPI ROW -->
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px;">
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Open cases<span class="tip" data-tip="Cases currently active${activeRegion === "ALL" ? " across the fleet" : " in " + activeRegion} — detected and not yet closed, at any severity or stage.">?</span></div>
      <div style="font-size: 30px; font-weight: 600; margin-top: 6px;">${openCasesKpi}</div>
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

  ${renderCasesTable(rows, activeRegion)}

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
function filterLiveCases(sev) {
  document.querySelectorAll('.liveSevFilter').forEach((btn) => {
    const active = btn.dataset.sev === sev;
    btn.style.background = active ? '#292826' : '#FFFFFF';
    btn.style.color = active ? '#FFFFFF' : '#4A4944';
    btn.style.borderColor = active ? '#292826' : '#D8D5CC';
  });
  document.querySelectorAll('#liveCaseRows .caseRow').forEach((row) => {
    row.style.display = sev === 'ALL' || row.dataset.sev === sev ? 'grid' : 'none';
  });
}
</script>
</body>
</html>`;
}

// Staff-facing drill-down from the Technician view table: all real cases
// currently assigned to one technician (assignedTech is Carlos's own
// pickTechnician() skill-match, same as the Open cases table on /fleet).
export function renderTechnicianAppointmentsPage(techName: string): string {
  const tech = techs.find((t) => t.name === techName);
  const assigned = engine.getState().cases.map(deriveLiveCaseRow).filter((c) => c.assignedTech === techName);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${techName || "Technician"} — Appointments — ARCA</title>
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
      <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">ARCA</span>
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
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Assigned cases (${assigned.length})</div>
      <div style="display: grid; grid-template-columns: 70px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
        <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
      </div>
      ${assigned.length ? assigned.map((c) => renderLiveCaseRow(c)).join("") : `<div style="padding: 24px 6px; color: #8A8880;">No cases currently assigned.</div>`}
    </div>
  </div>

</div>
</body>
</html>`;
}
