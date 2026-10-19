import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* =========================================================
   Configurazione
   ========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyAQE4EXaYxFgJHb_9iMGbtOGghIFQyGWqo",
  authDomain: "aperivolley.firebaseapp.com",
  projectId: "aperivolley",
  storageBucket: "aperivolley.firebasestorage.app",
  messagingSenderId: "785233193282",
  appId: "1:785233193282:web:ceba7bbbbab7757f0040db"
};
const SUPER_ADMIN = "nicola.vacca@gmail.com";   // deve coincidere con firestore.rules

const SKILLS = [
  { k: "bat", l: "Battuta" },
  { k: "ric", l: "Ricezione" },
  { k: "alz", l: "Alzata" },
  { k: "att", l: "Attacco" },
  { k: "mur", l: "Muro" },
  { k: "rec", l: "Recupero palloni" }
];
const FALLBACK = 3;          // valore usato dove nessuno ha ancora votato
const PUBLISHED = 5;         // formazioni pubblicate per la votazione
const MIN_SEL = 4, MAX_SEL = 20;
const PTS_WIN = 1, PTS_PLAYED = 1;   // classifica: 1 per vittoria + 1 per presenza (vittoria = 2, sconfitta = 1)

const TEST_PLAYERS = [
  "Marco Lorusso", "Giulia De Santis", "Antonio Carofiglio", "Francesca Papagni",
  "Davide Ranieri", "Elena Mastrorilli", "Luca Pastore", "Sara Colella",
  "Vito Amoruso", "Chiara Lattanzio", "Pietro Grimaldi", "Martina Sasso",
  "Nicola Fanelli", "Alessia Debenedictis", "Gianluca Ventura", "Roberta Cassano"
];

const USER_VIEWS = [["vota", "Vota"], ["formazioni", "Formazioni"], ["classifica", "Classifica"]];
const ADMIN_VIEWS = [["partita", "Partita"], ["roster", "Roster"], ["utenti", "Utenti"]];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

/* =========================================================
   Stato
   ========================================================= */
const S = {
  phase: "loading",          // loading | signedout | ready
  user: null, uid: null, isSuper: false, isAdminDoc: false, adminKnown: false,
  view: "vota",
  players: [], my: {}, dirty: false, saving: false, saveTimer: null,
  state: null, matches: [], fvotes: new Map(),
  users: [], admins: new Set(), votes: new Map(),
  sel: [], played: null, winner: null, finalA: null, finalB: null, finalFrom: null, addPid: "",
  confirm: null, busy: false, newName: "", bulk: "", resetText: "",
  failed: "", loginErr: "",
  unsubs: [], adminUnsubs: [], fvUnsub: null, fvMatch: null
};
const isAdmin = () => S.isSuper || S.isAdminDoc;

const $view = document.getElementById("view");
const $status = document.getElementById("status");
const $tabs = document.getElementById("tabs");
const $userbar = document.getElementById("userbar");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o || {}));
const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "it", { sensitivity: "base" });
const pName = id => (S.players.find(p => p.id === id) || {}).name || "Giocatore rimosso";
const sortIdsByName = ids => ids.slice().sort((a, b) => pName(a).localeCompare(pName(b), "it", { sensitivity: "base" }));
const fmtDate = ms => ms ? new Date(ms).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" }) : "–";
const fmtDateTime = ms => ms ? new Date(ms).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|; wv\)|Telegram/i.test(navigator.userAgent);
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z"/></svg>';

/* =========================================================
   Navigazione (?p=vista)
   ========================================================= */
function readView() {
  const p = new URLSearchParams(location.search).get("p");
  const all = [...USER_VIEWS, ...ADMIN_VIEWS].map(v => v[0]);
  return all.includes(p) ? p : "vota";
}
function go(view) {
  S.view = view; S.confirm = null;
  try { history.pushState(null, "", "?p=" + view); } catch (_) { }
  render(); window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => { S.view = readView(); S.confirm = null; render(); });

/* =========================================================
   Login
   ========================================================= */
async function login() {
  S.loginErr = "";
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    const c = e && e.code;
    if (c === "auth/popup-blocked" || c === "auth/operation-not-supported-in-this-environment" || c === "auth/cancelled-popup-request") {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { S.loginErr = msgFor(e2); }
    } else if (c !== "auth/popup-closed-by-user") S.loginErr = msgFor(e);
    render();
  }
}
function msgFor(e) {
  const c = e && e.code;
  if (c === "auth/unauthorized-domain") return "Questo indirizzo non è autorizzato per l'accesso. Avvisa Nicola.";
  if (c === "auth/operation-not-allowed") return "L'accesso con Google non è ancora attivo. Avvisa Nicola.";
  if (c === "auth/network-request-failed") return "Connessione assente. Controlla la rete e riprova.";
  return "Accesso non riuscito (" + (c || "errore") + "). Riprova, oppure apri la pagina in Chrome o Safari.";
}
getRedirectResult(auth).catch(e => { S.loginErr = msgFor(e); render(); });

onAuthStateChanged(auth, async user => {
  stopAll();
  Object.assign(S, {
    user, uid: user ? user.uid : null, players: [], my: {}, state: null, matches: [],
    fvotes: new Map(), users: [], admins: new Set(), votes: new Map(), isAdminDoc: false, adminKnown: false, failed: ""
  });
  S.isSuper = !!(user && user.emailVerified && (user.email || "").toLowerCase() === SUPER_ADMIN);
  if (!user) { S.phase = "signedout"; render(); return; }
  S.phase = "ready";
  render();
  registerUser(user);
  subscribe();
});

async function registerUser(user) {
  const ref = doc(db, "users", user.uid);
  const data = { email: user.email || "", name: user.displayName || "", lastLogin: Date.now() };
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) data.createdAt = Date.now();
    await setDoc(ref, data, { merge: true });
  } catch (e) { /* non bloccante */ }
}

/* =========================================================
   Sottoscrizioni
   ========================================================= */
function stopAll() {
  S.unsubs.forEach(u => u()); S.unsubs = [];
  stopAdmin();
  if (S.fvUnsub) { S.fvUnsub(); S.fvUnsub = null; S.fvMatch = null; }
}
function stopAdmin() { S.adminUnsubs.forEach(u => u()); S.adminUnsubs = []; }

function onErr(e) {
  S.failed = e && e.code === "permission-denied"
    ? "Il database ha rifiutato la richiesta: le regole di sicurezza vanno aggiornate."
    : "Collegamento al database interrotto. Ricarica la pagina.";
  render();
}

function subscribe() {
  const uid = S.uid;
  S.unsubs.push(onSnapshot(collection(db, "players"), snap => {
    S.players = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(doc(db, "votes", uid), snap => {
    if (!S.dirty && !S.saving) S.my = clone(snap.exists() ? snap.data().ratings : {});
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(doc(db, "config", "state"), snap => {
    S.state = snap.exists() ? snap.data() : null;
    watchFormationVotes();
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(collection(db, "matches"), snap => {
    S.matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(doc(db, "admins", uid), snap => {
    const was = isAdmin();
    S.isAdminDoc = snap.exists(); S.adminKnown = true;
    if (isAdmin() !== was || (isAdmin() && !S.adminUnsubs.length)) syncAdmin();
    render();
  }, () => { S.adminKnown = true; syncAdmin(); render(); }));
  if (S.isSuper) syncAdmin();
}

function syncAdmin() {
  stopAdmin();
  if (!isAdmin()) { S.users = []; S.admins = new Set(); S.votes = new Map(); return; }
  S.adminUnsubs.push(onSnapshot(collection(db, "users"), snap => {
    S.users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
  S.adminUnsubs.push(onSnapshot(collection(db, "admins"), snap => {
    S.admins = new Set(snap.docs.map(d => d.id));
    render();
  }, onErr));
  S.adminUnsubs.push(onSnapshot(collection(db, "votes"), snap => {
    S.votes = new Map(snap.docs.map(d => [d.id, d.data()]));
    render();
  }, onErr));
}

function currentMatch() {
  const id = S.state && S.state.currentMatch;
  if (!id) return null;
  const m = S.matches.find(x => x.id === id);
  return m && m.status === "voting" ? m : null;
}
function watchFormationVotes() {
  const id = S.state && S.state.currentMatch;
  if (id === S.fvMatch) return;
  if (S.fvUnsub) { S.fvUnsub(); S.fvUnsub = null; }
  S.fvMatch = id || null; S.fvotes = new Map();
  if (!id) return;
  S.fvUnsub = onSnapshot(collection(db, "matches", id, "fvotes"), snap => {
    S.fvotes = new Map(snap.docs.map(d => [d.id, d.data().choice]));
    render();
  }, onErr);
}

/* =========================================================
   Voti alle skill
   ========================================================= */
function rate(pid, k, v) {
  const cur = (S.my[pid] && S.my[pid][k]) || 0;
  const r = S.my[pid] = Object.assign({}, S.my[pid]);
  if (cur === v) delete r[k]; else r[k] = v;
  if (!Object.keys(r).length) delete S.my[pid];
  S.dirty = true;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveVotes, 600);
  render();
}
async function saveVotes() {
  if (S.saving) { S.saveTimer = setTimeout(saveVotes, 400); return; }
  if (!S.dirty || !S.uid) return;
  S.saving = true; S.dirty = false;
  try {
    await setDoc(doc(db, "votes", S.uid), { ratings: clone(S.my), updatedAt: Date.now() });
    flash("Voti salvati.", "ok");
  } catch (e) {
    S.dirty = true;
    flash("Salvataggio non riuscito, riprovo tra poco.", "warn");
    S.saveTimer = setTimeout(saveVotes, 2500 + Math.random() * 1500);
  }
  S.saving = false; render();
}

/* =========================================================
   Formazioni: calcolo (solo nel browser dell'amministratore)
   ========================================================= */
function playerAverages() {
  const sum = {}, cnt = {};
  for (const [, d] of S.votes) {
    for (const [pid, r] of Object.entries((d && d.ratings) || {})) {
      for (const { k } of SKILLS) {
        const v = Number(r && r[k]);
        if (Number.isInteger(v) && v >= 1 && v <= 5) {
          const key = pid + "|" + k;
          sum[key] = (sum[key] || 0) + v; cnt[key] = (cnt[key] || 0) + 1;
        }
      }
    }
  }
  const avg = {};
  for (const p of S.players) {
    avg[p.id] = SKILLS.map(({ k }) => { const key = p.id + "|" + k; return cnt[key] ? sum[key] / cnt[key] : null; });
  }
  return avg;
}

/*
  Criterio di formazione delle squadre
  1. Ruoli (criterio principale): per ogni skill si confrontano i due migliori
     giocatori di A con i due migliori di B (1° con 1°, 2° con 2°).
     Squilibrio ruoli = media, su tutte le skill, di (|1°A − 1°B| + |2°A − 2°B|) / 2.
  2. Equilibrio generale (vincolo): si scartano le divisioni in cui la media
     generale delle due squadre differisce più di ROLE_GATE stelle; se ne restano
     meno di PUBLISHED la soglia si allarga di 0,05 alla volta.
  3. A parità di ruoli decide il costo generale:
     0,4 × Δ media globale + 0,4 × Δ medio tra le skill + 0,2 × Δ skill più sbilanciata.
*/
const ROLE_GATE = 0.25;
const TOP_PER_ROLE = 2;

function generate(sel, avg) {
  const n = sel.length, h = n / 2, K = SKILLS.length;
  const vals = sel.map(pid => (avg[pid] || []).map(a => a == null ? FALLBACK : a).concat(Array(K).fill(FALLBACK)).slice(0, K));
  const totAll = SKILLS.map((_, j) => vals.reduce((s, v) => s + v[j], 0));
  const top = Math.min(TOP_PER_ROLE, h);
  const res = [], idx = [0];
  const evalSplit = () => {
    const inA = new Array(n).fill(false); idx.forEach(i => inA[i] = true);
    const sA = SKILLS.map((_, j) => idx.reduce((s, i) => s + vals[i][j], 0));
    const mA = sA.map(v => v / h), mB = sA.map((v, j) => (totAll[j] - v) / h);
    const dS = mA.map((v, j) => Math.abs(v - mB[j]));
    const gA = mA.reduce((a, b) => a + b, 0) / K, gB = mB.reduce((a, b) => a + b, 0) / K;
    const dG = Math.abs(gA - gB);
    const dAvg = dS.reduce((a, b) => a + b, 0) / K;
    const dMax = Math.max(...dS);
    const cost = 0.4 * dG + 0.4 * dAvg + 0.2 * dMax;
    // squilibrio dei ruoli
    let role = 0;
    for (let j = 0; j < K; j++) {
      const a = [], b = [];
      for (let i = 0; i < n; i++) (inA[i] ? a : b).push(vals[i][j]);
      a.sort((x, y) => y - x); b.sort((x, y) => y - x);
      let g = 0;
      for (let t = 0; t < top; t++) g += Math.abs(a[t] - b[t]);
      role += g / top;
    }
    role /= K;
    res.push({ a: idx.slice(), cost, role, dG, mA, mB, gA, gB });
  };
  const rec = start => {
    if (idx.length === h) { evalSplit(); return; }
    for (let i = start; i <= n - (h - idx.length); i++) { idx.push(i); rec(i + 1); idx.pop(); }
  };
  rec(1);
  // vincolo di equilibrio generale, con soglia che si allarga se servono più candidati
  let gate = ROLE_GATE, pool = [];
  const want = Math.min(PUBLISHED, res.length);
  while (true) {
    pool = res.filter(r => r.dG <= gate + 1e-9);
    if (pool.length >= want || gate > 5) break;
    gate += 0.05;
  }
  const key = x => Math.round(x * 100) / 100;     // ruoli quasi uguali = pari, decide l'equilibrio generale
  pool.sort((x, y) => key(x.role) - key(y.role) || x.cost - y.cost || x.dG - y.dG);
  const r1 = x => Math.round(x * 10) / 10;
  const score = x => Math.max(0, Math.round(100 * (1 - x)));
  return pool.slice(0, PUBLISHED).map(r => {
    const set = new Set(r.a);
    const statsOf = m => Object.fromEntries(SKILLS.map(({ k }, j) => [k, r1(m[j])]));
    return {
      A: sortIdsByName(r.a.map(i => sel[i])),
      B: sortIdsByName(sel.filter((_, i) => !set.has(i))),
      sA: statsOf(r.mA), sB: statsOf(r.mB),
      gA: r1(r.gA), gB: r1(r.gB),
      req: score(r.role),          // equilibrio ruoli
      eq: score(r.cost)            // equilibrio generale
    };
  });
}

async function publishMatch() {
  const sel = S.sel.filter(id => S.players.some(p => p.id === id));
  if (sel.length < MIN_SEL || sel.length > MAX_SEL || sel.length % 2) return;
  S.busy = true; render();
  try {
    const snap = await getDocs(collection(db, "votes"));   // dati freschi
    S.votes = new Map(snap.docs.map(d => [d.id, d.data()]));
    const formations = generate(sel, playerAverages());
    const ref = doc(collection(db, "matches"));
    const b = writeBatch(db);
    b.set(ref, { status: "voting", createdAt: Date.now(), selected: sel, formations, createdBy: S.user.email || "" });
    b.set(doc(db, "config", "state"), { currentMatch: ref.id, updatedAt: Date.now() });
    await b.commit();
    S.sel = []; S.played = null; S.winner = null;
    flash("Formazioni pubblicate: ora i giocatori possono votarle.", "ok");
  } catch (e) { flash("Pubblicazione non riuscita: " + (e.code || "errore"), "warn"); }
  S.busy = false; render();
}

async function voteFormation(i) {
  const m = currentMatch(); if (!m) return;
  try { await setDoc(doc(db, "matches", m.id, "fvotes", S.uid), { choice: i, at: Date.now() }); }
  catch (e) { flash("Voto non registrato. Riprova.", "warn"); }
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
// Formazioni definitive: partono dalla formazione scelta e si possono correggere
function ensureFinal(m) {
  const key = m.id + "|" + S.played;
  if (S.finalFrom === key && S.finalA && S.finalB) return;
  const f = m.formations[S.played] || { A: [], B: [] };
  S.finalA = f.A.slice(); S.finalB = f.B.slice(); S.finalFrom = key;
}
function moveFinal(pid, to) {
  S.finalA = S.finalA.filter(x => x !== pid);
  S.finalB = S.finalB.filter(x => x !== pid);
  if (to === "A") S.finalA.push(pid);
  else if (to === "B") S.finalB.push(pid);
  render();
}

async function recordResult() {
  const m = currentMatch(); if (!m || S.played == null || !S.winner) return;
  const f = m.formations[S.played]; if (!f) return;
  ensureFinal(m);
  const A = S.finalA.slice(), B = S.finalB.slice();
  if (!A.length || !B.length) return;
  const changed = !sameSet(A, f.A) || !sameSet(B, f.B);
  S.busy = true; render();
  try {
    const b = writeBatch(db);
    b.update(doc(db, "matches", m.id), {
      status: "played", playedAt: Date.now(), playedIndex: S.played,
      teamA: A, teamB: B, edited: changed, winner: S.winner, formations: deleteField()
    });
    b.set(doc(db, "config", "state"), { currentMatch: null, updatedAt: Date.now() });
    await b.commit();
    S.played = null; S.winner = null; S.confirm = null; S.finalA = S.finalB = S.finalFrom = null; S.addPid = "";
    flash("Risultato registrato. La classifica è aggiornata.", "ok");
  } catch (e) { flash("Risultato non salvato: " + (e.code || "errore"), "warn"); }
  S.busy = false; render();
}

async function deleteMatchFully(id) {
  const fv = await getDocs(collection(db, "matches", id, "fvotes"));
  const b = writeBatch(db);
  fv.docs.forEach(d => b.delete(d.ref));
  b.delete(doc(db, "matches", id));
  if (S.state && S.state.currentMatch === id) b.set(doc(db, "config", "state"), { currentMatch: null, updatedAt: Date.now() });
  await b.commit();
}
async function cancelMatch(id) {
  S.busy = true; render();
  try { await deleteMatchFully(id); flash("Partita eliminata.", "ok"); }
  catch (e) { flash("Eliminazione non riuscita.", "warn"); }
  S.confirm = null; S.busy = false; render();
}

/* =========================================================
   Classifica
   ========================================================= */
function ranking() {
  const st = new Map(S.players.map(p => [p.id, { id: p.id, name: p.name, g: 0, v: 0 }]));
  for (const m of S.matches) {
    if (m.status !== "played") continue;
    for (const side of ["A", "B"]) {
      for (const id of (m["team" + side] || [])) {
        const s = st.get(id); if (!s) continue;
        s.g++; if (m.winner === side) s.v++;
      }
    }
  }
  const rows = [...st.values()].map(s => ({ ...s, pts: PTS_WIN * s.v + PTS_PLAYED * s.g, pct: s.g ? s.v / s.g : 0 }));
  rows.sort((a, b) => b.pts - a.pts || b.pct - a.pct || b.g - a.g || byName(a, b));
  let pos = 0, prev = null;
  rows.forEach((r, i) => {
    const key = r.pts + "|" + r.pct + "|" + r.g;
    if (key !== prev) pos = i + 1;
    r.pos = pos; prev = key;
  });
  return rows;
}

/* =========================================================
   Roster e utenti (amministratori)
   ========================================================= */
async function addPlayers(names) {
  const list = names.map(n => n.trim()).filter(Boolean);
  if (!list.length) return;
  const existing = new Set(S.players.map(p => (p.name || "").toLowerCase()));
  const fresh = [...new Set(list)].filter(n => !existing.has(n.toLowerCase()));
  try {
    const b = writeBatch(db);
    fresh.forEach(name => b.set(doc(collection(db, "players")), { name: name.slice(0, 80), createdAt: Date.now() }));
    await b.commit();
    S.newName = ""; S.bulk = "";
    const skipped = list.length - fresh.length;
    flash(`Aggiunti ${fresh.length} giocatori` + (skipped ? ` (${skipped} già presenti)` : "") + ".", "ok");
  } catch (e) { flash("Giocatori non aggiunti.", "warn"); }
  render();
}
async function renamePlayer(pid, name) {
  name = name.trim(); const p = S.players.find(x => x.id === pid);
  if (!name || !p || p.name === name) return;
  try { await updateDoc(doc(db, "players", pid), { name: name.slice(0, 80) }); } catch (e) { flash("Nome non aggiornato.", "warn"); }
}
async function removePlayer(pid) {
  try { await deleteDoc(doc(db, "players", pid)); flash("Giocatore rimosso.", "ok"); }
  catch (e) { flash("Giocatore non rimosso.", "warn"); }
  S.confirm = null; render();
}

async function commitDeletes(refs) {
  for (let i = 0; i < refs.length; i += 450) {
    const b = writeBatch(db);
    refs.slice(i, i + 450).forEach(r => b.delete(r));
    await b.commit();
  }
}
async function resetTestData() {
  S.busy = true; render();
  try {
    const refs = [];
    for (const c of ["players", "votes", "week", "config"]) (await getDocs(collection(db, c))).docs.forEach(d => refs.push(d.ref));
    const ms = await getDocs(collection(db, "matches"));
    for (const m of ms.docs) {
      (await getDocs(collection(db, "matches", m.id, "fvotes"))).docs.forEach(d => refs.push(d.ref));
      refs.push(m.ref);
    }
    await commitDeletes(refs);
    const b = writeBatch(db);
    TEST_PLAYERS.forEach(name => b.set(doc(collection(db, "players")), { name, createdAt: Date.now() }));
    await b.commit();
    S.my = {}; S.resetText = "";
    flash("Dati azzerati e 16 giocatori di prova caricati.", "ok");
  } catch (e) { flash("Azzeramento non riuscito: " + (e.code || "errore"), "warn"); }
  S.confirm = null; S.busy = false; render();
}

async function setAdmin(uid, on) {
  const u = S.users.find(x => x.id === uid);
  try {
    if (on) await setDoc(doc(db, "admins", uid), { email: (u && u.email) || "", by: S.user.email || "", at: Date.now() });
    else await deleteDoc(doc(db, "admins", uid));
    flash(on ? "Amministratore aggiunto." : "Permessi di amministratore revocati.", "ok");
  } catch (e) { flash("Operazione non riuscita.", "warn"); }
  S.confirm = null; render();
}
async function deleteUser(uid) {
  S.busy = true; render();
  try {
    const refs = [doc(db, "users", uid), doc(db, "votes", uid), doc(db, "admins", uid)];
    const m = currentMatch(); if (m) refs.push(doc(db, "matches", m.id, "fvotes", uid));
    await commitDeletes(refs);
    flash("Utente eliminato insieme ai suoi voti.", "ok");
  } catch (e) { flash("Eliminazione non riuscita.", "warn"); }
  S.confirm = null; S.busy = false; render();
}

/* =========================================================
   Messaggi
   ========================================================= */
let flashTimer = null, flashMsg = null;
function flash(msg, kind) {
  flashMsg = { msg, kind }; renderStatus();
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashMsg = null; renderStatus(); }, 3500);
}
const HINTS = {
  vota: "Dai da 1 a 5 stelle a ogni skill. Tocca di nuovo la stessa stella per togliere il voto. I tuoi voti li vedi solo tu.",
  formazioni: "Scegli la formazione che ti sembra più giusta. Puoi cambiare voto finché la votazione è aperta.",
  classifica: "Ogni partita vinta vale 2 punti, ogni partita persa 1 punto.",
  partita: "Scegli i convocati e pubblica le formazioni. Dopo la partita inserisci le formazioni definitive e la squadra vincitrice.",
  roster: "Aggiungi, rinomina o rimuovi giocatori.",
  utenti: "Persone che sono entrate nell'app con Google."
};
function renderStatus() {
  if (S.phase !== "ready") { $status.hidden = true; return; }
  let msg, kind = "";
  if (flashMsg) { msg = flashMsg.msg; kind = flashMsg.kind; }
  else if (S.failed) { msg = S.failed; kind = "warn"; }
  else msg = HINTS[S.view] || "";
  $status.hidden = !msg;
  $status.className = "status" + (kind ? " " + kind : "");
  $status.textContent = msg;
}

/* =========================================================
   Render
   ========================================================= */
function render() {
  const ae = document.activeElement;
  const active = ae && ae.id;
  const keep = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") ? { v: ae.value, s: ae.selectionStart, e: ae.selectionEnd } : null;

  const adminView = ADMIN_VIEWS.some(v => v[0] === S.view);

  if (S.phase === "ready") {
    const views = isAdmin() ? [...USER_VIEWS, ...ADMIN_VIEWS] : USER_VIEWS;
    const pending = currentMatch() && !S.fvotes.has(S.uid);
    $tabs.hidden = false;
    $tabs.innerHTML = views.map(([v, l]) => {
      const adm = ADMIN_VIEWS.some(x => x[0] === v);
      const dot = v === "formazioni" && pending ? '<span class="dot-new" aria-label="da votare"></span>' : "";
      return `<a class="tab${adm ? " adm" : ""}" href="?p=${v}" data-nav="${v}" ${S.view === v ? 'aria-current="page"' : ""}>${l}${dot}</a>`;
    }).join("");
    $userbar.hidden = false;
    $userbar.innerHTML = `<span>Entrato come <strong>${esc(S.user.email)}</strong>${isAdmin() ? " · amministratore" : ""}</span><button class="linkbtn" id="logout" data-act="logout">Esci</button>`;
  } else { $tabs.hidden = true; $userbar.hidden = true; }
  renderStatus();

  if (S.phase === "loading") $view.innerHTML = `<div class="empty">Caricamento…</div>`;
  else if (S.phase === "signedout") $view.innerHTML = loginHTML();
  else if (adminView && !isAdmin()) $view.innerHTML = S.adminKnown || S.isSuper
    ? `<div class="empty">Questa sezione è riservata agli amministratori. <a href="?p=vota" data-nav="vota">Vai a Vota</a></div>`
    : `<div class="empty">Verifica dei permessi…</div>`;
  else $view.innerHTML = ({
    vota: voteHTML, formazioni: formationsHTML, classifica: rankingHTML,
    partita: matchAdminHTML, roster: rosterHTML, utenti: usersHTML
  }[S.view] || voteHTML)();

  if (active) {
    const el = document.getElementById(active);
    if (el) {
      if (keep && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.value = keep.v; try { el.setSelectionRange(keep.s, keep.e); } catch (_) { } }
      el.focus({ preventScroll: true });
    }
  }
}

const confirmBtns = (key, label, yesAct, data = "") => S.confirm === key
  ? `<button class="btn danger" id="yes-${esc(key)}" data-act="${yesAct}" ${data}>Conferma</button><button class="btn" id="no-${esc(key)}" data-act="cancel">Annulla</button>`
  : `<button class="btn danger-o" id="ask-${esc(key)}" data-act="ask" data-key="${esc(key)}">${label}</button>`;

function loginHTML() {
  return `<section class="gate">
    <h2>AperiVolley</h2>
    <p>Entra con il tuo account Google per votare le skill dei compagni, scegliere le formazioni e vedere la classifica.</p>
    <button class="btn primary" id="login" data-act="login">Accedi con Google</button>
    ${S.loginErr ? `<p class="hint" style="color:var(--bad)">${esc(S.loginErr)}</p>` : ""}
    ${inAppBrowser ? `<p class="hint" style="color:var(--warn)">Hai aperto il link dentro un'app (Instagram, Facebook, Telegram…). Se l'accesso non funziona, apri la pagina in Chrome o Safari.</p>` : ""}
    <p class="hint">Dal tuo account usiamo solo nome ed email, per riconoscere i tuoi voti.</p>
  </section>`;
}

/* ---------- Vota ---------- */
function voteHTML() {
  if (!S.players.length) return `<div class="empty">Nessun giocatore nel roster.${isAdmin() ? ` Aggiungili dal pannello <a href="?p=roster" data-nav="roster">Roster</a>.` : ""}</div>`;
  const done = S.players.filter(p => SKILLS.every(({ k }) => S.my[p.id] && S.my[p.id][k])).length;
  let h = `<div class="sec-head"><h2>Vota le skill</h2><span class="meta num">Completati ${done} su ${S.players.length}</span></div><div class="grid">`;
  for (const p of S.players) {
    const mine = S.my[p.id] || {};
    const n = SKILLS.filter(({ k }) => mine[k]).length;
    h += `<article class="card">
      <div class="card-h"><h3>${esc(p.name)}</h3><span class="pill ${n === SKILLS.length ? "ok" : n ? "part" : ""} num">${n}/${SKILLS.length}</span></div>`;
    for (const { k, l } of SKILLS) {
      h += `<div class="skill"><span class="lbl">${l}</span><div class="stars" role="group" aria-label="${l}">`;
      for (let v = 1; v <= 5; v++) {
        h += `<button class="star${v <= (mine[k] || 0) ? " on" : ""}" id="st-${p.id}-${k}-${v}" data-act="rate" data-pid="${p.id}" data-k="${k}" data-v="${v}" aria-label="${l}: ${v} stell${v > 1 ? "e" : "a"}" aria-pressed="${v === mine[k]}">${STAR}</button>`;
      }
      h += `</div></div>`;
    }
    h += `</article>`;
  }
  return h + `</div>`;
}

/* ---------- Formazioni ---------- */
function teamBlock(side, ids, stats, g) {
  return `<section class="team ${side}">
    <div class="team-h"><h4>Squadra ${side}</h4><div class="tg num">${g.toFixed(1)}<small> totale</small></div></div>
    <ul class="plist">${sortIdsByName(ids).map(id => `<li>${esc(pName(id))}</li>`).join("")}</ul>
    <div class="tstats">${SKILLS.map(({ k, l }) => `<div class="ts"><span class="lbl">${l}</span><div class="track"><b style="width:${((stats[k] || 0) / 5 * 100).toFixed(0)}%"></b></div><span class="num v">${(stats[k] || 0).toFixed(1)}</span></div>`).join("")}</div>
  </section>`;
}
const eqClass = e => e >= 90 ? "g" : e >= 75 ? "w" : "b";

function formationsHTML() {
  const m = currentMatch();
  if (!m) return `<div class="empty">Nessuna partita in programma. Quando gli organizzatori scelgono i convocati, qui trovi le formazioni da votare.</div>`;
  const counts = m.formations.map((_, i) => [...S.fvotes.values()].filter(c => c === i).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const mine = S.fvotes.get(S.uid);
  let h = `<div class="sec-head"><h2>Formazioni</h2><span class="meta num">Partita del ${fmtDate(m.createdAt)} · ${m.selected.length} convocati · ${total} vot${total === 1 ? "o" : "i"}</span></div>
  <p class="note">Le formazioni sono ordinate dalla più equilibrata. <b>Ruoli</b> indica quanto sono divisi tra le due squadre i migliori di ogni skill (per esempio i due attaccanti più forti uno per parte); <b>Generale</b> quanto si equivalgono le squadre nel complesso. Per ogni squadra vedi la media di ogni skill e il totale (media delle skill).</p>
  <div class="variants">`;
  m.formations.forEach((f, i) => {
    const pct = total ? Math.round(counts[i] / total * 100) : 0;
    const chosen = mine === i;
    h += `<article class="variant${chosen ? " chosen" : ""}">
      <div class="v-head">
        <h3>Formazione ${i + 1}</h3>
        ${f.req != null ? `<span class="eq ${eqClass(f.req)} num" title="Equilibrio dei ruoli">Ruoli ${f.req}</span>` : ""}<span class="eq ${eqClass(f.eq)} num" title="Equilibrio generale">Generale ${f.eq}</span>
        <div class="vbar" title="${counts[i]} voti"><div class="track"><b style="width:${pct}%"></b></div><span class="num">${counts[i]} vot${counts[i] === 1 ? "o" : "i"}</span></div>
        <button class="btn ${chosen ? "primary" : ""}" id="fv-${i}" data-act="fvote" data-i="${i}" aria-pressed="${chosen}">${chosen ? "Il tuo voto ✓" : "Vota questa"}</button>
      </div>
      <div class="teams">${teamBlock("A", f.A, f.sA, f.gA)}${teamBlock("B", f.B, f.sB, f.gB)}</div>
    </article>`;
  });
  return h + `</div>`;
}

/* ---------- Classifica ---------- */
function rankingHTML() {
  const rows = ranking();
  const played = S.matches.filter(m => m.status === "played").length;
  if (!rows.length) return `<div class="empty">Nessun giocatore nel roster.</div>`;
  let h = `<div class="sec-head"><h2>Classifica</h2><span class="meta num">${played} partit${played === 1 ? "a" : "e"} giocat${played === 1 ? "a" : "e"}</span></div>
  <p class="note">Punti = ${PTS_WIN} × vittorie + ${PTS_PLAYED} × partite giocate: una partita vinta vale 2 punti, una persa 1. Chi non ha ancora giocato ha 0 punti. A parità di punti conta la percentuale di vittorie, poi il numero di partite.</p>
  <div class="tbl-wrap"><table class="rank">
    <thead><tr><th>#</th><th>Giocatore</th><th class="r">Punti</th><th class="r">Giocate</th><th class="r">Vinte</th><th class="r">% vittorie</th></tr></thead><tbody>`;
  for (const r of rows) {
    h += `<tr class="${r.pos <= 3 && r.pts > 0 ? "podium" : ""}${r.g === 0 ? " zero" : ""}"><td class="num">${r.pos}</td><td>${esc(r.name)}</td><td class="r num pts">${r.pts}</td><td class="r num">${r.g}</td><td class="r num">${r.v}</td><td class="r num">${r.g ? Math.round(r.pct * 100) + "%" : "–"}</td></tr>`;
  }
  return h + `</tbody></table></div>`;
}

/* ---------- Admin: Partita ---------- */
function matchAdminHTML() {
  const m = currentMatch();
  let h = "";
  if (m) {
    const counts = m.formations.map((_, i) => [...S.fvotes.values()].filter(c => c === i).length);
    const best = counts.indexOf(Math.max(...counts));
    if (S.played == null) S.played = counts.some(c => c > 0) ? best : 0;
    h += `<div class="sec-head"><h2>Partita in votazione</h2><span class="meta num">Pubblicata il ${fmtDateTime(m.createdAt)} · ${S.fvotes.size} vot${S.fvotes.size === 1 ? "o" : "i"}</span></div>
    <div class="card"><strong>1. Formazione di partenza</strong><span class="meta">Di solito la più votata.</span><div class="radio-list">`;
    m.formations.forEach((f, i) => {
      h += `<label class="radio"><input type="radio" name="played" id="pl-${i}" data-act="played" data-i="${i}" ${S.played === i ? "checked" : ""}>
        <span><b>Formazione ${i + 1}</b> · ${counts[i]} vot${counts[i] === 1 ? "o" : "i"} · ruoli ${f.req ?? "–"} · generale ${f.eq}<br><small>A: ${sortIdsByName(f.A).map(pName).map(esc).join(", ")}<br>B: ${sortIdsByName(f.B).map(pName).map(esc).join(", ")}</small></span></label>`;
    });
    ensureFinal(m);
    const f = m.formations[S.played];
    const edited = f && (!sameSet(S.finalA, f.A) || !sameSet(S.finalB, f.B));
    const inTeams = new Set([...S.finalA, ...S.finalB]);
    const others = S.players.filter(p => !inTeams.has(p.id));
    if (S.addPid && inTeams.has(S.addPid)) S.addPid = "";
    const teamCol = (side, ids) => `<div class="fteam ${side}"><div class="fteam-h"><b>Squadra ${side}</b><span class="meta num">${ids.length} giocator${ids.length === 1 ? "e" : "i"}</span></div>
      ${ids.length ? `<ul class="flist">${sortIdsByName(ids).map(id => `<li><span>${esc(pName(id))}</span>
        <span class="fbtns"><button class="btn sm" id="mv-${id}" data-act="fmove" data-pid="${id}" data-to="${side === "A" ? "B" : "A"}" title="Sposta nella squadra ${side === "A" ? "B" : "A"}">→ ${side === "A" ? "B" : "A"}</button>
        <button class="btn sm danger-o" id="rm-${id}" data-act="fmove" data-pid="${id}" data-to="" title="Non ha giocato" aria-label="Togli ${esc(pName(id))}">✕</button></span></li>`).join("")}</ul>`
        : `<p class="meta">Nessun giocatore.</p>`}</div>`;
    h += `</div>
      <strong>2. Formazioni definitive</strong>
      <span class="meta">Parti dalla formazione scelta e correggila con chi ha giocato davvero: sposta i giocatori tra le squadre, togli chi era assente, aggiungi chi non era convocato.${edited ? ' <b style="color:var(--warn)">Modificata rispetto alla formazione ' + (S.played + 1) + '.</b>' : ""}</span>
      <div class="fteams">${teamCol("A", S.finalA)}${teamCol("B", S.finalB)}</div>
      <div class="manage-row">
        <select class="field" id="addpid" aria-label="Aggiungi un giocatore" ${others.length ? "" : "disabled"}>
          <option value="">${others.length ? "Aggiungi un giocatore…" : "Tutti i giocatori sono già in squadra"}</option>
          ${others.map(p => `<option value="${p.id}" ${S.addPid === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        <button class="btn" id="add-A" data-act="fadd" data-to="A" ${S.addPid ? "" : "disabled"}>In squadra A</button>
        <button class="btn" id="add-B" data-act="fadd" data-to="B" ${S.addPid ? "" : "disabled"}>In squadra B</button>
        ${edited ? `<button class="btn" id="freset" data-act="freset">Ripristina formazione ${S.played + 1}</button>` : ""}
      </div>
      <strong>3. Squadra vincitrice</strong>
      <div class="seg" role="group" aria-label="Vincitrice">
        <button id="win-A" data-act="winner" data-v="A" aria-pressed="${S.winner === "A"}">Squadra A</button>
        <button id="win-B" data-act="winner" data-v="B" aria-pressed="${S.winner === "B"}">Squadra B</button>
      </div>
      <div class="manage-row">
        <button class="btn primary" id="record" data-act="record" ${S.winner && S.finalA.length && S.finalB.length && !S.busy ? "" : "disabled"}>Registra risultato</button>
        ${confirmBtns("cancel-" + m.id, "Annulla partita", "cancelmatch", `data-id="${m.id}"`)}
      </div>
      <span class="meta">Nella classifica contano le formazioni definitive. Registrando il risultato la votazione si chiude e le statistiche delle formazioni vengono cancellate.</span>
    </div>`;
  } else {
    const sel = S.sel.filter(id => S.players.some(p => p.id === id)), n = sel.length;
    const ok = n >= MIN_SEL && n <= MAX_SEL && n % 2 === 0;
    const set = new Set(sel);
    const voters = S.votes.size;
    h += `<div class="sec-head"><h2>Nuova partita</h2><span class="count num ${n === 12 ? "okc" : ok ? "" : "badc"}">${n} / 12</span></div>
    <div class="bar"><button class="btn" id="sel-none" data-act="sel-none">Svuota</button><button class="btn" id="sel-all" data-act="sel-all">Seleziona tutti</button></div>
    <div class="chips">${S.players.map(p => `<button class="chip" id="ch-${p.id}" data-act="toggle" data-pid="${p.id}" aria-pressed="${set.has(p.id)}"><span class="dot"></span>${esc(p.name)}</button>`).join("")}</div>
    <div class="manage-row" style="margin-top:16px">
      <button class="btn primary" id="publish" data-act="publish" ${ok && !S.busy ? "" : "disabled"}>${S.busy ? "Calcolo in corso…" : `Genera ${PUBLISHED} formazioni e apri la votazione`}</button>
      <span class="meta">${ok ? `Le formazioni si calcolano dai voti di ${voters} person${voters === 1 ? "a" : "e"}. Dove manca un voto si usa ${FALLBACK}.` : n % 2 ? "Serve un numero pari di convocati." : `Seleziona da ${MIN_SEL} a ${MAX_SEL} convocati.`}</span>
    </div>`;
  }
  const hist = S.matches.filter(x => x.status === "played").sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0));
  h += `<div class="sec-head" style="margin-top:28px"><h2>Partite giocate</h2><span class="meta num">${hist.length}</span></div>`;
  if (!hist.length) h += `<div class="empty">Nessuna partita registrata.</div>`;
  else h += `<div class="acc-list">${hist.map(x => `<div class="acc"><div class="who"><b>${fmtDate(x.playedAt)}</b> · vince la squadra ${esc(x.winner)}${x.edited ? " · formazioni corrette a mano" : ""}
      <small>A${x.winner === "A" ? " 🏆" : ""}: ${sortIdsByName(x.teamA || []).map(pName).map(esc).join(", ")}</small>
      <small>B${x.winner === "B" ? " 🏆" : ""}: ${sortIdsByName(x.teamB || []).map(pName).map(esc).join(", ")}</small></div>
      ${confirmBtns("delm-" + x.id, "Elimina", "cancelmatch", `data-id="${x.id}"`)}</div>`).join("")}</div>`;
  return h;
}

/* ---------- Admin: Roster ---------- */
function rosterHTML() {
  let h = `<div class="sec-head"><h2>Roster</h2><span class="meta num">${S.players.length} giocatori</span></div>
  <form class="card" id="addform">
    <strong>Aggiungi giocatori</strong>
    <div class="manage-row"><input class="field" id="newname" placeholder="Nome e cognome" value="${esc(S.newName)}" autocomplete="off"><button class="btn primary" id="addbtn" type="submit">Aggiungi</button></div>
    <label class="meta" for="bulk">Oppure incolla un elenco, un nome per riga:</label>
    <textarea class="field" id="bulk" placeholder="Mario Rossi&#10;Anna Bianchi">${esc(S.bulk)}</textarea>
    <div class="manage-row"><button class="btn" id="bulkbtn" type="button" data-act="bulk">Aggiungi elenco</button><span class="meta">I nomi già presenti vengono saltati.</span></div>
  </form>
  <div class="acc-list" style="margin-top:14px">`;
  if (!S.players.length) h += `<div class="empty">Il roster è vuoto.</div>`;
  for (const p of S.players) {
    h += `<div class="acc"><input class="field grow" id="rn-${p.id}" data-act="rename" data-pid="${p.id}" value="${esc(p.name)}" aria-label="Nome di ${esc(p.name)}">
      ${confirmBtns("delp-" + p.id, "Rimuovi", "delplayer", `data-pid="${p.id}"`)}</div>`;
  }
  h += `</div>
  <div class="card danger-zone" style="margin-top:28px">
    <strong>Azzera i dati</strong>
    <span class="meta">Cancella tutti i giocatori, tutti i voti e tutte le partite, poi carica ${TEST_PLAYERS.length} giocatori di prova. Gli utenti e gli amministratori restano. Non si può annullare.</span>
    ${S.confirm === "reset"
      ? `<label class="meta" for="resettext">Scrivi <b>AZZERA</b> per confermare:</label>
         <div class="manage-row"><input class="field" id="resettext" value="${esc(S.resetText)}" autocomplete="off">
         <button class="btn danger" id="reset-yes" data-act="reset" ${S.resetText.trim() === "AZZERA" && !S.busy ? "" : "disabled"}>Azzera e carica i giocatori di prova</button>
         <button class="btn" id="reset-no" data-act="cancel">Annulla</button></div>`
      : `<div class="manage-row"><button class="btn danger-o" id="reset-ask" data-act="ask" data-key="reset">Azzera i dati…</button></div>`}
  </div>`;
  return h;
}

/* ---------- Admin: Utenti ---------- */
function usersHTML() {
  const list = S.users.slice().sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
  let h = `<div class="sec-head"><h2>Utenti</h2><span class="meta num">${list.length} utenti · ${S.admins.size + 1} amministratori</span></div>
  <p class="note">Eliminare un utente cancella i suoi voti. Se la persona rientra con Google, ricompare come nuovo utente senza voti.</p>
  <div class="acc-list">`;
  if (!list.length) h += `<div class="empty">Nessun utente registrato.</div>`;
  for (const u of list) {
    const sup = (u.email || "").toLowerCase() === SUPER_ADMIN;
    const adm = sup || S.admins.has(u.id);
    const me = u.id === S.uid;
    const v = S.votes.get(u.id);
    const rated = v && v.ratings ? Object.keys(v.ratings).filter(pid => S.players.some(p => p.id === pid)).length : 0;
    h += `<div class="acc"><div class="who"><b>${esc(u.name || u.email)}</b>${sup ? ' <span class="pill adm">Amministratore principale</span>' : adm ? ' <span class="pill adm">Amministratore</span>' : ""}${me ? ' <span class="pill">Tu</span>' : ""}
      <small>${esc(u.email)} · ultimo accesso ${fmtDateTime(u.lastLogin)} · ha votato ${rated} giocator${rated === 1 ? "e" : "i"}</small></div>`;
    if (!sup && !me) {
      h += adm
        ? confirmBtns("rev-" + u.id, "Revoca amministratore", "unadmin", `data-uid="${u.id}"`)
        : `<button class="btn" id="prom-${u.id}" data-act="mkadmin" data-uid="${u.id}">Promuovi amministratore</button>`;
      h += confirmBtns("delu-" + u.id, "Elimina", "deluser", `data-uid="${u.id}"`);
    }
    h += `</div>`;
  }
  return h + `</div>`;
}

/* =========================================================
   Eventi
   ========================================================= */
document.addEventListener("click", e => {
  const nav = e.target.closest("[data-nav]");
  if (nav && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); go(nav.dataset.nav); return; }
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === "login") login();
  else if (a === "logout") signOut(auth);
  else if (a === "rate") rate(b.dataset.pid, b.dataset.k, Number(b.dataset.v));
  else if (a === "fvote") voteFormation(Number(b.dataset.i));
  else if (a === "ask") { S.confirm = b.dataset.key; render(); }
  else if (a === "cancel") { S.confirm = null; S.resetText = ""; render(); }
  else if (a === "toggle") {
    const i = S.sel.indexOf(b.dataset.pid);
    if (i >= 0) S.sel.splice(i, 1); else S.sel.push(b.dataset.pid);
    render();
  }
  else if (a === "sel-none") { S.sel = []; render(); }
  else if (a === "sel-all") { S.sel = S.players.map(p => p.id); render(); }
  else if (a === "publish") publishMatch();
  else if (a === "winner") { S.winner = b.dataset.v; render(); }
  else if (a === "record") recordResult();
  else if (a === "fmove") moveFinal(b.dataset.pid, b.dataset.to);
  else if (a === "fadd") { const pid = S.addPid; S.addPid = ""; if (pid) moveFinal(pid, b.dataset.to); }
  else if (a === "freset") { S.finalFrom = null; render(); }
  else if (a === "cancelmatch") cancelMatch(b.dataset.id);
  else if (a === "bulk") addPlayers(S.bulk.split(/\r?\n/));
  else if (a === "delplayer") removePlayer(b.dataset.pid);
  else if (a === "reset") resetTestData();
  else if (a === "mkadmin") setAdmin(b.dataset.uid, true);
  else if (a === "unadmin") setAdmin(b.dataset.uid, false);
  else if (a === "deluser") deleteUser(b.dataset.uid);
});
$view.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.act === "rename") renamePlayer(t.dataset.pid, t.value);
  else if (t.dataset.act === "played") { S.played = Number(t.dataset.i); render(); }
  else if (t.id === "addpid") { S.addPid = t.value; render(); }
});
$view.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "newname") S.newName = t.value;
  else if (t.id === "bulk") S.bulk = t.value;
  else if (t.id === "resettext") { S.resetText = t.value; render(); }
});
$view.addEventListener("submit", e => {
  if (e.target.id === "addform") { e.preventDefault(); addPlayers([S.newName]); }
});

S.view = readView();
render();
