// ============================================================================
// Vantage Health — frontend application logic (no framework, no build step)
// ============================================================================
const API = ''; // same-origin; server.js serves both API and static files

const state = {
  role: null,          // 'patient' | 'doctor' | 'admin'
  authMode: 'password', // for patient: 'password' | 'otp'
  authView: 'login',    // 'login' | 'register'
  token: null,
  user: null,
  session: null,        // active doctor session {id, expiresAt, ...}
  timerInterval: null,
  medRowCount: 0,
};

const STORAGE_KEY = 'smartmedico_session_v1';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function persistSessionState() {
  if (!state.token || !state.role || !state.user) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: state.token, role: state.role, user: state.user }));
}

function clearSessionState() {
  localStorage.removeItem(STORAGE_KEY);
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers['Authorization'] = 'Bearer ' + state.token;
  if (auth && state.token && !headers.Authorization) headers['X-SmartMedico-Token'] = state.token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ============================================================================
// Gate: portal picker -> auth forms
// ============================================================================
$$('.portal-card').forEach((card) => {
  card.addEventListener('click', () => {
    state.role = card.dataset.role;
    state.authView = 'login';
    state.authMode = 'password';
    $('#portalPicker').hidden = true;
    $('#authWrap').hidden = false;
    renderAuth();
  });
});

$('#backToPicker').addEventListener('click', () => {
  $('#authWrap').hidden = true;
  $('#portalPicker').hidden = false;
});

function renderAuth() {
  const card = $('#authCard');
  if (state.role === 'patient') {
    card.innerHTML = patientAuthTemplate();
  } else if (state.role === 'admin') {
    card.innerHTML = adminAuthTemplate();
  } else {
    card.innerHTML = doctorAuthTemplate();
  }
  bindAuthEvents();
}

function patientAuthTemplate() {
  const isLogin = state.authView === 'login';
  return `
    <h2>${isLogin ? 'Welcome back' : 'Create your account'}</h2>
    <span class="sub">${isLogin ? 'Sign in to your health record.' : 'Takes under a minute.'}</span>
    ${isLogin ? `
      <div class="tab-row">
        <button class="tab-btn ${state.authMode === 'password' ? 'active' : ''}" data-mode="password">Password</button>
        <button class="tab-btn ${state.authMode === 'otp' ? 'active' : ''}" data-mode="otp">OTP</button>
      </div>` : ''}
    <form id="authForm">
      ${!isLogin ? `
        <div class="field"><label>Full name</label><input name="name" required /></div>
        <div class="field"><label>Mobile number</label><input name="mobile" required /></div>` : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required /></div>
      ${(isLogin && state.authMode === 'otp') ? '' : `
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="4" /></div>`}
      ${(isLogin && state.authMode === 'otp') ? `
        <div class="field" id="otpField" hidden>
          <label>Enter OTP</label>
          <div class="otp-inline">
            <input name="otp" maxlength="6" inputmode="numeric" placeholder="000000" />
          </div>
        </div>
        <button type="button" class="btn btn-secondary" id="sendOtpBtn" style="width:100%; margin-bottom:12px;">Send OTP</button>
      ` : ''}
      <button type="submit" class="btn btn-primary">${isLogin ? (state.authMode === 'otp' ? 'Verify & sign in' : 'Sign in') : 'Create account'}</button>
      <p class="form-error" id="authError"></p>
    </form>
    <div class="form-switch">
      ${isLogin ? `New here? <button id="toRegister">Create an account</button>` : `Already registered? <button id="toLogin">Sign in</button>`}
    </div>
  `;
}

function doctorAuthTemplate() {
  const isLogin = state.authView === 'login';
  return `
    <h2>${isLogin ? 'Doctor sign in' : 'Register your practice'}</h2>
    <span class="sub">${isLogin ? 'Your identity — patient access always needs a separate OTP.' : 'Create your provider identity.'}</span>
    <form id="authForm">
      ${!isLogin ? `
        <div class="field"><label>Full name</label><input name="name" required /></div>
        <div class="field"><label>Mobile number</label><input name="mobile" required /></div>
        <div class="field"><label>Hospital / clinic</label><input name="hospital" /></div>` : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required /></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="4" /></div>
      <button type="submit" class="btn btn-primary">${isLogin ? 'Sign in' : 'Create account'}</button>
      <p class="form-error" id="authError"></p>
    </form>
    <div class="form-switch">
      ${isLogin ? `New provider? <button id="toRegister">Register</button>` : `Already registered? <button id="toLogin">Sign in</button>`}
    </div>
  `;
}

function adminAuthTemplate() {
  return `
    <h2>System administration</h2>
    <span class="sub">Secure operations view for patient volume, provider access, and recent health activity.</span>
    <form id="authForm">
      <div class="field"><label>Email</label><input name="email" type="email" required /></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="8" /></div>
      <button type="submit" class="btn btn-primary">Open admin dashboard</button>
      <p class="form-error" id="authError"></p>
    </form>
  `;
}

function bindAuthEvents() {
  $('#toRegister')?.addEventListener('click', () => { state.authView = 'register'; renderAuth(); });
  $('#toLogin')?.addEventListener('click', () => { state.authView = 'login'; state.authMode = 'password'; renderAuth(); });
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => { state.authMode = b.dataset.mode; renderAuth(); }));

  $('#sendOtpBtn')?.addEventListener('click', async () => {
    const email = $('#authForm [name=email]').value.trim();
    if (!email) return toast('Enter your email first.', true);
    try {
      const data = await api('/api/patient/request-login-otp', { method: 'POST', body: { email }, auth: false });
      $('#otpField').hidden = false;
      toast(`OTP sent. (Demo code: ${data.demoOtp})`);
    } catch (e) { toast(e.message, true); }
  });

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = Object.fromEntries(form.entries());
    const errEl = $('#authError');
    errEl.textContent = '';
    try {
      let data;
      if (state.role === 'patient') {
        if (state.authView === 'register') {
          data = await api('/api/patient/register', { method: 'POST', body: payload, auth: false });
        } else if (state.authMode === 'otp') {
          data = await api('/api/patient/login-otp', { method: 'POST', body: { email: payload.email, otp: payload.otp }, auth: false });
        } else {
          data = await api('/api/patient/login', { method: 'POST', body: payload, auth: false });
        }
        state.token = data.token; state.user = data.patient; persistSessionState();
        enterPatientDash();
      } else if (state.role === 'admin') {
        data = await api('/api/admin/login', { method: 'POST', body: payload, auth: false });
        state.token = data.token; state.user = data.admin; persistSessionState();
        enterAdminDash();
      } else {
        const path = state.authView === 'register' ? '/api/doctor/register' : '/api/doctor/login';
        data = await api(path, { method: 'POST', body: payload, auth: false });
        state.token = data.token; state.user = data.doctor; persistSessionState();
        enterDoctorDash();
      }
    } catch (e2) {
      errEl.textContent = e2.message;
    }
  });
}

// ============================================================================
// Shared: top bar + logout
// ============================================================================
function renderTopbarRight() {
  const el = $('#topbarRight');
  if (!state.user) { el.innerHTML = ''; return; }
  const roleLabel = state.role === 'patient' ? 'Patient' : state.role === 'doctor' ? 'Doctor' : 'Admin';
  el.innerHTML = `
    <div class="topbar-pill"><span class="dot"></span> ${roleLabel} · ${state.user.name}</div>
    <button class="logout-btn" id="logoutBtn">Sign out</button>
  `;
  $('#logoutBtn').addEventListener('click', logout);
}

function logout() {
  clearInterval(state.timerInterval);
  Object.assign(state, { role: null, token: null, user: null, session: null });
  clearSessionState();
  $('#patientDash').hidden = true;
  $('#doctorDash').hidden = true;
  $('#adminDash').hidden = true;
  $('#gate').hidden = false;
  $('#authWrap').hidden = true;
  $('#portalPicker').hidden = false;
  renderTopbarRight();
}

// ============================================================================
// PATIENT DASHBOARD
// ============================================================================
async function enterPatientDash() {
  $('#gate').hidden = true;
  $('#patientDash').hidden = false;
  renderTopbarRight();
  $('#patientNameOverview').textContent = `, ${firstName(state.user.name)}`;
  bindPatientNav();
  bindOtpGenerator();
  await refreshPatientOverview();
}

function firstName(full) { return full ? full.split(' ')[0] : ''; }

function bindPatientNav() {
  $$('#patientDash .dash-nav-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      $$('#patientDash .dash-nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('#patientDash .dash-panel').forEach((p) => p.hidden = true);
      const panel = $('#panel-' + btn.dataset.panel);
      panel.hidden = false;
      if (btn.dataset.panel === 'prescriptions') await loadPrescriptions();
      if (btn.dataset.panel === 'reminders') await loadReminders();
      if (btn.dataset.panel === 'audit') await loadAudit();
    });
  });
}

function bindOtpGenerator() {
  $('#genAccessOtp').addEventListener('click', async () => {
    try {
      const data = await api('/api/patient/generate-access-otp', { method: 'POST' });
      $('#otpDisplay').textContent = data.otp.split('').join(' ');
      startOtpCountdown(data.expiresInSeconds);
    } catch (e) { toast(e.message, true); }
  });
}

function startOtpCountdown(seconds) {
  let remaining = seconds;
  const meta = $('#otpMeta');
  clearInterval(startOtpCountdown._i);
  const tick = () => {
    if (remaining <= 0) {
      meta.textContent = 'Code expired. Generate a new one.';
      clearInterval(startOtpCountdown._i);
      return;
    }
    const m = Math.floor(remaining / 60), s = remaining % 60;
    meta.textContent = `Valid for ${m}:${String(s).padStart(2, '0')} — share this with your doctor now.`;
    remaining--;
  };
  tick();
  startOtpCountdown._i = setInterval(tick, 1000);
}

async function refreshPatientOverview() {
  try {
    const [rx, audit] = await Promise.all([
      api('/api/patient/prescriptions'),
      api('/api/patient/audit-log'),
    ]);
    $('#statRxCount').textContent = rx.prescriptions.length;
    const visitCount = new Set(audit.auditLog.filter(a => a.type === 'access_granted').map(a => a.sessionId)).size;
    $('#statVisitCount').textContent = visitCount;

    const pendingHistory = audit.auditLog.find((a) => a.type === 'history_otp_generated' && !audit.auditLog.some(b => b.type === 'history_unlocked' && b.sessionId === a.sessionId && b.timestamp > a.timestamp));
  } catch (e) { toast(e.message, true); }
}

async function loadPrescriptions() {
  const container = $('#prescriptionList');
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { prescriptions } = await api('/api/patient/prescriptions');
    container.innerHTML = prescriptions.length ? prescriptions.map(rxItemHtml).join('') :
      `<div class="empty-state">No prescriptions yet. They'll appear here right after a doctor's visit.</div>`;
  } catch (e) { toast(e.message, true); }
}

function rxItemHtml(rx) {
  return `
    <div class="rx-item">
      <div class="rx-item-head">
        <span class="rx-doctor">Dr. ${escapeHtml(rx.doctorName)}</span>
        <span class="rx-date">${rx.date}</span>
      </div>
      <div class="rx-meds">${rx.medicines.map(m => `<span class="rx-med-chip">${escapeHtml(m.name)}${m.dosage ? ' · ' + escapeHtml(m.dosage) : ''}</span>`).join('')}</div>
      ${rx.notes ? `<div class="rx-notes">${escapeHtml(rx.notes)}</div>` : ''}
    </div>`;
}

async function loadReminders() {
  const container = $('#reminderList');
  container.innerHTML = '<p class="muted">Generating…</p>';
  try {
    const { reminders } = await api('/api/patient/reminders');
    container.innerHTML = reminders.length ? reminders.map(reminderHtml).join('') :
      `<div class="empty-state">No reminders yet — these build up automatically as prescriptions are added.</div>`;
  } catch (e) { toast(e.message, true); }
}

function reminderHtml(r) {
  const meta = [];
  if (r.priority) meta.push(`<span class="reminder-pill priority-${String(r.priority).toLowerCase()}">${escapeHtml(r.priority)}</span>`);
  if (r.aiLabel) meta.push(`<span class="reminder-pill">${escapeHtml(r.aiLabel)}</span>`);

  if (r.type === 'medication') {
    return `
      <div class="card reminder-item">
        <div class="reminder-icon">Rx</div>
        <div>
          <div class="reminder-title">${escapeHtml(r.title)}</div>
          <div class="reminder-meta">${meta.join('')}</div>
          <div class="reminder-schedule">${r.schedule.join(' · ')}</div>
          <div class="reminder-note">${escapeHtml(r.note)}</div>
          ${r.insight ? `<div class="reminder-insight">${escapeHtml(r.insight)}</div>` : ''}
        </div>
      </div>`;
  }
  return `
    <div class="card reminder-item chronic">
      <div class="reminder-icon">◎</div>
      <div>
        <div class="reminder-title">${escapeHtml(r.title)}</div>
        <div class="reminder-meta">${meta.join('')}</div>
        <div class="reminder-schedule">Due ${new Date(r.dueDate).toLocaleDateString()}</div>
        <div class="reminder-note">${escapeHtml(r.note)}</div>
        ${r.insight ? `<div class="reminder-insight">${escapeHtml(r.insight)}</div>` : ''}
      </div>
    </div>`;
}

async function loadAudit() {
  const container = $('#auditList');
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { auditLog } = await api('/api/patient/audit-log');
    container.innerHTML = auditLog.length ? auditLog.map(auditItemHtml).join('') :
      `<div class="empty-state">Nothing logged yet.</div>`;
  } catch (e) { toast(e.message, true); }
}

const ALERT_TYPES = new Set(['history_viewed', 'history_unlocked', 'history_otp_generated']);
function auditItemHtml(a) {
  const isAlert = ALERT_TYPES.has(a.type);
  return `
    <div class="timeline-item ${isAlert ? 'alert' : ''}">
      <div class="timeline-time">${new Date(a.timestamp).toLocaleString()}</div>
      <div class="timeline-detail">${escapeHtml(a.detail)}</div>
    </div>`;
}

// ============================================================================
// DOCTOR DASHBOARD
// ============================================================================
async function enterDoctorDash() {
  $('#gate').hidden = true;
  $('#doctorDash').hidden = false;
  renderTopbarRight();
  $('#doctorNameOverview').textContent = `, Dr. ${firstName(state.user.name)}`;
  showDoctorHome();
  bindDoctorHome();
  bindDoctorSession();
}

function showDoctorHome() {
  $('#doctorHome').hidden = false;
  $('#doctorSession').hidden = true;
  $('#sessionEndedPanel').hidden = true;
}

function bindDoctorHome() {
  $('#verifyAccessOtp').addEventListener('click', async () => {
    const otp = $('#accessOtpInput').value.trim();
    const errEl = $('#accessOtpError');
    errEl.textContent = '';
    if (!otp) return errEl.textContent = 'Enter the code the patient gave you.';
    try {
      const data = await api('/api/doctor/verify-access-otp', { method: 'POST', body: { otp } });
      state.session = { id: data.sessionId, expiresAt: data.expiresAt, patient: data.patient, historyUnlocked: false };
      $('#accessOtpInput').value = '';
      openDoctorSession();
    } catch (e) { errEl.textContent = e.message; }
  });
  $('#newSessionBtn')?.addEventListener('click', () => { state.session = null; showDoctorHome(); });
}

function openDoctorSession() {
  $('#doctorHome').hidden = true;
  $('#sessionEndedPanel').hidden = true;
  $('#doctorSession').hidden = false;
  $('#sessionPatientName').textContent = state.session.patient.name;
  $('#historyLocked').hidden = false;
  $('#historyOtpEntry').hidden = true;
  $('#historyUnlockedList').hidden = true;
  $('#rxSuccess').textContent = '';
  resetMedicineRows();
  loadDoctorSummary();
  startSessionTimer();
}

function bindDoctorSession() {
  $('#endSessionBtn').addEventListener('click', async () => {
    try { await api(`/api/session/${state.session.id}/end`, { method: 'POST' }); } catch (_) {}
    endSessionUI('You ended this visit.');
  });

  $('#requestHistoryOtp').addEventListener('click', async () => {
    try {
      const data = await api(`/api/session/${state.session.id}/request-history-otp`, { method: 'POST' });
      $('#historyOtpEntry').hidden = false;
      toast(`History code requested from patient. (Demo code: ${data.otp})`);
    } catch (e) { toast(e.message, true); }
  });

  $('#verifyHistoryOtp').addEventListener('click', async () => {
    const otp = $('#historyOtpInput').value.trim();
    const errEl = $('#historyOtpError');
    errEl.textContent = '';
    try {
      await api(`/api/session/${state.session.id}/verify-history-otp`, { method: 'POST', body: { otp } });
      $('#historyLocked').hidden = true;
      $('#historyOtpEntry').hidden = true;
      $('#historyUnlockedList').hidden = false;
      loadDoctorHistory();
    } catch (e) { errEl.textContent = e.message; }
  });

  $('#addMedicineRow').addEventListener('click', () => addMedicineRow());

  $('#submitRx').addEventListener('click', async () => {
    const rows = $$('.med-row');
    const medicines = [...rows].map((row) => ({
      name: row.querySelector('[data-f=name]').value.trim(),
      dosage: row.querySelector('[data-f=dosage]').value.trim(),
      frequency: row.querySelector('[data-f=frequency]').value.trim(),
    })).filter((m) => m.name);
    const notes = $('#rxNotes').value.trim();
    const successEl = $('#rxSuccess');
    if (!medicines.length) { successEl.textContent = 'Add at least one medicine name.'; return; }
    try {
      await api(`/api/session/${state.session.id}/prescription`, { method: 'POST', body: { medicines, notes } });
      successEl.textContent = 'Saved to the patient\'s record.';
      resetMedicineRows();
      $('#rxNotes').value = '';
      loadDoctorSummary();
    } catch (e) {
      successEl.textContent = e.message;
    }
  });
}

function resetMedicineRows() {
  $('#medicineRows').innerHTML = '';
  state.medRowCount = 0;
  addMedicineRow();
}
function addMedicineRow() {
  const wrap = document.createElement('div');
  wrap.className = 'med-row';
  wrap.innerHTML = `
    <input placeholder="Medicine name" data-f="name" />
    <input placeholder="Dosage e.g. 500mg" data-f="dosage" />
    <input placeholder="Frequency e.g. twice daily" data-f="frequency" />
  `;
  $('#medicineRows').appendChild(wrap);
}

async function loadDoctorSummary() {
  try {
    const data = await api(`/api/session/${state.session.id}/patient-summary`);
    $('#doctorRecentRx').innerHTML = data.recentPrescriptions.length
      ? data.recentPrescriptions.map(rxItemHtml).join('')
      : `<div class="empty-state">No prior visits on file.</div>`;
  } catch (e) {
    if (isSessionClosedError(e)) return endSessionUI('This access window has closed.');
    toast(e.message, true);
  }
}

async function loadDoctorHistory() {
  try {
    const data = await api(`/api/session/${state.session.id}/patient-history`);
    $('#historyUnlockedList').innerHTML = data.prescriptions.length
      ? data.prescriptions.map(rxItemHtml).join('')
      : `<div class="empty-state">No past history on file.</div>`;
  } catch (e) {
    if (isSessionClosedError(e)) return endSessionUI('This access window has closed.');
    toast(e.message, true);
  }
}

function isSessionClosedError(e) {
  return /access window has closed|not found/i.test(e.message || '');
}

// --- Session countdown ring -------------------------------------------------
const RING_CIRCUMFERENCE = 2 * Math.PI * 34; // ~213.6

function startSessionTimer() {
  clearInterval(state.timerInterval);
  const tick = () => {
    const remaining = Math.max(0, state.session.expiresAt - Date.now());
    const totalMs = 25 * 60 * 1000;
    const fraction = remaining / totalMs;
    const offset = RING_CIRCUMFERENCE * (1 - fraction);
    $('#ringFg').style.strokeDasharray = RING_CIRCUMFERENCE;
    $('#ringFg').style.strokeDashoffset = offset;
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    $('#timerText').textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (remaining <= 0) {
      endSessionUI('Access window closed automatically.');
    }
  };
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

function endSessionUI(message) {
  clearInterval(state.timerInterval);
  $('#doctorSession').hidden = true;
  $('#doctorHome').hidden = true;
  $('#sessionEndedPanel').hidden = false;
  toast(message);
}

// ============================================================================
// ADMIN DASHBOARD
// ============================================================================
async function enterAdminDash() {
  $('#gate').hidden = true;
  $('#patientDash').hidden = true;
  $('#doctorDash').hidden = true;
  $('#adminDash').hidden = false;
  renderTopbarRight();
  await refreshAdminDashboard();
}

async function refreshAdminDashboard() {
  try {
    const { summary } = await api('/api/admin/summary');
    $('#adminPatientCount').textContent = summary.patientCount;
    $('#adminDoctorCount').textContent = summary.doctorCount;
    $('#adminSessionCount').textContent = summary.activeSessionCount;
    $('#adminPrescriptionCount').textContent = summary.prescriptionCount;

    const activity = summary.recentEvents || [];
    const list = $('#adminActivityList');
    list.innerHTML = activity.length ? activity.map((a) => `
      <div class="timeline-item ${['history_viewed', 'history_unlocked', 'history_otp_generated'].includes(a.type) ? 'alert' : ''}">
        <div class="timeline-time">${new Date(a.timestamp).toLocaleString()}</div>
        <div class="timeline-detail">${escapeHtml(a.detail || 'System event')}</div>
      </div>
    `).join('') : '<div class="empty-state">No recent activity yet.</div>';
  } catch (e) {
    toast(e.message, true);
  }
}

async function restoreSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved?.token || !saved?.role || !saved?.user) return;
    state.token = saved.token;
    state.role = saved.role;
    state.user = saved.user;

    if (state.role === 'patient') {
      const { patient } = await api('/api/patient/me');
      state.user = patient;
      persistSessionState();
      enterPatientDash();
    } else if (state.role === 'doctor') {
      const { doctor } = await api('/api/doctor/me');
      state.user = doctor;
      persistSessionState();
      enterDoctorDash();
    } else if (state.role === 'admin') {
      const { admin } = await api('/api/admin/me');
      state.user = admin;
      persistSessionState();
      enterAdminDash();
    }
  } catch (error) {
    clearSessionState();
    Object.assign(state, { role: null, token: null, user: null });
  }
}

// ============================================================================
// Utils
// ============================================================================
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

restoreSession();
