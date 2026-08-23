/**
 * Secure Patient-Doctor Healthcare Management Platform — Backend
 * Zero external dependencies. Run with: node server.js
 *
 * Data is stored in-memory (resets on restart). Swap the `db` object
 * for a real database (Postgres/Mongo) in production — every access
 * goes through the small helper functions below, so that's the only
 * layer you'd need to change.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { DatabaseSync } = require('node:sqlite');
const dotenv = require('dotenv');

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_DIR = __dirname;
const stateDb = new DatabaseSync(path.join(__dirname, 'smartmedico.db'));
stateDb.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

// ---------------------------------------------------------------------------
// In-memory "database"
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = process.env.SMARTMEDICO_ADMIN_EMAIL || 'admin@smartmedico.local';
const ADMIN_PASSWORD = process.env.SMARTMEDICO_ADMIN_PASSWORD || 'SmartMedicoAdmin123!';

const db = {
  patients: new Map(),     // id -> patient
  doctors: new Map(),      // id -> doctor
  admins: new Map(),       // id -> admin
  accessOtps: new Map(),   // otp -> { patientId, expiresAt, used }
  historyOtps: new Map(),  // otp -> { sessionId, expiresAt, used }
  sessions: new Map(),     // sessionId -> session
  tokens: new Map(),       // token -> { role, id }
};

function persistState() {
  const snapshot = {
    patients: [...db.patients.entries()],
    doctors: [...db.doctors.entries()],
    admins: [...db.admins.entries()],
    accessOtps: [...db.accessOtps.entries()],
    historyOtps: [...db.historyOtps.entries()],
    sessions: [...db.sessions.entries()],
    tokens: [...db.tokens.entries()],
  };

  stateDb.exec('BEGIN');
  stateDb.prepare('INSERT INTO app_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('db_snapshot', JSON.stringify(snapshot));
  stateDb.exec('COMMIT');
}

function hydrateState() {
  const row = stateDb.prepare('SELECT value FROM app_state WHERE key = ?').get('db_snapshot');
  if (!row) return;
  try {
    const snapshot = JSON.parse(row.value);
    db.patients = new Map(snapshot.patients || []);
    db.doctors = new Map(snapshot.doctors || []);
    db.admins = new Map(snapshot.admins || []);
    db.accessOtps = new Map(snapshot.accessOtps || []);
    db.historyOtps = new Map(snapshot.historyOtps || []);
    db.sessions = new Map(snapshot.sessions || []);
    db.tokens = new Map(snapshot.tokens || []);
  } catch (error) {
    console.warn('State hydration failed; starting from an empty in-memory store.', error.message);
  }
}

function ensureBootstrapAdmin() {
  const adminId = 'admin';
  if (!db.admins.has(adminId)) {
    db.admins.set(adminId, {
      id: adminId,
      name: 'System Administrator',
      email: ADMIN_EMAIL,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      createdAt: Date.now(),
    });
    persistState();
  }
}

hydrateState();
ensureBootstrapAdmin();

const SESSION_LENGTH_MS = 25 * 60 * 1000; // 25 minutes
const ACCESS_OTP_TTL_MS = 5 * 60 * 1000;  // patient-generated OTP valid 5 min
const HISTORY_OTP_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const uid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const genOtp = () => String(crypto.randomInt(100000, 999999));
const now = () => Date.now();

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}

function issueToken(role, id) {
  const token = uid('tok');
  db.tokens.set(token, { role, id, createdAt: now() });
  persistState();
  return token;
}
function getAuth(req) {
  const header = req.headers['authorization'] || '';
  const fallback = req.headers['x-smartmedico-token'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (fallback || null);
  if (!token) return null;
  const entry = db.tokens.get(token);
  if (!entry) return null;
  return { token, ...entry };
}

function addAudit(patient, entry) {
  patient.auditLog.unshift({
    id: uid('log'),
    timestamp: now(),
    ...entry,
  });
}

function findPatientByEmail(email) {
  return [...db.patients.values()].find((p) => p.email.toLowerCase() === email.toLowerCase());
}
function findDoctorByEmail(email) {
  return [...db.doctors.values()].find((d) => d.email.toLowerCase() === email.toLowerCase());
}

function publicPatient(p) {
  return { id: p.id, name: p.name, email: p.email, mobile: p.mobile, createdAt: p.createdAt };
}
function publicDoctor(d) {
  return { id: d.id, name: d.name, email: d.email, mobile: d.mobile, hospital: d.hospital };
}
function publicAdmin(a) {
  return { id: a.id, name: a.name, email: a.email };
}

function expireSessionIfNeeded(session) {
  if (session.status === 'active' && now() >= session.expiresAt) {
    session.status = 'expired';
    persistState();
    const patient = db.patients.get(session.patientId);
    if (patient) {
      addAudit(patient, {
        type: 'session_expired',
        doctorId: session.doctorId,
        doctorName: session.doctorName,
        sessionId: session.id,
        detail: 'Access window closed automatically after 25 minutes.',
      });
      persistState();
    }
  }
  return session;
}

// ---------------------------------------------------------------------------
// AI-powered reminder engine with a local fallback for offline/demo use.
// ---------------------------------------------------------------------------
const CHRONIC_KEYWORDS = {
  diabetes: { label: 'Diabetes follow-up', everyDays: 90 },
  diabetic: { label: 'Diabetes follow-up', everyDays: 90 },
  hypertension: { label: 'Blood pressure follow-up', everyDays: 90 },
  'blood pressure': { label: 'Blood pressure follow-up', everyDays: 90 },
  thyroid: { label: 'Thyroid panel follow-up', everyDays: 120 },
  asthma: { label: 'Asthma review', everyDays: 180 },
  cardiac: { label: 'Cardiac follow-up', everyDays: 90 },
  surgery: { label: 'Post-surgical checkup', everyDays: 120 },
  'post-op': { label: 'Post-surgical checkup', everyDays: 120 },
};

const FREQUENCY_PATTERNS = [
  { re: /\bonce a day|once daily|od\b|1x\/?day\b/i, timesPerDay: 1 },
  { re: /\btwice a day|twice daily|bd\b|bid\b|2x\/?day\b/i, timesPerDay: 2 },
  { re: /\bthrice a day|three times a day|tds\b|tid\b|3x\/?day\b/i, timesPerDay: 3 },
  { re: /\b4 times a day|four times a day|qid\b/i, timesPerDay: 4 },
];

function buildFallbackReminders(patient) {
  const reminders = [];
  const meds = patient.prescriptions.flatMap((rx) => rx.medicines.map((m) => ({ ...m, date: rx.date })));

  for (const med of meds) {
    const text = `${med.name} ${med.dosage || ''} ${med.frequency || ''}`;
    let timesPerDay = 1;
    for (const pat of FREQUENCY_PATTERNS) {
      if (pat.re.test(text)) { timesPerDay = pat.timesPerDay; break; }
    }
    const slots = timesPerDay === 1 ? ['08:00'] :
      timesPerDay === 2 ? ['08:00', '20:00'] :
      timesPerDay === 3 ? ['08:00', '14:00', '20:00'] :
      ['08:00', '12:00', '16:00', '20:00'];

    const priority = /insulin|blood thinner|steroid|antibiotic|painkiller|thyroid|diab|warfarin|rivaroxaban/i.test(String(med.name)) ? 'High' : 'Routine';
    reminders.push({
      id: uid('rem'),
      type: 'medication',
      title: `Take ${med.name}${med.dosage ? ' — ' + med.dosage : ''}`,
      schedule: slots,
      note: med.frequency ? `Prescribed: ${med.frequency}` : 'Follow prescribed frequency',
      sourceDate: med.date,
      priority,
      aiLabel: 'AI-generated',
      insight: priority === 'High'
        ? 'Monitor timing closely and confirm refill timing with your clinician.'
        : 'Stay consistent with the prescribed schedule to support your treatment plan.',
    });
  }

  const allText = patient.prescriptions.map((rx) => `${rx.notes || ''} ${rx.medicines.map(m => m.name).join(' ')}`).join(' ').toLowerCase();
  const seenLabels = new Set();
  for (const [kw, cfg] of Object.entries(CHRONIC_KEYWORDS)) {
    if (allText.includes(kw) && !seenLabels.has(cfg.label)) {
      seenLabels.add(cfg.label);
      const lastRx = patient.prescriptions[patient.prescriptions.length - 1];
      const base = lastRx ? lastRx.timestamp : now();
      reminders.push({
        id: uid('rem'),
        type: 'chronic_followup',
        title: cfg.label,
        dueDate: base + cfg.everyDays * 24 * 60 * 60 * 1000,
        note: `Recommended check-in every ~${Math.round(cfg.everyDays / 30)} months based on your records.`,
        priority: 'Monitor',
        aiLabel: 'AI-generated',
        insight: `Schedule a review around ${new Date(base + cfg.everyDays * 24 * 60 * 60 * 1000).toLocaleDateString()} to keep this condition on track.`,
      });
    }
  }

  return reminders;
}

async function generateAIInsights(patient) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !globalThis.fetch) return null;

  const meds = patient.prescriptions.flatMap((rx) => rx.medicines.map((m) => ({
    name: m.name,
    dosage: m.dosage,
    frequency: m.frequency,
  })));
  if (!meds.length) return null;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a care-optimization assistant. Return only valid JSON with a "recommendations" array of {"medication": string, "priority": "Routine|Monitor|High", "insight": string}. Keep every recommendation brief, non-diagnostic, and suitable for a patient dashboard.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              patientSummary: {
                prescriptionCount: patient.prescriptions.length,
                meds,
                recentNotes: patient.prescriptions.slice(-3).map((rx) => rx.notes).filter(Boolean),
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.recommendations) ? parsed.recommendations : null;
  } catch (error) {
    return null;
  }
}

async function generateReminders(patient) {
  const base = buildFallbackReminders(patient);
  const ai = await generateAIInsights(patient);
  if (!ai) return base;

  return base.map((reminder) => {
    const match = ai.find((item) => {
      if (!item.medication) return false;
      const medNorm = String(item.medication).toLowerCase().replace(/[^a-z0-9]/g, '');
      const titleNorm = String(reminder.title).toLowerCase().replace(/[^a-z0-9]/g, '');
      return titleNorm.includes(medNorm) || medNorm.includes(titleNorm);
    });

    if (!match) return reminder;
    return {
      ...reminder,
      priority: match.priority || reminder.priority,
      insight: match.insight || reminder.insight,
      aiLabel: 'AI-assisted',
    };
  });
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

// --- Patient auth -----------------------------------------------------------
route('POST', '/api/patient/register', async (req, res, body) => {
  const { name, email, mobile, password } = body;
  if (!name || !email || !mobile || !password) return sendJson(res, 400, { error: 'name, email, mobile and password are required.' });
  if (findPatientByEmail(email)) return sendJson(res, 409, { error: 'An account with this email already exists.' });

  const patient = {
    id: uid('pat'),
    name, email, mobile,
    passwordHash: hashPassword(password),
    createdAt: now(),
    prescriptions: [],
    auditLog: [],
    pendingRequests: [], // doctor requests waiting for patient to generate OTP
  };
  db.patients.set(patient.id, patient);
  persistState();
  addAudit(patient, { type: 'account_created', detail: 'Patient account created.' });
  persistState();
  const token = issueToken('patient', patient.id);
  sendJson(res, 201, { token, patient: publicPatient(patient) });
});

route('POST', '/api/patient/login', async (req, res, body) => {
  const { email, password } = body;
  const patient = findPatientByEmail(email || '');
  if (!patient || !verifyPassword(password || '', patient.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid email or password.' });
  }
  const token = issueToken('patient', patient.id);
  sendJson(res, 200, { token, patient: publicPatient(patient) });
});

route('POST', '/api/admin/login', async (req, res, body) => {
  const { email, password } = body;
  const admin = [...db.admins.values()].find((a) => a.email.toLowerCase() === String(email || '').trim().toLowerCase());
  if (!admin || !verifyPassword(password || '', admin.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid admin credentials.' });
  }
  const token = issueToken('admin', admin.id);
  sendJson(res, 200, { token, admin: publicAdmin(admin) });
});

route('POST', '/api/patient/request-login-otp', async (req, res, body) => {
  const patient = findPatientByEmail(body.email || '');
  if (!patient) return sendJson(res, 404, { error: 'No account found with this email.' });
  const otp = genOtp();
  patient.loginOtp = { code: otp, expiresAt: now() + ACCESS_OTP_TTL_MS };
  persistState();
  // In production this would be sent via SMS/email. Returned here for demo purposes.
  sendJson(res, 200, { message: 'OTP generated.', demoOtp: otp, expiresInSeconds: ACCESS_OTP_TTL_MS / 1000 });
});

route('POST', '/api/patient/login-otp', async (req, res, body) => {
  const patient = findPatientByEmail(body.email || '');
  if (!patient || !patient.loginOtp) return sendJson(res, 400, { error: 'Request an OTP first.' });
  if (now() > patient.loginOtp.expiresAt) return sendJson(res, 400, { error: 'OTP expired. Request a new one.' });
  if (patient.loginOtp.code !== body.otp) return sendJson(res, 400, { error: 'Incorrect OTP.' });
  patient.loginOtp = null;
  persistState();
  const token = issueToken('patient', patient.id);
  sendJson(res, 200, { token, patient: publicPatient(patient) });
});

// --- Doctor auth -------------------------------------------------------------
route('POST', '/api/doctor/register', async (req, res, body) => {
  const { name, email, mobile, password, hospital } = body;
  if (!name || !email || !mobile || !password) return sendJson(res, 400, { error: 'name, email, mobile and password are required.' });
  if (findDoctorByEmail(email)) return sendJson(res, 409, { error: 'An account with this email already exists.' });

  const doctor = { id: uid('doc'), name, email, mobile, hospital: hospital || '', passwordHash: hashPassword(password), createdAt: now() };
  db.doctors.set(doctor.id, doctor);
  persistState();
  const token = issueToken('doctor', doctor.id);
  sendJson(res, 201, { token, doctor: publicDoctor(doctor) });
});

route('POST', '/api/doctor/login', async (req, res, body) => {
  const { email, password } = body;
  const doctor = findDoctorByEmail(email || '');
  if (!doctor || !verifyPassword(password || '', doctor.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid email or password.' });
  }
  const token = issueToken('doctor', doctor.id);
  sendJson(res, 200, { token, doctor: publicDoctor(doctor) });
});

route('GET', '/api/doctor/me', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'doctor') return sendJson(res, 401, { error: 'Doctor login required.' });
  const doctor = db.doctors.get(auth.id);
  sendJson(res, 200, { doctor: publicDoctor(doctor) });
});

// --- Patient-side: generate an access OTP to hand to a doctor ---------------
route('POST', '/api/patient/generate-access-otp', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'patient') return sendJson(res, 401, { error: 'Patient login required.' });
  const patient = db.patients.get(auth.id);
  const otp = genOtp();
  db.accessOtps.set(otp, { patientId: patient.id, expiresAt: now() + ACCESS_OTP_TTL_MS, used: false });
  persistState();
  addAudit(patient, { type: 'access_otp_generated', detail: 'You generated a 25-minute access code to share with a doctor.' });
  persistState();
  sendJson(res, 200, { otp, expiresInSeconds: ACCESS_OTP_TTL_MS / 1000 });
});

// --- Doctor-side: redeem a patient's access OTP to open a session ----------
route('POST', '/api/doctor/verify-access-otp', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'doctor') return sendJson(res, 401, { error: 'Doctor login required.' });
  const doctor = db.doctors.get(auth.id);
  const entry = db.accessOtps.get(body.otp);
  if (!entry || entry.used) return sendJson(res, 400, { error: 'Invalid or already-used code.' });
  if (now() > entry.expiresAt) return sendJson(res, 400, { error: 'This code has expired.' });
  entry.used = true;
  persistState();

  const patient = db.patients.get(entry.patientId);
  const session = {
    id: uid('sess'),
    doctorId: doctor.id,
    doctorName: doctor.name,
    patientId: patient.id,
    createdAt: now(),
    expiresAt: now() + SESSION_LENGTH_MS,
    status: 'active',
    historyUnlocked: false,
  };
  db.sessions.set(session.id, session);
  persistState();
  addAudit(patient, {
    type: 'access_granted', doctorId: doctor.id, doctorName: doctor.name, sessionId: session.id,
    detail: `Dr. ${doctor.name} was granted 25 minutes of access to your records.`,
  });
  persistState();
  sendJson(res, 200, {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    patient: publicPatient(patient),
  });
});

// --- Session-scoped doctor actions ------------------------------------------
function requireActiveSession(sessionId) {
  const session = db.sessions.get(sessionId);
  if (!session) return { error: 'Session not found.' };
  expireSessionIfNeeded(session);
  if (session.status !== 'active') return { error: 'This access window has closed.', session };
  return { session };
}

route('GET', '/api/session/:id/status', async (req, res, body, auth, params) => {
  const { session, error } = requireActiveSession(params.id);
  if (error && !session) return sendJson(res, 404, { error });
  sendJson(res, 200, {
    status: session.status,
    expiresAt: session.expiresAt,
    remainingMs: Math.max(0, session.expiresAt - now()),
    historyUnlocked: session.historyUnlocked,
  });
});

route('GET', '/api/session/:id/patient-summary', async (req, res, body, auth, params) => {
  const { session, error } = requireActiveSession(params.id);
  if (error) return sendJson(res, session ? 403 : 404, { error });
  const patient = db.patients.get(session.patientId);
  addAudit(patient, {
    type: 'record_viewed', doctorId: session.doctorId, doctorName: session.doctorName, sessionId: session.id,
    detail: `Dr. ${session.doctorName} viewed your current record summary.`,
  });
  const recentPrescriptions = patient.prescriptions.slice(-5).reverse();
  sendJson(res, 200, {
    patient: publicPatient(patient),
    recentPrescriptions,
    historyUnlocked: session.historyUnlocked,
  });
});

route('POST', '/api/session/:id/request-history-otp', async (req, res, body, auth, params) => {
  const { session, error } = requireActiveSession(params.id);
  if (error) return sendJson(res, session ? 403 : 404, { error });
  const patient = db.patients.get(session.patientId);
  const otp = genOtp();
  db.historyOtps.set(otp, { sessionId: session.id, patientId: patient.id, expiresAt: now() + HISTORY_OTP_TTL_MS, used: false });
  persistState();
  addAudit(patient, {
    type: 'history_otp_generated', doctorId: session.doctorId, doctorName: session.doctorName, sessionId: session.id,
    detail: `Dr. ${session.doctorName} requested access to your past medical history. A separate code was generated.`,
  });
  persistState();
  sendJson(res, 200, { otp, expiresInSeconds: HISTORY_OTP_TTL_MS / 1000 });
});

route('POST', '/api/session/:id/verify-history-otp', async (req, res, body, auth, params) => {
  const { session, error } = requireActiveSession(params.id);
  if (error) return sendJson(res, session ? 403 : 404, { error });
  const entry = db.historyOtps.get(body.otp);
  if (!entry || entry.used || entry.sessionId !== session.id) return sendJson(res, 400, { error: 'Invalid or already-used code.' });
  if (now() > entry.expiresAt) return sendJson(res, 400, { error: 'This code has expired.' });
  entry.used = true;
  session.historyUnlocked = true;
  persistState();
  const patient = db.patients.get(session.patientId);
  addAudit(patient, {
    type: 'history_unlocked', doctorId: session.doctorId, doctorName: session.doctorName, sessionId: session.id,
    detail: `Dr. ${session.doctorName} unlocked your full past medical history for this visit.`,
  });
  persistState();
  sendJson(res, 200, { historyUnlocked: true });
});

route('GET', '/api/session/:id/patient-history', async (req, res, body, auth, params) => {
  const { session, error } = requireActiveSession(params.id);
  if (error) return sendJson(res, session ? 403 : 404, { error });
  if (!session.historyUnlocked) return sendJson(res, 403, { error: 'History is locked. Ask the patient for a history access code.' });
  const patient = db.patients.get(session.patientId);
  addAudit(patient, {
    type: 'history_viewed', doctorId: session.doctorId, doctorName: session.doctorName, sessionId: session.id,
    detail: `Dr. ${session.doctorName} viewed your full past medical history.`,
  });
  sendJson(res, 200, { prescriptions: [...patient.prescriptions].reverse() });
});

route('POST', '/api/session/:id/prescription', async (req, res, body, auth, params) => {
  const { session, error } = requireActiveSession(params.id);
  if (error) return sendJson(res, session ? 403 : 404, { error });
  const { medicines, notes } = body;
  if (!Array.isArray(medicines) || medicines.length === 0) return sendJson(res, 400, { error: 'At least one medicine is required.' });

  const patient = db.patients.get(session.patientId);
  const rx = {
    id: uid('rx'),
    date: new Date().toLocaleDateString('en-GB'), // e.g. 4/4/26
    timestamp: now(),
    doctorId: session.doctorId,
    doctorName: session.doctorName,
    medicines,
    notes: notes || '',
  };
  patient.prescriptions.push(rx);
  persistState();
  addAudit(patient, {
    type: 'prescription_added', doctorId: session.doctorId, doctorName: session.doctorName, sessionId: session.id,
    detail: `Dr. ${session.doctorName} added a new prescription (${medicines.map(m => m.name).join(', ')}).`,
  });
  persistState();
  sendJson(res, 201, { prescription: rx });
});

route('POST', '/api/session/:id/end', async (req, res, body, auth, params) => {
  const session = db.sessions.get(params.id);
  if (!session) return sendJson(res, 404, { error: 'Session not found.' });
  if (session.status === 'active') {
    session.status = 'ended';
    persistState();
    const patient = db.patients.get(session.patientId);
    addAudit(patient, {
      type: 'session_ended', doctorId: session.doctorId, doctorName: session.doctorName, sessionId: session.id,
      detail: `Dr. ${session.doctorName} ended the visit early. All changes were saved.`,
    });
    persistState();
  }
  sendJson(res, 200, { status: session.status });
});

// --- Patient-side dashboard data --------------------------------------------
route('GET', '/api/patient/me', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'patient') return sendJson(res, 401, { error: 'Patient login required.' });
  const patient = db.patients.get(auth.id);
  sendJson(res, 200, { patient: publicPatient(patient) });
});

route('GET', '/api/admin/me', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'admin') return sendJson(res, 401, { error: 'Admin login required.' });
  const admin = db.admins.get(auth.id);
  sendJson(res, 200, { admin: publicAdmin(admin) });
});

route('GET', '/api/patient/prescriptions', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'patient') return sendJson(res, 401, { error: 'Patient login required.' });
  const patient = db.patients.get(auth.id);
  sendJson(res, 200, { prescriptions: [...patient.prescriptions].reverse() });
});

route('GET', '/api/patient/audit-log', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'patient') return sendJson(res, 401, { error: 'Patient login required.' });
  const patient = db.patients.get(auth.id);
  sendJson(res, 200, { auditLog: patient.auditLog });
});

route('GET', '/api/patient/reminders', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'patient') return sendJson(res, 401, { error: 'Patient login required.' });
  const patient = db.patients.get(auth.id);
  const reminders = await generateReminders(patient);
  sendJson(res, 200, { reminders });
});

function collectAuditEntries() {
  const entries = [];
  for (const patient of db.patients.values()) {
    for (const entry of patient.auditLog || []) {
      entries.push({
        ...entry,
        patientId: patient.id,
        patientName: patient.name,
      });
    }
  }
  return entries.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

route('GET', '/api/admin/summary', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'admin') return sendJson(res, 401, { error: 'Admin login required.' });
  const patients = [...db.patients.values()];
  const doctors = [...db.doctors.values()];
  const sessions = [...db.sessions.values()];
  const activity = collectAuditEntries();
  const summary = {
    patientCount: patients.length,
    doctorCount: doctors.length,
    activeSessionCount: sessions.filter((s) => s.status === 'active').length,
    prescriptionCount: patients.reduce((sum, patient) => sum + (patient.prescriptions || []).length, 0),
    reminderSignals: patients.filter((patient) => (patient.prescriptions || []).length > 0).length,
    recentEvents: activity.slice(0, 8),
  };
  sendJson(res, 200, { summary });
});

route('GET', '/api/admin/activity', async (req, res, body, auth) => {
  if (!auth || auth.role !== 'admin') return sendJson(res, 401, { error: 'Admin login required.' });
  sendJson(res, 200, { activity: collectAuditEntries().slice(0, 20) });
});

// ---------------------------------------------------------------------------
// Static file serving (frontend)
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(req, res, pathname) {
  let filePath = path.join(FRONTEND_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(FRONTEND_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(FRONTEND_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.regex);
    if (!match) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const auth = getAuth(req);
      return await r.handler(req, res, body, auth, params);
    } catch (e) {
      console.error(e);
      return sendJson(res, 500, { error: 'Server error.', detail: String(e.message || e) });
    }
  }
  sendJson(res, 404, { error: 'Not found.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏥  Healthcare platform backend running at http://localhost:${PORT}`);
  console.log(`    Frontend served from the same URL. API under /api/*\n`);
});
