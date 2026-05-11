// ============================================================
//  MediSense AI — medisense-firebase.js
//  Firebase layer: Authentication + Firestore realtime storage
//
//  Replaces:
//    • medisense-db.js    (localStorage JSON store)
//    • medisense-sheets.js (Google Sheets sync)
//
//  Firestore Collections:
//    users            → { email, full_name, created_at }
//    vital_signs      → { recorded_by, heart_rate, spo2, temperature,
//                         bp_systolic, bp_diastolic, resp_rate,
//                         blood_glucose, recorded_at }
//    sessions         → { user_id, role, last_seen }
//    assignments      → { doctor_id, patient_id, assigned_at }
//    login_events     → { user_id, email, auth_method, user_agent, logged_at }
//    user_profiles    → { user_id, full_name, department, hospital_id,
//                         role, updated_at }
//
//  ⚠️  SETUP — paste your Firebase project config below.
//  Get it from: Firebase Console → Project Settings → Your Apps → SDK setup
// ============================================================

// ── 🔧 YOUR FIREBASE CONFIG — fill these in ──────────────────
const firebaseConfig = {
  apiKey: "AIzaSyACI081P7vrZXjVAQcPeucTjUwzYMQkCH8",
  authDomain: "medisense-1a0d7.firebaseapp.com",
  projectId: "medisense-1a0d7",
  storageBucket: "medisense-1a0d7.firebasestorage.app",
  messagingSenderId: "566928987858",
  appId: "1:566928987858:web:da59f6265357f39ef7ff0b",
  measurementId: "G-JG579K99KL"
};
// ─────────────────────────────────────────────────────────────

import { initializeApp }                    from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

// ── Init ──────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

// ── Config check ──────────────────────────────────────────────
const CONFIGURED = !FIREBASE_CONFIG.apiKey.includes('YOUR_');
if (!CONFIGURED) {
  console.warn(
    '%c[MediSense Firebase] ⚠️ Not configured!\n' +
    'Open medisense-firebase.js and fill in your Firebase config.',
    'color:#F59E0B;font-size:13px;font-weight:bold'
  );
}

// ============================================================
//  DB — Firestore CRUD helpers
//  Mirrors the old localStorage DB API so medisense.js needs
//  minimal changes. All functions are async.
// ============================================================
const DB = {

  // ── INSERT ─────────────────────────────────────────────────
  /** Add a new document. Returns the doc with its Firestore id. */
  async insert(table, data) {
    const payload = {
      ...data,
      created_at: serverTimestamp(),
    };
    const ref = await addDoc(collection(_db, table), payload);
    const snap = await getDoc(ref);
    return { id: ref.id, ...snap.data(), created_at: new Date().toISOString() };
  },

  // ── UPSERT ────────────────────────────────────────────────
  /**
   * Insert or overwrite a document by matchKey field value.
   * If a doc with that field exists, merge; otherwise create.
   */
  async upsert(table, data, matchKey = 'id') {
    if (matchKey === 'id' && data.id) {
      // Direct doc write by id
      const ref = doc(_db, table, data.id);
      await setDoc(ref, { ...data, updated_at: serverTimestamp() }, { merge: true });
      return data;
    }
    // Query by matchKey
    const q = query(collection(_db, table), where(matchKey, '==', data[matchKey]));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const existing = snap.docs[0];
      await updateDoc(existing.ref, { ...data, updated_at: serverTimestamp() });
      return { id: existing.id, ...existing.data(), ...data };
    } else {
      return DB.insert(table, data);
    }
  },

  // ── FIND ─────────────────────────────────────────────────
  /** Return first Firestore doc that passes predicate, or null. */
  async find(table, predicate) {
    const snap = await getDocs(collection(_db, table));
    for (const d of snap.docs) {
      const row = { id: d.id, ...d.data() };
      if (predicate(row)) return row;
    }
    return null;
  },

  // ── FILTER ───────────────────────────────────────────────
  /** Return all docs that pass predicate. */
  async filter(table, predicate) {
    const snap = await getDocs(collection(_db, table));
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(predicate);
  },

  // ── ALL ──────────────────────────────────────────────────
  /** Return all docs in a collection. */
  async all(table) {
    const snap = await getDocs(collection(_db, table));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // ── UPDATE ───────────────────────────────────────────────
  /** Update all docs matching predicate with patch. Returns count. */
  async update(table, predicate, patch) {
    const snap = await getDocs(collection(_db, table));
    let count = 0;
    for (const d of snap.docs) {
      const row = { id: d.id, ...d.data() };
      if (predicate(row)) {
        await updateDoc(d.ref, patch);
        count++;
      }
    }
    return count;
  },

  // ── REMOVE ───────────────────────────────────────────────
  /** Delete all docs matching predicate. Returns count. */
  async remove(table, predicate) {
    const snap = await getDocs(collection(_db, table));
    let count = 0;
    for (const d of snap.docs) {
      const row = { id: d.id, ...d.data() };
      if (predicate(row)) {
        await deleteDoc(d.ref);
        count++;
      }
    }
    return count;
  },

  // ── COUNT ────────────────────────────────────────────────
  async count(table, predicate) {
    const snap = await getDocs(collection(_db, table));
    if (!predicate) return snap.size;
    return snap.docs.filter(d => predicate({ id: d.id, ...d.data() })).length;
  },

  // ── REALTIME LISTENER ────────────────────────────────────
  /**
   * Subscribe to realtime updates on a collection.
   * Returns unsubscribe function.
   * Usage: DB.onSnapshot('vital_signs', rows => renderTable(rows))
   */
  onSnapshot(table, callback, queryConstraints = []) {
    const q = queryConstraints.length
      ? query(collection(_db, table), ...queryConstraints)
      : collection(_db, table);
    return onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(rows);
    });
  },

  // ── VITALS REALTIME ──────────────────────────────────────
  /**
   * Subscribe to realtime vitals for a user.
   * Doctors get all vitals, family only their own.
   * Returns unsubscribe function.
   */
  watchVitals(userId, role, callback) {
    let q;
    if (role === 'doctor' || role === 'admin') {
      q = query(
        collection(_db, 'vital_signs'),
        orderBy('recorded_at', 'desc'),
        limit(50)
      );
    } else {
      q = query(
        collection(_db, 'vital_signs'),
        where('recorded_by', '==', userId),
        orderBy('recorded_at', 'desc'),
        limit(50)
      );
    }
    return onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(rows);
    });
  },

  // ── QUERY HELPERS ────────────────────────────────────────
  /** Firestore query builders re-exported for convenience */
  query:   { where, orderBy, limit },
};

// ============================================================
//  AUTH — Firebase Authentication helpers
// ============================================================
const Auth = {

  // ── SIGN UP ──────────────────────────────────────────────
  async signUp(email, password, fullName) {
    const cred = await createUserWithEmailAndPassword(_auth, email, password);
    await updateProfile(cred.user, { displayName: fullName });

    // Save user profile to Firestore
    await setDoc(doc(_db, 'users', cred.user.uid), {
      email,
      full_name: fullName,
      created_at: serverTimestamp(),
    });

    return {
      id:        cred.user.uid,
      email,
      full_name: fullName,
    };
  },

  // ── SIGN IN ──────────────────────────────────────────────
  async signIn(email, password) {
    const cred = await signInWithEmailAndPassword(_auth, email, password);
    const snap = await getDoc(doc(_db, 'users', cred.user.uid));
    const profile = snap.exists() ? snap.data() : {};

    return {
      id:        cred.user.uid,
      email:     cred.user.email,
      full_name: profile.full_name || cred.user.displayName || email.split('@')[0],
    };
  },

  // ── GOOGLE SIGN-IN ────────────────────────────────────────
  async signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    const cred     = await signInWithPopup(_auth, provider);
    const uid      = cred.user.uid;

    // Create Firestore profile if first time
    const snap = await getDoc(doc(_db, 'users', uid));
    if (!snap.exists()) {
      await setDoc(doc(_db, 'users', uid), {
        email:      cred.user.email,
        full_name:  cred.user.displayName || cred.user.email.split('@')[0],
        created_at: serverTimestamp(),
      });
    }
    const profile = snap.exists() ? snap.data() : {};
    return {
      id:        uid,
      email:     cred.user.email,
      full_name: profile.full_name || cred.user.displayName,
    };
  },

  // ── SIGN OUT ─────────────────────────────────────────────
  async signOut() {
    await signOut(_auth);
  },

  // ── FORGOT PASSWORD ──────────────────────────────────────
  async sendPasswordReset(email) {
    await sendPasswordResetEmail(_auth, email);
  },

  // ── OBSERVE AUTH STATE ───────────────────────────────────
  /** Calls callback(user | null) whenever auth state changes. */
  onAuthStateChanged(callback) {
    return onAuthStateChanged(_auth, async (firebaseUser) => {
      if (!firebaseUser) { callback(null); return; }
      const snap    = await getDoc(doc(_db, 'users', firebaseUser.uid));
      const profile = snap.exists() ? snap.data() : {};
      callback({
        id:        firebaseUser.uid,
        email:     firebaseUser.email,
        full_name: profile.full_name || firebaseUser.displayName || firebaseUser.email.split('@')[0],
      });
    });
  },

  /** Return the currently signed-in Firebase user, or null. */
  currentUser() {
    return _auth.currentUser;
  },
};

// ============================================================
//  SESSION — thin wrapper using sessionStorage (same API as before)
//  Stores the resolved user object so the app works offline briefly.
// ============================================================
const Session = {
  get() {
    try { return JSON.parse(sessionStorage.getItem('ms_current_user')); }
    catch { return null; }
  },
  set(user) {
    sessionStorage.setItem('ms_current_user', JSON.stringify(user));
  },
  clear() {
    sessionStorage.removeItem('ms_current_user');
  },
};

// ============================================================
//  LOG LOGIN EVENT to Firestore
// ============================================================
async function logLoginEvent(userId, email, method) {
  await addDoc(collection(_db, 'login_events'), {
    user_id:     userId,
    email,
    auth_method: method,
    user_agent:  navigator.userAgent.slice(0, 200),
    logged_at:   serverTimestamp(),
  });
}

// ============================================================
//  EXPOSE GLOBALS  (same surface as the old medisense-db.js)
// ============================================================
window.DB             = DB;
window.Auth           = Auth;
window.Session        = Session;
window.logLoginEvent  = logLoginEvent;

// Legacy shim: apps that call hashPassword directly still work,
// but authentication is now handled by Firebase Auth.
window.hashPassword = async (pw) => {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// Firestore query helpers exposed for power use
window._firestore      = _db;
window._firebaseAuth   = _auth;
window._firestoreUtils = { collection, doc, query, where, orderBy, limit, onSnapshot, serverTimestamp };

console.log('%c[MediSense Firebase] 🔥 Initialized', 'color:#0EA5E9;font-weight:bold;font-size:13px');
