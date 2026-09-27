// Read-only technician counterpart to case-workspace.ts / fleet-dashboard.ts.
// A technician sees the real open Austin cases (from the real, stateful austinEngine — see
// src/response/austin-routes.ts — same engine fleet-dashboard.ts's Cases table now reads) and
// their own assigned Visits, sourced from that SAME Austin engine via /api/response-austin/*
// (not Carlos's separate simulated response engine at /api/response/*, which stays untouched
// and unmixed in here — see /response, src/response/routes.ts, src/pages/response-page.ts) —
// no example/mock case data, no approve/reject/close.
import { austinEngine } from "../response/austin-routes.js";
import type { RcaCase } from "../response/types.js";

interface CaseRow {
  id: string;
  asset: string;
  site: string;
  sev: "L0" | "L1" | "L2" | "L3" | "L4";
  rootCause: string;
  status: string;
}

const sevColors: Record<CaseRow["sev"], { bg: string; color: string }> = {
  L0: { bg: "#FDECEC", color: "#B42318" },
  L1: { bg: "#FFF3E0", color: "#9A5B00" },
  L2: { bg: "#FFF3E0", color: "#9A5B00" },
  L3: { bg: "#EAF3E7", color: "#1E4D2B" },
  L4: { bg: "#EAF3E7", color: "#1E4D2B" },
};

// Maps a real Austin RcaCase onto a row. `id` gets an "austin:" prefix so /case?case_id=...
// resolves unambiguously against austinEngine's case store rather than colliding with Carlos's
// simulated fleet's own "RCA-####" ids (both CaseStores mint the same sequence independently —
// see case-workspace.ts's header comment for the full collision note).
function deriveRow(c: RcaCase): CaseRow {
  return {
    id: `austin:${c.case_id}`,
    asset: c.vin,
    site: c.site,
    sev: c.status === "Escalated L0" ? "L0" : c.gameplan?.level ?? "L1",
    rootCause: c.hypothesis?.root_cause ?? "unknown",
    status: c.status,
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
      <div style="display: flex; align-items: center; gap: 10px;">
        <button id="tourBtn" class="btn btnGhost" type="button" title="Replay the walkthrough" style="font-family:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:5px 12px;cursor:pointer;background:#FFFFFF;color:#4A4944;border:1px solid #D8D5CC;">Tour</button>
        <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">Technician</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
      </div>
    </div>
    <div style="font-size: 24px; font-weight: 600; color: #292826;">Technician Dashboard</div>
    <div style="font-size: 15px; color: #6B6A64; margin-top: 2px; padding-bottom: 20px;">${subtitle}</div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>`;
}

function renderTechCaseRow(c: CaseRow): string {
  const sc = sevColors[c.sev];
  return `<div class="caseRow" onclick="window.location.href='/case?case_id=${encodeURIComponent(c.id)}'" style="display:grid;grid-template-columns:150px 130px 1fr 60px 220px 160px;gap:10px;padding:10px 6px;font-size:15px;border-bottom:1px solid #F0EEE9;align-items:center;cursor:pointer;">
    <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.id}</span>
    <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.asset}</span>
    <span>${c.site}</span>
    <span style="background:${sc.bg};color:${sc.color};font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;width:fit-content;">${c.sev}</span>
    <span class="mono" style="font-size:14px;color:#4A4944;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.rootCause}</span>
    <span style="color:#4A4944;">${c.status}</span>
  </div>`;
}

export async function renderTechnicianDashboard(): Promise<string> {
  const openCases = austinEngine
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
  ${header("click a case to see its details. Your assigned visits are below.")}
  <div style="padding: 32px 40px 80px;">
    <div id="casesCard" style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Open cases<span style="margin-left: 8px; font-size: 12px; font-weight: 400; color: #8A8880;">real Austin engine cases: real detectors + triage feed a real, stateful gameplan</span></div>
      <div style="display: grid; grid-template-columns: 150px 130px 1fr 60px 220px 160px; gap: 10px; padding: 8px 6px; font-size: 13px; font-weight: 600; color: #6B6A64; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #DEDAD2;">
        <span>Case#</span><span>Asset</span><span>Site</span><span>Sev</span><span>Root cause</span><span>Status</span>
      </div>
      <div>${openCases.length ? openCases.map(renderTechCaseRow).join("") : `<div style="padding: 16px 6px; color: #8A8880;">No open cases yet.</div>`}</div>
    </div>
    <div id="visitsCard" style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 18px 20px; margin-top: 24px;">
      <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 14px;">Visits &mdash; appointments assigned to you</div>
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
    return '<div class="visitCard" style="background:#FFFFFF;border:1px solid #DEDAD2;border-radius:8px;padding:12px 14px;margin-bottom:10px;' + (v.state !== "scheduled" ? "opacity:0.75;" : "") + '">'
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
    api("/api/response-austin/state").then(function (s) { state = s; render(); }).catch(function (e) {
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
      api("/api/response-austin/visit", { visit_id: d.visit, user_id: visit.assignee.id, outcome: outcome })
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
<script>
(function () {
  // First-visit onboarding walkthrough, same spotlight-tour pattern as /response's tour
  // (src/pages/response-page.ts's tourMain) — same visual style, remembered per browser under
  // its own key so visiting /response doesn't skip this one or vice versa. Replay with the Tour
  // button or /technician?tour=1.
  var KEY = "technician.tour.v1";
  var STEPS = [
    { title: "Welcome to your Technician dashboard",
      body: "Two things live here: every open case in the Austin fleet, and the visits actually assigned to you. This tour takes about 30 seconds." },
    { target: "#casesCard", title: "Open cases",
      body: "These are the open cases in the fleet. Wait here to be told what to do next." },
    { target: ".caseRow", title: "Case detail",
      body: "Click any row to open its full diagnostic report: the evidence, the confidence, and the timeline that led to the current severity level." },
    { target: "#visitsCard", title: "Your visits",
      body: "Once staff approves a dispatch step on a case, a real visit is scheduled here with your name on it — a time window, a briefing, and a checklist built from the actual diagnosis. Nothing appears here until that happens, so this card may still say 'No visits scheduled' right now." },
    { target: ".visitCard", title: "A visit",
      body: "This is where you check the brief, review the checklist, and see if photos are required before you can mark the visit complete." },
    { target: '[data-act="visitDone"]', title: "Complete or flag a visit",
      body: "Check “Photos attached” if required, then Complete visit once the work is done. If you can't finish — no access, wrong parts, needs an engineer — pick a reason and Mark incomplete instead." },
    { title: "That's it",
      body: "Open a case for the full picture, or head to your first visit when one's assigned. Replay this any time with the Tour button." },
  ];

  var i = 0;
  var curTarget;
  var root = null;
  var timer;

  function $(sel) { return document.querySelector(sel); }
  function esc(t) { return t.replace(/[&<>"]/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]; }); }
  function seen() { try { return localStorage.getItem(KEY) === "done"; } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(KEY, "done"); } catch (e) { /* storage blocked */ } }

  function build() {
    root = document.createElement("div");
    root.id = "tour";
    root.innerHTML = ''
      + '<div id="tourShade" style="position:fixed;inset:0;z-index:100;"></div>'
      + '<div id="tourHole" style="position:fixed;z-index:101;border-radius:10px;box-shadow:0 0 0 9999px rgba(30,29,27,0.58);outline:2px solid #FFFFFF;transition:all 0.25s ease;pointer-events:none;"></div>'
      + '<div id="tourCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle" style="position:fixed;z-index:102;background:#FFFFFF;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.25);padding:18px 20px 14px;width:min(380px,calc(100vw - 32px));transition:top 0.25s ease,left 0.25s ease;">'
      + '<div id="tourCount" style="font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#1E4D2B;"></div>'
      + '<div id="tourTitle" style="font-size:17px;font-weight:600;color:#292826;margin-top:4px;"></div>'
      + '<div id="tourBody" style="font-size:14px;line-height:1.5;color:#4A4944;margin-top:8px;"></div>'
      + '<div style="display:flex;align-items:center;gap:8px;margin-top:14px;">'
      + '<button type="button" data-tour="skip" style="font-family:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:5px 0;cursor:pointer;background:none;border:none;color:#6B6A64;">Skip tour</button>'
      + '<span style="flex:1;"></span>'
      + '<button type="button" data-tour="back" style="font-family:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:5px 12px;cursor:pointer;background:#FFFFFF;color:#4A4944;border:1px solid #D8D5CC;">Back</button>'
      + '<button type="button" data-tour="next" style="font-family:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:5px 12px;cursor:pointer;background:#1E4D2B;color:#FFFFFF;border:1px solid #1E4D2B;"></button>'
      + '</div>'
      + '<div id="tourDots" style="display:flex;gap:5px;justify-content:center;margin-top:12px;"></div>'
      + '</div>';
    document.body.appendChild(root);
    root.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-tour]");
      if (!b) return;
      var a = b.dataset.tour;
      if (a === "next") go(i + 1);
      else if (a === "back") go(i - 1);
      else if (a === "skip") end();
    });
  }

  function place() {
    if (!root) return;
    var hole = $("#tourHole");
    var card = $("#tourCard");
    var el = curTarget ? $(curTarget) : null;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cw = card.offsetWidth, ch = card.offsetHeight;
    if (!el) {
      hole.style.cssText += ";top:" + (vh / 2) + "px;left:" + (vw / 2) + "px;width:0;height:0;";
      card.style.top = Math.max(16, (vh - ch) / 2) + "px";
      card.style.left = Math.max(16, (vw - cw) / 2) + "px";
      return;
    }
    var r = el.getBoundingClientRect();
    var pad = 6;
    hole.style.top = (r.top - pad) + "px";
    hole.style.left = (r.left - pad) + "px";
    hole.style.width = (r.width + pad * 2) + "px";
    hole.style.height = (r.height + pad * 2) + "px";
    var top = r.bottom + 14;
    if (top + ch > vh - 16) top = r.top - ch - 14;
    if (top < 16) top = vh - ch - 16;
    var left = Math.min(Math.max(16, r.left), vw - cw - 16);
    card.style.top = top + "px";
    card.style.left = left + "px";
  }

  function go(n) {
    if (n >= STEPS.length) return end();
    i = Math.max(0, n);
    var step = STEPS[i];
    // If a step's target isn't on the page right now (e.g. no visits scheduled yet), fall back
    // to the containing card instead of pointing at nothing.
    var target = step.target;
    if (target && !$(target)) {
      if (target === ".visitCard" || target === '[data-act="visitDone"]') target = "#visitsCard";
      else if (!$(target)) target = undefined;
    }
    curTarget = target;
    $("#tourCount").textContent = "Step " + (i + 1) + " of " + STEPS.length;
    $("#tourTitle").textContent = step.title;
    $("#tourBody").innerHTML = esc(step.body);
    $("[data-tour=back]").style.visibility = i === 0 ? "hidden" : "visible";
    $("[data-tour=next]").textContent = i === 0 ? "Start" : i === STEPS.length - 1 ? "Done" : "Next";
    $("#tourDots").innerHTML = STEPS.map(function (_, k) {
      return '<span style="width:6px;height:6px;border-radius:50%;background:' + (k === i ? "#1E4D2B" : "#D8D5CC") + ';"></span>';
    }).join("");
    place();
    setTimeout(place, 350);
    $("[data-tour=next]").focus();
  }

  function start() {
    if (root) return;
    build();
    timer = window.setInterval(place, 400);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    document.addEventListener("keydown", onKey);
    go(0);
  }

  function end() {
    markSeen();
    if (timer) clearInterval(timer);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place);
    document.removeEventListener("keydown", onKey);
    if (root) root.remove();
    root = null;
  }

  function onKey(ev) {
    if (ev.key === "Escape") end();
    else if (ev.key === "ArrowRight" || ev.key === "Enter") { ev.preventDefault(); go(i + 1); }
    else if (ev.key === "ArrowLeft") go(i - 1);
  }

  var tourBtn = document.getElementById("tourBtn");
  if (tourBtn) tourBtn.addEventListener("click", function () { start(); });

  var force = new URLSearchParams(location.search).get("tour") === "1";
  if (force || !seen()) {
    var t0 = Date.now();
    var wait = window.setInterval(function () {
      if ($("#casesCard") || Date.now() - t0 > 6000) { clearInterval(wait); start(); }
    }, 200);
  }
})();
</script>
</body>
</html>`;
}
