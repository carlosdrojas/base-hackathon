// Plain HTML/CSS/vanilla-JS port of the Case Workspace Claude Artifact mockup
// (Field RCA design doc §8.1). Ported by hand from the .dc.html source so it
// runs in a real browser instead of Claude's sandboxed Design-canvas runtime.
//
// Next step (not wired up here): src/mock-telemetry/core-fleet-telemetry.json
// has real-BMS-grounded mock fleet data that could replace the static values
// below once the case detail view is data-driven instead of hardcoded.

const chartScale = (min: number, max: number, val: number) => Math.round(((val - min) / (max - min)) * 120);

const bucketTimes = ["08:00", "08:15", "08:30", "08:45", "09:00", "09:15", "09:30", "09:45"];
const spikeIdx = 5;

const tempMin = 60, tempMax = 100, tempBaseline = 89, tempThreshold = 80;
const tempValues = [88, 89, 90, 88, 84, 71, 81, 83];
const tempBaselineY = chartScale(tempMin, tempMax, tempBaseline);

const canMin = 0, canMax = 120, canBaseline = 36, canThreshold = 45;
const canValues = [34, 36, 35, 38, 40, 112, 42, 38];
const canBaselineY = chartScale(canMin, canMax, canBaseline);
const canThresholdY = chartScale(canMin, canMax, canThreshold);

function renderBars(values: number[], min: number, max: number, threshold: number, selectedIdx: number, kind: "temp" | "can"): string {
  return values
    .map((v, i) => {
      const h = chartScale(min, max, v);
      const color = kind === "temp" ? (v < threshold ? "#DC2626" : "#1E4D2B") : (v > threshold ? "#DC2626" : "#1E4D2B");
      const isSpike = i === spikeIdx;
      const ring = i === selectedIdx ? "inset 0 0 0 2px #292826" : "none";
      return `<button class="bar" data-kind="${kind}" data-idx="${i}" data-time="${bucketTimes[i]}" data-value="${v}" onclick="selectBar('${kind}', ${i})" style="position:relative;flex:1;height:100%;display:flex;align-items:flex-end;justify-content:center;background:none;border:none;padding:0;cursor:pointer;">
        ${isSpike ? `<span style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-size:11px;font-weight:700;color:#B42318;background:#FDECEC;padding:1px 5px;border-radius:3px;white-space:nowrap;">SPIKE</span>` : ""}
        <div style="width:100%;background:${color};opacity:0.85;border-radius:2px 2px 0 0;height:${h}px;box-shadow:${ring};"></div>
      </button>`;
    })
    .join("");
}

function renderTimes(): string {
  return bucketTimes.map((t) => `<span class="mono" style="flex:1;text-align:center;font-size:11px;color:#8A8880;">${t}</span>`).join("");
}

const differentials = [
  { value: "can_link_unreliable", label: "can_link_unreliable", conf: 81, primary: true },
  { value: "fw_soft_fault_reboot_candidate", label: "fw_soft_fault_reboot_candidate", conf: 14, primary: false },
  { value: "install_commissioning_incomplete", label: "install_commissioning_incomplete", conf: 5, primary: false },
];

function renderDifferentials(): string {
  return differentials
    .map(
      (d) => `<div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;font-size:15px;margin-bottom:4px;">
          <span class="mono" style="color:${d.primary ? "#292826" : "#6B6A64"};font-weight:${d.primary ? "600" : "400"};">${d.label}</span>
          <span class="mono" style="color:#6B6A64;">${d.conf}%</span>
        </div>
        <div style="height:6px;background:#EFEDE7;border-radius:3px;">
          <div style="height:6px;background:${d.primary ? "#292826" : "#C9C6BD"};border-radius:3px;width:${d.conf}%;"></div>
        </div>
      </div>`
    )
    .join("");
}

const overrideOptions = [
  { value: "", label: "No override — accept agent hypothesis" },
  { value: "fw_version_mismatch", label: "fw_version_mismatch" },
  { value: "fw_soft_fault_reboot_candidate", label: "fw_soft_fault_reboot_candidate" },
  { value: "can_link_unreliable", label: "can_link_unreliable" },
  { value: "install_commissioning_incomplete", label: "install_commissioning_incomplete" },
  { value: "install_wiring_or_sense_error", label: "install_wiring_or_sense_error" },
  { value: "true_hardware_defect", label: "true_hardware_defect" },
  { value: "no_fault_found", label: "no_fault_found" },
  { value: "unknown", label: "unknown" },
];

// Merged, chronologically-ordered feed of system CaseEvents and human notes —
// previously two separate tabs (Timeline + Notes). One shared thread so the
// system's own record and what engineers/technicians said about it read as
// a single story instead of requiring a reader to cross-reference two tabs.
export const caseThread: { time: string; actor: string; label: string }[] = [
  { time: "09-24 16:05", actor: "TECHNICIAN", label: "D. Osei: Prior visit incomplete — needed a second tech for panel access. Rescheduled for 09-26." },
  { time: "09:14", actor: "DETECTOR", label: "CAN drop 14% (threshold 12%) — bus-off events x3" },
  { time: "09:15", actor: "AGENT", label: "Hypothesis posted — can_link_unreliable (0.81 confidence)" },
  { time: "09:16", actor: "SYSTEM", label: "Policy gate — L2, human approval required before execution" },
  { time: "09:20", actor: "ENGINEER", label: "M. Alvarez: Second bus-off cluster this month on this site — check if the J3 harness batch is flagged." },
];

export function renderCaseThread(): string {
  return caseThread
    .map(
      (e) => `<div style="display: flex; gap: 14px; padding: 8px 0; border-top: 1px solid #F0EEE9;">
          <span class="mono" style="width: 84px; flex-shrink: 0; font-size: 13px; color: #8A8880; padding-top: 2px;">${e.time}</span>
          <span style="width: 96px; flex-shrink: 0; font-size: 13px; font-weight: 600; color: #4A4944; padding-top: 2px;">${e.actor}</span>
          <span style="font-size: 16px; color: #292826;">${e.label}</span>
        </div>`
    )
    .join("");
}

import type { Decision } from "../session-store.js";

export function renderCaseWorkspacePage(decision: Decision, closed: boolean): string {
  const isApproved = decision === "approved";
  const isRejected = decision === "rejected";
  const decided = isApproved || isRejected;

  const statusLabel = !decided ? "Awaiting ops approval" : isApproved ? "Approved — executed" : "Rejected — escalated to engineer";
  const statusColor = !decided ? "#9A5B00" : isApproved ? "#1E4D2B" : "#DC2626";

  const approveBg = decided ? "#EFEDE7" : "#1E4D2B";
  const approveColor = decided ? "#B0AEA6" : "#FFFFFF";
  const approveCursor = decided ? "default" : "pointer";

  const caseStatusLabel = closed ? "Closed" : "Investigating";
  const approvalStatusLabel = closed ? "Closed" : "Open";

  const signLabel = closed ? "Signed &amp; Closed &#10003;" : "Sign &amp; Close";
  const signBg = closed ? "#EAF3E7" : decided ? "#1E4D2B" : "#EFEDE7";
  const signColor = closed ? "#1E4D2B" : decided ? "#FFFFFF" : "#B0AEA6";
  const signBorder = closed ? "#EAF3E7" : decided ? "#1E4D2B" : "#D8D5CC";
  const signCursor = closed ? "default" : decided ? "pointer" : "not-allowed";
  const signClickable = decided && !closed;

  const timelineFinalTime = decided ? "now" : "&mdash;";
  const timelineFinalActor = decided ? "OPS" : "PENDING";
  const timelineFinalLabel = !decided
    ? "Awaiting ops approval on reboot_firmware"
    : isApproved
    ? "Approved — reboot_firmware executed, post-check scheduled in 15 min"
    : "Rejected — case escalated for engineer review";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Case Workspace — Field RCA</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;500&display=swap">
<style>
  html { scroll-behavior: smooth; }
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; }
  a { color: #1E4D2B; }
  a:hover { color: #163A20; }
  .mono { font-family: 'Space Mono', monospace; }
  ::selection { background: #D6F0B4; }
  .navTab { color: #FFFFFF; }
  .navTab:hover { color: #B9E2A8; }
</style>
</head>
<body>

<div style="width: 100%; min-height: 100%; display: flex; flex-direction: column;">

  <!-- HEADER -->
  <div id="stickyHeader" style="position: sticky; top: 0; z-index: 10; background: #F0EEEB; padding: 16px 40px 0;">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="/base_logo.png" alt="Base" style="height: 48px; width: auto; display: block;">
        <span style="width: 1px; height: 24px; background: #C9C6BD; display: inline-block;"></span>
        <span style="font-size: 15px; color: #6B6A64; font-weight: 400;">Field RCA</span>
      </div>
      <div style="font-size: 13px; color: #8A8880;">Logged in as <strong style="color: #4A4944;">Staff</strong> &middot; <a href="/logout" style="color: #6B6A64;">Logout</a></div>
    </div>
    <a href="/fleet" style="font-size: 15px; color: #6B6A64; text-decoration: none;">&larr; Open cases</a>
    <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 6px; padding-bottom: 14px;">
      <span class="mono" style="font-size: 24px; font-weight: 600; color: #292826;">Case #1234</span>
      <span style="font-size: 17px; color: #6B6A64;">INV-4021 &middot; 118 Maple Ct, Round Rock TX</span>
    </div>

    <!-- SECTION NAV (jump links, one-pager) -->
    <div style="display: flex; gap: 2px; overflow-x: auto; background: #1E4D2B; margin: 0 -40px; padding: 0 40px;">
      <a href="#diagnosis" class="navTab" style="font-weight: 500; font-size: 15px; padding: 10px 14px; text-decoration: none; white-space: nowrap;">Diagnosis</a>
      <a href="#timeline" class="navTab" style="font-weight: 500; font-size: 15px; padding: 10px 14px; text-decoration: none; white-space: nowrap;">Timeline &amp; Notes</a>
      <a href="#evidence" class="navTab" style="font-weight: 500; font-size: 15px; padding: 10px 14px; text-decoration: none; white-space: nowrap;">Evidence viewer</a>
      <a href="#hypothesis" class="navTab" style="font-weight: 500; font-size: 15px; padding: 10px 14px; text-decoration: none; white-space: nowrap;">Hypothesis panel</a>
      <a href="#action" class="navTab" style="font-weight: 500; font-size: 15px; padding: 10px 14px; text-decoration: none; white-space: nowrap;">Action</a>
      <a href="#other" class="navTab" style="font-weight: 500; font-size: 15px; padding: 10px 14px; text-decoration: none; white-space: nowrap;">Other information</a>
    </div>
  </div>

  <!-- BODY -->
  <div style="padding: 28px 40px 80px; max-width: 1800px;">

    <!-- DIAGNOSIS -->
    <div id="diagnosis" style="scroll-margin-top: 16px; margin-bottom: 48px;">
      <div style="font-size: 22px; font-weight: 600; margin-bottom: 16px;">Diagnosis</div>
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 16px; align-items: start;">

        <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
          <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 6px;">Case summary</div>

          <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-top: 1px solid #F0EEE9;">
            <span style="font-size: 15px; color: #6B6A64;">Status</span>
            <span id="caseStatusDiagnosis" style="font-size: 16px; font-weight: 600;">${caseStatusLabel}</span>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-top: 1px solid #F0EEE9;">
            <span style="display: flex; align-items: center; gap: 6px; font-size: 15px; color: #6B6A64;">
              Severity
              <button onclick="toggleInfo('severityInfo')" aria-label="What does L2 mean?" style="background: none; border: 1px solid #2F6FED; border-radius: 50%; width: 16px; height: 16px; font-size: 13px; line-height: 1; color: #2F6FED; cursor: pointer; padding: 0;">&#9432;</button>
            </span>
            <span style="display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 600;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #CA8A00; display: inline-block;"></span>
              L2 &middot; Supervised act
            </span>
          </div>
          <div id="severityInfo" hidden style="margin: 2px 0 4px; padding: 14px 16px; background: #F0EEEB; border-radius: 6px; font-size: 14px; color: #333230; line-height: 1.7;">
            <div><span class="mono" style="font-weight: 600;">L0</span> Observe only &mdash; human only, no remote actuation (smoke/thermal/HV anomaly)</div>
            <div><span class="mono" style="font-weight: 600;">L1</span> Recommend &mdash; agent writes RCA + playbook, human approves</div>
            <div><span class="mono" style="font-weight: 600;">L2</span> Supervised act &mdash; agent can execute if confidence &ge; threshold AND a human clicks approve</div>
            <div><span class="mono" style="font-weight: 600;">L3</span> Narrow auto &mdash; agent may auto-propose OTA to an allow-listed version; reflash still needs a human step</div>
            <div><span class="mono" style="font-weight: 600;">L4</span> Physical world &mdash; dispatch technician / recovery truck; never auto, ops confirms</div>
            <div style="margin-top: 8px;"><a href="https://app.notion.com/p/3e7d8d4faccd81058155fbce4e41654a" target="_blank">Full permission ladder &mdash; Field RCA design doc &sect;5.3 &rarr;</a></div>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-top: 1px solid #F0EEE9;">
            <span style="font-size: 15px; color: #6B6A64;">Firmware</span>
            <span style="font-size: 16px; font-weight: 600;">3.2.1 <span style="color: #B42318; font-weight: 400;">&middot; stale (allow-list 3.4.0)</span></span>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-top: 1px solid #F0EEE9;">
            <span style="display: flex; align-items: center; gap: 6px; font-size: 15px; color: #6B6A64;">
              Health
              <button onclick="toggleInfo('healthInfo')" aria-label="What does Degraded mean?" style="background: none; border: 1px solid #2F6FED; border-radius: 50%; width: 16px; height: 16px; font-size: 13px; line-height: 1; color: #2F6FED; cursor: pointer; padding: 0;">&#9432;</button>
            </span>
            <span style="display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 600;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #CA8A00; display: inline-block;"></span>
              Degraded
            </span>
          </div>
          <div id="healthInfo" hidden style="margin: 2px 0 4px; padding: 14px 16px; background: #F0EEEB; border-radius: 6px; font-size: 14px; color: #333230; line-height: 1.7;">
            <div><span class="mono" style="font-weight: 600;">Healthy</span> &mdash; no active fault code; efficiency/thermal within trailing baseline; comms stable</div>
            <div><span class="mono" style="font-weight: 600;">Degraded</span> &mdash; still operating, one or more soft indicators off (efficiency, temp, or intermittent comms) &mdash; no hard fault active. <strong>This unit is Degraded because of intermittent CAN comms (see Evidence viewer).</strong></div>
            <div><span class="mono" style="font-weight: 600;">Fault</span> &mdash; a hard fault or safety signature is active (always clamps to L0)</div>
            <div><span class="mono" style="font-weight: 600;">Offline</span> &mdash; no recent telemetry; can't evaluate</div>
            <div style="margin-top: 8px; color: #6B6A64;">v0 &mdash; not yet implemented, may change.</div>
            <div style="margin-top: 4px;"><a href="https://app.notion.com/p/3e7d8d4faccd81058155fbce4e41654a" target="_blank">Health status definitions (v0) &mdash; Field RCA design doc &sect;9a &rarr;</a></div>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-top: 1px solid #F0EEE9;">
            <span style="font-size: 15px; color: #6B6A64;">Installed</span>
            <span style="font-size: 16px; font-weight: 600;">2026-03-11 <span style="color: #8A8880; font-weight: 400;">&middot; 199 days ago</span></span>
          </div>
        </div>

        <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 24px;">
          <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 10px;">What we think is wrong</div>
          <div class="mono" style="font-size: 24px; font-weight: 600;">can_link_unreliable</div>
          <div style="font-size: 15px; color: #6B6A64; margin-top: 4px;">81% confidence &middot; connector J3 suspected not fully mated (see Evidence viewer &amp; Hypothesis panel)</div>

          <div style="margin-top: 20px; padding-top: 18px; border-top: 1px solid #F0EEE9; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 6px;">Recommended next step</div>
              <div style="font-size: 17px;"><span class="mono" style="font-weight: 600;">reboot_firmware</span> <span style="color: #6B6A64;">&middot; confidence 0.81 &middot; role required: ops</span></div>
              <div style="margin-top: 6px; font-size: 14px; font-weight: 600;"><span id="actionStatusLabelDiagnosis" style="color: ${statusColor};">${statusLabel}</span></div>
            </div>
            <a href="#action" style="background: #1E4D2B; color: #FFFFFF; border-radius: 6px; padding: 10px 16px; font-size: 15px; font-weight: 700; white-space: nowrap; text-decoration: none; display: inline-block;">Review in Action &rarr;</a>
          </div>
        </div>

        </div>
        <div style="font-size: 14px; color: #8A8880;">Jump to any section above for the full evidence, timeline, notes and approval record behind this diagnosis.</div>
      </div>
    </div>

    <!-- TIMELINE & NOTES (merged: system CaseEvents + human notes, one thread) -->
    <div id="timeline" style="scroll-margin-top: 16px; margin-bottom: 48px;">
      <div style="font-size: 22px; font-weight: 600; margin-bottom: 16px;">Timeline &amp; Notes</div>
      <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
        ${renderCaseThread()}
        <div style="display: flex; gap: 14px; padding: 8px 0; border-top: 1px solid #F0EEE9;">
          <span class="mono" id="timelineFinalTime" style="width: 84px; flex-shrink: 0; font-size: 13px; color: #8A8880; padding-top: 2px;">${timelineFinalTime}</span>
          <span style="width: 96px; flex-shrink: 0; font-size: 13px; font-weight: 600; color: #4A4944; padding-top: 2px;" id="timelineFinalActor">${timelineFinalActor}</span>
          <span style="font-size: 16px; color: #292826;" id="timelineFinalLabel">${timelineFinalLabel}</span>
        </div>
      </div>
    </div>

    <!-- EVIDENCE VIEWER -->
    <div id="evidence" style="scroll-margin-top: 16px; margin-bottom: 48px;">
      <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
        <div style="font-size: 15px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 14px;">Evidence viewer</div>
        <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;">
          <div style="border: 1px solid #EDEBE5; border-radius: 6px; padding: 14px;">
            <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 2px;">Efficiency (%)</div>
            <div style="font-size: 12px; color: #8A8880; margin-bottom: 8px;">08:00 &ndash; 09:45, 15 min buckets</div>
            <div style="display: flex; gap: 8px;">
              <div style="display: flex; flex-direction: column; justify-content: space-between; height: 120px; font-size: 12px; color: #8A8880; text-align: right; width: 36px; flex-shrink: 0;">
                <span>100%</span><span>80%</span><span>60%</span>
              </div>
              <div style="position: relative; flex: 1; height: 120px;">
                <div style="position: absolute; left: 0; right: 0; bottom: ${tempBaselineY}px; border-top: 1px dashed #8A8880;"></div>
                <div style="position: absolute; right: 0; bottom: calc(${tempBaselineY}px + 3px); font-size: 12px; color: #6B6A64; background: #FFFFFF; padding: 0 4px;">baseline 89%</div>
                <div id="tempBars" style="position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 4px;">${renderBars(tempValues, tempMin, tempMax, tempThreshold, 5, "temp")}</div>
              </div>
            </div>
            <div style="display: flex; gap: 4px; padding-left: 44px; margin-top: 4px;">${renderTimes()}</div>
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #F0EEE9; font-size: 14px; color: #292826;">Selected: <strong class="mono" id="tempSelectedLabel">09:15 &mdash; 71% (baseline 89%, -18pt)</strong></div>
          </div>
          <div style="border: 1px solid #EDEBE5; border-radius: 6px; padding: 14px;">
            <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 2px;">Dropped frames / min</div>
            <div style="font-size: 12px; color: #8A8880; margin-bottom: 8px;">08:00 &ndash; 09:45, 15 min buckets</div>
            <div style="display: flex; gap: 8px;">
              <div style="display: flex; flex-direction: column; justify-content: space-between; height: 120px; font-size: 12px; color: #8A8880; text-align: right; width: 36px; flex-shrink: 0;">
                <span>120</span><span>60</span><span>0</span>
              </div>
              <div style="position: relative; flex: 1; height: 120px;">
                <div style="position: absolute; left: 0; right: 0; bottom: ${canThresholdY}px; border-top: 1px dashed #B42318;"></div>
                <div style="position: absolute; right: 0; bottom: calc(${canThresholdY}px + 3px); font-size: 12px; color: #B42318; background: #FFFFFF; padding: 0 4px;">threshold 45/min</div>
                <div style="position: absolute; left: 0; right: 0; bottom: ${canBaselineY}px; border-top: 1px dashed #8A8880;"></div>
                <div style="position: absolute; left: 0; bottom: calc(${canBaselineY}px - 12px); font-size: 12px; color: #6B6A64; background: #FFFFFF; padding: 0 4px;">baseline 36/min</div>
                <div id="canBars" style="position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 4px;">${renderBars(canValues, canMin, canMax, canThreshold, 5, "can")}</div>
              </div>
            </div>
            <div style="display: flex; gap: 4px; padding-left: 44px; margin-top: 4px;">${renderTimes()}</div>
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #F0EEE9; font-size: 14px; color: #292826;">Selected: <strong class="mono" id="canSelectedLabel">09:15 &mdash; 112 dropped frames/min (3.1&times; the 36/min baseline)</strong></div>
            <div style="font-size: 13px; color: #8A8880; margin-top: 4px;">3 bus-off events recorded during the spike bucket</div>
          </div>
        </div>

        <div style="border: 1px solid #EDEBE5; border-radius: 6px; padding: 14px; margin-top: 16px;">
          <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 10px;">Device info</div>
          <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;">
            <div><div style="font-size: 13px; color: #8A8880;">Firmware</div><div class="mono" style="font-size: 15px; font-weight: 600; margin-top: 2px;">3.2.1</div></div>
            <div><div style="font-size: 13px; color: #8A8880;">Boot reason</div><div style="font-size: 15px; font-weight: 600; margin-top: 2px;">Watchdog reset</div></div>
            <div><div style="font-size: 13px; color: #8A8880;">Uptime</div><div style="font-size: 15px; font-weight: 600; margin-top: 2px;">14d 6h</div></div>
            <div><div style="font-size: 13px; color: #8A8880;">Connectivity</div><div style="font-size: 15px; font-weight: 600; margin-top: 2px;">Cellular &middot; -78 dBm</div></div>
          </div>
        </div>

        <div style="border: 1px solid #EDEBE5; border-radius: 6px; padding: 14px; margin-top: 16px;">
          <div style="font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 10px;">Recent OTA / reboot history</div>
          <div style="display: flex; gap: 12px; padding: 7px 0; border-top: 1px solid #F0EEE9;">
            <span class="mono" style="width: 130px; flex-shrink: 0; font-size: 13px; color: #8A8880; padding-top: 1px;">2026-09-20 09:14</span>
            <span style="font-size: 15px; color: #292826;">Remote reboot (soft fault, resolved)</span>
          </div>
          <div style="display: flex; gap: 12px; padding: 7px 0; border-top: 1px solid #F0EEE9;">
            <span class="mono" style="width: 130px; flex-shrink: 0; font-size: 13px; color: #8A8880; padding-top: 1px;">2026-08-30 02:00</span>
            <span style="font-size: 15px; color: #B42318;">OTA update attempted &rarr; 3.3.0 (failed, rolled back to 3.2.1)</span>
          </div>
          <div style="display: flex; gap: 12px; padding: 7px 0; border-top: 1px solid #F0EEE9;">
            <span class="mono" style="width: 130px; flex-shrink: 0; font-size: 13px; color: #8A8880; padding-top: 1px;">2026-08-02 14:00</span>
            <span style="font-size: 15px; color: #1D6F3E;">OTA update &rarr; 3.2.1 (success)</span>
          </div>
          <div style="font-size: 13px; color: #8A8880; margin-top: 8px;">The failed 3.3.0 rollback is why this unit still shows the stale-firmware flag in Diagnosis.</div>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 14px; border-top: 1px solid #F0EEE9;">
          <div style="display: flex; align-items: center; gap: 8px; font-size: 15px; color: #292826;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3D8B3D" stroke-width="2.5"><path d="M4 12l5 5L20 6"/></svg>
            Commissioning checklist complete
          </div>
          <button id="logToggleBtn" onclick="toggleLog()" style="background: none; border: 1px solid #D8D5CC; border-radius: 6px; font-size: 14px; padding: 6px 12px; color: #4A4944; cursor: pointer;">Show raw log</button>
        </div>
        <div id="rawLog" hidden class="mono" style="margin-top: 10px; background: #292826; color: #D8D5CC; font-size: 14px; padding: 12px 14px; border-radius: 6px; line-height: 1.6; white-space: pre-line;">09:14:02 CAN0 err_frame count=112 (win=60s)&#10;09:14:11 CAN0 bus-off recovered after 3 retries&#10;09:14:47 node 0x22 heartbeat missed x4&#10;09:15:03 fw: no fault code raised, comms-layer only</div>
      </div>
    </div>

    <!-- HYPOTHESIS PANEL -->
    <div id="hypothesis" style="scroll-margin-top: 16px; margin-bottom: 48px;">
      <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
        <div style="font-size: 15px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 14px;">Hypothesis panel</div>
        ${renderDifferentials()}
        <div style="margin-top: 18px; padding-top: 16px; border-top: 1px solid #F0EEE9;">
          <label style="display: block; font-size: 14px; font-weight: 600; color: #4A4944; margin-bottom: 6px;">Human override &mdash; root cause class</label>
          <select onchange="handleOverride(this.value)" style="width: 280px; padding: 8px 10px; border: 1px solid #D8D5CC; border-radius: 6px; font-size: 15px; background: #FFFFFF;">
            ${overrideOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
          </select>
          <div id="overrideBanner" hidden style="margin-top: 10px; font-size: 14px; color: #9A5B00; background: #FFF3E0; padding: 8px 12px; border-radius: 6px;">
            Override recorded &mdash; counts toward the agent/engineer disagreement-rate metric.
          </div>
        </div>
      </div>
    </div>

    <!-- ACTION -->
    <div id="action" style="scroll-margin-top: 16px; margin-bottom: 48px;">
      <div style="font-size: 22px; font-weight: 600; margin-bottom: 16px;">Action</div>
      <div style="display: flex; flex-direction: column; gap: 16px; align-items: stretch;">
        <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
          <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64;">Current permission level</div>
          <div style="font-size: 26px; font-weight: 600; margin-top: 4px;">L2 &mdash; Supervised act</div>
        </div>
        <div style="background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 20px 24px;">
          <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 10px;">Recommended action</div>
          <div class="mono" style="font-size: 18px; font-weight: 600;">reboot_firmware</div>
          <div style="font-size: 15px; color: #6B6A64; margin: 4px 0 16px;">confidence 0.81 &middot; role required: ops</div>
          <div style="display: flex; gap: 8px; max-width: 320px;">
            <button id="approveBtn" onclick="decideAction('approved')" ${decided ? "disabled" : ""} style="flex: 1; background: ${approveBg}; color: ${approveColor}; border: none; border-radius: 6px; padding: 10px 0; font-size: 15px; font-weight: 700; cursor: ${approveCursor};">Approve</button>
            <button id="rejectBtn" onclick="decideAction('rejected')" ${decided ? "disabled" : ""} style="flex: 1; background: #FFFFFF; color: #DC2626; border: 1px solid #F0B4B4; border-radius: 6px; padding: 10px 0; font-size: 15px; font-weight: 600; cursor: ${approveCursor};">Reject</button>
          </div>
          <div style="margin-top: 12px; font-size: 15px; font-weight: 600;"><span id="actionStatusLabelAction" style="color: ${statusColor};">${statusLabel}</span></div>

          <div style="margin-top: 20px; padding-top: 18px; border-top: 1px solid #F0EEE9;">
            <div style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6B6A64; margin-bottom: 10px;">Approval</div>
            <div style="font-size: 16px; margin-bottom: 14px;">Status: <span id="approvalStatusLabel" style="font-weight: 600;">${approvalStatusLabel}</span></div>
            <button id="signBtn" onclick="signClose()" ${signClickable ? "" : "disabled"} style="width: 260px; background: ${signBg}; color: ${signColor}; border: 1px solid ${signBorder}; border-radius: 6px; padding: 10px 0; font-size: 15px; font-weight: 700; cursor: ${signCursor};">${signLabel}</button>
            <div style="font-size: 14px; color: #8A8880; margin-top: 10px;">Engineer signature only &middot; resolve the recommended action above first.</div>
            <div id="signedNote" ${closed ? "" : "hidden"} style="font-size: 14px; color: #1E4D2B; margin-top: 8px; font-weight: 600;">Signed by Engineer &middot; just now</div>
          </div>
        </div>
      </div>
    </div>

    <!-- OTHER INFORMATION (placeholder) -->
    <div id="other" style="scroll-margin-top: 16px;">
      <div style="background: #FFFFFF; border: 1px dashed #D8D5CC; border-radius: 8px; padding: 24px; color: #6B6A64;">
        <div style="font-size: 15px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px;">Other information</div>
        <div style="font-size: 16px;">Not yet designed &mdash; reserved for things like install/commissioning history and a link to the technician profile who last visited this asset. Nothing real to show here yet.</div>
      </div>
    </div>

  </div>
</div>

<script>
function jumpToSection(e, id) {
  e.preventDefault();
  const header = document.getElementById('stickyHeader');
  const target = document.getElementById(id);
  if (!target) return;
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const targetTop = target.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top: Math.max(0, targetTop - headerHeight), behavior: 'smooth' });
}
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => jumpToSection(e, a.getAttribute('href').slice(1)));
});

function toggleInfo(id) {
  const el = document.getElementById(id);
  el.hidden = !el.hidden;
}

function toggleLog() {
  const log = document.getElementById('rawLog');
  log.hidden = !log.hidden;
  document.getElementById('logToggleBtn').textContent = log.hidden ? 'Show raw log' : 'Hide raw log';
}

function handleOverride(value) {
  document.getElementById('overrideBanner').hidden = !value;
}

const CHART_SCALE = (min, max, val) => Math.round(((val - min) / (max - min)) * 120);
const TEMP_VALUES = ${JSON.stringify(tempValues)};
const CAN_VALUES = ${JSON.stringify(canValues)};
const BUCKET_TIMES = ${JSON.stringify(bucketTimes)};
const TEMP_BASELINE = ${tempBaseline};
const CAN_BASELINE = ${canBaseline};

function selectBar(kind, idx) {
  const container = document.getElementById(kind === 'temp' ? 'tempBars' : 'canBars');
  container.querySelectorAll('.bar > div').forEach((bar, i) => {
    bar.style.boxShadow = i === idx ? 'inset 0 0 0 2px #292826' : 'none';
  });
  if (kind === 'temp') {
    const v = TEMP_VALUES[idx];
    const diff = v - TEMP_BASELINE;
    document.getElementById('tempSelectedLabel').textContent =
      BUCKET_TIMES[idx] + ' — ' + v + '% (baseline ' + TEMP_BASELINE + '%, ' + (diff > 0 ? '+' : '') + diff + 'pt)';
  } else {
    const v = CAN_VALUES[idx];
    const mult = (v / CAN_BASELINE).toFixed(1);
    document.getElementById('canSelectedLabel').textContent =
      BUCKET_TIMES[idx] + ' — ' + v + ' dropped frames/min (' + mult + '× the ' + CAN_BASELINE + '/min baseline)';
  }
}

function decideAction(state) {
  fetch('/api/case/1234/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'decision=' + state,
  });

  document.getElementById('approveBtn').disabled = true;
  document.getElementById('rejectBtn').disabled = true;
  document.getElementById('approveBtn').style.background = '#EFEDE7';
  document.getElementById('approveBtn').style.color = '#B0AEA6';
  document.getElementById('approveBtn').style.cursor = 'default';
  document.getElementById('rejectBtn').style.cursor = 'default';

  let label, color;
  if (state === 'approved') {
    label = 'Approved — executed';
    color = '#1E4D2B';
    document.getElementById('timelineFinalTime').textContent = 'now';
    document.getElementById('timelineFinalActor').textContent = 'OPS';
    document.getElementById('timelineFinalLabel').textContent = 'Approved — reboot_firmware executed, post-check scheduled in 15 min';
  } else {
    label = 'Rejected — escalated to engineer';
    color = '#DC2626';
    document.getElementById('timelineFinalTime').textContent = 'now';
    document.getElementById('timelineFinalActor').textContent = 'OPS';
    document.getElementById('timelineFinalLabel').textContent = 'Rejected — case escalated for engineer review';
  }
  ['actionStatusLabelDiagnosis', 'actionStatusLabelAction'].forEach((id) => {
    const el = document.getElementById(id);
    el.textContent = label;
    el.style.color = color;
  });

  const signBtn = document.getElementById('signBtn');
  signBtn.disabled = false;
  signBtn.style.background = '#1E4D2B';
  signBtn.style.color = '#FFFFFF';
  signBtn.style.borderColor = '#1E4D2B';
  signBtn.style.cursor = 'pointer';
}

function signClose() {
  fetch('/api/case/1234/close', { method: 'POST' });

  const signBtn = document.getElementById('signBtn');
  signBtn.disabled = true;
  signBtn.textContent = 'Signed & Closed ✓';
  signBtn.style.background = '#EAF3E7';
  signBtn.style.color = '#1E4D2B';
  signBtn.style.borderColor = '#EAF3E7';
  signBtn.style.cursor = 'default';

  document.getElementById('caseStatusDiagnosis').textContent = 'Closed';
  document.getElementById('approvalStatusLabel').textContent = 'Closed';
  document.getElementById('signedNote').hidden = false;
}
</script>
</body>
</html>`;
}
