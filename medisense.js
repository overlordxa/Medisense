// ============================================================
//  MediSense AI — medisense.js  (Firebase edition)
//  Requires: medisense-firebase.js loaded first (as ES module)
//  Globals provided: DB, Auth, Session, logLoginEvent
// ============================================================

// ============================================================
//  APP STATE
// ============================================================
const state = {
  user:         null,
  role:         null,   // 'doctor' | 'family' | 'admin'
  vitals:       [],
  alerts:       [],
  resendTimer:  null,
  otpSession:   null,
  _unsubVitals: null,
};

// ============================================================
//  DOM HELPERS
// ============================================================
const $ = id => document.getElementById(id);
const qsa = sel => document.querySelectorAll(sel);

function showToast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.getBoundingClientRect();
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
}

function setLoading(btn, loading) {
  if (!btn) return;
  const span    = btn.querySelector('span');
  const spinner = btn.querySelector('.spinner');
  btn.disabled  = loading;
  if (span)    span.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

function showScreen(id) {
  qsa('.auth-card').forEach(c => c.classList.remove('active'));
  const target = $(id);
  if (target) target.classList.add('active');
}

// ============================================================
//  BOOT — Firebase Auth observer restores session automatically
// ============================================================
async function init() {
  Auth.onAuthStateChanged(async (user) => {
    if (user) {
      state.user = user;
      Session.set(user);
      await loadUserRole();
    } else {
      Session.clear();
      showAuthWrapper();
    }
  });
}

async function loadUserRole() {
  const session = await DB.find('sessions', r => r.user_id === state.user.id);
  if (session?.role) {
    state.role = session.role;
    enterApp();
  } else {
    showScreen('screen-role');
  }
}

// ============================================================
//  SIGN-IN
// ============================================================
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) { showToast('Please fill in both fields', 'error'); return; }

  const btn = $('login-btn');
  setLoading(btn, true);
  try {
    const user = await Auth.signIn(email, password);
    state.user = user;
    Session.set(user);
    await logLoginEvent(user.id, user.email, 'email_password');
    showToast('Signed in successfully!', 'success');
    await loadUserRole();
  } catch (err) {
    showToast(firebaseErrMsg(err.code), 'error');
  } finally {
    setLoading(btn, false);
  }
});

// ============================================================
//  SIGN-UP
// ============================================================
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name  = $('signup-name').value.trim();
  const email = $('signup-email').value.trim();
  const pw1   = $('signup-password').value;
  const pw2   = $('signup-password2').value;

  if (!name)          { showToast('Please enter your full name', 'error'); return; }
  if (!email)         { showToast('Please enter your email address', 'error'); return; }
  if (!pw1)           { showToast('Please enter a password', 'error'); return; }
  if (pw1.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
  if (pw1 !== pw2)    { showToast('Passwords do not match', 'error'); return; }

  const btn = $('signup-btn');
  setLoading(btn, true);
  try {
    const newUser = await Auth.signUp(email, pw1, name);
    state.user = newUser;
    Session.set(newUser);
    showToast('Account created! Welcome to MediSense.', 'success');
    await loadUserRole();
  } catch (err) {
    showToast(firebaseErrMsg(err.code), 'error');
  } finally {
    setLoading(btn, false);
  }
});

window.resetSignupForm = function() {
  const loginTab = document.querySelector('.tab[data-tab="login"]');
  if (loginTab) loginTab.click();
};

// ============================================================
//  GOOGLE SIGN-IN
// ============================================================
$('google-btn').addEventListener('click', async () => {
  try {
    const user = await Auth.signInWithGoogle();
    state.user = user;
    Session.set(user);
    await logLoginEvent(user.id, user.email, 'google');
    showToast('Signed in with Google!', 'success');
    await loadUserRole();
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      showToast(firebaseErrMsg(err.code), 'error');
    }
  }
});

// ============================================================
//  OTP FLOW
// ============================================================
$('otp-link').addEventListener('click', (e) => { e.preventDefault(); showScreen('screen-otp'); });
$('back-from-otp').addEventListener('click', () => showScreen('screen-login'));

$('otp-request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('otp-email').value.trim();
  const password = $('otp-password').value;
  if (!email || !password) { showToast('Enter email and password', 'error'); return; }

  const btn = $('send-otp-btn');
  setLoading(btn, true);
  try {
    const user = await Auth.signIn(email, password);
    await Auth.signOut(); // sign out again — mid-OTP flow
    state.otpSession = { user, email, password };

    const code      = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await DB.insert('otp_codes', { user_id: user.id, email, code, expires_at: expiresAt, used: false });

    console.log(`%c🔐 OTP Code: ${code}`, 'font-size:18px;color:#0EA5E9;font-weight:bold');
    showToast('OTP generated — check browser console (demo mode)', 'info');
    $('otp-verify-section').classList.remove('hidden');
    startResendTimer();
  } catch (err) {
    showToast('Invalid credentials — please check email and password', 'error');
  } finally {
    setLoading(btn, false);
  }
});

$('verify-otp-btn').addEventListener('click', async () => {
  const digits = Array.from(qsa('.otp-digit')).map(i => i.value).join('');
  if (digits.length < 6) { showToast('Enter all 6 digits', 'error'); return; }

  const btn = $('verify-otp-btn');
  setLoading(btn, true);

  const now   = new Date().toISOString();
  const email = state.otpSession?.email;
  const record = await DB.find('otp_codes', r =>
    r.email === email && r.code === digits && !r.used && r.expires_at > now
  );

  if (!record) { setLoading(btn, false); showToast('Invalid or expired OTP', 'error'); return; }

  await DB.update('otp_codes', r => r.id === record.id, { used: true });

  try {
    const user = await Auth.signIn(email, state.otpSession.password);
    state.user = user;
    Session.set(user);
    await logLoginEvent(user.id, user.email, 'email_otp');
    setLoading(btn, false);
    showToast('OTP verified! Signing in…', 'success');
    loadUserRole();
  } catch {
    const user = state.otpSession.user;
    state.user = user;
    Session.set(user);
    setLoading(btn, false);
    showToast('OTP verified! Signing in…', 'success');
    loadUserRole();
  }
});

qsa('.otp-digit').forEach((input, i, all) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(-1);
    if (input.value && i < all.length - 1) all[i + 1].focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && i > 0) all[i - 1].focus();
  });
});

function startResendTimer() {
  const btn     = $('resend-otp-btn');
  const timerEl = $('resend-timer');
  btn.disabled  = true;
  let seconds   = 60;
  clearInterval(state.resendTimer);
  state.resendTimer = setInterval(() => {
    seconds--;
    timerEl.textContent = seconds;
    if (seconds <= 0) { clearInterval(state.resendTimer); btn.disabled = false; timerEl.textContent = '0'; }
  }, 1000);
}

$('resend-otp-btn').addEventListener('click', () => {
  $('otp-request-form').dispatchEvent(new Event('submit'));
});

// ============================================================
//  FORGOT PASSWORD — real Firebase email reset
// ============================================================
$('forgot-link').addEventListener('click', (e) => { e.preventDefault(); showScreen('screen-forgot'); });
$('back-from-forgot').addEventListener('click', () => showScreen('screen-login'));

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  if (!email) { showToast('Enter your email address', 'error'); return; }
  const btn = $('forgot-btn');
  setLoading(btn, true);
  try {
    await Auth.sendPasswordReset(email);
  } catch { /* don't reveal email existence */ }
  finally { setLoading(btn, false); }
  showToast('If that email exists, a reset link has been sent.', 'success');
  setTimeout(() => showScreen('screen-login'), 2500);
});

// ============================================================
//  ROLE SELECTION
// ============================================================
qsa('[data-role]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const role = btn.dataset.role;
    state.role = role;
    await DB.upsert('sessions', {
      user_id: state.user.id, role, last_seen: new Date().toISOString(),
    }, 'user_id');
    enterApp();
  });
});

// ============================================================
//  APP ENTRY
// ============================================================
function showAuthWrapper() {
  $('auth-wrapper').classList.remove('hidden');
  $('app').classList.add('hidden');
  showScreen('screen-login');
}

function enterApp() {
  $('auth-wrapper').classList.add('hidden');
  $('app').classList.remove('hidden');
  setupUserUI();
  navigateTo('dashboard');

  const doctorNav = $('doctor-only-nav');
  const adminNav  = $('admin-only-nav');
  if (doctorNav) doctorNav.style.display = state.role === 'doctor' ? 'flex' : 'none';
  if (adminNav)  adminNav.style.display  = state.role === 'admin'  ? 'flex' : 'none';

  if (state.role === 'admin') {
    navigateTo('admin');
  } else {
    subscribeToVitals();
  }
}

function setupUserUI() {
  const email   = state.user?.email || '';
  const name    = state.user?.full_name || email.split('@')[0];
  const initial = name.charAt(0).toUpperCase();
  const role    = state.role || 'user';

  $('sidebar-avatar').textContent = initial;
  $('sidebar-name').textContent   = name;
  $('sidebar-role').textContent   = role;
  $('topbar-role').textContent    = role;
  $('dashboard-greeting').textContent = `Welcome back, ${name}`;

  if ($('p-name'))  $('p-name').value  = name;
  if ($('p-email')) $('p-email').value = email;
  $('profile-avatar-lg').textContent   = initial;
}

// ============================================================
//  NAVIGATION
// ============================================================
function navigateTo(viewId) {
  qsa('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === viewId));
  qsa('.view').forEach(v  => v.classList.toggle('active', v.id === `view-${viewId}`));
  if (viewId === 'history') loadHistory();
  if (viewId === 'admin')   loadAdminPanel();
}

qsa('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(item.dataset.view);
    $('sidebar').classList.remove('open');
  });
});

$('menu-toggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// ============================================================
//  AUTH TABS
// ============================================================
qsa('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    $('login-form').classList.toggle('hidden',  which !== 'login');
    $('signup-form').classList.toggle('hidden', which !== 'signup');
  });
});

qsa('.eye-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

// ============================================================
//  PATIENT-DOCTOR ASSIGNMENT SYSTEM
// ============================================================
async function assignPatientToDoctor(doctorId, patientId) {
  await DB.remove('assignments', a => a.patient_id === patientId);
  return DB.insert('assignments', { doctor_id: doctorId, patient_id: patientId, assigned_at: new Date().toISOString() });
}

async function getPatientsForDoctor(doctorId) {
  const assignments = await DB.filter('assignments', a => a.doctor_id === doctorId);
  const patients = await Promise.all(assignments.map(a => DB.find('users', u => u.id === a.patient_id)));
  return patients.filter(Boolean);
}

async function loadAdminPanel() {
  const allUsers    = await DB.all('users');
  const allSessions = await DB.all('sessions');
  const assignments = await DB.all('assignments');

  const doctors  = allUsers.filter(u => allSessions.find(s => s.user_id === u.id && s.role === 'doctor'));
  const patients = allUsers.filter(u => allSessions.find(s => s.user_id === u.id && s.role === 'family'));

  const patientsTbody = $('admin-patients-tbody');
  if (patientsTbody) {
    if (!patients.length) {
      patientsTbody.innerHTML = `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--ink-soft)">No patients registered yet</td></tr>`;
    } else {
      patientsTbody.innerHTML = patients.map(p => {
        const assignment = assignments.find(a => a.patient_id === p.id);
        const doctor     = assignment ? allUsers.find(u => u.id === assignment.doctor_id) : null;
        const docLabel   = doctor
          ? `<span style="color:var(--accent)">${doctor.full_name}</span>`
          : `<span style="color:var(--ink-soft)">Unassigned</span>`;
        return `<tr style="border-bottom:1px solid var(--rule)">
          <td style="padding:10px 12px;color:var(--ink);font-weight:500">${p.full_name}</td>
          <td style="padding:10px 12px;color:var(--ink-soft)">${p.email}</td>
          <td style="padding:10px 12px">${docLabel}</td>
          <td style="padding:10px 12px">
            <button class="btn-sm assign-btn" data-patient-id="${p.id}" data-patient-name="${p.full_name}"
              style="font-size:12px;padding:4px 12px">${assignment ? 'Reassign' : 'Assign →'}</button>
          </td></tr>`;
      }).join('');
    }
  }

  const doctorsTbody = $('admin-doctors-tbody');
  if (doctorsTbody) {
    if (!doctors.length) {
      doctorsTbody.innerHTML = `<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--ink-soft)">No doctors registered yet</td></tr>`;
    } else {
      doctorsTbody.innerHTML = doctors.map(d => {
        const cnt = assignments.filter(a => a.doctor_id === d.id).length;
        return `<tr style="border-bottom:1px solid var(--rule)">
          <td style="padding:10px 12px;color:var(--ink);font-weight:500">${d.full_name}</td>
          <td style="padding:10px 12px;color:var(--ink-soft)">${d.email}</td>
          <td style="padding:10px 12px">
            <span style="background:var(--rule);padding:2px 10px;border-radius:20px;font-size:12px;color:var(--ink)">
              ${cnt} patient${cnt !== 1 ? 's' : ''}</span>
          </td></tr>`;
      }).join('');
    }
  }

  let currentPatientId = null, currentPatientName = null;
  qsa('.assign-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPatientId   = btn.dataset.patientId;
      currentPatientName = btn.dataset.patientName;
      $('assign-patient-label').textContent = `Patient: ${currentPatientName}`;
      const sel = $('assign-doctor-select');
      sel.innerHTML = '<option value="">— Select a doctor —</option>' +
        doctors.map(d => `<option value="${d.id}">${d.full_name}</option>`).join('');
      const existing = assignments.find(a => a.patient_id === currentPatientId);
      if (existing) sel.value = existing.doctor_id;
      $('assign-modal').style.display = 'flex';
    });
  });

  $('assign-confirm-btn').onclick = async () => {
    const doctorId = $('assign-doctor-select').value;
    if (!doctorId) { showToast('Please select a doctor', 'error'); return; }
    await assignPatientToDoctor(doctorId, currentPatientId);
    $('assign-modal').style.display = 'none';
    showToast(`${currentPatientName} assigned successfully ✓`, 'success');
    loadAdminPanel();
  };
  $('assign-cancel-btn').onclick = () => { $('assign-modal').style.display = 'none'; };
  const refreshBtn = $('admin-refresh-btn');
  if (refreshBtn) refreshBtn.onclick = loadAdminPanel;
}

// ============================================================
//  SIGN-OUT
// ============================================================
$('logout-btn').addEventListener('click', async () => {
  if (state._unsubVitals) { state._unsubVitals(); state._unsubVitals = null; }
  await Auth.signOut();
  Session.clear();
  state.user = null; state.role = null; state.vitals = [];
  showToast('Signed out', 'info');
  showAuthWrapper();
});

// ============================================================
//  VITALS — Firestore realtime listener
// ============================================================
function subscribeToVitals() {
  if (state._unsubVitals) state._unsubVitals();

  state._unsubVitals = DB.watchVitals(state.user.id, state.role, async (allVitals) => {
    let vitals = allVitals;

    if (state.role === 'doctor') {
      const myPatients   = await getPatientsForDoctor(state.user.id);
      const myPatientIds = new Set(myPatients.map(p => p.id));
      if (myPatientIds.size > 0) vitals = vitals.filter(v => myPatientIds.has(String(v.recorded_by)));
    }

    state.vitals = vitals.slice(0, 20);
    renderDashboardStats();
    renderVitalsTable('vitals-tbody', state.vitals.slice(0, 5));
    checkAlerts();

    const lastEl = $('last-updated');
    if (lastEl && state.vitals.length > 0) lastEl.textContent = 'Updated ' + timeAgo(state.vitals[0].recorded_at);
    if ($('readings-count')) $('readings-count').textContent = state.vitals.length;
  });
}

async function loadVitals() { subscribeToVitals(); }

async function loadHistory() {
  try {
    const role   = state.role || 'family';
    const userId = state.user?.id || '';
    let vitals;
    if (role === 'doctor') {
      vitals = await DB.filter('vital_signs', () => true);
    } else {
      vitals = await DB.filter('vital_signs', v => v.recorded_by === userId);
    }
    vitals = vitals.sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at))).slice(0, 100);
    renderVitalsTable('history-tbody', vitals);
  } catch (err) {
    console.warn('[History] Firestore fetch failed:', err.message);
  }
}

// ============================================================
//  Range checks
// ============================================================
const checkHR      = v => v < 50 || v > 120  ? { label: 'CRITICAL', cls: 'crit' } : v < 60 || v > 100 ? { label: 'WARNING', cls: 'warn' } : { label: 'Normal', cls: 'ok' };
const checkSpO2    = v => v < 90             ? { label: 'CRITICAL', cls: 'crit' } : v < 95             ? { label: 'LOW', cls: 'warn' }     : { label: 'Normal', cls: 'ok' };
const checkTemp    = v => v > 39.5 || v < 35 ? { label: 'CRITICAL', cls: 'crit' } : v > 37.5           ? { label: 'FEVER', cls: 'warn' }   : { label: 'Normal', cls: 'ok' };
const checkResp    = v => v < 8  || v > 30   ? { label: 'CRITICAL', cls: 'crit' } : v < 12 || v > 20   ? { label: 'WARNING', cls: 'warn' } : { label: 'Normal', cls: 'ok' };
const checkGlucose = v => v < 50 || v > 400  ? { label: 'CRITICAL', cls: 'crit' } : v < 70 || v > 180  ? { label: 'WARNING', cls: 'warn' } : { label: 'Normal', cls: 'ok' };
const checkBP      = (s, d) => s > 180 || d > 120 ? { label: 'CRISIS', cls: 'crit' } : s > 140 || d > 90 ? { label: 'HIGH', cls: 'warn' } : { label: 'Normal', cls: 'ok' };

// ============================================================
//  SAVE VITALS → Firestore
// ============================================================
$('vitals-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('save-vitals-btn');
  const payload = {
    recorded_by:   state.user.id,
    recorded_at:   new Date().toISOString(),
    heart_rate:    parseNum($('f-hr').value),
    spo2:          parseNum($('f-spo2').value),
    temperature:   parseNum($('f-temp').value),
    bp_systolic:   parseNum($('f-sys').value),
    bp_diastolic:  parseNum($('f-dia').value),
    resp_rate:     parseNum($('f-resp').value),
    blood_glucose: parseNum($('f-glucose').value),
  };

  const vitalsOnly = { ...payload };
  delete vitalsOnly.recorded_by; delete vitalsOnly.recorded_at;
  Object.keys(vitalsOnly).forEach(k => vitalsOnly[k] == null && delete vitalsOnly[k]);
  if (Object.keys(vitalsOnly).length === 0) { showToast('Enter at least one vital sign', 'error'); return; }

  setLoading(btn, true);
  try {
    await DB.insert('vital_signs', payload);
    showToast('Vitals saved! 🔥 Synced to Firestore', 'success');
    $('vitals-form').reset();
    navigateTo('dashboard');
  } catch (err) {
    console.error('[Vitals] Save failed:', err);
    showToast('Failed to save vitals — check your connection', 'error');
  } finally {
    setLoading(btn, false);
  }
});

$('export-btn').addEventListener('click', () => {
  if (!state.vitals.length) { showToast('No data to export', 'error'); return; }
  const headers = ['Time', 'HR', 'SpO2', 'Temp', 'Sys_BP', 'Dia_BP', 'Resp', 'Glucose'];
  const rows = state.vitals.map(v => [
    formatTime(v.recorded_at), v.heart_rate, v.spo2, v.temperature,
    v.bp_systolic, v.bp_diastolic, v.resp_rate, v.blood_glucose,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `medisense-vitals-${Date.now()}.csv`;
  a.click();
});

$('refresh-btn').addEventListener('click', () => { subscribeToVitals(); showToast('Refreshed', 'info'); });
$('clear-alerts-btn').addEventListener('click', () => {
  state.alerts = [];
  $('alert-badge').textContent = '';
  $('alerts-list').innerHTML = '<p class="empty-state">No alerts — all vitals within normal range ✓</p>';
});

// ============================================================
//  AI INSIGHT
// ============================================================
$('get-insight-btn').addEventListener('click', async () => {
  const v = state.vitals[0];
  if (!v) { showToast('No vitals data available', 'error'); return; }
  const btn  = $('get-insight-btn');
  const body = $('insight-body');
  btn.disabled = true; btn.textContent = 'Generating…';
  body.innerHTML = '<p class="insight-placeholder">Analysing vitals…</p>';

  const prompt = `You are a clinical AI assistant. Briefly analyse these patient vitals and highlight anything concerning. Be concise (3–5 sentences). Do not give diagnoses.\n\nVitals:\n- Heart Rate: ${v.heart_rate ?? 'N/A'} bpm\n- SpO₂: ${v.spo2 ?? 'N/A'}%\n- Temperature: ${v.temperature ?? 'N/A'}°C\n- Blood Pressure: ${v.bp_systolic ?? 'N/A'}/${v.bp_diastolic ?? 'N/A'} mmHg\n- Respiratory Rate: ${v.resp_rate ?? 'N/A'}/min\n- Blood Glucose: ${v.blood_glucose ?? 'N/A'} mg/dL\n- Recorded: ${formatTime(v.recorded_at)}`;

  try {
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    body.innerHTML = `<p>${(data?.content?.[0]?.text || 'No insight generated.').replace(/\n/g, '<br/>')}</p>`;
  } catch {
    body.innerHTML = `<p class="insight-placeholder">Could not generate insight. Check your network connection.</p>`;
  }
  btn.disabled = false; btn.textContent = 'Generate →';
});

// ============================================================
//  PROFILE
// ============================================================
$('save-profile-btn').addEventListener('click', async () => {
  const btn = $('save-profile-btn');
  setLoading(btn, true);
  try {
    await DB.upsert('user_profiles', {
      user_id:     state.user.id,
      full_name:   $('p-name')?.value.trim(),
      department:  $('p-dept')?.value.trim(),
      hospital_id: $('p-hospital')?.value.trim(),
      role:        state.role,
      updated_at:  new Date().toISOString(),
    }, 'user_id');
    showToast('Profile saved!', 'success');
  } catch { showToast('Failed to save profile', 'error'); }
  finally { setLoading(btn, false); }
});

// ============================================================
//  RENDER HELPERS
// ============================================================
function renderDashboardStats() {
  const v = state.vitals[0];
  if (!v) return;
  setStatVal('stat-hr',      v.heart_rate,    'bpm',   'stat-hr-status',      checkHR);
  setStatVal('stat-spo2',    v.spo2,          '%',     'stat-spo2-status',    checkSpO2);
  setStatVal('stat-temp',    v.temperature,   '°C',    'stat-temp-status',    checkTemp);
  setStatVal('stat-resp',    v.resp_rate,     '/min',  'stat-resp-status',    checkResp);
  setStatVal('stat-glucose', v.blood_glucose, 'mg/dL', 'stat-glucose-status', checkGlucose);
  const bpEl = $('stat-bp');
  if (bpEl && v.bp_systolic != null) {
    bpEl.innerHTML = `${v.bp_systolic}/${v.bp_diastolic} <span>mmHg</span>`;
    applyStatus('stat-bp-status', checkBP(v.bp_systolic, v.bp_diastolic));
  }
}

function setStatVal(elId, val, unit, statusId, checkFn) {
  const el = $(elId);
  if (!el || val == null) return;
  el.innerHTML = `${parseFloat(val).toFixed(val % 1 === 0 ? 0 : 1)} <span>${unit}</span>`;
  applyStatus(statusId, checkFn(val));
}

function applyStatus(elId, { label, cls }) {
  const el = $(elId);
  if (!el) return;
  el.textContent = label;
  el.className = `stat-status ${cls}`;
}

function renderVitalsTable(tbodyId, vitals) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  if (!vitals.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No readings yet</td></tr>'; return; }
  tbody.innerHTML = vitals.map(v => `
    <tr>
      <td>${formatTime(v.recorded_at)}</td>
      <td>${v.heart_rate ?? '—'}</td>
      <td>${v.spo2 ?? '—'}</td>
      <td>${v.temperature ?? '—'}</td>
      <td>${v.bp_systolic != null ? `${v.bp_systolic}/${v.bp_diastolic}` : '—'}</td>
      <td>${v.resp_rate ?? '—'}</td>
      <td>${v.blood_glucose ?? '—'}</td>
    </tr>`).join('');
}

function checkAlerts() {
  state.alerts = [];
  const v = state.vitals[0];
  if (!v) return;
  [
    { label: 'Heart Rate',   val: v.heart_rate,    fn: checkHR },
    { label: 'SpO₂',        val: v.spo2,           fn: checkSpO2 },
    { label: 'Temperature', val: v.temperature,    fn: checkTemp },
    { label: 'Resp. Rate',  val: v.resp_rate,      fn: checkResp },
    { label: 'Glucose',     val: v.blood_glucose,  fn: checkGlucose },
  ].forEach(({ label, val, fn }) => {
    if (val == null) return;
    const { cls } = fn(val);
    if (cls === 'crit' || cls === 'warn') state.alerts.push({ label, val, cls, time: v.recorded_at });
  });
  if (v.bp_systolic != null) {
    const { cls } = checkBP(v.bp_systolic, v.bp_diastolic);
    if (cls !== 'ok') state.alerts.push({ label: 'Blood Pressure', val: `${v.bp_systolic}/${v.bp_diastolic}`, cls, time: v.recorded_at });
  }
  const badge = $('alert-badge');
  badge.textContent = state.alerts.length || '';
  const list = $('alerts-list');
  if (!list) return;
  if (!state.alerts.length) { list.innerHTML = '<p class="empty-state">No alerts — all vitals within normal range ✓</p>'; return; }
  list.innerHTML = state.alerts.map(a => `
    <div class="alert-item ${a.cls === 'warn' ? 'warn' : ''}">
      <div class="alert-label">⚠ ${a.label}: ${a.val}</div>
      <div class="alert-time">${formatTime(a.time)}</div>
    </div>`).join('');
}

// ============================================================
//  UTILITIES
// ============================================================
function parseNum(val) { const n = parseFloat(val); return isNaN(n) ? null : n; }

function formatTime(iso) {
  if (!iso) return '—';
  if (iso?.seconds) iso = new Date(iso.seconds * 1000).toISOString();
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  if (iso?.seconds) iso = new Date(iso.seconds * 1000).toISOString();
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function firebaseErrMsg(code) {
  const map = {
    'auth/user-not-found':        'No account found with this email.',
    'auth/wrong-password':        'Incorrect password. Please try again.',
    'auth/invalid-credential':    'Incorrect email or password.',
    'auth/email-already-in-use':  'An account with this email already exists.',
    'auth/weak-password':         'Password must be at least 6 characters.',
    'auth/invalid-email':         'Please enter a valid email address.',
    'auth/too-many-requests':     'Too many attempts. Please try again later.',
    'auth/network-request-failed':'Network error — check your connection.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// ============================================================
//  BOOT
// ============================================================
init();
