// Plain HTML/CSS/vanilla-JS port of the Automatic Root Cause Analysis Dashboard Claude Artifact
// mockup (Field RCA design doc §8.3). See case-workspace.ts for the sibling
// Case Workspace port and porting notes.
//
// The main "Cases" table, KPI, and root-cause histogram below are backed by a real, STATEFUL
// response engine over the real Austin fleet: src/response/austin-routes.ts's `austinEngine`, a
// second instantiation of Carlos's real DefaultResponseEngine (src/response/engine.ts) running
// Carlos's own Core telemetry pack pipeline (src/sim/core-pack.ts + src/response/detector-hypothesis.ts
// -- the same "core" fleet build() in src/response/routes.ts uses for /response's fleet switcher),
// filtered to Austin-sited units, with a real (non-stub) Task 1 hypothesis source that re-runs
// Megan's field-rca detectors fresh per diagnosis. Approve/reject/close on these cases are real
// actions (see case-workspace.ts).
//
// This supersedes the page's previous data source, Megan's stateless field-rca pipeline
// (src/pages/field-rca-cases.ts, still exported and still used as a read-only fallback in
// case-workspace.ts for any case id neither engine recognizes) — that pipeline has no case
// lifecycle (no persisted status, no actuation), so once real Approve/Reject/Close existed for
// this same fleet via austinEngine, keeping both wired into this one table would have meant two
// different "real" answers for the same VINs. Rather than leave that half-migrated, this file no
// longer calls listFieldRcaCases() at all; technician-dashboard.ts made the same swap.
//
// The "Technician view" card below is a separate, genuinely different real
// fleet: Carlos's response engine (src/response/*, INV-#### sim VINs), kept
// as-is because his pickTechnician() skill-match has no equivalent in
// Megan's pipeline (no scheduler, no assignment). Two real fleets, not
// reconciled into one — see the fork report for why.
// Read-only reuse of Carlos's live response engine (do not edit src/response/*).
// `engine` is the same singleton dashboard-server.ts already wires up — importing
// it here just gets a reference, it doesn't construct a second engine. Same for
// `austinEngine` from austin-routes.ts.
import fs from "node:fs";
import path from "node:path";
import { engine } from "../response/routes.js";
import { austinEngine } from "../response/austin-routes.js";
import { pickTechnician } from "../response/scheduler.js";
import { loadSeed, type FleetSeed } from "../response/seed.js";
import type { RcaCase } from "../response/types.js";

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

const techs = [
  { name: "D. Osei", completion: "88%", tags: "connector-class refresher" },
  { name: "R. Fenwick", completion: "95%", tags: "—" },
  { name: "K. Nguyen", completion: "79%", tags: "install checklist, panel access" },
];

// ILLUSTRATIVE, not derived from data_input/ — no file there has a
// per-firmware-version return-rate field to compute this from. Kept as a
// fixed array (renamed/reframed by the firmware-rename pass) pending real
// return data. Not tagged in the card UI (per product decision) — don't
// mistake this for the real, per-request-computed root-cause tally in
// renderRootCauses().
const fwClusterData = [
  { version: "3.2.1", returnRate: 22, max: 25, stale: true },
  { version: "3.3.0", returnRate: 11, max: 25, stale: true },
  { version: "3.4.0", returnRate: 4, max: 25, stale: false },
];

const trendVals = [34, 31, 29, 25, 22, 19, 15, 12];
const trendMax = 34;

// Real inventory (data_input/inventory.csv): vin, city, lat, lon, faulted (Y/N).
// The underlying CSV is a statewide TX fleet spanning 10 cities, but this
// dashboard only ever renders the Austin region param — see renderFleetMap
// below and DEMO_REGIONS above.
interface InventoryUnit {
  vin: string;
  city: string;
  lat: number;
  lon: number;
  faulted: boolean;
}

function loadInventory(): InventoryUnit[] {
  const csvPath = path.join(process.cwd(), "data_input", "inventory.csv");
  if (!fs.existsSync(csvPath)) return [];
  const text = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const lines = text.trim().split(/\r?\n/);
  const cols = lines[0]?.split(",") ?? [];
  const vinIdx = cols.indexOf("vin");
  const cityIdx = cols.indexOf("city");
  const latIdx = cols.indexOf("lat");
  const lonIdx = cols.indexOf("lon");
  const faultedIdx = cols.indexOf("faulted");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return {
      vin: cells[vinIdx] ?? "",
      city: cells[cityIdx] ?? "",
      lat: Number(cells[latIdx]),
      lon: Number(cells[lonIdx]),
      faulted: (cells[faultedIdx] ?? "").trim().toUpperCase() === "Y",
    };
  });
}

const inventoryUnits = loadInventory();

// This dashboard is scoped to one region: Austin (4 real units in
// data_input/inventory.csv). Houston was a demo comparison region and has
// been dropped — no Houston route, map asset, or data is emitted anymore.
const DEMO_REGIONS = ["Austin"] as const;

// Real Texas geographic bounding box (west tip of El Paso to the Sabine River,
// Panhandle top to the Rio Grande Valley tip) — fixed, not derived from the
// fleet's own min/max, so every unit (and every region filter) lands in its
// true position against the real state outline image below. Calibrated by
// plotting all 10 real fleet cities against public/texas_outline.svg and
// checking each landed in its correct place (El Paso at the western tip,
// Houston on the coast, Dallas/Plano north-central, etc.).
const TX_LON_MIN = -106.65;
const TX_LON_MAX = -93.51;
const TX_LAT_MIN = 25.84;
const TX_LAT_MAX = 36.5;
// Native viewBox of public/texas_outline.svg (Wikimedia Commons, CC0) — the
// fleet map draws in this same coordinate space so the dots and the outline
// image share one projection.
const TX_SVG_W = 1162;
const TX_SVG_H = 1134;

// data_input/inventory.csv only has city-level GPS (one lat/lon per city,
// shared by every unit in it) — there is no per-unit street address, so a
// real per-unit projection would put every dot for a city on the exact same
// pixel (this is what "the map doesn't populate" turned out to be: 3-4 dots
// stacked invisibly on one point). Each region's schematic background
// (public/city_maps/*.svg, original artwork — not a Google Maps tile) has a
// fixed anchor point at that city's real centroid; units are spread in a
// small fixed ring around it purely so overlapping markers stay visible and
// clickable. The ring position carries no positional meaning — only each
// dot's own real VIN/fault status (in its tooltip) does.
const CITY_MAP_ANCHOR: Record<string, { x: number; y: number; w: number; h: number; src: string }> = {
  Austin: { x: 234, y: 230, w: 400, h: 400, src: "/city_maps/austin.svg" },
};

function renderCityMap(units: InventoryUnit[], region: string): string {
  const anchor = CITY_MAP_ANCHOR[region];
  if (!anchor) return `<div style="font-size:13px;color:#8A8880;">No map art for ${region}.</div>`;
  const ringR = units.length > 1 ? 26 : 0;
  const dots = units
    .map((u, i) => {
      const angle = (i / units.length) * Math.PI * 2 - Math.PI / 2;
      const cx = anchor.x + Math.cos(angle) * ringR;
      const cy = anchor.y + Math.sin(angle) * ringR;
      const color = u.faulted ? "#DC2626" : "#1E4D2B";
      const label = `${u.vin} &mdash; ${u.city} &mdash; ${u.faulted ? "faulted" : "healthy"}`;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${color}" fill-opacity="0.92" stroke="#FFFFFF" stroke-width="2"><title>${label}</title></circle>`;
    })
    .join("");

  // The card is now full-width (see the fleet-map card's own style below),
  // but the map art is a square (400x400) — stretching it to width:100% would
  // blow it up into a giant square. Cap by height instead and center it, so
  // the card is as wide as its neighbors while the map itself stays a
  // sensible size.
  return `<div style="display:flex;justify-content:center;">
    <svg viewBox="0 0 ${anchor.w} ${anchor.h}" style="height:380px;width:auto;max-width:100%;display:block;overflow:visible;border-radius:6px;">
      <image href="${anchor.src}" x="0" y="0" width="${anchor.w}" height="${anchor.h}"></image>
      ${dots}
    </svg>
  </div>`;
}

function renderFleetMap(units: InventoryUnit[], region?: string): string {
  if (units.length === 0) {
    return `<div style="font-size:13px;color:#8A8880;">inventory.csv not found &mdash; map unavailable.</div>`;
  }
  const faultedCount = units.filter((u) => u.faulted).length;
  const healthyCount = units.length - faultedCount;
  const legend = `<div style="display:flex;align-items:center;gap:14px;margin-top:8px;font-size:12px;color:#6B6A64;">
    <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#DC2626;margin-right:4px;"></span>${faultedCount} faulted</span>
    <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#1E4D2B;margin-right:4px;"></span>${healthyCount} healthy</span>
  </div>`;

  if (region) return renderCityMap(units, region) + legend;

  // Statewide: fixed real TX bbox against the real outline image.
  const xFor = (lon: number) => ((lon - TX_LON_MIN) / (TX_LON_MAX - TX_LON_MIN)) * TX_SVG_W;
  const yFor = (lat: number) => (1 - (lat - TX_LAT_MIN) / (TX_LAT_MAX - TX_LAT_MIN)) * TX_SVG_H;

  const dots = units
    .map((u) => {
      const color = u.faulted ? "#DC2626" : "#1E4D2B";
      const label = `${u.vin} &mdash; ${u.city} &mdash; ${u.faulted ? "faulted" : "healthy"}`;
      const r = TX_SVG_W / 90; // scales with the outline's native coordinate space
      return `<circle cx="${xFor(u.lon).toFixed(1)}" cy="${yFor(u.lat).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.9" stroke="#FFFFFF" stroke-width="2"><title>${label}</title></circle>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${TX_SVG_W} ${TX_SVG_H}" style="width:100%;height:auto;display:block;overflow:visible;">
    <image href="/texas_outline.svg" x="0" y="0" width="${TX_SVG_W}" height="${TX_SVG_H}"></image>
    ${dots}
  </svg>
  ${legend}`;
}

// Root-cause tally over real austinEngine RcaCase objects (c.hypothesis.root_cause), not the old
// FieldRcaCaseView pipeline output — same taxonomy either way.
function rootCauseTally(cases: RcaCase[]): { label: string; count: number; max: number }[] {
  const tally = new Map<string, number>();
  for (const c of cases) {
    const rc = c.hypothesis?.root_cause ?? "unknown";
    tally.set(rc, (tally.get(rc) ?? 0) + 1);
  }
  const max = Math.max(1, ...tally.values());
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count, max }));
}

function renderRootCauses(cases: RcaCase[]): string {
  return rootCauseTally(cases)
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
        <div style="height:14px;background:${f.stale ? "#DC2626" : "#1E4D2B"};border-radius:3px;width:${Math.round((f.returnRate / f.max) * 100)}%;"></div>
      </div>
      <span class="mono" style="width:36px;font-size:13px;color:#6B6A64;text-align:right;">${f.returnRate}%</span>
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
}

let liveSeed: FleetSeed | null = null;

// Maps one of Carlos's real RcaCase objects onto our own row concepts.
// Used only by renderTechnicianAppointmentsPage below now — the main /fleet
// case table uses the real Austin engine instead (see deriveAustinCaseRow).
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
  };
}

// Maps one of the real Austin engine's RcaCase objects onto the same row shape as
// deriveLiveCaseRow above (reused, not reinvented) — real hypothesis/gameplan/status straight
// off austinEngine.getState().cases. `id` gets an "austin:" prefix: both engines' CaseStore
// (case-store.ts, untouched) mint "RCA-0001", "RCA-0002", ... independently, so raw case ids
// WILL collide between Carlos's simulated fleet and this real one the moment both have opened at
// least one case. The prefix is stripped back off in case-workspace.ts's lookup — see its
// header comment for the full collision note.
function deriveAustinCaseRow(c: RcaCase): LiveCaseRow {
  // Carlos's Core-pack build reuses the same demo seed file for users/tech_roster/drivers
  // (see core-pack.ts's loadCorePack doc comment), so this is the same loadSeed() liveSeed
  // above already reads -- one shared roster, no separate Austin seed file anymore.
  liveSeed ??= loadSeed();
  const rootCause = c.hypothesis?.root_cause ?? "unknown";
  const sev: CaseRow["sev"] = c.status === "Escalated L0" ? "L0" : c.gameplan?.level ?? "L1";
  const assignedTech = pickTechnician(rootCause, liveSeed).name;
  return {
    id: `austin:${c.case_id}`,
    asset: c.vin,
    site: c.site,
    sev,
    rootCause,
    status: c.status,
    age: relativeAge(c.opened_at),
    assignedTech,
  };
}

// showId/clickable default to the real Austin Cases table's behavior (a real case_id worth
// showing and navigating to). The Technician-view appointments table (Carlos's simulated fleet,
// not part of the demo) passes both false: its case_id isn't demo-relevant, and clicking through
// would land on Carlos's own /case page, a different off-demo system — that's more confusing,
// not less, so those rows are plain and non-interactive instead.
function renderLiveCaseRow(c: LiveCaseRow, opts: { showId: boolean; clickable: boolean } = { showId: true, clickable: true }): string {
  const sc = sevColors[c.sev];
  const cols = opts.showId ? "150px 100px 1fr 60px 220px 160px 60px" : "100px 1fr 60px 220px 160px 60px";
  const click = opts.clickable ? ` onclick="window.location.href='/case?case_id=${encodeURIComponent(c.id)}'"` : "";
  return `<div class="caseRow" data-sev="${c.sev}"${click} style="display:grid;grid-template-columns:${cols};gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;${opts.clickable ? "cursor:pointer;" : ""}">
    ${opts.showId ? `<span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.id}</span>` : ""}
    <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.asset}</span>
    <span>${c.site}</span>
    <span style="background:${sc.bg};color:${sc.color};font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;width:fit-content;">${c.sev}</span>
    <span class="mono" style="font-size:14px;color:#4A4944;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.rootCause}</span>
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

// Real Austin cases table: server-rendered straight from austinEngine.getState().cases (a
// synchronous call — no fetch/loading-state complexity needed for a value already in hand at
// render time). Same row shape/rendering as the Technician-view assigned-appointments table
// below (renderLiveCaseRow) — one row pattern for real RcaCase-backed tables in this file.
function renderLiveCasesTable(rows: LiveCaseRow[]): string {
  return `<div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944;">Cases<span class="tip" data-tip="Real Austin cases: the field-rca detector and triage pipeline produces a real hypothesis for each faulted unit, which the response engine plans, policy-gates, and persists. Approve/reject/close are real actions, not a read-only recompute.">?</span></div>
      <div id="liveSevFilters" style="display: flex; gap: 6px;">${renderLiveFilters()}</div>
    </div>
    <div style="display: grid; grid-template-columns: 150px 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
      <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
    </div>
    <div id="liveCaseRows">${rows.length ? rows.map((c) => renderLiveCaseRow(c)).join("") : `<div style="padding: 16px 6px; color: #8A8880;">No open Austin cases yet.</div>`}</div>
  </div>`;
}

export async function renderFleetDashboardPage(region?: string): Promise<string> {
  // austinEngine's fleet is Austin-only by construction (see austin-routes.ts — Carlos's Core
  // pack fleet filtered to units whose site starts with "Austin,"), so there is no region filter
  // to apply here any more; every case in it already is this region. `region` is kept as a param
  // only for the page title/heading and the map's inventory filter below.
  const state = austinEngine.getState();
  const cases = state.cases;
  const rows = cases.map(deriveAustinCaseRow);
  const openCasesKpi = String(state.metrics.open_cases);
  const mapUnits = region ? inventoryUnits.filter((u) => u.city === region) : inventoryUnits;
  const mapTitle = region ? `Fleet map &mdash; ${region}` : "Fleet map &mdash; Texas";
  const mapTip = region
    ? `Every real unit in data_input/inventory.csv whose city is ${region}. Red = faulted, green = healthy. inventory.csv only records city-level GPS (one coordinate per city, not per unit), so units are anchored to the real city centroid and spread in a small ring for legibility &mdash; the spread itself is not a real position.`
    : `Every real unit in data_input/inventory.csv, plotted by its actual lat/lon. Red = faulted, green = healthy. Spans 10 TX service areas &mdash; only 4 of ${inventoryUnits.length} units are in Austin proper.`;
  const pageTitle = region ? `Automatic Root Cause Analysis Dashboard — ${region} — ARCA` : "Automatic Root Cause Analysis Dashboard — ARCA";
  const heading = region ? `Automatic Root Cause Analysis Dashboard &mdash; ${region}` : "Automatic Root Cause Analysis Dashboard";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${pageTitle}</title>
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
      <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">Staff-Austin</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
    </div>
    <div style="font-size: 24px; font-weight: 600; color: #292826;">${heading}</div>
    <div style="font-size: 15px; color: #6B6A64; margin-top: 2px; padding-bottom: 20px;">Entry point into individual Cases &mdash; click a row to open its Case workspace.</div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>

  <!-- BODY -->
  <div style="padding: 32px 40px 80px;">

  <!-- KPI ROW -->
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px;">
    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Open cases<span class="tip" data-tip="Real Austin cases not yet Closed (austinEngine's own metrics.open_cases) — approve/reject/close on a case actually changes this count.">?</span></div>
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
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 12px;">Root-cause histogram<span class="tip" data-tip="Every real Austin case, grouped by its real Hypothesis.root_cause from the Austin engine.">?</span></div>
      ${renderRootCauses(cases)}
    </div>

    <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 12px;">Active firmware versions<span class="tip" data-tip="Return-to-HQ rate for units on each active firmware version — a stale or unpatched version tends to carry a higher return rate than the current allow-listed version.">?</span></div>
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

  <!-- FLEET MAP (real inventory.csv coordinates + fault status) -->
  <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 16px 18px; margin-bottom: 24px;">
    <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 4px;">${mapTitle}<span class="tip" data-tip="${mapTip}">?</span></div>
    ${renderFleetMap(mapUnits, region)}
  </div>

  ${renderLiveCasesTable(rows)}

  <!-- TECHNICIAN VIEW -->
  <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px;">
    <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 4px;">Technician view<span class="tip" data-tip="Response-engine fleet — a separate dataset from the Cases table above, with its own VIN space (INV-####) and case lifecycle.">?</span></div>
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
    <a href="/fleet" style="font-size: 15px; color: #6B6A64; text-decoration: none;">&larr; Automatic Root Cause Analysis Dashboard</a>
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
      <div style="display: grid; grid-template-columns: 100px 1fr 60px 220px 160px 60px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
        <span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span><span>Age</span>
      </div>
      ${assigned.length ? assigned.map((c) => renderLiveCaseRow(c, { showId: false, clickable: false })).join("") : `<div style="padding: 24px 6px; color: #8A8880;">No cases currently assigned.</div>`}
    </div>
  </div>

</div>
</body>
</html>`;
}
