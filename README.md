# Vantage Health — Secure Patient-Doctor Healthcare Platform

A working prototype of the platform described in the brief: dual-role auth,
OTP-gated 25-minute doctor sessions, no-edit prescriptions, patient-visible
audit logging, and rule-based "AI" medication/chronic-care reminders.

## Run it

```bash
cd backend
node server.js
```

Then open **http://localhost:4000** — the backend serves the frontend too,
so there's nothing else to start and nothing to `npm install` (the backend
uses only Node's built-in modules).

Requires Node 18+ (uses `crypto.scryptSync`, `crypto.randomInt`).

## How to try the full flow

1. **Register as a patient** (left portal card). You'll land on the patient
   dashboard.
2. Click **Generate code** on the Overview tab — this is the 25-minute
   access code you'd hand a doctor in person. It's echoed back on screen
   since there's no real SMS gateway wired up in this demo.
3. Open a **second browser tab/window**, go back to the role picker (or use
   an incognito window), and **register as a doctor**.
4. On the doctor's Home screen, paste the code from step 2 and click
   **Open session**. A 25-minute countdown ring starts immediately.
5. As the doctor: view the patient's recent visits, write a new
   prescription (try "Metformin, 500mg, twice daily" and mention
   "diabetes" in the notes), and try opening **Full history** — it's
   locked until a *second*, separate OTP is requested and the patient
   supplies it.
6. Switch back to the **patient tab** and check the **Access Log** tab —
   every one of the doctor's actions (access granted, record viewed,
   history requested/unlocked, prescription added) is listed with a
   timestamp. Check **Reminders** to see the rule-based medication and
   chronic-care follow-up reminders generated from that prescription.

The doctor's session auto-expires at 25:00 — you can also end it early
with **End visit**. Either way, the patient sees a `session_expired` /
`session_ended` entry appear in their log.

## What's implemented vs. simplified for the demo

| Brief requirement | This prototype |
|---|---|
| Patient email/mobile/OTP/password signup | ✅ full registration + password login + OTP login |
| Doctor/hospital registration | ✅ separate registration & login |
| Doctor access **only** via OTP, 25-min window, auto-revoke | ✅ enforced server-side on every session route, not just in the UI |
| No edit permission for doctors | ✅ there is no update/delete endpoint for prescriptions at all — only `POST` (add) |
| Separate OTP for past history | ✅ second, independently-issued OTP scoped to that session |
| Prescription history, date-stamped | ✅ `d/m/yy`-style stamps per visit |
| Transparent, patient-visible audit trail | ✅ every doctor action writes an audit entry the patient can read in plain language |
| AI-powered medication/chronic-care reminders | ⚠️ simulated with a transparent rule engine (`generateReminders` in `server.js`) that parses dosage frequency and chronic-condition keywords. Swap this for a real model/LLM call or a proper scheduling service in production. |
| OTP delivery via SMS | ⚠️ there's no SMS gateway hooked up, so OTPs are returned directly in the API response / shown as a toast, clearly labeled "demo code." Wire in Twilio/MSG91/etc. and stop returning `demoOtp` before going anywhere near real patient data. |
| Data persistence | ⚠️ in-memory (`Map`s in `server.js`) — restarting the server clears everything. The whole app talks to the DB only through a handful of helper functions, so swapping in Postgres/Mongo is a contained change. |

## Project structure

```
healthcare-platform/
├── backend/
│   └── server.js       # Node http server — routing, auth, OTP/session logic, reminder engine
├── frontend/
│   ├── index.html       # Role picker, auth forms, patient & doctor dashboards
│   ├── styles.css       # Design system (teal/coral, Fraunces + Inter + JetBrains Mono)
│   └── app.js           # All client-side logic, calls the API with fetch()
└── README.md
```

## Security notes for turning this into something real

- Passwords are hashed with `scrypt` + per-user salt — fine for a demo,
  but you'll want a maintained library (e.g. `argon2`) in production.
- Auth "tokens" here are random opaque strings held in memory, not JWTs —
  swap for signed, expiring tokens and move `db.tokens` to a real store.
- Add HTTPS/TLS termination (e.g. behind nginx or a managed load balancer)
  before this ever leaves localhost.
- Add rate limiting on the OTP endpoints — as written, nothing stops
  someone from brute-forcing a 6-digit code beyond its 5-minute expiry.
- This demo returns OTPs in the API response for convenience. In a real
  deployment, generate the code, send it out-of-band (SMS/email), and
  never echo it back over the same channel that's requesting it.
