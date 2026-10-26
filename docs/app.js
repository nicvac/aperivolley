import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, SUPER_ADMIN, SKILLS, toRelative } from "./shared.js";

/* =========================================================
   Configurazione
   ========================================================= */
const FALLBACK = 3;          // valore usato dove nessuno ha ancora votato
const MIN_SEL = 4, MAX_SEL = 20;
const PTS_WIN = 1, PTS_PLAYED = 1;   // classifica: 1 per vittoria + 1 per presenza (vittoria = 2, sconfitta = 1)

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
  genN: 20,
  voteSort: "all", voteOrder: null, voteStale: true, reorderTimer: null,
  sel: [], draft: null, played: null, winner: null, finalA: null, finalB: null, finalFrom: null, addPid: "",
  confirm: null, busy: false, newName: "", bulk: "",
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
  if (S.reorderTimer) { clearTimeout(S.reorderTimer); S.reorderTimer = null; }
  S.voteStale = true;
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
    if (!S.reorderTimer) S.voteStale = true;
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(doc(db, "votes", uid), snap => {
    if (!S.dirty && !S.saving) { S.my = clone(snap.exists() ? snap.data().ratings : {}); if (!S.reorderTimer) S.voteStale = true; }
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
  clearTimeout(S.reorderTimer);
  S.reorderTimer = setTimeout(applyReorder, 2000);   // la scheda resta ferma 2 s, poi si ricolloca
  render();
}

/* ---------- Ordinamento della vista Vota (sui voti personali di chi guarda) ---------- */
function myOverall(pid) {
  const r = S.my[pid] || {};
  const vals = SKILLS.map(({ k }) => Number(r[k])).filter(v => v >= 1 && v <= 5);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function computeVoteOrder() {
  const key = p => S.voteSort === "all" ? myOverall(p.id) : (Number((S.my[p.id] || {})[S.voteSort]) || null);
  const desc = (a, b) => (a == null) - (b == null) || (b ?? 0) - (a ?? 0);   // non votati in fondo
  return S.players.slice().sort((a, b) =>
    desc(key(a), key(b)) || desc(myOverall(a.id), myOverall(b.id)) || byName(a, b)
  ).map(p => p.id);
}
function currentVoteOrder() {
  const ids = new Set(S.players.map(p => p.id));
  if (S.voteStale || !S.voteOrder) { S.voteOrder = computeVoteOrder(); S.voteStale = false; }
  const order = S.voteOrder.filter(id => ids.has(id));
  S.players.forEach(p => { if (!order.includes(p.id)) order.push(p.id); });   // giocatori nuovi in coda
  return order;
}
// Ricollocazione animata (tecnica FLIP): misura, riordina, poi fa scivolare le schede
function applyReorder() {
  clearTimeout(S.reorderTimer); S.reorderTimer = null;
  if (S.view !== "vota") { S.voteStale = true; return; }
  const before = new Map([...document.querySelectorAll(".vcard")].map(e => [e.dataset.pid, e.getBoundingClientRect()]));
  S.voteOrder = computeVoteOrder(); S.voteStale = false;
  render();
  const moved = [];
  document.querySelectorAll(".vcard").forEach(e => {
    const b = before.get(e.dataset.pid); if (!b) return;
    const a = e.getBoundingClientRect();
    const dx = b.left - a.left, dy = b.top - a.top;
    if (!dx && !dy) return;
    e.style.transition = "none";
    e.style.transform = `translate(${dx}px, ${dy}px)`;
    e.style.zIndex = "2";
    moved.push(e);
  });
  if (!moved.length) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    moved.forEach(e => {
      e.style.transition = "transform .7s cubic-bezier(.2,.75,.2,1)";
      e.style.transform = "";
      e.addEventListener("transitionend", () => { e.style.transition = ""; e.style.zIndex = ""; }, { once: true });
    });
  }));
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
     meno del necessario la soglia si allarga di 0,05 alla volta.
  3. A parità di ruoli decide il costo generale:
     0,4 × Δ media globale + 0,4 × Δ medio tra le skill + 0,2 × Δ skill più sbilanciata.
*/
const ROLE_GATE = 0.25;
const TOP_PER_ROLE = 2;
const r1 = x => Math.round(x * 10) / 10;
// Equilibrio in percentuale, lineare: squilibrio x in stelle (0..4) → 100·(4 − x)/4
const balPct = x => Math.max(0, Math.min(100, Math.round(100 * (4 - x) / 4)));
const BAL_SCALE = 2;   // versione della scala salvata nelle formazioni (2 = percentuale lineare)

// Valori di un giocatore (con FALLBACK dove manca il voto)
function playerVals(avg, pid) {
  const K = SKILLS.length;
  return (avg[pid] || []).map(a => a == null ? FALLBACK : a).concat(Array(K).fill(FALLBACK)).slice(0, K);
}

// Statistiche di una divisione qualsiasi (anche squadre di dimensioni diverse)
function evaluate(Aids, Bids, avg) {
  const K = SKILLS.length;
  const va = Aids.map(id => playerVals(avg, id)), vb = Bids.map(id => playerVals(avg, id));
  const mean = (vs, j) => vs.length ? vs.reduce((s, v) => s + v[j], 0) / vs.length : 0;
  const mA = SKILLS.map((_, j) => mean(va, j)), mB = SKILLS.map((_, j) => mean(vb, j));
  const dS = mA.map((v, j) => Math.abs(v - mB[j]));
  const gA = mA.reduce((x, y) => x + y, 0) / K, gB = mB.reduce((x, y) => x + y, 0) / K;
  const dG = Math.abs(gA - gB);
  const cost = 0.4 * dG + 0.4 * (dS.reduce((x, y) => x + y, 0) / K) + 0.2 * Math.max(...dS);
  const top = Math.max(1, Math.min(TOP_PER_ROLE, va.length, vb.length));
  let role = 0;
  for (let j = 0; j < K; j++) {
    const sa = va.map(v => v[j]).sort((x, y) => y - x), sb = vb.map(v => v[j]).sort((x, y) => y - x);
    let g = 0;
    for (let t = 0; t < top; t++) g += Math.abs((sa[t] ?? 0) - (sb[t] ?? 0));
    role += g / top;
  }
  role /= K;
  return { mA, mB, gA, gB, dG, cost, role };
}

// Formazione nel formato pubblicato (solo medie di squadra arrotondate)
function toFormation(Aids, Bids, avg) {
  const e = evaluate(Aids, Bids, avg);
  const statsOf = m => Object.fromEntries(SKILLS.map(({ k }, j) => [k, r1(m[j])]));
  return {
    A: sortIdsByName(Aids), B: sortIdsByName(Bids),
    sA: statsOf(e.mA), sB: statsOf(e.mB), gA: r1(e.gA), gB: r1(e.gB),
    req: balPct(e.role), eq: balPct(e.cost), bal: BAL_SCALE,
    _role: e.role, _cost: e.cost
  };
}

/*
  Criterio di formazione delle squadre
  1. Vincolo: si scartano le divisioni con differenza di media generale > ROLE_GATE
     (la soglia si allarga di 0,05 se restano meno divisioni di quelle richieste).
  2. Criterio principale, ruoli: per ogni skill si confrontano i due migliori di A
     con i due migliori di B (1° con 1°, 2° con 2°).
  3. Spareggio: 0,4 × Δ media globale + 0,4 × Δ medio skill + 0,2 × Δ skill più sbilanciata.
  Opzioni: cons = vincoli [{a, b, same}] da rispettare; exclude = chiavi già presenti; count = quante.
*/
const DRAFT_BATCH = 20;     // valore iniziale del campo "quante proposte"
const genCount = () => Math.max(1, Math.min(500, parseInt(S.genN, 10) || DRAFT_BATCH));
function satisfies(A, B, cons) {
  if (!cons || !cons.length) return true;
  const inA = new Set(A), all = new Set([...A, ...B]);
  return cons.every(c => !all.has(c.a) || !all.has(c.b) || ((inA.has(c.a) === inA.has(c.b)) === c.same));
}
// Chiave di una divisione indipendente dai nomi A/B: la squadra che contiene il giocatore "minore"
function splitKey(A, B) {
  const anchor = [...A, ...B].sort()[0];
  return (A.includes(anchor) ? A : B).slice().sort().join(",");
}
function generate(sel, avg, { cons = [], exclude = new Set(), count = genCount() } = {}) {
  const n = sel.length, h = n / 2;
  const res = [], idx = [0];
  const rec = start => {
    if (idx.length === h) {
      const set = new Set(idx);
      const A = idx.map(i => sel[i]), B = sel.filter((_, i) => !set.has(i));
      if (satisfies(A, B, cons) && !exclude.has(splitKey(A, B))) res.push({ A, B, ...evaluate(A, B, avg) });
      return;
    }
    for (let i = start; i <= n - (h - idx.length); i++) { idx.push(i); rec(i + 1); idx.pop(); }
  };
  rec(1);
  let gate = ROLE_GATE, pool = [];
  const want = Math.min(count, res.length);
  while (true) {
    pool = res.filter(r => r.dG <= gate + 1e-9);
    if (pool.length >= want || gate > 5) break;
    gate += 0.05;
  }
  pool.sort(rankCmp);
  return pool.slice(0, count).map(r => ({ A: r.A, B: r.B }));
}
const rk = x => Math.round(x * 100) / 100;    // ruoli quasi uguali = pari
function rankCmp(x, y) {
  const xr = x.role ?? x._role, yr = y.role ?? y._role, xc = x.cost ?? x._cost, yc = y.cost ?? y._cost;
  return rk(xr) - rk(yr) || xc - yc;
}

/* ---------- Bozza modificabile (solo nel browser dell'amministratore) ---------- */
// Proposte accumulabili: si generano a gruppi (anche con vincoli), si ordinano a mano,
// si filtrano, si spuntano quelle da pubblicare.
function newItem(f) {
  return { id: ++S.draft.nextId, A: f.A.slice(), B: f.B.slice(), oA: f.A.slice(), oB: f.B.slice(), pub: false, skills: S.draft.allSkills };
}
async function makeDraft() {
  const sel = S.sel.filter(id => S.players.some(p => p.id === id));
  if (sel.length < MIN_SEL || sel.length > MAX_SEL || sel.length % 2) return;
  S.busy = true; render();
  try {
    const snap = await getDocs(collection(db, "votes"));   // dati freschi
    S.votes = new Map(snap.docs.map(d => [d.id, d.data()]));
    const avg = playerAverages();
    S.draft = { sel, avg, items: [], cons: [], filterOn: false, nextId: 0, allSkills: true, highlight: new Set(), divN: 5, consA: "", consRel: "same", consB: "" };
    S.draft.items = generate(sel, avg).map(newItem);
    flash(`${S.draft.items.length} proposte pronte: sistemale, spunta quelle da pubblicare e pubblicale.`, "ok");
  } catch (e) { flash("Calcolo non riuscito: " + (e.code || "errore"), "warn"); }
  S.busy = false; render();
}
function addBatch() {
  const d = S.draft; if (!d) return;
  const exclude = new Set(d.items.map(it => splitKey(it.A, it.B)));
  const fresh = generate(d.sel, d.avg, { cons: d.cons, exclude }).map(newItem);
  d.items.push(...fresh);
  flash(fresh.length ? `Aggiunte ${fresh.length} proposte${d.cons.length ? " che rispettano i vincoli" : ""}.` : "Nessuna nuova proposta trovata con questi vincoli.", fresh.length ? "ok" : "warn");
  render();
}
const dItem = id => S.draft && S.draft.items.find(it => it.id === id);
const visibleItems = () => S.draft.filterOn ? S.draft.items.filter(it => satisfies(it.A, it.B, S.draft.cons)) : S.draft.items;
function draftMove(id, pid) {
  const it = dItem(id); if (!it) return;
  if (it.A.includes(pid)) { it.A = it.A.filter(x => x !== pid); it.B.push(pid); }
  else if (it.B.includes(pid)) { it.B = it.B.filter(x => x !== pid); it.A.push(pid); }
  render();
}
function draftReset(id) { const it = dItem(id); it.A = it.oA.slice(); it.B = it.oB.slice(); render(); }
function draftDrop(id) { S.draft.items = S.draft.items.filter(it => it.id !== id); S.draft.highlight.delete(id); S.confirm = null; render(); }
// Sposta una proposta prima/dopo la proposta visibile adiacente
function draftShift(id, dir) {
  const items = S.draft.items, vis = visibleItems();
  const vi = vis.findIndex(it => it.id === id), other = vis[vi + dir];
  if (!other) return;
  const i = items.findIndex(it => it.id === id), j = items.findIndex(it => it.id === other.id);
  [items[i], items[j]] = [items[j], items[i]];
  render();
}
function draftSortBalance() {
  const d = S.draft;
  d.items.sort((x, y) => rankCmp(toFormation(x.A, x.B, d.avg), toFormation(y.A, y.B, d.avg)));
  render();
}
// Distanza tra due proposte = giocatori che cambiano squadra (ignorando lo scambio A/B)
function splitDistance(x, y) {
  const all = [...new Set([...x.A, ...x.B, ...y.A, ...y.B])];
  const xa = new Set(x.A), ya = new Set(y.A);
  const diff = all.filter(p => xa.has(p) !== ya.has(p)).length;
  return Math.min(diff, all.length - diff);
}
// Le N proposte più diverse tra loro (massimizza la distanza minima, scelta golosa)
function draftDiverse() {
  const d = S.draft, vis = visibleItems(), N = Math.max(2, Math.min(d.divN | 0, vis.length));
  d.highlight = new Set();
  if (vis.length < 2) { render(); return; }
  let best = [0, 1], bd = -1;
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
    const dd = splitDistance(vis[i], vis[j]); if (dd > bd) { bd = dd; best = [i, j]; }
  }
  const chosen = [...best];
  while (chosen.length < N) {
    let bi = -1, bm = -1;
    vis.forEach((it, i) => {
      if (chosen.includes(i)) return;
      const m = Math.min(...chosen.map(c => splitDistance(it, vis[c])));
      if (m > bm) { bm = m; bi = i; }
    });
    if (bi < 0) break;
    chosen.push(bi);
  }
  chosen.forEach(i => d.highlight.add(vis[i].id));
  flash(`Evidenziate le ${chosen.length} proposte più diverse tra loro.`, "ok");
  render();
}
const draftPublishable = () => S.draft && S.draft.items.filter(it => it.pub);
const draftValid = () => { const p = draftPublishable(); return p && p.length >= 1 && p.every(it => it.A.length === it.B.length && it.A.length > 0); };

async function publishMatch() {
  if (!draftValid()) return;
  S.busy = true; render();
  try {
    const { sel, avg } = S.draft;
    const formations = draftPublishable().map(it => toFormation(it.A, it.B, avg))      // nell'ordine scelto a mano
      .map(({ _role, _cost, ...f }) => ({ ...f, ...toRelative(f) }));                 // nel database solo percentuali
    const ref = doc(collection(db, "matches"));
    const b = writeBatch(db);
    b.set(ref, { status: "voting", createdAt: Date.now(), selected: sel, formations, createdBy: S.user.email || "" });
    b.set(doc(db, "config", "state"), { currentMatch: ref.id, updatedAt: Date.now() });
    await b.commit();
    S.sel = []; S.draft = null; S.played = null; S.winner = null;
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
   Immagine della formazione (Copia / Condividi)
   html-to-image ridisegna la scheda così com'è a schermo e la trasforma in PNG.
   - telefono: menu Condividi del sistema (es. WhatsApp)
   - computer: copia negli appunti (poi Ctrl+V nella chat)
   - altrimenti: scarica il file PNG
   ========================================================= */
const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 7.5 12 3l4.5 4.5"/><path d="M9 10H7a2.5 2.5 0 0 0-2.5 2.5v6A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 17 10h-2"/></svg>';
const H2I_URL = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js";
const CAN_SHARE_FILES = (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([""], "x.png", { type: "image/png" })] })); }
  catch (_) { return false; }
})();
const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;
const CAN_COPY = !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
const SHOT_MODE = CAN_SHARE_FILES && TOUCH ? "share" : CAN_COPY ? "copy" : CAN_SHARE_FILES ? "share" : "download";
let h2iPromise = null, shotBusy = null, pendingShot = null;

function loadH2I() {
  if (window.htmlToImage) return Promise.resolve();
  if (!h2iPromise) h2iPromise = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = H2I_URL; sc.onload = res;
    sc.onerror = () => { h2iPromise = null; rej(new Error("Libreria per le immagini non caricata")); };
    document.head.appendChild(sc);
  });
  return h2iPromise;
}
function shotLabel(key) {
  if (shotBusy === key) return "Preparo…";
  if (pendingShot && pendingShot.key === key) return "Condividi ora";
  return SHOT_MODE === "share" ? "Condividi" : SHOT_MODE === "copy" ? "Copia immagine" : "Scarica immagine";
}
// Icona Condividi da mettere in alto a destra di un riquadro con classe "has-shot"
function shotBtn(key) {
  const lbl = shotLabel(key);
  return `<button class="shot-btn no-shot${shotBusy === key ? " busy" : ""}${pendingShot && pendingShot.key === key ? " ready" : ""}" id="sh-${key}" data-act="shot" data-key="${key}" title="${lbl}" aria-label="${lbl}" ${shotBusy === key ? "disabled" : ""}>${SHARE_ICON}</button>`;
}
async function makeShot(elId) {
  await loadH2I();
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const el = document.getElementById(elId);
  if (!el) throw new Error("Riquadro non trovato");
  // le righe di tabella escluse (es. giocatori a 0 punti) accorciano l'immagine
  const cut = [...el.querySelectorAll("tr.no-shot, .rrow.no-shot")].reduce((t, r) => t + r.offsetHeight, 0);
  const opts = {
    pixelRatio: Math.max(2, window.devicePixelRatio || 1),
    backgroundColor: getComputedStyle(el).backgroundColor,
    width: el.offsetWidth, height: el.offsetHeight - cut,
    style: { margin: "0" },
    filter: n => !(n.classList && n.classList.contains("no-shot"))   // esclude pulsanti, barre voti, righe a 0 punti…
  };
  await window.htmlToImage.toBlob(el, opts);          // primo passaggio: Safari carica i caratteri
  const blob = await window.htmlToImage.toBlob(el, opts);
  if (!blob) throw new Error("Immagine vuota");
  return blob;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
// Bersagli condivisibili: formazione N ("f0", "f1"…) e classifica ("rank")
function shotTarget(key) {
  if (key === "rank") return { elId: "rank-card", name: "aperivolley-classifica.png", title: "Classifica AperiVolley" };
  const i = Number(key.slice(1));
  return { elId: "form-" + i, name: `aperivolley-formazione-${i + 1}.png`, title: `Formazione ${i + 1}` };
}
async function shoot(key) {
  const { elId, name, title } = shotTarget(key);
  // secondo tocco dopo un blocco del browser: condivide l'immagine già pronta
  if (pendingShot && pendingShot.key === key) {
    const f = pendingShot.file; pendingShot = null; render();
    try { await navigator.share({ files: [f], title }); }
    catch (e) { if (e.name !== "AbortError") { downloadBlob(f, name); flash("Condivisione non disponibile: immagine scaricata.", "warn"); } }
    return;
  }
  shotBusy = key; render();
  try {
    if (SHOT_MODE === "copy") {
      // la promessa va passata subito a ClipboardItem: Safari lo richiede
      const blobP = makeShot(elId);
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
        flash("Immagine copiata: incollala nella chat (Ctrl+V o Cmd+V).", "ok");
      } catch (e) {
        downloadBlob(await blobP, name);
        flash("Copia non consentita dal browser: immagine scaricata.", "warn");
      }
    } else if (SHOT_MODE === "share") {
      const file = new File([await makeShot(elId)], name, { type: "image/png" });
      try { await navigator.share({ files: [file], title }); }
      catch (e) {
        if (e.name === "NotAllowedError") { pendingShot = { key, file }; flash("Immagine pronta: tocca di nuovo «Condividi ora».", "ok"); }
        else if (e.name !== "AbortError") { downloadBlob(file, name); flash("Condivisione non disponibile: immagine scaricata.", "warn"); }
      }
    } else {
      downloadBlob(await makeShot(elId), name);
      flash("Immagine scaricata.", "ok");
    }
  } catch (e) { flash("Immagine non creata: " + (e.message || "errore"), "warn"); }
  shotBusy = null; render();
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
  partita: "Scegli i convocati, genera le proposte, sistemale e pubblicale. Dopo la partita inserisci le formazioni definitive e la squadra vincitrice.",
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
  const byId = new Map(S.players.map(p => [p.id, p]));
  const sorts = [["all", "Complessivo"], ...SKILLS.map(({ k, l }) => [k, l])];
  let h = `<div class="sec-head"><h2>Vota le skill</h2><span class="meta num">Completati ${done} su ${S.players.length}</span></div>
  <div class="sortbar" role="group" aria-label="Ordina per">
    <span class="meta">Ordina per</span>
    ${sorts.map(([k, l]) => `<button class="sortchip" id="vs-${k}" data-act="vsort" data-k="${k}" aria-pressed="${S.voteSort === k}">${l}</button>`).join("")}
  </div>
  <p class="note">L'ordine segue i tuoi voti, dal più alto al più basso; a parità conta il tuo giudizio complessivo. Chi non hai ancora votato è in fondo.</p>
  <div class="grid">`;
  for (const id of currentVoteOrder()) {
    const p = byId.get(id); if (!p) continue;
    const mine = S.my[p.id] || {};
    const n = SKILLS.filter(({ k }) => mine[k]).length;
    h += `<article class="card vcard" data-pid="${p.id}">
      <div class="card-h"><h3>${esc(p.name)}</h3><span class="pill ${n === SKILLS.length ? "ok" : n ? "part" : ""} num">${n}/${SKILLS.length}</span></div>`;
    const shown = S.voteSort === "all" ? SKILLS : SKILLS.filter(({ k }) => k === S.voteSort);   // con una skill scelta si vede solo quella
    for (const { k, l } of shown) {
      h += `<div class="skill${S.voteSort === k ? " sorted" : ""}"><span class="lbl">${l}</span><div class="stars" role="group" aria-label="${l}">`;
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
    <div class="team-h"><h4>Squadra ${side}</h4><div class="tg num">${dec(g)}<small> totale</small></div></div>
    <ul class="plist">${sortIdsByName(ids).map(id => `<li>${esc(pName(id))}</li>`).join("")}</ul>
    <div class="tstats">${statRows(stats)}</div>
  </section>`;
}
const eqClass = e => e >= 95 ? "g" : e >= 90 ? "w" : "b";      // verde ≥ 95% · giallo 90–94% · rosso < 90%
const balHTML = f => `<span class="bal"><span class="bal-lbl">Equilibrio:</span>${f.req != null ? `<span class="eq ${eqClass(f.req)} num" title="Equilibrio dei ruoli: i migliori di ogni skill sono divisi tra le squadre">ruoli ${f.req}%</span>` : ""}<span class="eq ${eqClass(f.eq)} num" title="Equilibrio di forza: le squadre si equivalgono">forza ${f.eq}%</span></span>`;
const dec = x => ((Number(x) || 0) / 10).toFixed(1).replace(".", ",");   // 100% → 10,0

const statRows = stats => SKILLS.map(({ k, l }) => `<div class="ts"><span class="lbl">${l}</span><div class="track"><b style="width:${stats[k] || 0}%"></b></div><span class="num v">${dec(stats[k])}</span></div>`).join("");

function formationsHTML() {
  const m = currentMatch();
  if (m) loadH2I().catch(() => { });
  if (!m) return `<div class="empty">Nessuna partita in programma. Quando gli organizzatori scelgono i convocati, qui trovi le formazioni da votare.</div>`;
  const counts = m.formations.map((_, i) => [...S.fvotes.values()].filter(c => c === i).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const mine = S.fvotes.get(S.uid);
  let h = `<div class="sec-head"><h2>Formazioni</h2><span class="meta num">Partita del ${fmtDate(m.createdAt)} · ${m.selected.length} convocati · ${total} vot${total === 1 ? "o" : "i"}</span></div>
  <p class="note">Le formazioni sono nell'ordine scelto dagli organizzatori. <b>Equilibrio</b>: <b>ruoli</b> dice quanto sono divisi tra le due squadre i migliori di ogni skill (per esempio i due attaccanti più forti uno per parte), <b>forza</b> quanto le squadre si equivalgono nel complesso; 100% = perfetto, verde dal 95%, giallo dal 90%, rosso sotto. Totali e skill sono su 10 e relativi: la skill più alta tra le due squadre vale 10 e le altre sono in proporzione; nel totale la squadra più forte vale 10.</p>
  <div class="variants">`;
  m.formations.forEach((f, i) => {
    const pct = total ? Math.round(counts[i] / total * 100) : 0;
    const chosen = mine === i;
    h += `<article class="variant has-shot${chosen ? " chosen" : ""}" id="form-${i}">
      ${shotBtn("f" + i)}
      <div class="v-head">
        <h3>Formazione ${i + 1}</h3>
        ${balHTML(f)}
        ${chosen ? `<span class="mine-badge no-shot">✓ Il tuo voto</span>` : ""}
        <span class="vh-break" aria-hidden="true"></span>
        <div class="vbar no-shot" title="${counts[i]} voti"><div class="track"><b style="width:${pct}%"></b></div><span class="vcount num"><b>${counts[i]}</b> vot${counts[i] === 1 ? "o" : "i"}${total ? ` · ${pct}%` : ""}</span></div>
        <button class="btn vote-btn no-shot ${chosen ? "primary" : ""}" id="fv-${i}" data-act="fvote" data-i="${i}" aria-pressed="${chosen}">${chosen ? "Votata ✓" : "Vota questa"}</button>

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
  const lastPlayed = Math.max(0, ...S.matches.filter(m => m.status === "played").map(m => m.playedAt || 0));
  const partite = `${played} partit${played === 1 ? "a" : "e"} giocat${played === 1 ? "a" : "e"}`;
  if (rows.some(r => r.pts > 0)) loadH2I().catch(() => { });
  let h = `<p class="note">Punti = ${PTS_WIN} × vittorie + ${PTS_PLAYED} × partite giocate: una partita vinta vale 2 punti, una persa 1. Chi non ha ancora giocato ha 0 punti. A parità di punti conta la percentuale di vittorie, poi il numero di partite. Nell'immagine da condividere compaiono solo i giocatori con almeno un punto.</p>
  <section class="rank-card has-shot" id="rank-card">
    ${rows.some(r => r.pts > 0) ? shotBtn("rank") : ""}
    <div class="rank-head"><h2>Classifica</h2><span class="meta num">${partite}${lastPlayed ? ` · aggiornata al ${fmtDate(lastPlayed)}` : ""}</span></div>
    <div class="rank-grid" role="table" aria-label="Classifica">
      <div class="rrow rhead" role="row"><span role="columnheader">#</span><span role="columnheader">Giocatore</span><span class="r" role="columnheader">Punti</span><span class="r" role="columnheader">Giocate</span><span class="r" role="columnheader">Vinte</span><span class="r" role="columnheader">% vitt.</span></div>`;
  for (const r of rows) {
    h += `<div class="rrow${r.pos <= 3 && r.pts > 0 ? " podium" : ""}${r.g === 0 ? " zero" : ""}${r.pts === 0 ? " no-shot" : ""}" role="row"><span class="num" role="cell">${r.pos}</span><span class="nm" role="cell">${esc(r.name)}</span><span class="r num pts" role="cell">${r.pts}</span><span class="r num" role="cell">${r.g}</span><span class="r num" role="cell">${r.v}</span><span class="r num" role="cell">${r.g ? Math.round(r.pct * 100) + "%" : "–"}</span></div>`;
  }
  return h + `</div></section>`;
}

/* ---------- Admin: Partita ---------- */
function draftTeam(id, side, ids, stats, g, showSkills) {
  return `<section class="team ${side}">
    <div class="team-h"><h4>Squadra ${side} <small class="meta num">(${ids.length})</small></h4><div class="tg num">${dec(g)}<small> totale</small></div></div>
    <ul class="flist">${sortIdsByName(ids).map(pid => `<li><span>${esc(pName(pid))}</span><button class="btn sm" id="dm-${id}-${pid}" data-act="dmove" data-id="${id}" data-pid="${pid}" title="Sposta nella squadra ${side === "A" ? "B" : "A"}">→ ${side === "A" ? "B" : "A"}</button></li>`).join("")}</ul>
    ${showSkills ? `<div class="tstats">${statRows(stats)}</div>` : ""}
  </section>`;
}
function draftHTML() {
  const d = S.draft, vis = visibleItems();
  const nPub = d.items.filter(it => it.pub).length;
  const opts = (sel) => `<option value="">Giocatore…</option>` + sortIdsByName(d.sel).map(pid => `<option value="${pid}" ${sel === pid ? "selected" : ""}>${esc(pName(pid))}</option>`).join("");
  let h = `<div class="sec-head"><h2>Proposte da sistemare</h2><span class="meta num">${d.sel.length} convocati · ${d.items.length} propost${d.items.length === 1 ? "a" : "e"}${d.filterOn ? ` · ${vis.length} visibili col filtro` : ""} · ${nPub} da pubblicare · bozza visibile solo a te</span></div>

  <div class="card tools">
    <strong>Vincoli</strong>
    <div class="manage-row">
      <select class="field" id="cons-a" aria-label="Primo giocatore">${opts(d.consA)}</select>
      <select class="field rel" id="cons-rel" aria-label="Relazione"><option value="same" ${d.consRel === "same" ? "selected" : ""}>in squadra con</option><option value="diff" ${d.consRel === "diff" ? "selected" : ""}>non in squadra con</option></select>
      <select class="field" id="cons-b" aria-label="Secondo giocatore">${opts(d.consB)}</select>
      <button class="btn" id="cons-add" data-act="consadd" ${d.consA && d.consB && d.consA !== d.consB ? "" : "disabled"}>Aggiungi vincolo</button>
    </div>
    ${d.cons.length ? `<div class="chips">${d.cons.map((c, i) => `<span class="cons-chip">${esc(pName(c.a))} <b>${c.same ? "con" : "non con"}</b> ${esc(pName(c.b))}<button class="linkbtn" id="cons-rm-${i}" data-act="consrm" data-i="${i}" aria-label="Rimuovi vincolo">✕</button></span>`).join("")}</div>` : `<span class="meta">Nessun vincolo: tutte le condizioni vanno rispettate insieme (E).</span>`}
    <div class="manage-row">
      <span class="gen-ctl"><button class="btn primary" id="gen-more" data-act="genmore">Genera altre</button><input class="field num" type="number" id="gen-n" min="1" max="500" value="${esc(S.genN)}" aria-label="Quante proposte"><span class="meta">proposte${d.cons.length ? " con questi vincoli" : ""}</span></span>
      <label class="check"><input type="checkbox" id="filter-on" ${d.filterOn ? "checked" : ""} ${d.cons.length ? "" : "disabled"}> Mostra solo le proposte che rispettano i vincoli</label>
    </div>
    <strong>Elenco</strong>
    <div class="manage-row">
      <button class="btn" id="sort-bal" data-act="sortbal">Ordina per equilibrio</button>
      <button class="btn" id="skills-all" data-act="skillsall">${d.allSkills ? "Nascondi skill su tutte" : "Mostra skill su tutte"}</button>
      <span class="div-ctl"><label for="div-n" class="meta">Le</label><input class="field num" type="number" id="div-n" min="2" max="${Math.max(2, vis.length)}" value="${d.divN}"><button class="btn" id="div-go" data-act="diverse" ${vis.length >= 2 ? "" : "disabled"}>più diverse tra loro</button></span>
      ${d.highlight.size ? `<button class="btn" id="hl-pub" data-act="hlpub">Spunta le evidenziate</button><button class="btn" id="hl-clear" data-act="hlclear">Togli evidenziazione</button>` : ""}
    </div>
  </div>
  <p class="note">Sposta i giocatori con → A / → B, riordina le proposte con ↑ ↓ e spunta <b>Pubblica</b> su quelle da mettere ai voti: si pubblicano nell'ordine dell'elenco. Totali e skill sono su 10; l'equilibrio (ruoli e forza) è in percentuale: verde dal 95%, giallo dal 90%, rosso sotto. Le squadre da pubblicare devono avere lo stesso numero di giocatori. Se ricarichi la pagina la bozza si perde.</p>
  <div class="variants">`;
  if (!vis.length) h += `<div class="empty">Nessuna proposta rispetta i vincoli. Prova «Genera altre proposte» con questi vincoli.</div>`;
  vis.forEach((it, vi) => {
    const f = toFormation(it.A, it.B, d.avg);
    const changed = !sameSet(it.A, it.oA) || !sameSet(it.B, it.oB);
    const uneven = it.A.length !== it.B.length;
    const pos = d.items.indexOf(it) + 1;
    h += `<article class="variant${uneven ? " uneven" : ""}${it.pub ? " topub" : ""}${d.highlight.has(it.id) ? " hl" : ""}">
      <div class="v-head">
        <label class="check pubcheck"><input type="checkbox" id="pub-${it.id}" data-act="dpub" data-id="${it.id}" ${it.pub ? "checked" : ""}> Pubblica</label>
        <h3>Proposta ${pos}</h3>
        ${balHTML(f)}
        ${d.highlight.has(it.id) ? `<span class="pill hl-pill">Più diversa</span>` : ""}
        ${uneven ? `<span class="pill part">Squadre dispari: ${it.A.length} contro ${it.B.length}</span>` : changed ? `<span class="pill adm">Modificata</span>` : ""}
        <span class="v-tools">
          <button class="btn sm" id="up-${it.id}" data-act="dup" data-id="${it.id}" ${vi === 0 ? "disabled" : ""} aria-label="Sposta su">↑</button>
          <button class="btn sm" id="dn-${it.id}" data-act="ddown" data-id="${it.id}" ${vi === vis.length - 1 ? "disabled" : ""} aria-label="Sposta giù">↓</button>
          <button class="btn sm" id="sk-${it.id}" data-act="dskills" data-id="${it.id}">${it.skills ? "Nascondi skill" : "Mostra skill"}</button>
          ${changed ? `<button class="btn sm" id="dr-${it.id}" data-act="dreset" data-id="${it.id}">Ripristina</button>` : ""}
          ${S.confirm === "drop-" + it.id
            ? `<button class="btn sm danger" id="dd-${it.id}" data-act="ddrop" data-id="${it.id}">Conferma</button><button class="btn sm" id="ddn-${it.id}" data-act="cancel">Annulla</button>`
            : `<button class="btn sm danger-o" id="dda-${it.id}" data-act="ask" data-key="drop-${it.id}">Scarta</button>`}
        </span>
      </div>
      ${(() => { const r = toRelative(f); return `<div class="teams">${draftTeam(it.id, "A", it.A, r.sA, r.gA, it.skills)}${draftTeam(it.id, "B", it.B, r.sB, r.gB, it.skills)}</div>`; })()}
    </article>`;
  });
  const valid = draftValid();
  h += `</div>
  <div class="manage-row" style="margin-top:16px">
    <button class="btn primary" id="publish" data-act="publish" ${valid && !S.busy ? "" : "disabled"}>${S.busy ? "Pubblicazione…" : `Pubblica ${nPub || ""} e apri la votazione`}</button>
    ${S.confirm === "draft-discard"
      ? `<button class="btn danger" id="dx-yes" data-act="ddiscard">Conferma</button><button class="btn" id="dx-no" data-act="cancel">Annulla</button>`
      : `<button class="btn" id="dx-ask" data-act="ask" data-key="draft-discard">Torna ai convocati</button>`}
    <span class="meta">${!nPub ? "Spunta «Pubblica» su almeno una proposta." : valid ? "" : "Riporta in pari le squadre delle proposte spuntate."}</span>
  </div>`;
  return h;
}

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
        <span><b>Formazione ${i + 1}</b> · ${counts[i]} vot${counts[i] === 1 ? "o" : "i"} · equilibrio: ruoli ${f.req != null ? f.req + "%" : "–"} · forza ${f.eq}%<br><small>A: ${sortIdsByName(f.A).map(pName).map(esc).join(", ")}<br>B: ${sortIdsByName(f.B).map(pName).map(esc).join(", ")}</small></span></label>`;
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
  } else if (S.draft) {
    h += draftHTML();
  } else {
    const sel = S.sel.filter(id => S.players.some(p => p.id === id)), n = sel.length;
    const ok = n >= MIN_SEL && n <= MAX_SEL && n % 2 === 0;
    const set = new Set(sel);
    const voters = S.votes.size;
    h += `<div class="sec-head"><h2>Nuova partita</h2><span class="count num ${n === 12 ? "okc" : ok ? "" : "badc"}">${n} / 12</span></div>
    <div class="bar"><button class="btn" id="sel-none" data-act="sel-none">Svuota</button><button class="btn" id="sel-all" data-act="sel-all">Seleziona tutti</button></div>
    <div class="chips">${S.players.map(p => `<button class="chip" id="ch-${p.id}" data-act="toggle" data-pid="${p.id}" aria-pressed="${set.has(p.id)}"><span class="dot"></span>${esc(p.name)}</button>`).join("")}</div>
    <div class="manage-row" style="margin-top:16px">
      <span class="gen-ctl"><button class="btn primary" id="gen" data-act="gendraft" ${ok && !S.busy ? "" : "disabled"}>${S.busy ? "Calcolo in corso…" : "Genera"}</button><input class="field num" type="number" id="gen-n" min="1" max="500" value="${esc(S.genN)}" aria-label="Quante proposte"><span class="meta">proposte</span></span>
      <span class="meta">${ok ? `Le proposte si calcolano dai voti di ${voters} person${voters === 1 ? "a" : "e"} (dove manca un voto si usa ${FALLBACK}). Prima di pubblicarle potrai modificarle.` : n % 2 ? "Serve un numero pari di convocati." : `Seleziona da ${MIN_SEL} a ${MAX_SEL} convocati.`}</span>
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
  h += `</div>`;
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
  else if (a === "vsort") { if (S.voteSort !== b.dataset.k) { S.voteSort = b.dataset.k; applyReorder(); } }
  else if (a === "fvote") voteFormation(Number(b.dataset.i));
  else if (a === "shot") shoot(b.dataset.key);
  else if (a === "ask") { S.confirm = b.dataset.key; render(); }
  else if (a === "cancel") { S.confirm = null; render(); }
  else if (a === "toggle") {
    const i = S.sel.indexOf(b.dataset.pid);
    if (i >= 0) S.sel.splice(i, 1); else S.sel.push(b.dataset.pid);
    render();
  }
  else if (a === "sel-none") { S.sel = []; render(); }
  else if (a === "sel-all") { S.sel = S.players.map(p => p.id); render(); }
  else if (a === "publish") publishMatch();
  else if (a === "gendraft") makeDraft();
  else if (a === "dmove") draftMove(Number(b.dataset.id), b.dataset.pid);
  else if (a === "dreset") draftReset(Number(b.dataset.id));
  else if (a === "ddrop") draftDrop(Number(b.dataset.id));
  else if (a === "dup") draftShift(Number(b.dataset.id), -1);
  else if (a === "ddown") draftShift(Number(b.dataset.id), 1);
  else if (a === "dskills") { const it = dItem(Number(b.dataset.id)); it.skills = !it.skills; render(); }
  else if (a === "skillsall") { const d = S.draft; d.allSkills = !d.allSkills; d.items.forEach(it => it.skills = d.allSkills); render(); }
  else if (a === "sortbal") draftSortBalance();
  else if (a === "genmore") addBatch();
  else if (a === "consadd") { const d = S.draft; if (d.consA && d.consB && d.consA !== d.consB) { d.cons.push({ a: d.consA, b: d.consB, same: d.consRel === "same" }); d.consA = d.consB = ""; } render(); }
  else if (a === "consrm") { const d = S.draft; d.cons.splice(Number(b.dataset.i), 1); if (!d.cons.length) d.filterOn = false; render(); }
  else if (a === "diverse") draftDiverse();
  else if (a === "hlpub") { S.draft.items.forEach(it => { if (S.draft.highlight.has(it.id)) it.pub = true; }); render(); }
  else if (a === "hlclear") { S.draft.highlight = new Set(); render(); }
  else if (a === "ddiscard") { S.draft = null; S.confirm = null; render(); }
  else if (a === "winner") { S.winner = b.dataset.v; render(); }
  else if (a === "record") recordResult();
  else if (a === "fmove") moveFinal(b.dataset.pid, b.dataset.to);
  else if (a === "fadd") { const pid = S.addPid; S.addPid = ""; if (pid) moveFinal(pid, b.dataset.to); }
  else if (a === "freset") { S.finalFrom = null; render(); }
  else if (a === "cancelmatch") cancelMatch(b.dataset.id);
  else if (a === "bulk") addPlayers(S.bulk.split(/\r?\n/));
  else if (a === "delplayer") removePlayer(b.dataset.pid);
  else if (a === "mkadmin") setAdmin(b.dataset.uid, true);
  else if (a === "unadmin") setAdmin(b.dataset.uid, false);
  else if (a === "deluser") deleteUser(b.dataset.uid);
});
$view.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.act === "rename") renamePlayer(t.dataset.pid, t.value);
  else if (t.dataset.act === "played") { S.played = Number(t.dataset.i); render(); }
  else if (t.id === "addpid") { S.addPid = t.value; render(); }
  else if (t.dataset.act === "dpub") { const it = dItem(Number(t.dataset.id)); if (it) it.pub = t.checked; render(); }
  else if (t.id === "cons-a") { S.draft.consA = t.value; render(); }
  else if (t.id === "cons-b") { S.draft.consB = t.value; render(); }
  else if (t.id === "cons-rel") { S.draft.consRel = t.value; render(); }
  else if (t.id === "filter-on") { S.draft.filterOn = t.checked; render(); }
  else if (t.id === "gen-n") { S.genN = t.value; }
  else if (t.id === "div-n") { S.draft.divN = Math.max(2, parseInt(t.value, 10) || 2); }
});
$view.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "newname") S.newName = t.value;
  else if (t.id === "bulk") S.bulk = t.value;
});
$view.addEventListener("submit", e => {
  if (e.target.id === "addform") { e.preventDefault(); addPlayers([S.newName]); }
});

S.view = readView();
render();
