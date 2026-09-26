# Testing & demo guide — login, roles, shared case state

Walkthrough for testing and showcasing the two-role login system (Base Staff vs.
Technician) and the shared case-decision state between them.

## 1. Start the app

```
npm run dashboard
```

Serves at **http://localhost:4173**. Logged out, every route redirects to `/login`.

## 2. Accounts

| Username | Password     | Role                          | Lands on       |
|----------|--------------|-------------------------------|----------------|
| `staff`  | `basehq2026` | Engineer / Ops / Admin (one login) | `/fleet`  |
| `tech`   | `basehq2026` | Technician                    | `/technician`  |

## 3. Demo script

### Part A — Staff side

1. Go to `http://localhost:4173/login`, log in as `staff` / `basehq2026`.
2. Lands on **Fleet RCA Dashboard** (`/fleet`) — KPI row, root-cause histogram, FW
   version clusters, the false-pull-rate trend chart, the open-cases table.
3. Click any case row → **Case Workspace** (`/case`, always Case #1234 in this
   mock). Tour: Diagnosis, the merged **Timeline & Notes** thread (system events
   + human notes in one chronological feed), Evidence viewer, Hypothesis panel,
   Action tab.
4. On the **Action** tab, click **Approve**. Note it live-updates in this tab
   (button disables, status goes green, Sign & Close enables) — this call also
   persists to the server, not just this browser tab.

### Part B — Technician side (the actual point of the feature)

5. Open a **second browser** (or an incognito window — a real second session,
   not just a new tab, so it's obviously not sharing state with Part A).
6. Log in as `tech` / `basehq2026`. Lands on **Technician Dashboard**
   (`/technician`) — a read-only list of the 5 open/pending cases.
7. Open the linked case → **read-only** view: case header, a one-paragraph
   "why you're here," the same Timeline & Notes thread, and a **Direction**
   block. No Approve/Reject buttons anywhere on this side.
8. **The showcase moment**: the Direction block already reads *"Approved:
   reboot_firmware — proceed with this action"* — because of the Approve
   click in Part A, on a completely different login session. That's the real
   point: an engineer's decision reaches the technician through the system
   itself, not a Slack ping.

### Part C — Prove the role gating (quick, optional)

- While logged in as `tech`, try navigating to `/fleet` or `/case` directly →
  bounced back to `/technician`, not an error page.
- While logged in as `staff`, try navigating to `/technician` directly →
  bounced back to `/fleet`.
- This shows the role split is enforced server-side, not just hidden buttons.

## 4. Resetting for a repeat run

The approve/reject decision is stored in memory (`src/session-store.ts`,
`caseDecisions`) and isn't reset by logging out. To run the demo again from a
clean "Awaiting engineer approval" state, **restart the server**
(`Ctrl+C`, then `npm run dashboard` again) — sessions and decisions both reset.

## 5. Logging out

`/logout` from either role clears the session and returns to `/login`.
