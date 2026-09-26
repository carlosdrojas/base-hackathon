import "dotenv/config";
import http from "node:http";
import { ercotGet, API_BASE } from "./ercot-client.js";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);
const HUB = "HB_WEST";
const POLL_CACHE_MS = 20_000;
const BASELINE_WINDOW = 48; // ~4 hours at 5-min intervals
const ELEVATED_MULTIPLIER = 1.25; // simplified demo threshold, not the 30-day percentile model

type CurtailmentClass = "NORMAL" | "OVERSUPPLY" | "CONGESTION";
type DamRtmClass = "NORMAL" | "HIGH_RTM" | "LOW_RTM";
type Trend = "RISING" | "FALLING" | "FLAT";
type Signal = "CURTAILMENT" | "DAM_RTM";

interface Ticket {
  signal: Signal;
  timestamp: string;
  classification: string;
  summary: string;
  routedTeam: string;
  suggestedAction: string;
}

interface Point {
  time: string;
  value: number;
}

interface Status {
  fetchedAt: string;
  intervalEnding: string;
  gen: number;
  hsl: number;
  ratio: number;
  baselineRatio: number;
  price: number;
  priceDate: string;
  classification: CurtailmentClass;
  trend: { ratio: Point[]; price: Point[] };
  forecast: { points: Point[]; trendLabel: Trend; forecastRunAt: string };
  damRtm: {
    dam: number;
    rtm: number;
    deviation: number;
    baselineAbsDeviation: number;
    classification: DamRtmClass;
    trendRtm: Point[];
    trendDam: Point[];
  };
  fleet: {
    units: MockUnit[];
    events: FleetEvent[];
    stats: { totalFlagged: number; autoResolved: number; suppressed: number; scheduled: number; dispatched: number };
    savingsLow: number;
    savingsHigh: number;
    cyclingStressMultiplier: number;
  };
  tickets: Ticket[];
  error?: string;
}

// --- Fleet Health / "Telemetry CI/CD" (MOCKED telemetry, cross-checked against REAL ERCOT signals above) ---

type Triage = "AUTO_FIXABLE" | "SCHEDULE_MAINTENANCE" | "DISPATCH_NOW" | "SUPPRESSED_BY_ERCOT_CONTEXT";

interface MockUnit {
  id: string;
  tempC: number;
  efficiencyPct: number;
  faultCode: string | null;
  status: "ONLINE" | "OFFLINE";
}

interface FleetEvent {
  timestamp: string;
  unitId: string;
  issue: string;
  triage: Triage;
  resolution: string;
  ercotContext?: string;
}

const UNIT_COUNT = 10;
// Truck-roll cost range: $150-300 direct (Aberdeen Group), up to ~$1,000 fully loaded (TSIA) —
// industry-estimate figures repeated across vendor/trade sources, not a single verified primary study.
const TRUCK_ROLL_LOW = 200;
const TRUCK_ROLL_HIGH = 1000;

const mockFleet: MockUnit[] = Array.from({ length: UNIT_COUNT }, (_, i) => ({
  id: `INV-${1000 + i}`,
  tempC: 35 + Math.random() * 5,
  efficiencyPct: 96 + Math.random() * 2,
  faultCode: null,
  status: "ONLINE",
}));

const fleetEvents: FleetEvent[] = [];
const fleetStats = { totalFlagged: 0, autoResolved: 0, suppressed: 0, scheduled: 0, dispatched: 0 };

function stepMockFleet(cyclingStressMultiplier: number, curtailmentClass: CurtailmentClass) {
  for (const unit of mockFleet) {
    unit.tempC += (Math.random() - 0.45) * 0.5 * cyclingStressMultiplier;
    unit.efficiencyPct -= Math.random() * 0.05 * cyclingStressMultiplier;

    if (unit.faultCode === null && unit.status === "ONLINE" && Math.random() < 0.03) {
      const roll = Math.random();
      if (roll < 0.4) unit.faultCode = "E1_COMMS_TIMEOUT";
      else if (roll < 0.7) unit.faultCode = "E2_SOFT_RESET_NEEDED";
      else if (roll < 0.85) unit.status = "OFFLINE";
      else {
        unit.faultCode = "E9_INVERTER_FAULT";
        unit.status = "OFFLINE";
      }
    }

    const needsAttention = unit.faultCode !== null || unit.status === "OFFLINE" || unit.efficiencyPct < 90;
    if (!needsAttention) continue;

    const issue = unit.faultCode ?? (unit.status === "OFFLINE" ? "unexpected offline, no fault code" : `efficiency degraded to ${unit.efficiencyPct.toFixed(1)}%`);
    fleetStats.totalFlagged++;
    let triage: Triage;
    let resolution: string;
    let ercotContext: string | undefined;

    if (unit.status === "OFFLINE" && unit.faultCode === null && curtailmentClass === "OVERSUPPLY") {
      triage = "SUPPRESSED_BY_ERCOT_CONTEXT";
      resolution = `${unit.id} isn't discharging, but real-time ERCOT data shows an active oversupply window — expected behavior, not a fault. No technician, no ticket.`;
      ercotContext = "Curtailment Radar: OVERSUPPLY (real, live)";
      fleetStats.suppressed++;
      unit.status = "ONLINE";
    } else if (unit.faultCode === "E1_COMMS_TIMEOUT" || unit.faultCode === "E2_SOFT_RESET_NEEDED") {
      triage = "AUTO_FIXABLE";
      resolution = `Sent a remote reset command to ${unit.id} — resolved without a technician.`;
      fleetStats.autoResolved++;
      unit.faultCode = null;
      unit.status = "ONLINE";
    } else if (unit.faultCode === "E9_INVERTER_FAULT") {
      triage = "DISPATCH_NOW";
      resolution = `Hard inverter fault on ${unit.id} — dispatching a technician with the trend history pre-loaded (temp climbed to ${unit.tempC.toFixed(1)}°C, efficiency fell to ${unit.efficiencyPct.toFixed(1)}% beforehand), instead of an investigation starting from zero.`;
      fleetStats.dispatched++;
      unit.faultCode = null;
      unit.status = "ONLINE";
    } else if (unit.efficiencyPct < 90) {
      triage = "SCHEDULE_MAINTENANCE";
      resolution = `${unit.id} efficiency degraded to ${unit.efficiencyPct.toFixed(1)}% — flagged for a scheduled, pre-diagnosed visit before this becomes a hard failure, not an emergency truck roll after the fact.`;
      fleetStats.scheduled++;
      unit.efficiencyPct = 96;
    } else {
      triage = "AUTO_FIXABLE";
      resolution = `${unit.id} back online.`;
      fleetStats.autoResolved++;
      unit.status = "ONLINE";
    }

    fleetEvents.unshift({ timestamp: new Date().toISOString(), unitId: unit.id, issue, triage, resolution, ercotContext });
    if (fleetEvents.length > 25) fleetEvents.length = 25;
  }
}

let cached: { at: number; status: Status } | undefined;
let lastCurtailmentClass: CurtailmentClass = "NORMAL";
let lastDamRtmClass: DamRtmClass = "NORMAL";
const tickets: Ticket[] = [];

function pushTicket(t: Ticket) {
  tickets.unshift(t);
  if (tickets.length > 25) tickets.length = 25;
}

function classifyCurtailment(ratio: number, baseline: number, price: number, priceP25: number): CurtailmentClass {
  const elevated = ratio > baseline * ELEVATED_MULTIPLIER;
  if (!elevated) return "NORMAL";
  return price <= priceP25 ? "OVERSUPPLY" : "CONGESTION";
}

function suggestedActionForCurtailment(classification: CurtailmentClass): { team: string; action: string } {
  if (classification === "OVERSUPPLY") {
    return {
      team: "Market Operations Engineer",
      action:
        "Elevated curtailment with depressed price — worth a check-in on whether the automated dispatch model is capturing this window; not urgent, informational.",
    };
  }
  return {
    team: "Market Operations Engineer",
    action:
      "Elevated curtailment with no depressed price — likely transmission-constrained, not oversupply. Check congestion/outage reports for this hub before assuming a trading opportunity.",
  };
}

function classifyDamRtm(deviation: number, baselineAbsDeviation: number): DamRtmClass {
  const elevated = Math.abs(deviation) > baselineAbsDeviation * ELEVATED_MULTIPLIER;
  if (!elevated) return "NORMAL";
  return deviation > 0 ? "HIGH_RTM" : "LOW_RTM";
}

function suggestedActionForDamRtm(classification: DamRtmClass, deviation: number): { team: string; action: string } {
  if (classification === "HIGH_RTM") {
    return {
      team: "Market Operations Engineer",
      action: `Real-time price is running $${deviation.toFixed(2)}/MWh above this hour's day-ahead price — a real, capturable spread if discharge capacity was available. Worth checking whether it was caught.`,
    };
  }
  return {
    team: "Market Operations Engineer",
    action: `Real-time price is running $${Math.abs(deviation).toFixed(2)}/MWh below this hour's day-ahead price — a charging opportunity relative to what was committed day-ahead.`,
  };
}

function trendLabelFor(points: number[]): Trend {
  if (points.length < 2) return "FLAT";
  const first = points[0];
  const last = points[points.length - 1];
  const delta = (last - first) / Math.max(Math.abs(first), 1);
  if (delta > 0.05) return "RISING";
  if (delta < -0.05) return "FALLING";
  return "FLAT";
}

async function fetchWindAndTrend(): Promise<{
  latestPosted: string;
  intervalEnding: string;
  gen: number;
  hsl: number;
  ratio: number;
  baselineRatio: number;
  ratioTrend: Point[];
}> {
  const wind = (await ercotGet(`${API_BASE}/np4-733-cd/wpp_actual_5min_avg_values`, {
    size: BASELINE_WINDOW + 1,
  })) as any;
  const rows: any[][] = wind.data; // DESC by intervalEnding: rows[0] is most recent
  const [latestPosted, intervalEnding, gen, , , , hsl] = rows[0];
  const ratio = (hsl - gen) / hsl;

  const older = rows.slice(1);
  const baselineRatios = older.map((r) => (r[6] - r[2]) / r[6]);
  const baselineRatio = baselineRatios.reduce((a, b) => a + b, 0) / baselineRatios.length;

  const ratioTrend: Point[] = [...rows].reverse().map((r) => ({ time: r[1], value: (r[6] - r[2]) / r[6] }));

  return { latestPosted, intervalEnding, gen, hsl, ratio, baselineRatio, ratioTrend };
}

async function fetchPriceAndTrend(
  today: string,
): Promise<{ latestPrice: number; priceP25: number; priceTrend: Point[]; allRows: any[][] }> {
  const priceResp = (await ercotGet(`${API_BASE}/np6-905-cd/spp_node_zone_hub`, {
    size: 500,
    settlementPoint: HUB,
    deliveryDateFrom: today,
    deliveryDateTo: today,
  })) as any;
  const priceRows: any[][] = priceResp.data; // ascending through the day
  const prices = priceRows.map((r) => r[5] as number);
  const sorted = [...prices].sort((a, b) => a - b);
  const priceP25 = sorted[Math.floor(sorted.length * 0.25)] ?? sorted[0];
  const latestPrice = prices[prices.length - 1];

  const recent = priceRows.slice(-16); // last ~4 hours at 15-min settlement
  const priceTrend: Point[] = recent.map((r) => ({ time: `${r[0]} H${r[1]}I${r[2]}`, value: r[5] as number }));

  return { latestPrice, priceP25, priceTrend, allRows: priceRows };
}

async function fetchForecast(): Promise<{ points: Point[]; trendLabel: Trend; forecastRunAt: string }> {
  const resp = (await ercotGet(`${API_BASE}/np4-751-cd/ih_wind_fcast_geo`, { size: 1000 })) as any;
  const rows: any[][] = resp.data;
  if (rows.length === 0) return { points: [], trendLabel: "FLAT", forecastRunAt: "" };

  const latestPosted = rows[0][0];
  const latestRun = rows.filter((r) => r[0] === latestPosted && r[5] === true);

  const byInterval = new Map<string, number>();
  for (const r of latestRun) {
    const intervalEnding = r[1] as string;
    const value = r[3] as number;
    byInterval.set(intervalEnding, (byInterval.get(intervalEnding) ?? 0) + value);
  }

  const points: Point[] = [...byInterval.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, value]) => ({ time, value }));
  const trendLabel = trendLabelFor(points.map((p) => p.value));
  return { points, trendLabel, forecastRunAt: latestPosted };
}

function hourEndingFor(deliveryHour: number): string {
  return String(deliveryHour).padStart(2, "0") + ":00";
}

async function fetchDamPrices(today: string): Promise<Map<string, number>> {
  const dam = (await ercotGet(`${API_BASE}/np4-190-cd/dam_stlmnt_pnt_prices`, {
    size: 48,
    settlementPoint: HUB,
    deliveryDateFrom: today,
    deliveryDateTo: today,
  })) as any;
  const rows: any[][] = dam.data;
  const byHour = new Map<string, number>();
  for (const r of rows) byHour.set(r[1], r[3]);
  return byHour;
}

function computeDamRtm(rtmRowsToday: any[][], damByHour: Map<string, number>) {
  const withDeviation = rtmRowsToday
    .map((r) => {
      const hourEnding = hourEndingFor(r[1]);
      const dam = damByHour.get(hourEnding);
      const rtm = r[5] as number;
      return { time: `${r[0]} H${r[1]}I${r[2]}`, rtm, dam: dam ?? null, deviation: dam != null ? rtm - dam : null };
    })
    .filter((x): x is { time: string; rtm: number; dam: number; deviation: number } => x.dam != null);

  const latest = withDeviation[withDeviation.length - 1];
  const recent = withDeviation.slice(-16);
  const baselineSample = recent.slice(0, -1);
  const baselineAbsDeviation =
    baselineSample.length > 0
      ? baselineSample.reduce((a, b) => a + Math.abs(b.deviation), 0) / baselineSample.length
      : Math.abs(latest.deviation);

  return {
    latest,
    baselineAbsDeviation,
    rtmTrend: recent.map((p) => ({ time: p.time, value: p.rtm })),
    damTrend: recent.map((p) => ({ time: p.time, value: p.dam })),
  };
}

async function fetchStatus(): Promise<Status> {
  const wind = await fetchWindAndTrend();
  const today = String(wind.intervalEnding).slice(0, 10);
  const [priceInfo, forecast, damByHour] = await Promise.all([
    fetchPriceAndTrend(today),
    fetchForecast(),
    fetchDamPrices(today),
  ]);

  const curtailmentClass = classifyCurtailment(wind.ratio, wind.baselineRatio, priceInfo.latestPrice, priceInfo.priceP25);
  if (curtailmentClass !== "NORMAL" && curtailmentClass !== lastCurtailmentClass) {
    const { team, action } = suggestedActionForCurtailment(curtailmentClass);
    pushTicket({
      signal: "CURTAILMENT",
      timestamp: wind.latestPosted,
      classification: curtailmentClass,
      summary: `ratio ${(wind.ratio * 100).toFixed(2)}% vs baseline ${(wind.baselineRatio * 100).toFixed(2)}%, price $${priceInfo.latestPrice.toFixed(2)}`,
      routedTeam: team,
      suggestedAction: action,
    });
  }
  lastCurtailmentClass = curtailmentClass;

  const damRtmCalc = computeDamRtm(priceInfo.allRows, damByHour);
  const damRtmClass = classifyDamRtm(damRtmCalc.latest.deviation, damRtmCalc.baselineAbsDeviation);
  if (damRtmClass !== "NORMAL" && damRtmClass !== lastDamRtmClass) {
    const { team, action } = suggestedActionForDamRtm(damRtmClass, damRtmCalc.latest.deviation);
    pushTicket({
      signal: "DAM_RTM",
      timestamp: new Date().toISOString(),
      classification: damRtmClass,
      summary: `RTM $${damRtmCalc.latest.rtm.toFixed(2)} vs DAM $${damRtmCalc.latest.dam.toFixed(2)} (Δ $${damRtmCalc.latest.deviation.toFixed(2)})`,
      routedTeam: team,
      suggestedAction: action,
    });
  }
  lastDamRtmClass = damRtmClass;

  // Real ERCOT price volatility as a proxy for how hard the fleet has been cycling this week —
  // higher real deviation -> assumed higher wear rate on the mocked fleet. Heuristic, not validated
  // against real failure data.
  const cyclingStressMultiplier = 1 + Math.min(damRtmCalc.baselineAbsDeviation / 15, 2);
  stepMockFleet(cyclingStressMultiplier, curtailmentClass);
  const dispatchesAvoided = fleetStats.autoResolved + fleetStats.suppressed;

  return {
    fetchedAt: new Date().toISOString(),
    intervalEnding: wind.intervalEnding,
    gen: wind.gen,
    hsl: wind.hsl,
    ratio: wind.ratio,
    baselineRatio: wind.baselineRatio,
    price: priceInfo.latestPrice,
    priceDate: today,
    classification: curtailmentClass,
    trend: { ratio: wind.ratioTrend, price: priceInfo.priceTrend },
    forecast,
    damRtm: {
      dam: damRtmCalc.latest.dam,
      rtm: damRtmCalc.latest.rtm,
      deviation: damRtmCalc.latest.deviation,
      baselineAbsDeviation: damRtmCalc.baselineAbsDeviation,
      classification: damRtmClass,
      trendRtm: damRtmCalc.rtmTrend,
      trendDam: damRtmCalc.damTrend,
    },
    fleet: {
      units: mockFleet,
      events: fleetEvents,
      stats: fleetStats,
      savingsLow: dispatchesAvoided * TRUCK_ROLL_LOW,
      savingsHigh: dispatchesAvoided * TRUCK_ROLL_HIGH,
      cyclingStressMultiplier,
    },
    tickets,
  };
}

async function getStatus(): Promise<Status> {
  if (cached && Date.now() - cached.at < POLL_CACHE_MS) return cached.status;
  try {
    const status = await fetchStatus();
    cached = { at: Date.now(), status };
    return status;
  } catch (error) {
    const fallback: Status = cached?.status ?? {
      fetchedAt: new Date().toISOString(),
      intervalEnding: "",
      gen: 0,
      hsl: 0,
      ratio: 0,
      baselineRatio: 0,
      price: 0,
      priceDate: "",
      classification: "NORMAL",
      trend: { ratio: [], price: [] },
      forecast: { points: [], trendLabel: "FLAT", forecastRunAt: "" },
      damRtm: {
        dam: 0,
        rtm: 0,
        deviation: 0,
        baselineAbsDeviation: 0,
        classification: "NORMAL",
        trendRtm: [],
        trendDam: [],
      },
      fleet: { units: mockFleet, events: fleetEvents, stats: fleetStats, savingsLow: 0, savingsHigh: 0, cyclingStressMultiplier: 1 },
      tickets,
    };
    return { ...fallback, error: error instanceof Error ? error.message : String(error) };
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Issue Router — Live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{
    --bg:#f5f6f8; --surface:#ffffff; --surface-2:#eef1f5;
    --text:#10151c; --text-muted:#5b6472; --border:#dde2e8;
    --accent:#c2650a; --accent-ink:#7a3f05; --accent-soft:#fbe6cc;
    --teal:#0f766e; --teal-soft:#dcf4f1;
    --good:#15803d; --good-soft:#dcf5e4;
    --crit:#b91c1c; --crit-soft:#fde2e1;
    --purple:#6d28d9; --purple-soft:#ede9fe;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0b0f14; --surface:#121923; --surface-2:#1a2330;
      --text:#e7ebf1; --text-muted:#8f9bab; --border:#263241;
      --accent:#f0a020; --accent-ink:#ffd9a0; --accent-soft:#3a2a10;
      --teal:#2dd4bf; --teal-soft:#0f2a28;
      --good:#4ade80; --good-soft:#0f2a1a;
      --crit:#f87171; --crit-soft:#3a1414;
      --purple:#a78bfa; --purple-soft:#241a3d;
    }
  }
  *{box-sizing:border-box;}
  body{background:var(--bg); color:var(--text); font-family:'Public Sans', system-ui, sans-serif; margin:0; padding:32px 20px 80px; line-height:1.5;}
  .wrap{max-width:960px; margin:0 auto;}
  h1{font-family:'Space Grotesk', system-ui, sans-serif; font-size:1.8rem; margin:0;}
  .sub{color:var(--text-muted); margin-top:8px; font-size:.95rem; max-width:70ch;}
  h2{font-family:'Space Grotesk', system-ui, sans-serif; font-size:1.15rem; margin:0 0 4px;}
  .signal-eyebrow{font-family:'IBM Plex Mono', monospace; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--teal); margin:0 0 6px;}
  .section-desc{font-size:.85rem; color:var(--text-muted); margin:0 0 14px;}
  .cards{display:grid; grid-template-columns:repeat(auto-fit, minmax(260px,1fr)); gap:16px; margin-top:14px;}
  .card{background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:18px 20px;}
  section{margin-top:44px;}
  section.signal-block{padding-top:28px; border-top:1px solid var(--border);}

  .statrow{display:flex; gap:12px; flex-wrap:wrap;}
  .stat{flex:1; min-width:140px; background:var(--surface-2); border:1px solid var(--border); border-radius:10px; padding:12px 14px;}
  .stat .num{font-family:'IBM Plex Mono', monospace; font-size:1.4rem; font-weight:600;}
  .stat .lbl{font-size:.78rem; color:var(--text-muted); margin-top:4px; display:flex; align-items:center; gap:4px;}

  .tip{position:relative; display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:50%; background:var(--border); color:var(--text-muted); font-size:10px; font-weight:700; cursor:help;}
  .tip:hover::after{
    content:attr(data-tip); position:absolute; bottom:130%; left:50%; transform:translateX(-50%);
    background:var(--text); color:var(--bg); font-family:'Public Sans', sans-serif; font-weight:400;
    font-size:.78rem; line-height:1.35; padding:8px 10px; border-radius:8px; width:220px; z-index:10;
    box-shadow:0 4px 16px rgba(0,0,0,.2); text-align:left;
  }
  .tip:hover::before{
    content:''; position:absolute; bottom:118%; left:50%; transform:translateX(-50%);
    border:5px solid transparent; border-top-color:var(--text); z-index:10;
  }

  .status-badge{display:inline-block; font-family:'IBM Plex Mono', monospace; font-size:.85rem; padding:6px 14px; border-radius:99px; margin-top:16px; font-weight:600;}
  .status-badge.NORMAL{background:var(--good-soft); color:var(--good);}
  .status-badge.OVERSUPPLY,.status-badge.HIGH_RTM{background:var(--accent-soft); color:var(--accent-ink);}
  .status-badge.CONGESTION,.status-badge.LOW_RTM{background:var(--crit-soft); color:var(--crit);}

  .trend-label{display:inline-block; font-family:'IBM Plex Mono', monospace; font-size:.75rem; padding:3px 9px; border-radius:99px; margin-top:8px;}
  .trend-label.RISING{background:var(--accent-soft); color:var(--accent-ink);}
  .trend-label.FALLING{background:var(--teal-soft); color:var(--teal);}
  .trend-label.FLAT{background:var(--surface-2); color:var(--text-muted);}

  svg.spark{display:block; width:100%; height:60px; margin-top:10px;}
  .spark path{fill:none; stroke:var(--accent); stroke-width:2;}
  .spark.price path{stroke:var(--teal);}
  .spark.forecast path{stroke:var(--purple);}
  .spark path.dam{stroke:var(--text-muted); stroke-dasharray:3 3;}
  .spark path.rtm{stroke:var(--accent);}
  .legend{display:flex; gap:14px; margin-top:8px; font-size:.75rem; color:var(--text-muted);}
  .legend span{display:inline-flex; align-items:center; gap:5px;}
  .swatch{width:14px; height:2px; display:inline-block;}

  .ticket{background:var(--surface); border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:10px; padding:14px 16px; margin-top:12px; font-size:.92rem;}
  .ticket.CONGESTION,.ticket.LOW_RTM{border-left-color:var(--crit);}
  .ticket .sig{font-family:'IBM Plex Mono', monospace; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; color:var(--teal); display:block; margin-bottom:2px;}
  .ticket .meta{font-family:'IBM Plex Mono', monospace; font-size:.78rem; color:var(--text-muted); display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;}
  .empty{color:var(--text-muted); font-size:.92rem; margin-top:12px;}
  .note{margin-top:16px; font-size:.85rem; color:var(--text-muted); border-left:3px solid var(--border); padding-left:12px;}
  .err{margin-top:16px; color:var(--crit); font-size:.9rem;}

  .mock-flag{display:inline-block; font-family:'IBM Plex Mono', monospace; font-size:.68rem; text-transform:uppercase; letter-spacing:.05em; background:var(--purple-soft); color:var(--purple); border-radius:5px; padding:2px 7px; margin-left:8px;}
  .fleet-grid{display:grid; grid-template-columns:repeat(auto-fill, minmax(90px,1fr)); gap:8px; margin-top:14px;}
  .unit{background:var(--surface-2); border:1px solid var(--border); border-radius:8px; padding:8px; font-family:'IBM Plex Mono', monospace; font-size:.7rem; text-align:center;}
  .unit.fault{border-color:var(--crit); background:var(--crit-soft);}
  .unit.offline{border-color:var(--accent); background:var(--accent-soft);}
  .unit .id{font-weight:600;}
  .savings{display:flex; gap:16px; flex-wrap:wrap; margin-top:16px;}
  .event{background:var(--surface); border:1px solid var(--border); border-left:4px solid var(--purple); border-radius:10px; padding:12px 16px; margin-top:10px; font-size:.9rem;}
  .event.DISPATCH_NOW{border-left-color:var(--crit);}
  .event.AUTO_FIXABLE,.event.SUPPRESSED_BY_ERCOT_CONTEXT{border-left-color:var(--good);}
  .event.SCHEDULE_MAINTENANCE{border-left-color:var(--accent);}
  .event .triage-lbl{font-family:'IBM Plex Mono', monospace; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em;}
</style>
</head>
<body>
<div class="wrap">
  <h1>Issue Router — Live</h1>
  <p class="sub">Three independent detectors, one shared feed and router — proof this scales past a single hard-coded signal. The two market signals poll real ERCOT data every ${POLL_CACHE_MS / 1000}s; Fleet Health below uses <strong>mocked</strong> telemetry (we don't have access to Base's real fleet data) cross-checked against the real ERCOT signals above it.</p>
  <div id="err" class="err" hidden></div>

  <section class="signal-block">
    <div class="signal-eyebrow">Signal 02 · Curtailment Radar</div>
    <h2>Now</h2>
    <p class="section-desc">What's happening on the grid at this exact interval.</p>
    <div class="card">
      <div class="statrow">
        <div class="stat">
          <div class="num" id="ratio">—</div>
          <div class="lbl">curtailment ratio <span class="tip" data-tip="Share of available wind capacity not being used right now: (HSL − actual output) / HSL. On its own this doesn't say why — check price for that.">?</span></div>
        </div>
        <div class="stat">
          <div class="num" id="baseline">—</div>
          <div class="lbl">trailing ~4h baseline <span class="tip" data-tip="Average curtailment ratio over the last 4 hours. Used to judge whether right now is unusual, not just normal variation.">?</span></div>
        </div>
        <div class="stat">
          <div class="num" id="price">—</div>
          <div class="lbl">${HUB} price ($/MWh) <span class="tip" data-tip="Real-time price at this hub. Depressed price + elevated curtailment = likely oversupply. Normal/high price + elevated curtailment = likely transmission congestion instead.">?</span></div>
        </div>
      </div>
      <span id="badge" class="status-badge NORMAL">NORMAL</span>
    </div>

    <h2 style="margin-top:28px">Past — last ~4 hours</h2>
    <p class="section-desc">Is this a one-off blip or a sustained pattern?</p>
    <div class="cards">
      <div class="card">
        <div class="lbl">curtailment ratio trend <span class="tip" data-tip="Each point is one real 5-minute interval. A rising line means curtailment has been building, not just spiking once.">?</span></div>
        <svg class="spark ratio" id="sparkRatio" viewBox="0 0 300 60" preserveAspectRatio="none"></svg>
      </div>
      <div class="card">
        <div class="lbl">${HUB} price trend <span class="tip" data-tip="Real settlement prices for this hub over roughly the last 4 hours.">?</span></div>
        <svg class="spark price" id="sparkPrice" viewBox="0 0 300 60" preserveAspectRatio="none"></svg>
      </div>
    </div>

    <h2 style="margin-top:28px">Future — next ~2 hours (forecast)</h2>
    <p class="section-desc">ERCOT's own intra-hour wind forecast (<code>NP4-751-CD</code>), not a projection we invented.</p>
    <div class="card">
      <div class="lbl">forecasted wind potential <span class="tip" data-tip="ERCOT's rolling 2-hour, 5-minute wind production POTENTIAL forecast (uncurtailed), summed across regions. Potential, not dispatch — context for oversupply risk building, not a firm prediction.">?</span></div>
      <svg class="spark forecast" id="sparkForecast" viewBox="0 0 300 60" preserveAspectRatio="none"></svg>
      <span id="forecastTrend" class="trend-label FLAT">FLAT</span>
    </div>
  </section>

  <section class="signal-block">
    <div class="signal-eyebrow">Signal 01 · DAM–RTM Deviation</div>
    <h2>Now</h2>
    <p class="section-desc">Real-time price vs. the price already committed a day ahead for this hour — a direct profit signal, not a classification call.</p>
    <div class="card">
      <div class="statrow">
        <div class="stat">
          <div class="num" id="damPrice">—</div>
          <div class="lbl">day-ahead price, this hour <span class="tip" data-tip="The price already cleared yesterday for this hour — a fixed commitment, not something that moves anymore.">?</span></div>
        </div>
        <div class="stat">
          <div class="num" id="rtmPrice">—</div>
          <div class="lbl">real-time price, latest 15-min <span class="tip" data-tip="What the same hour is actually settling at right now, interval by interval — this is what moves.">?</span></div>
        </div>
        <div class="stat">
          <div class="num" id="deviation">—</div>
          <div class="lbl">deviation ($/MWh) <span class="tip" data-tip="RTM minus DAM. A real 30-day backtest of this exact signal found a mean deviation of $9.95/MWh, and $49.41/MWh in the worst decile of hours.">?</span></div>
        </div>
      </div>
      <span id="damRtmBadge" class="status-badge NORMAL">NORMAL</span>
    </div>

    <h2 style="margin-top:28px">Past — last ~4 hours</h2>
    <p class="section-desc">Day-ahead is a flat step per hour; real-time moves every 15 minutes. The gap between the two lines is the opportunity.</p>
    <div class="card">
      <div class="lbl">DAM (committed) vs RTM (actual) <span class="tip" data-tip="Dashed line = day-ahead price (fixed per hour). Solid line = real-time price (moves every 15 min). Distance between them is the deviation.">?</span></div>
      <svg class="spark" id="sparkDamRtm" viewBox="0 0 300 60" preserveAspectRatio="none"></svg>
      <div class="legend">
        <span><span class="swatch" style="background:var(--text-muted); border-top:2px dashed var(--text-muted); height:0;"></span>day-ahead</span>
        <span><span class="swatch" style="background:var(--accent);"></span>real-time</span>
      </div>
    </div>
  </section>

  <section class="signal-block">
    <div class="signal-eyebrow">Signal 03 · Fleet Health — "Telemetry CI/CD"<span class="mock-flag">mocked telemetry</span></div>
    <h2>Now</h2>
    <p class="section-desc">The pain point this answers: an inverter can be degrading — or already blown — and nobody knows until telemetry happens to flag it, at which point a technician is dispatched to retrieve the unit and investigate blind. This continuously watches degradation trends, attempts an automated fix first, and cross-checks against the real ERCOT signals above before ever creating a ticket.</p>
    <div class="card">
      <div class="fleet-grid" id="fleetGrid"></div>
      <div class="savings">
        <div class="stat">
          <div class="num" id="dispatchesAvoided">—</div>
          <div class="lbl">dispatches avoided so far <span class="tip" data-tip="Auto-fixed remotely, or correctly suppressed because real ERCOT data explained the behavior — either way, no truck roll.">?</span></div>
        </div>
        <div class="stat">
          <div class="num" id="savingsRange">—</div>
          <div class="lbl">estimated savings <span class="tip" data-tip="Dispatches avoided × $200-$1,000 per truck roll (Aberdeen Group / TSIA industry estimates — a repeated vendor benchmark, not a single verified primary study). Illustrative on this mocked fleet, not a real Base number.">?</span></div>
        </div>
        <div class="stat">
          <div class="num" id="cyclingStress">—</div>
          <div class="lbl">cycling stress multiplier <span class="tip" data-tip="Derived from the REAL DAM-RTM deviation above: the more real arbitrage volatility this week, the harder a fleet plausibly cycles, and the faster this mocked fleet's simulated wear accumulates. A heuristic, not validated against real failure data.">?</span></div>
        </div>
      </div>
    </div>

    <h2 style="margin-top:28px">Event feed</h2>
    <p class="section-desc">Every flagged unit, and what happened instead of an automatic dispatch.</p>
    <div id="fleetEvents"><p class="empty">No fleet events yet — polling live.</p></div>
    <p class="note">Mocked: unit telemetry (temperature, efficiency, fault codes) — we don't have access to Base's real fleet data. Real: the ERCOT cross-checks (Curtailment Radar classification for suppression, DAM–RTM deviation for the cycling-stress multiplier) and the truck-roll cost citation.</p>
  </section>

  <section>
    <h2>Ticket feed</h2>
    <p class="section-desc">Only fires on a state change per signal, not every poll <span class="tip" data-tip="Debounced on purpose: paging someone every 20 seconds for the same ongoing condition would be noise, not signal.">?</span> — one shared feed for both detectors, this is the payload a real paging integration would send.</p>
    <div id="tickets"><p class="empty">No anomalies detected yet — polling live.</p></div>
  </section>

  <p class="note">Simplified thresholds for this live demo on both signals (elevated = &gt;1.25× a trailing baseline) — not the full 30-day percentile models described in the Curtailment Radar / Signal Engine specs. No paging integration is wired up; tickets show the payload such an integration would send.</p>
</div>
<script>
function sparkPath(points, key) {
  key = key || 'value';
  if (!points || points.length < 2) return '';
  const vals = points.map(p => p[key]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const w = 300, h = 60, pad = 4;
  return points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - pad - ((p[key] - min) / range) * (h - pad * 2);
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}
function renderSpark(id, points) {
  const el = document.getElementById(id);
  const d = sparkPath(points);
  el.innerHTML = d ? '<path d="' + d + '"/>' : '';
}
function renderDualSpark(id, rtmPoints, damPoints) {
  const el = document.getElementById(id);
  if (!rtmPoints || !damPoints || rtmPoints.length < 2) { el.innerHTML = ''; return; }
  const allVals = rtmPoints.map(p=>p.value).concat(damPoints.map(p=>p.value));
  const min = Math.min(...allVals), max = Math.max(...allVals);
  const range = (max - min) || 1;
  const w = 300, h = 60, pad = 4;
  function pathFor(points) {
    return points.map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - pad - ((p.value - min) / range) * (h - pad * 2);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  }
  el.innerHTML = '<path class="dam" d="' + pathFor(damPoints) + '"/><path class="rtm" d="' + pathFor(rtmPoints) + '"/>';
}
async function tick(){
  try{
    const res = await fetch('/api/status');
    const s = await res.json();
    document.getElementById('err').hidden = !s.error;
    if (s.error) document.getElementById('err').textContent = 'Last fetch error (showing cached data): ' + s.error;

    document.getElementById('ratio').textContent = (s.ratio*100).toFixed(2) + '%';
    document.getElementById('baseline').textContent = (s.baselineRatio*100).toFixed(2) + '%';
    document.getElementById('price').textContent = '$' + s.price.toFixed(2);
    const badge = document.getElementById('badge');
    badge.textContent = s.classification;
    badge.className = 'status-badge ' + s.classification;

    renderSpark('sparkRatio', s.trend.ratio);
    renderSpark('sparkPrice', s.trend.price);
    renderSpark('sparkForecast', s.forecast.points);
    const ft = document.getElementById('forecastTrend');
    ft.textContent = s.forecast.trendLabel + (s.forecast.forecastRunAt ? ' · run ' + new Date(s.forecast.forecastRunAt).toLocaleTimeString() : '');
    ft.className = 'trend-label ' + s.forecast.trendLabel;

    document.getElementById('damPrice').textContent = '$' + s.damRtm.dam.toFixed(2);
    document.getElementById('rtmPrice').textContent = '$' + s.damRtm.rtm.toFixed(2);
    document.getElementById('deviation').textContent = (s.damRtm.deviation >= 0 ? '+' : '') + '$' + s.damRtm.deviation.toFixed(2);
    const drBadge = document.getElementById('damRtmBadge');
    drBadge.textContent = s.damRtm.classification;
    drBadge.className = 'status-badge ' + s.damRtm.classification;
    renderDualSpark('sparkDamRtm', s.damRtm.trendRtm, s.damRtm.trendDam);

    const grid = document.getElementById('fleetGrid');
    grid.innerHTML = s.fleet.units.map(u => {
      const cls = u.faultCode ? 'fault' : (u.status === 'OFFLINE' ? 'offline' : '');
      return \`<div class="unit \${cls}"><div class="id">\${u.id}</div><div>\${u.faultCode ?? u.status}</div><div>\${u.efficiencyPct.toFixed(0)}% eff</div></div>\`;
    }).join('');
    document.getElementById('dispatchesAvoided').textContent = (s.fleet.stats.autoResolved + s.fleet.stats.suppressed);
    document.getElementById('savingsRange').textContent = '$' + s.fleet.savingsLow.toLocaleString() + '–$' + s.fleet.savingsHigh.toLocaleString();
    document.getElementById('cyclingStress').textContent = s.fleet.cyclingStressMultiplier.toFixed(2) + '×';

    const fEl = document.getElementById('fleetEvents');
    if (s.fleet.events.length === 0) {
      fEl.innerHTML = '<p class="empty">No fleet events yet — polling live.</p>';
    } else {
      fEl.innerHTML = s.fleet.events.map(e => \`
        <div class="event \${e.triage}">
          <span class="triage-lbl">\${e.triage.replace(/_/g,' ')}</span> — \${e.unitId}
          <div class="meta" style="font-family:'IBM Plex Mono', monospace; font-size:.78rem; color:var(--text-muted); margin-top:4px;">
            <span>\${new Date(e.timestamp).toLocaleTimeString()}</span>
            <span>\${e.issue}</span>
            \${e.ercotContext ? '<span>' + e.ercotContext + '</span>' : ''}
          </div>
          <div style="margin-top:6px">\${e.resolution}</div>
        </div>
      \`).join('');
    }

    const el = document.getElementById('tickets');
    if (s.tickets.length === 0) {
      el.innerHTML = '<p class="empty">No anomalies detected yet — polling live.</p>';
    } else {
      el.innerHTML = s.tickets.map(t => \`
        <div class="ticket \${t.classification}">
          <span class="sig">\${t.signal === 'CURTAILMENT' ? 'Curtailment Radar' : 'DAM–RTM Deviation'}</span>
          <strong>\${t.classification}</strong> — routed to \${t.routedTeam}
          <div class="meta">
            <span>\${new Date(t.timestamp).toLocaleString()}</span>
            <span>\${t.summary}</span>
          </div>
          <div style="margin-top:6px">\${t.suggestedAction}</div>
        </div>
      \`).join('');
    }
  } catch(e) {
    document.getElementById('err').hidden = false;
    document.getElementById('err').textContent = 'Dashboard fetch failed: ' + e.message;
  }
}
tick();
setInterval(tick, ${POLL_CACHE_MS});
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/status") {
    try {
      const status = await getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGE);
});

server.listen(PORT, () => {
  console.log(`Issue Router dashboard running at http://localhost:${PORT}`);
});
