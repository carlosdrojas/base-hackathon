// /response page for the Response Agent + Fake Fleet (design doc §12). Visual style matches
// fleet-dashboard.ts. The client script is written as a real function below and serialized with
// toString(), so it must not reference anything outside its own body.

/* eslint-disable @typescript-eslint/no-explicit-any */
function clientMain(): void {
  const USER_KEY = "response.user_id";
  const DEMO_USERS = ["u-osei", "u-alvarez", "u-park"];
  const PLANTABLE = [
    "fw_soft_fault_reboot_candidate",
    "fw_version_mismatch",
    "can_link_unreliable",
    "install_commissioning_incomplete",
    "install_wiring_or_sense_error",
    "grid_or_home_side_condition",
    "no_fault_found",
    "true_hardware_defect",
    "thermal_or_safety_event",
  ];
  const INCOMPLETE_REASONS = ["parts", "access", "did_not_know", "unsafe", "needs_engineer"];
  const ALLOWLIST = ["3.4.0"]; // mirrors fw_allowlist in the seed; the server is the real check

  let state: any = null;
  let userId = "u-alvarez";
  try { userId = localStorage.getItem(USER_KEY) || userId; } catch { /* storage blocked */ }
  let selectedCase: string | null = new URLSearchParams(location.search).get("case"); // deep link: /response?case=RCA-0003
  let plantMenuVin: string | null = null;
  let rejecting: string | null = null; // step_id with the reject form open
  let rejectReason = "";
  let closeNote = "";
  let openReport: string | null = null;
  const visitForm: Record<string, { photos: boolean; reason: string }> = {};
  let busy = false;

  const $ = (id: string) => document.getElementById(id)!;
  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  const pretty = (s: string) => s.replace(/_/g, " ");
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
  const me = () => state?.users.find((u: any) => u.id === userId) ?? state?.users[0];

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
  const chip = (text: string, c: [string, string] | undefined, extra = "") =>
    `<span class="chip" style="background:${(c ?? ["#EFEDE7", "#4A4944"])[0]};color:${(c ?? ["#EFEDE7", "#4A4944"])[1]};${extra}">${esc(text)}</span>`;
  const actorName = (a: any) => (typeof a === "string" ? a : a.name);

  // Client-side mirror of the §5 gate, used only to disable buttons with a reason.
  function isSafety(c: any): boolean {
    const dev = state.fleet.find((d: any) => d.vin === c.vin);
    return c.hypothesis?.root_cause === "thermal_or_safety_event" ||
      (dev?.active_fault_codes ?? []).some((x: string) => x.startsWith("INV-F900")) ||
      c.status === "Escalated L0";
  }
  function gateFor(step: any, c: any, u: any): string | null {
    const remote = step.action === "reboot" || step.action === "ota_to_allowlisted";
    if (remote && isSafety(c)) return "safety (L0) case: no remote actuation";
    if (remote && (!c.hypothesis || c.hypothesis.root_cause === "unknown" || c.hypothesis.confidence < 0.5)) return "hypothesis unknown or confidence < 0.5";
    if (step.action === "ota_to_allowlisted" && !ALLOWLIST.includes(step.params?.target_fw)) return "target fw not on the allow-list";
    if (u.role === "technician") return "technicians complete visits; they don't approve actions";
    if (u.role === "admin") return "admin doesn't bypass safety";
    if (step.requires === "engineer" && u.role !== "engineer") return "engineer only: OTA needs an engineer's approval";
    if (step.requires === "ops_and_engineer") {
      if (step.approvals.some((a: any) => a.user.id === u.id)) return "you already approved; needs a second, distinct user";
      if (step.approvals.some((a: any) => a.user.role === u.role)) return `already approved by ${u.role}; needs the other role`;
    }
    return null;
  }
  function closeBlock(c: any, u: any): string | null {
    if (u.role !== "engineer") return "only an engineer can close a case";
    if (c.status === "Engineer review") return null;
    if (c.status === "Escalated L0" && (c.outcome === "l0_made_safe" || c.outcome === "pulled_justified")) return null;
    return `case is ${c.status}`;
  }

  // ------------------------------------------------------------------ API

  async function api(path: string, body?: any): Promise<any> {
    const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  async function act(path: string, body: any, ok?: string) {
    if (busy) return;
    busy = true;
    try {
      await api(path, body);
      if (ok) toast(ok, false);
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      busy = false;
      await refresh(true);
    }
  }
  let toastTimer: any = null;
  function toast(msg: string, err: boolean) {
    const t = $("toast");
    t.textContent = msg;
    t.style.background = err ? "#B42318" : "#1E4D2B";
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = "none"), 3500);
  }
  async function refresh(force = false) {
    try {
      state = await api("/api/response/state");
    } catch (e: any) {
      $("conn").textContent = "offline: " + e.message;
      return;
    }
    $("conn").textContent = "";
    const a = document.activeElement as HTMLElement | null;
    const typing = a && $("app").contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
    if (!force && typing) return; // don't clobber a field mid-edit; next poll catches up
    render();
  }

  // ------------------------------------------------------------------ render

  function render() {
    const u = me();
    renderHeader(u);
    $("metrics").innerHTML = renderMetrics();
    $("scorecard").innerHTML = renderScorecard();
    $("scorecard").style.display = state.scorecard ? "block" : "none";
    const core = state.fleet_source === "core";
    $("fleetTitle").innerHTML = core
      ? `Base Core telemetry pack <span style="font-weight:400;color:#8A8880;">&middot; ${state.fleet.length} synthetic units from data_input/ &middot; diagnosed by the Task 1 detectors</span>`
      : `Demo fleet <span style="font-weight:400;color:#8A8880;">&middot; ${state.fleet.length} hand-built inverters &middot; ${esc((state.fw_allowlist ?? ALLOWLIST)[0])} is allow-listed</span>`;
    const fs = $("fleetSel") as HTMLSelectElement;
    if (fs && state.fleet_source && fs.value !== state.fleet_source) fs.value = state.fleet_source;
    $("fleet").innerHTML = renderFleet();
    const cases = [...state.cases].sort((a: any, b: any) => rank(a) - rank(b) || a.case_id.localeCompare(b.case_id));
    if (!selectedCase || !state.cases.some((c: any) => c.case_id === selectedCase)) selectedCase = cases[0]?.case_id ?? null;
    $("queueCount").textContent = `${state.metrics.open_cases} open · ${state.metrics.closed_cases} closed`;
    $("queue").innerHTML = cases.map((c: any) => renderCase(c, u)).join("") || empty("No cases. Plant a fault on a healthy unit.");
    const sel = state.cases.find((c: any) => c.case_id === selectedCase);
    $("detail").innerHTML = sel ? renderDetail(sel, u) : empty("Select a case.");
    $("visits").innerHTML = renderVisits(u);
    $("bugs").innerHTML = renderBugs();
    $("modal").style.display = openReport ? "flex" : "none";
    if (openReport) {
      const r = state.bug_reports.find((b: any) => b.report_id === openReport);
      $("modalBody").innerHTML = r ? `<div class="mono" style="font-size:12px;color:#8A8880;margin-bottom:6px;">${esc(r.report_id)} · ${esc(r.source)} · ${time(r.created_at)} CT</div>${md(r.body_md)}` : "";
    }
  }
  const rank = (c: any) =>
    ({ "Escalated L0": 0, "Action pending": 1, "In progress": 2, "Field visit": 3, "Engineer review": 4, Investigating: 5, Open: 6, Closed: 9 } as any)[c.status] ?? 7;
  const empty = (msg: string) => `<div style="color:#8A8880;font-size:14px;padding:8px 2px;">${esc(msg)}</div>`;

  function renderHeader(u: any) {
    const sel = $("userSel") as HTMLSelectElement;
    const opts = state.users.filter((x: any) => DEMO_USERS.includes(x.id) || x.id === userId)
      .map((x: any) => `<option value="${esc(x.id)}"${x.id === u.id ? " selected" : ""}>${esc(x.name)} · ${esc(x.role)}</option>`).join("");
    if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    sel.value = u.id;
    $("planner").innerHTML = state.planner === "claude"
      ? chip("Planner: Claude", ["#EAF1FF", "#1E4FBE"])
      : chip("Planner: playbook", ["#EFEDE7", "#4A4944"]);
  }

  function renderScorecard(): string {
    const k = state.scorecard;
    if (!k) return "";
    const pct = (a: number, b: number) => (b ? `${a} / ${b}` : "–");
    const tiles: [string, string, string, boolean][] = [
      ["Matched answer key", pct(k.matched, k.graded), "Resolved cases whose outcome matches the pack's recommended_action class: no truck, fixed on site, or pulled to HQ.", false],
      ["Hardware kept", pct(k.dnr_kept, k.dnr_resolved), "Resolved units marked do_not_return_hardware=Y that stayed in the field.", false],
      ["Wrong pulls", String(k.wrong_pulls), "HQ pulls on units the key says not to return. North star: 0.", k.wrong_pulls > 0],
      ["Missed pulls", String(k.missed_pulls), "Units the key says should come back to HQ that were resolved without a pull.", k.missed_pulls > 0],
      ["Extra trucks", String(k.extra_trucks), "Tech visits on units the key says needed no truck. Each is traceable in the case timeline.", k.extra_trucks > 0],
      ["Not resolved yet", String(k.pending), "Cases with an answer key still waiting on approvals or visits.", false],
    ];
    return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
        <div class="panelTitle">Answer-key check</div>
        <div style="font-size:12px;color:#8A8880;">Graded against data_input/inventory.csv (recommended_action, do_not_return_hardware). Evaluation only: the agent never sees the key. MOCKED data.</div>
      </div>
      <div class="grid-score">${tiles.map(([label, v, tip, bad]) => `<div class="card" style="padding:12px 14px;box-shadow:none;">
        <div class="kpiLabel">${esc(label)}<span class="tip" data-tip="${esc(tip)}">?</span></div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;${bad ? "color:#B42318;" : ""}">${esc(v)}</div>
      </div>`).join("")}</div>`;
  }

  function keyChip(c: any): string {
    const k = state.scorecard?.per_case?.[c.case_id];
    if (!k) return "";
    const [bg, fg, mark] = k.verdict === "match" ? ["#E7F2EA", "#1D6F3E", "✓"] : k.verdict === "miss" ? ["#FDECEC", "#B42318", "✗"] : ["#EFEDE7", "#6B6A64", "…"];
    return `<span class="chip mono" title="${esc(k.note)}" style="background:${bg};color:${fg};font-size:11px;">key: ${esc(k.recommended_action)} ${mark}</span>`;
  }

  function renderMetrics(): string {
    const m = state.metrics;
    const tiles: [string, number, string][] = [
      ["Open cases", m.open_cases, "Cases not yet closed by an engineer."],
      ["Fixed remotely", m.fixed_remote, "Cleared by a remote action (reboot, OTA) and verified by re-reading device status. No truck."],
      ["Avoided false pulls", m.avoided_false_pulls, "Monitor or a tech visit showed nothing wrong with the unit, so it stayed in the field."],
      ["Truck rolls", m.truck_rolls, "Completed field visits and HQ recoveries."],
      ["Unnecessary pulls", m.unnecessary_pulls, "HQ recoveries on a unit whose true fault was not hardware. North star: keep this at 0."],
      ["Gate denials", m.gate_denials, "Times the deterministic policy gate refused an action or an approval."],
      ["Closed", m.closed_cases, "Closed by an engineer."],
    ];
    return tiles.map(([label, v, tip]) => `<div class="card" style="padding:14px 16px;">
      <div class="kpiLabel">${esc(label)}<span class="tip" data-tip="${esc(tip)}">?</span></div>
      <div style="font-size:28px;font-weight:600;margin-top:4px;${label === "Unnecessary pulls" && v > 0 ? "color:#B42318;" : ""}">${v}</div>
    </div>`).join("");
  }

  function unitColor(d: any): [string, string, string] {
    const c = state.cases.find((x: any) => x.vin === d.vin && x.status !== "Closed");
    if (c && c.status === "Escalated L0" && d.faulted) return ["#7A1212", "#FDECEC", "L0 safety"];
    if (!d.faulted) return ["#1E4D2B", "#E7F2EA", c ? "cleared" : "healthy"];
    if (c && (c.status === "In progress" || c.status === "Field visit")) return ["#C27A00", "#FFF3E0", "in progress"];
    return ["#DC2626", "#FDECEC", "faulted"];
  }

  function renderFleet(): string {
    return state.fleet.map((d: any) => {
      const [bar, bg, label] = unitColor(d);
      const stale = !(state.fw_allowlist ?? ALLOWLIST).includes(d.fw_version);
      const menu = plantMenuVin === d.vin
        ? `<div class="menu">${PLANTABLE.map((f) => `<button class="menuItem mono" data-act="plant" data-vin="${esc(d.vin)}" data-fault="${f}">${esc(f)}</button>`).join("")}</div>`
        : "";
      return `<div class="unit" style="border-left:5px solid ${bar};">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <span class="mono" style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;" title="${esc(d.vin)}">${esc(d.vin)}</span>
          <span class="chip" style="background:${bg};color:${bar};font-size:11px;">${esc(label)}</span>
        </div>
        <div class="mono" style="font-size:12px;color:${stale ? "#B42318" : "#6B6A64"};margin-top:6px;">fw ${esc(d.fw_version)}${stale ? " · stale" : ""}</div>
        <div class="mono" style="font-size:11px;color:#8A8880;margin-top:2px;min-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(d.active_fault_codes.join(", "))}">${esc(d.active_fault_codes.join(", ") || "no codes")}</div>
        <div style="position:relative;margin-top:8px;">
          <button class="btn btnGhost" style="font-size:12px;padding:3px 8px;" data-act="plantMenu" data-vin="${esc(d.vin)}">Plant fault &#9662;</button>
          ${menu}
        </div>
      </div>`;
    }).join("");
  }

  function renderStep(s: any, i: number, c: any, u: any): string {
    let actions = "";
    if (s.state === "awaiting_approval" && c.status !== "Closed") {
      const why = gateFor(s, c, u);
      const dis = why ? ` disabled title="${esc(why)}"` : "";
      actions = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
        <button class="btn btnPrimary" data-act="approve" data-case="${esc(c.case_id)}" data-step="${esc(s.step_id)}"${dis}>Approve</button>
        <button class="btn btnGhost" data-act="rejectOpen" data-step="${esc(s.step_id)}"${dis}>Reject</button>
        ${why ? `<span style="font-size:12px;color:#9A5B00;">&#9888; ${esc(why)}</span>` : ""}
      </div>`;
      if (rejecting === s.step_id && !why) {
        actions += `<div style="display:flex;gap:6px;margin-top:6px;">
          <input id="rejectInput" class="input" placeholder="Reason (required)" value="${esc(rejectReason)}" style="flex:1;">
          <button class="btn btnDanger" data-act="reject" data-case="${esc(c.case_id)}" data-step="${esc(s.step_id)}">Confirm reject</button>
          <button class="btn btnGhost" data-act="rejectCancel">Cancel</button>
        </div>`;
      }
    }
    const approvals = s.approvals.length
      ? `<span style="font-size:12px;color:#6B6A64;"> · approved by ${s.approvals.map((a: any) => esc(a.user.name)).join(", ")}</span>` : "";
    const result = s.result ? `<div style="font-size:12px;color:#4A4944;margin-top:3px;"><span class="mono">${esc(s.result.outcome)}</span> · ${esc(s.result.detail)}</div>` : "";
    const params = s.params?.target_fw ? ` <span class="mono" style="font-size:12px;color:#6B6A64;">→ ${esc(s.params.target_fw)}</span>` : "";
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

  // Level of the step the case is on now (the plan's max level is nearly always L4, because
  // "send a tech" is the usual fallback). L0 cases always show L0.
  function levelChips(gp: any): string {
    if (gp.level === "L0") return chip("L0", LEVEL.L0);
    const live = ["running", "awaiting_approval", "approved", "planned"];
    const cur = gp.steps.find((s: any) => live.includes(s.state))
      ?? [...gp.steps].reverse().find((s: any) => s.state === "done" || s.state === "failed");
    const lvl = cur ? cur.level : gp.level;
    const tail = lvl !== gp.level ? `<span style="color:#8A8880;font-size:12px;">up to ${esc(gp.level)}</span>` : "";
    return `${chip("now " + lvl, LEVEL[lvl])}${tail}`;
  }

  function renderCase(c: any, u: any): string {
    const h = c.hypothesis;
    const gp = c.gameplan;
    const active = c.case_id === selectedCase;
    return `<div class="card caseCard" data-act="select" data-case="${esc(c.case_id)}" style="padding:14px 16px;margin-bottom:12px;${active ? "border-color:#1E4D2B;box-shadow:0 0 0 1px #1E4D2B;" : ""}${c.status === "Closed" ? "opacity:0.7;" : ""}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="mono" style="font-weight:500;">${esc(c.case_id)}</span>
        <span class="mono" style="color:#4A4944;">${esc(c.vin)}</span>
        <span style="color:#6B6A64;font-size:14px;">${esc(c.site)}</span>
        <span style="flex:1;"></span>
        ${keyChip(c)}
        ${gp ? levelChips(gp) : ""}
        ${chip(c.status, STATUS[c.status])}
      </div>
      ${h ? `<div style="font-size:14px;margin-top:6px;color:#4A4944;">
        <span class="mono">${esc(h.root_cause)}</span>
        <span style="color:#8A8880;"> · ${Math.round(h.confidence * 100)}% · ${h.source === "task1" ? "Task 1 detectors" : esc(h.source)} · fw ${esc(h.fw_version)}</span>
        ${gp ? ` <span style="color:#8A8880;">· plan: ${esc(gp.source)}</span>` : ""}
        ${c.outcome ? ` · ${chip(pretty(c.outcome), ["#E7F2EA", "#1D6F3E"], "font-size:11px;")}` : ""}
      </div>` : ""}
      ${gp ? `<div style="margin-top:10px;border-top:1px solid #F0EEE9;">${gp.steps.map((s: any, i: number) => renderStep(s, i, c, u)).join("")}</div>` : ""}
    </div>`;
  }

  function renderDetail(c: any, u: any): string {
    const block = closeBlock(c, u);
    const closeUi = c.status === "Closed" ? "" : `<div style="border-top:1px solid #F0EEE9;padding-top:12px;margin-top:12px;">
      <div style="display:flex;gap:6px;">
        <input id="closeNote" class="input" placeholder="Close note" value="${esc(closeNote)}" style="flex:1;"${block ? " disabled" : ""}>
        <button class="btn btnPrimary" data-act="close" data-case="${esc(c.case_id)}"${block ? ` disabled title="${esc(block)}"` : ""}>Close case</button>
      </div>
      ${block ? `<div style="font-size:12px;color:#8A8880;margin-top:4px;">${esc(block)}</div>` : ""}
    </div>`;
    const events = [...c.timeline].reverse().map((e: any) => `<div class="event">
      <span class="mono" style="font-size:11px;color:#8A8880;width:62px;flex-shrink:0;">${time(e.ts)}</span>
      <div style="min-width:0;">
        <div style="font-size:13px;color:#292826;">${esc(e.summary)}</div>
        <div style="font-size:11px;color:#8A8880;"><span class="mono">${esc(e.kind)}</span> · ${esc(actorName(e.actor))}</div>
      </div>
    </div>`).join("");
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
        <span class="mono" style="font-weight:500;">${esc(c.case_id)}</span>
        <span class="mono" style="color:#4A4944;">${esc(c.vin)}</span>
        <span style="flex:1;"></span>${chip(c.status, STATUS[c.status])}
      </div>
      ${c.gameplan ? `<div style="font-size:13px;color:#6B6A64;margin-bottom:8px;">${esc(c.gameplan.summary)}</div>` : ""}
      ${c.hypothesis ? `<div style="font-size:12px;color:#8A8880;margin-bottom:10px;">Evidence: ${c.hypothesis.evidence.map(esc).join(" · ")}</div>` : ""}
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6B6A64;margin-bottom:6px;">Timeline</div>
      <div style="max-height:360px;overflow-y:auto;">${events}</div>
      ${closeUi}`;
  }

  function renderVisits(u: any): string {
    const list = [...state.visits].sort((a: any, b: any) => (a.state === "scheduled" ? 0 : 1) - (b.state === "scheduled" ? 0 : 1));
    if (!list.length) return empty("No visits scheduled.");
    return list.map((v: any) => {
      const f = (visitForm[v.visit_id] ??= { photos: false, reason: "" });
      let controls = "";
      if (v.state === "scheduled") {
        controls = u.role === "technician"
          ? `<div style="border-top:1px solid #F0EEE9;margin-top:10px;padding-top:10px;display:flex;flex-direction:column;gap:8px;">
              <label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" data-act="photos" data-visit="${esc(v.visit_id)}"${f.photos ? " checked" : ""}> Photos attached${v.photos_required ? ' <span style="color:#B42318;">(required)</span>' : ""}
              </label>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn btnPrimary" data-act="visitDone" data-visit="${esc(v.visit_id)}"${v.photos_required && !f.photos ? ' disabled title="photos are required for this visit"' : ""}>Complete visit</button>
                <select class="input" data-act="reason" data-visit="${esc(v.visit_id)}" style="flex:1;min-width:120px;">
                  <option value="">Incomplete reason…</option>
                  ${INCOMPLETE_REASONS.map((r) => `<option value="${r}"${f.reason === r ? " selected" : ""}>${pretty(r)}</option>`).join("")}
                </select>
                <button class="btn btnGhost" data-act="visitIncomplete" data-visit="${esc(v.visit_id)}"${f.reason ? "" : ' disabled title="pick a reason first"'}>Mark incomplete</button>
              </div>
            </div>`
          : `<div style="font-size:12px;color:#8A8880;margin-top:8px;">Switch to a technician to complete this visit.</div>`;
      }
      const vs: [string, string] = v.state === "completed" ? ["#E7F2EA", "#1D6F3E"] : v.state === "incomplete" ? ["#FFF3E0", "#9A5B00"] : ["#EAF1FF", "#1E4FBE"];
      return `<div class="card" style="padding:12px 14px;margin-bottom:10px;box-shadow:none;${v.state !== "scheduled" ? "opacity:0.75;" : ""}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="mono" style="font-weight:500;">${esc(v.visit_id)}</span>
          <span style="font-size:13px;color:#4A4944;">${v.kind === "hq_recovery" ? "HQ recovery" : "Tech visit"}</span>
          <span class="mono" style="font-size:12px;color:#6B6A64;">${esc(v.vin)} · ${esc(v.case_id)}</span>
          <span style="flex:1;"></span>${chip(v.state, vs, "font-size:11px;")}
        </div>
        <div style="font-size:13px;color:#4A4944;margin-top:4px;">${esc(v.assignee.name)} · ${time(v.slot_start)}–${time(v.slot_end)} CT${v.photos_required ? " · photos required" : ""}</div>
        <div style="font-size:13px;color:#6B6A64;margin-top:6px;">${esc(v.brief)}</div>
        <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#4A4944;">${v.checklist.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${v.outcome && !v.outcome.completed ? `<div style="font-size:12px;color:#9A5B00;margin-top:6px;">Incomplete: ${esc(pretty(v.outcome.incomplete_reason ?? ""))}</div>` : ""}
        ${controls}
      </div>`;
    }).join("");
  }

  function renderBugs(): string {
    if (!state.bug_reports.length) return empty("No bug reports. Written when 3+ cases share a fw version and root cause.");
    return state.bug_reports.map((r: any) => `<div class="card bug" data-act="report" data-report="${esc(r.report_id)}" style="padding:12px 14px;margin-bottom:10px;box-shadow:none;cursor:pointer;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="mono" style="font-weight:500;">${esc(r.report_id)}</span>
        ${chip("fw " + r.fw_version, ["#FDECEC", "#B42318"], "font-size:11px;")}
        <span style="flex:1;"></span><span style="font-size:12px;color:#8A8880;">${esc(r.source)}</span>
      </div>
      <div style="font-size:14px;margin-top:4px;">${esc(r.title)}</div>
      <div class="mono" style="font-size:12px;color:#6B6A64;margin-top:2px;">${r.vins.map(esc).join(", ")}</div>
      <div style="font-size:13px;color:#1E4D2B;margin-top:4px;">${esc(r.recommendation)}</div>
    </div>`).join("");
  }

  function md(src: string): string {
    const inline = (s: string) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, '<code class="mono">$1</code>')
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1<em>$2</em>");
    let out = "";
    let inList = false;
    for (const line of src.split("\n")) {
      const li = line.match(/^\s*[-*] (.*)/);
      if (li) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(li[1])}</li>`; continue; }
      if (inList) { out += "</ul>"; inList = false; }
      const hd = line.match(/^(#{1,4}) (.*)/);
      if (hd) out += `<h${hd[1].length + 1}>${inline(hd[2])}</h${hd[1].length + 1}>`;
      else if (line.trim()) out += `<p>${inline(line)}</p>`;
    }
    return out + (inList ? "</ul>" : "");
  }

  // ------------------------------------------------------------------ events

  document.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!el) {
      if (plantMenuVin) { plantMenuVin = null; render(); }
      return;
    }
    const d = el.dataset;
    const uid = me().id;
    if (d.act !== "plantMenu" && d.act !== "plant" && plantMenuVin) plantMenuVin = null;
    switch (d.act) {
      case "select":
        if ((ev.target as HTMLElement).closest("input,select,textarea,label")) return;
        if (selectedCase !== d.case) { selectedCase = d.case!; closeNote = ""; render(); }
        return;
      case "plantMenu":
        ev.stopPropagation();
        plantMenuVin = plantMenuVin === d.vin ? null : d.vin!;
        render();
        return;
      case "plant":
        plantMenuVin = null;
        act("/api/sim/plant", { vin: d.vin, fault: d.fault }, `Planted ${d.fault} on ${d.vin}`);
        return;
      case "approve":
        ev.stopPropagation();
        act("/api/response/approve", { case_id: d.case, step_id: d.step, user_id: uid }, "Approved");
        return;
      case "rejectOpen":
        ev.stopPropagation();
        rejecting = d.step!;
        rejectReason = "";
        render();
        ($("rejectInput") as HTMLInputElement | null)?.focus();
        return;
      case "rejectCancel":
        ev.stopPropagation();
        rejecting = null;
        render();
        return;
      case "reject": {
        ev.stopPropagation();
        if (!rejectReason.trim()) { toast("Give a reason to reject", true); return; }
        const reason = rejectReason;
        rejecting = null;
        act("/api/response/reject", { case_id: d.case, step_id: d.step, user_id: uid, reason }, "Rejected");
        return;
      }
      case "close":
        act("/api/response/close", { case_id: d.case, user_id: uid, note: closeNote }, "Case closed");
        closeNote = "";
        return;
      case "visitDone": {
        const f = visitForm[d.visit!];
        act("/api/response/visit", { visit_id: d.visit, user_id: uid, outcome: { completed: true, photos_attached: !!f?.photos } }, "Visit completed");
        return;
      }
      case "visitIncomplete": {
        const f = visitForm[d.visit!];
        act("/api/response/visit", { visit_id: d.visit, user_id: uid, outcome: { completed: false, photos_attached: !!f?.photos, incomplete_reason: f?.reason } }, "Visit marked incomplete");
        return;
      }
      case "report":
        openReport = d.report!;
        render();
        return;
      case "modalBackdrop":
        if (ev.target !== el) return;
        openReport = null;
        render();
        return;
      case "modalClose":
        openReport = null;
        render();
        return;
      case "reset":
        if (confirm("Reset the fleet and all cases to the seed?")) act("/api/response/reset", {}, "Reset to seed");
        return;
    }
  });
  document.addEventListener("input", (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.id === "rejectInput") rejectReason = el.value;
    if (el.id === "closeNote") closeNote = el.value;
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target as HTMLInputElement;
    const d = el.dataset;
    if (el.id === "userSel") {
      userId = el.value;
      try { localStorage.setItem(USER_KEY, userId); } catch { /* storage blocked */ }
      rejecting = null;
      render();
    } else if (d.act === "photos") {
      visitForm[d.visit!].photos = el.checked;
      render();
    } else if (d.act === "reason") {
      visitForm[d.visit!].reason = el.value;
      render();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && openReport) { openReport = null; render(); }
  });

  ($("fleetSel") as HTMLSelectElement).addEventListener("change", (ev) => {
    const want = (ev.target as HTMLSelectElement).value;
    if (want === state?.fleet_source) return;
    if (confirm(`Switch to the ${want === "core" ? "Core telemetry pack" : "demo fleet"}? This resets all cases.`)) {
      act("/api/response/reset", { fleet: want }, want === "core" ? "Switched to the Core telemetry pack" : "Switched to the demo fleet");
    } else {
      (ev.target as HTMLSelectElement).value = state?.fleet_source ?? "core";
    }
  });

  refresh(true);
  setInterval(() => { if (!busy) refresh(); }, 2000);
}

// First-visit onboarding walkthrough for /response. Spotlights one panel at a time. Remembered per
// browser in localStorage ("response.tour.v1"); replay with the Tour button or /response?tour=1.
// Serialized with toString() like clientMain, so it must be self-contained.
function tourMain(): void {
  const KEY = "response.tour.v1";
  type Step = { target?: string; title: string; body: string };
  const STEPS: Step[] = [
    { title: "Welcome to the Response agent",
      body: "Diagnosis tells you what's wrong with an inverter. This page is what happens next: the agent plans the cheapest safe fix, a person approves it, the system runs it on the fleet, and then checks the fault actually cleared. The goal is to stop pulling healthy inverters back to HQ. This tour takes about a minute." },
    { target: "#roleSwitch", title: "Acting as: pick your role",
      body: "Switch between Technician, Ops and Engineer. What you can approve changes with the role, and the server enforces it, not just the buttons. Ops approves reboots and dispatches, only an Engineer can approve a firmware update or close a case, and a Technician approves nothing but completes field visits." },
    { target: "#planner", title: "Who wrote the plan",
      body: "\"Claude\" when the AI planner is live, \"playbook\" when it falls back to fixed rules. Either way it can only choose from a fixed list of actions, and it can never write or patch firmware." },
    { target: "#metrics", title: "The scoreboard",
      body: "Fixed remotely = solved with no truck. Avoided false pulls = a tech found nothing wrong, so no healthy unit went back to HQ. Gate denials = unsafe or unauthorized actions the rules blocked. Hover the ? on any tile for its definition." },
    { target: "#fleetCard", title: "The fleet",
      body: "Each tile is one unit (MOCKED): green is healthy, red is faulted, dark red is a safety case. By default this is the team's Base Core telemetry pack, diagnosed by the Task 1 detectors; the dropdown switches to the 12-unit demo fleet. Plant fault creates a new incident live, and Reset to seed starts over." },
    { target: "#scorecard", title: "Answer-key check",
      body: "The telemetry pack says what should happen to each unit: no truck, fix on site, or pull to HQ, and whether the hardware must stay in the field. As cases resolve, this grades the agent against that key. The agent never sees it. Hover a case's key chip to see why it matched or missed." },
    { target: ".caseCard", title: "A case",
      body: "One card per incident, most urgent first. The top line shows the level of the step it's on now (\"now L2 · up to L4\") and its status. Below it: the diagnosis, how confident it is, and the plan, cheapest and safest step first. Click a card to open it on the right." },
    { target: ".caseCard [data-act=\"approve\"]", title: "Approve or reject a step",
      body: "Steps wait here for the right person. If your role can't approve one, the button is disabled and tells you why (for example \"engineer only\"). After approval the action runs on the fleet and the verifier re-checks the unit: cleared goes to Engineer review; still faulted moves to the next step or escalates." },
    { target: "#detailCard", title: "Case detail and timeline",
      body: "Everything that happened on the case: the diagnosis, each approval and by whom, what ran, whether it worked, and alerts sent. This is the audit trail. An Engineer closes the case here once it's resolved." },
    { target: "#visitsCard", title: "Field visits",
      body: "When a tech has to go on site, the agent books one with a short \"why you're here\" and a checklist. Switch to a Technician to complete the visit. Connector and install jobs need photos first, and an incomplete visit needs a reason so the next person isn't starting from zero." },
    { target: "#bugsCard", title: "Engineer bug reports",
      body: "When several units on the same firmware fail the same way, the agent writes a report for engineers with the evidence and affected units. It recommends; it never patches." },
    { title: "Try it",
      body: "As M. Alvarez (Ops), approve a pending step and watch the agent run it, verify it, and escalate if it didn't work. Try a firmware update as Ops to see it blocked as engineer-only, then switch to J. Park. Replay this tour any time with the Tour button." },
  ];

  let i = 0;
  let curTarget: string | undefined; // STEPS[i].target, or its fallback
  let root: HTMLDivElement | null = null;
  let timer: number | undefined;

  const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[ch]);

  function seen(): boolean { try { return localStorage.getItem(KEY) === "done"; } catch { return false; } }
  function markSeen(): void { try { localStorage.setItem(KEY, "done"); } catch { /* storage blocked */ } }

  function build(): void {
    root = document.createElement("div");
    root.id = "tour";
    root.innerHTML = `
      <div id="tourShade" style="position:fixed;inset:0;z-index:100;"></div>
      <div id="tourHole" style="position:fixed;z-index:101;border-radius:10px;box-shadow:0 0 0 9999px rgba(30,29,27,0.58);outline:2px solid #FFFFFF;transition:all 0.25s ease;pointer-events:none;"></div>
      <div id="tourCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle" style="position:fixed;z-index:102;background:#FFFFFF;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.25);padding:18px 20px 14px;width:min(380px,calc(100vw - 32px));transition:top 0.25s ease,left 0.25s ease;">
        <div id="tourCount" style="font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#1E4D2B;"></div>
        <div id="tourTitle" style="font-size:17px;font-weight:600;color:#292826;margin-top:4px;"></div>
        <div id="tourBody" style="font-size:14px;line-height:1.5;color:#4A4944;margin-top:8px;"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:14px;">
          <button type="button" data-tour="skip" class="btn btnGhost" style="border:none;color:#6B6A64;padding-left:0;">Skip tour</button>
          <span style="flex:1;"></span>
          <button type="button" data-tour="back" class="btn btnGhost">Back</button>
          <button type="button" data-tour="next" class="btn btnPrimary"></button>
        </div>
        <div id="tourDots" style="display:flex;gap:5px;justify-content:center;margin-top:12px;"></div>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest("[data-tour]") as HTMLElement | null;
      if (!b) return;
      const a = b.dataset.tour;
      if (a === "next") go(i + 1);
      else if (a === "back") go(i - 1);
      else if (a === "skip") end();
    });
  }

  function place(): void {
    if (!root) return;
    const hole = $("#tourHole")!;
    const card = $("#tourCard")!;
    const el = curTarget ? $(curTarget) : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (!el) {
      hole.style.cssText += `;top:${vh / 2}px;left:${vw / 2}px;width:0;height:0;`;
      card.style.top = `${Math.max(16, (vh - ch) / 2)}px`;
      card.style.left = `${Math.max(16, (vw - cw) / 2)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    hole.style.top = `${r.top - pad}px`;
    hole.style.left = `${r.left - pad}px`;
    hole.style.width = `${r.width + pad * 2}px`;
    hole.style.height = `${r.height + pad * 2}px`;
    // Card below the target if it fits, else above, else pinned to the bottom of the screen.
    let top = r.bottom + 14;
    if (top + ch > vh - 16) top = r.top - ch - 14;
    if (top < 16) top = vh - ch - 16;
    let left = Math.min(Math.max(16, r.left), vw - cw - 16);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function go(n: number): void {
    if (n >= STEPS.length) return end();
    i = Math.max(0, n);
    // Fall back to the case card if no approvable step exists right now.
    const step = STEPS[i];
    const target = step.target && !$(step.target) && step.target.includes("approve") ? ".caseCard" : step.target;
    curTarget = target;
    $("#tourCount")!.textContent = `Step ${i + 1} of ${STEPS.length}`;
    $("#tourTitle")!.textContent = step.title;
    $("#tourBody")!.innerHTML = esc(step.body);
    ($("[data-tour=back]") as HTMLButtonElement).style.visibility = i === 0 ? "hidden" : "visible";
    $("[data-tour=next]")!.textContent = i === 0 ? "Start" : i === STEPS.length - 1 ? "Done" : "Next";
    $("#tourDots")!.innerHTML = STEPS.map((_, k) =>
      `<span style="width:6px;height:6px;border-radius:50%;background:${k === i ? "#1E4D2B" : "#D8D5CC"};"></span>`).join("");
    const el = target ? $(target) : null;
    if (el) {
      const r = el.getBoundingClientRect();
      const header = ($(".hdrPad") as HTMLElement | null)?.offsetHeight ?? 0;
      const inView = r.top >= header && r.bottom <= window.innerHeight;
      if (!inView && !el.closest(".hdrPad[style*=sticky]")) {
        window.scrollTo({ top: window.scrollY + r.top - header - 24, behavior: "smooth" });
      }
    }
    place();
    setTimeout(place, 350); // after smooth scroll settles
    ($("[data-tour=next]") as HTMLButtonElement).focus();
  }

  function start(): void {
    if (root) return;
    build();
    // The page re-renders every 2 s; keep the spotlight glued to the current target.
    timer = window.setInterval(place, 400);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    document.addEventListener("keydown", onKey);
    go(0);
  }

  function end(): void {
    markSeen();
    if (timer) clearInterval(timer);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place);
    document.removeEventListener("keydown", onKey);
    root?.remove();
    root = null;
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") end();
    else if (ev.key === "ArrowRight" || ev.key === "Enter") { ev.preventDefault(); go(i + 1); }
    else if (ev.key === "ArrowLeft") go(i - 1);
  }

  document.getElementById("tourBtn")?.addEventListener("click", () => start());

  // Auto-start on first visit, once the page has data (case cards rendered).
  const force = new URLSearchParams(location.search).get("tour") === "1";
  if (force || !seen()) {
    const t0 = Date.now();
    const wait = window.setInterval(() => {
      if ($(".caseCard") || Date.now() - t0 > 6000) { clearInterval(wait); start(); }
    }, 200);
  }
}

export const RESPONSE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Response Agent</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;500&display=swap">
<style>
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; }
  a { color: #1E4D2B; }
  a:hover { color: #163A20; }
  .mono { font-family: 'Space Mono', monospace; }
  .card { background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; }
  .panelTitle { font-size: 14px; font-weight: 600; color: #4A4944; }
  .kpiLabel { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; white-space: nowrap; }
  .grid-score { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 1100px) { .grid-score { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 560px) { .grid-score { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .btn { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 6px; padding: 5px 12px; cursor: pointer; border: 1px solid transparent; }
  .btn:disabled { cursor: not-allowed; opacity: 0.45; }
  .btnPrimary { background: #1E4D2B; color: #FFFFFF; border-color: #1E4D2B; }
  .btnPrimary:hover:not(:disabled) { background: #163A20; }
  .btnGhost { background: #FFFFFF; color: #4A4944; border-color: #D8D5CC; }
  .btnGhost:hover:not(:disabled) { background: #FAFAF8; }
  .btnDanger { background: #B42318; color: #FFFFFF; border-color: #B42318; }
  .input { font-family: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid #D8D5CC; border-radius: 6px; background: #FFFFFF; color: #292826; }
  .unit { background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 10px 12px; }
  .menu { position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 30; background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); padding: 4px; min-width: 250px; }
  .menuItem { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 6px 8px; font-size: 12px; color: #292826; border-radius: 4px; cursor: pointer; }
  .menuItem:hover { background: #F0EEEB; }
  .caseCard { cursor: pointer; }
  .caseCard:hover { border-color: #C9C6BD; }
  .step { padding: 8px 0; border-bottom: 1px solid #F0EEE9; }
  .step:last-child { border-bottom: 0; }
  .event { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid #F4F3EF; }
  .bug:hover { border-color: #C9C6BD; }
  .mocked { background: #292826; color: #FFFFFF; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; padding: 3px 8px; border-radius: 4px; }
  #modalBody h2 { font-size: 20px; margin: 0 0 8px; }
  #modalBody h3 { font-size: 15px; margin: 16px 0 6px; color: #4A4944; }
  #modalBody p, #modalBody li { font-size: 14px; line-height: 1.5; color: #292826; }
  #modalBody code { background: #F0EEEB; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  .tip { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border: 1px solid #2F6FED; border-radius: 50%; font-size: 10px; line-height: 1; color: #2F6FED; cursor: help; margin-left: 5px; }
  .tip:hover::after { content: attr(data-tip); position: absolute; top: 130%; left: 50%; transform: translateX(-50%); background: #292826; color: #FFFFFF; padding: 8px 10px; border-radius: 6px; font-size: 13px; font-weight: 400; line-height: 1.4; white-space: normal; width: 220px; z-index: 40; text-transform: none; letter-spacing: 0; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .grid-metrics { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
  .grid-fleet { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
  .grid-main { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 20px; align-items: start; }
  .sideCol { position: sticky; top: 190px; max-height: calc(100vh - 210px); overflow-y: auto; }
  @media (max-width: 1200px) {
    .grid-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .grid-fleet { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  @media (max-width: 900px) {
    .grid-main { grid-template-columns: minmax(0, 1fr); }
    .sideCol { position: static; max-height: none; overflow: visible; }
    .grid-metrics, .grid-fleet { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hdrPad { padding-left: 16px !important; padding-right: 16px !important; }
  }
</style>
</head>
<body>

<div id="app" style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">

  <!-- HEADER -->
  <div class="hdrPad" style="position: sticky; top: 0; z-index: 20; background: #F0EEEB; padding: 20px 40px 0;">
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
      <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
      <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
      <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">Field RCA</span>
      <span style="flex: 1;"></span>
      <a href="/fleet" style="font-size: 14px; color: #6B6A64; text-decoration: none;">Fleet</a>
      <a href="/case" style="font-size: 14px; color: #6B6A64; text-decoration: none; margin-left: 12px;">Case</a>
      <a href="/response" style="font-size: 14px; color: #1E4D2B; font-weight: 600; text-decoration: none; margin-left: 12px;">Response</a>
      <span style="font-size: 13px; color: #8A8880; margin-left: 18px;">Logged in as <strong style="color: #4A4944;">Staff</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></span>
    </div>
    <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-bottom: 20px;">
      <div>
        <div style="font-size: 24px; font-weight: 600; color: #292826;">Response agent</div>
        <div style="font-size: 15px; color: #6B6A64; margin-top: 2px;">Plan the cheapest safe fix, gate it, verify it cleared, and only roll a truck when needed.</div>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span class="mocked" title="Fake fleet and in-memory engine. Not Base data, no production APIs.">MOCKED</span>
        <span id="planner"></span>
        <button id="tourBtn" class="btn btnGhost" type="button" title="Replay the walkthrough">Tour</button>
        <label id="roleSwitch" style="font-size: 13px; color: #6B6A64; display: flex; align-items: center; gap: 6px;">Acting as
          <select id="userSel" class="input" style="font-size: 14px; font-weight: 600;"></select>
        </label>
        <span id="conn" style="font-size: 12px; color: #B42318;"></span>
      </div>
    </div>
    <div style="height: 8px; background: #1E4D2B; margin: 0 -40px;"></div>
  </div>

  <!-- BODY -->
  <div class="hdrPad" style="padding: 28px 40px 80px;">

    <div id="metrics" class="grid-metrics"></div>

    <div id="scorecard" class="card" style="padding: 16px 18px; margin-bottom: 20px; display: none;"></div>

    <div id="fleetCard" class="card" style="padding: 16px 18px; margin-bottom: 20px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <div id="fleetTitle" class="panelTitle">Fleet</div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <select id="fleetSel" class="input" style="font-size: 13px;" title="Switch fleet (resets cases)">
            <option value="core">Core telemetry pack</option>
            <option value="demo">Demo fleet (12)</option>
          </select>
          <button class="btn btnGhost" data-act="reset">Reset to seed</button>
        </div>
      </div>
      <div id="fleet" class="grid-fleet"></div>
    </div>

    <div class="grid-main">
      <div>
        <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px;">
          <div class="panelTitle">Case queue</div>
          <div id="queueCount" style="font-size: 13px; color: #8A8880;"></div>
        </div>
        <div id="queue"></div>
      </div>
      <div class="sideCol" style="display: flex; flex-direction: column; gap: 20px;">
        <div id="detailCard" class="card" style="padding: 16px 18px;">
          <div class="panelTitle" style="margin-bottom: 10px;">Case detail</div>
          <div id="detail"></div>
        </div>
        <div id="visitsCard" class="card" style="padding: 16px 18px;">
          <div class="panelTitle" style="margin-bottom: 10px;">Visits</div>
          <div id="visits"></div>
        </div>
        <div id="bugsCard" class="card" style="padding: 16px 18px;">
          <div class="panelTitle" style="margin-bottom: 10px;">Engineer bug reports</div>
          <div id="bugs"></div>
        </div>
      </div>
    </div>

  </div>
</div>

<div id="modal" data-act="modalBackdrop" style="display: none; position: fixed; inset: 0; background: rgba(41,40,38,0.45); z-index: 50; align-items: center; justify-content: center; padding: 16px;">
  <div class="card" style="max-width: 680px; width: 100%; max-height: 80vh; overflow-y: auto; padding: 22px 26px; position: relative;">
    <button class="btn btnGhost" data-act="modalClose" style="position: absolute; top: 14px; right: 14px;">Close</button>
    <div id="modalBody"></div>
  </div>
</div>

<div id="toast" style="display: none; position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); color: #FFFFFF; padding: 10px 16px; border-radius: 8px; font-size: 14px; z-index: 60; box-shadow: 0 6px 18px rgba(0,0,0,0.2); max-width: 90vw;"></div>

<script>
(${clientMain.toString()})();
</script>
<script>
(${tourMain.toString()})();
</script>
</body>
</html>`;
