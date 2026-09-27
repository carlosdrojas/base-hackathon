# ARCA demo script (~3 min)

**One-line story:** most pulled inverters are fine. ARCA diagnoses, tries the cheapest safe fix, proves it worked, and only rolls a truck when it has to.

## Before recording

1. Clean start:
   ```
   rm -rf data/runtime && npm run dashboard
   ```
2. Log in as `staffAustin` / `basehq2026`. In a second browser or incognito window, log in as `tech` / `basehq2026`.
3. Open `/response`, click **All Texas**, and wait ~10 s so the hot-garage cases resolve and the scorecard fills in. Switch back to **Austin**.
4. Close the tour if it opens.

**Bold** lines are clicks. The rest is spoken (~420 words).

---

### 0:00–0:25 · The problem
**[`/fleet`, Austin view, map visible]**

> Base has thousands of batteries in Texas homes. When one throws a fault, the default move is to roll a truck, and often to pull the hardware back to HQ. But most of those units turn out to be fine: a loose connector, a missed install step, a false alarm. ARCA exists to stop pulling healthy hardware.

### 0:25–0:55 · Diagnosis
**[Click case BP-CORE-00020-53 → `/case`]**

> Here's a real case from our fleet. Our detectors read the unit's telemetry: both fans at zero RPM, the heatsink at 92 degrees, and a fan-missing event from the detector. It's flagged as a safety case, so nothing gets touched remotely.

### 0:55–1:55 · The agent acts
**[Click Response → same case]**

> This is the response agent. It turns the diagnosis into a plan, cheapest and safest fix first. Its first instinct is a reboot, but look: **denied**. The policy gate is deterministic code, not AI, and it blocks any remote action on a safety case. So the agent escalates to a technician.

**[Click Approve on dispatch_tech; point at the visit card]**

> One approval, and a tech is booked with a brief, a checklist, and a photos-required rule.

**[Tech window → `/technician` → complete the visit with photos → back to `/response`]**

> The tech finds the fans were never installed and installs them. The agent doesn't take anyone's word for it. It re-reads the unit, confirms the fault cleared, and sends the case to an engineer to sign off.

**[Click Close case]**

> The battery stays in the home. It was an install miss, not bad hardware.

### 1:55–2:35 · The proof
**[Click All Texas; point at the Answer-key check]**

> Now the whole Texas fleet. Our telemetry pack comes with an answer key saying what should happen to each unit. The agent never sees it; we grade against it afterward. Zero wrong pulls: every unit that should stay in the field stayed there. And where we missed, the misses trace back to diagnosis, which tells us exactly what to tune next.

### 2:35–3:00 · Why it's real
**[Scroll the case timeline]**

> Every step is audited: who approved what, and when. The planner can only choose from eight fixed actions, never writes firmware, and only an engineer can approve a firmware update. One engine runs every screen, with 147 automated tests behind it. Swap our simulator for Base's device API and the same loop runs on the real fleet. That's ARCA.

---

## Tips

- Running long? Cut the tech-window step: say "the tech installs the missing fans" and jump to the verified result.
- If the scorecard shows "–" at 1:55, the All Texas warm-up was skipped.
- Don't dwell on `/fleet`'s "Active firmware versions" or "False-pull rate trend" cards. They show fixed example numbers.
- Don't plant faults live on camera.
- Rehearse once with a timer. First takes usually run about 15% long.
