# Software features

> Local copy of the Notion page **Software features** (child of the Field RCA design doc).
> Source: https://app.notion.com/p/3e7e26707bba819aa480e2acde0fb6ce · copied 2026-09-26. Notion wins if they diverge.

Straight list of what this product does. This sits under the main design doc. Other agents should treat this as the feature set, not extra architecture.

**Locked decision:** only an engineer can approve an OTA / reflash. Not ops. Not a technician. Not the AI.

---

## Who can do what (login and permissions)

People log in. The product knows their role. The role decides what buttons they even see.

Roles:

- **Technician** — sees the job they were sent on, the checklist, photos, and a simple “what we think is wrong.” Cannot reboot remotely. Cannot approve firmware. Cannot close an RCA.
- **Ops / dispatch** — can open cases, send a tech, schedule a truck, approve a reboot when policy allows. Cannot approve an OTA.
- **Engineer** — can approve or reject every RCA. **Only role that can approve an OTA / firmware update.** Can mark a unit “bring it in” vs “keep it in the field.”
- **Admin** — manages who has which role. Does not bypass safety rules.

Rules that do not change with role:

- AI cannot rewrite firmware.
- AI cannot flash anything by itself.
- If the inverter looks like a safety problem (smoke, thermal, HV), nobody gets a remote “just try a reboot” button. Flag it and send people.

Login is required for any action that touches a unit or closes a case. Every click is stored on the RCA: who did it, what they did, when.

---

## Cases (the RCA itself)

- Open a case when something looks wrong in the field (telemetry, a person reports it, or a tech is already on site).
- One case per incident. Keep the asset, firmware version, site, and what triggered it at the top.
- Status is obvious: open, waiting on a person, tech on the way, waiting on an engineer, closed.
- Every RCA has to be approved by an engineer before it is closed.
- Full history stays on the case: what the AI thought, what logs it used, what action was taken, which tech showed up, what that person wrote, whether a human overrode the AI.

---

## What the AI is allowed to do

- Read telemetry and software / firmware logs.
- Point at the likely cause. First things to catch: unit is actually fine, connector not seated, install was wrong, firmware version is wrong.
- Recommend the next step.
- Reboot firmware only when the case is not a safety flag, and a person still has to approve it.
- Suggest an OTA to a known released firmware version. Stop there. An engineer has to approve it. Then a person runs the update.
- Suggest sending a technician, or sending a truck to bring the unit back to Base HQ.
- Cannot invent new actions. Cannot write firmware. Cannot disable protection.

---

## Field visits

- Tech gets a short “why you are here” and a short checklist, not a pile of raw logs.
- Connector / install jobs require photos before the visit can be marked done.
- A visit cannot be marked complete if the work is not actually done. Tech has to pick a reason: parts, access, did not know what to do, unsafe, needs an engineer.
- Incomplete visits stay on the case so the next person is not starting from zero the next day.
- If a tech leaves and someone else has to come back, that bounce is tracked.

---

## Technician profiles

- A simple dashboard per technician.
- What we keep: how often they finish the job, how often a second visit is needed, what kinds of jobs they handle well, incomplete-visit reasons.
- Flag people who may need retraining. This is for quality, not a public scoreboard.

---

## Keep it in the field vs bring it in

- Default bias: most inverters are fine. Do not pull them to HQ unless we have a real reason.
- AI can recommend “no fault found, watch it” vs “send a tech” vs “bring it to engineers.”
- Bringing a unit to HQ needs ops plus an engineer.

---

## Dashboards (if we have time)

- All open RCAs in one place.
- Most common causes.
- How often we pulled a unit that was actually fine.
- How often we needed a second tech visit.
- Firmware version clusters (a lot of the same problem on one version).
- How often engineers agree with the AI.

---

## What we are not building

- An AI that writes or patches firmware.
- A chatbot with no case record.
- Auto-flash with no engineer in the loop.
- Letting a technician approve an OTA.
