import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, addDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- configurazione ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyAQE4EXaYxFgJHb_9iMGbtOGghIFQyGWqo",
  authDomain: "aperivolley.firebaseapp.com",
  projectId: "aperivolley",
  storageBucket: "aperivolley.firebasestorage.app",
  messagingSenderId: "785233193282",
  appId: "1:785233193282:web:ceba7bbbbab7757f0040db"
};
const ADMIN_EMAIL = "nicola.vacca@gmail.com";   // deve coincidere con firestore.rules

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const SKILLS = [
  { k: "ric", l: "Ricezione" },
  { k: "alz", l: "Alzata" },
  { k: "att", l: "Attacco" },
  { k: "mur", l: "Muro" }
];
const FALLBACK = 3;      // valore usato dove manca un voto
const MAX_SEL = 20;      // limite per l'enumerazione completa delle divisioni
const STEP = 4;          // varianti mostrate per volta
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z"/></svg>';

const S = {
  phase: "loading",            // loading | signedout | ready
  user: null, uid: null, isAdmin: false,
  tab: "roster",
  players: [], votes: new Map(), my: {}, dirty: false, saving: false, saveTimer: null,
  week: null, localSel: null, weekTimer: null, weekSaving: false,
  filter: "", sort: "name", manage: false, confirmDel: null, newName: "", bulk: "",
  shown: STEP, memoKey: "", memo: null, failed: "", loginErr: "",
  unsubs: []
};

const $view = document.getElementById("view");
const $status = document.getElementById("status");
const $tabs = document.getElementById("tabs");
const $userbar = document.getElementById("userbar");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = v => v == null ? "–" : v.toFixed(1);
const clone = o => JSON.parse(JSON.stringify(o || {}));
const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "it", { sensitivity: "base" });
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|; wv\)|Telegram/i.test(navigator.userAgent);

/* ---------- login ---------- */
async function login() {
  S.loginErr = "";
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const c = e && e.code;
    if (c === "auth/popup-blocked" || c === "auth/operation-not-supported-in-this-environment" || c === "auth/cancelled-popup-request") {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { S.loginErr = msgFor(e2); }
    } else if (c !== "auth/popup-closed-by-user") {
      S.loginErr = msgFor(e);
    }
    render();
  }
}
function msgFor(e) {
  const c = e && e.code;
  if (c === "auth/unauthorized-domain") return "Questo indirizzo non è autorizzato per l'accesso. Avvisa Nicola.";
  if (c === "auth/network-request-failed") return "Connessione assente. Controlla la rete e riprova.";
  return "Accesso non riuscito (" + (c || "errore") + "). Riprova, oppure apri la pagina in Chrome o Safari.";
}
getRedirectResult(auth).catch(e => { S.loginErr = msgFor(e); render(); });

onAuthStateChanged(auth, user => {
  S.unsubs.forEach(u => u()); S.unsubs = [];
  S.user = user; S.uid = user ? user.uid : null;
  S.isAdmin = !!(user && user.emailVerified && (user.email || "").toLowerCase() === ADMIN_EMAIL);
  S.players = []; S.votes = new Map(); S.my = {}; S.week = null; S.localSel = null; S.failed = "";
  if (!user) { S.phase = "signedout"; render(); return; }
  S.phase = "ready";
  subscribe();
  render();
});

function subscribe() {
  const onErr = e => {
    S.failed = e && e.code === "permission-denied"
      ? "Il database ha rifiutato la lettura: le regole di sicurezza non sono ancora pubblicate."
      : "Collegamento al database interrotto. Ricarica la pagina.";
    render();
  };
  S.unsubs.push(onSnapshot(collection(db, "players"), snap => {
    S.players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(collection(db, "votes"), snap => {
    S.votes = new Map(snap.docs.map(d => [d.id, d.data()]));
    if (!S.dirty && !S.saving) {
      const mine = S.votes.get(S.uid);
      S.my = clone(mine && mine.ratings);
    }
    render();
  }, onErr));
  S.unsubs.push(onSnapshot(doc(db, "week", "current"), snap => {
    S.week = snap.exists() ? snap.data() : null;
    if (S.isAdmin && !S.weekSaving && !S.weekTimer) S.localSel = null;
    render();
  }, onErr));
}

/* ---------- statistiche ---------- */
function computeStats() {
  const st = {};
  for (const p of S.players) st[p.id] = { sum: {}, cnt: {}, voters: 0 };
  const add = ratings => {
    for (const [pid, r] of Object.entries(ratings || {})) {
      const s = st[pid]; if (!s || !r) continue;
      let any = false;
      for (const { k } of SKILLS) {
        const v = Number(r[k]);
        if (Number.isInteger(v) && v >= 1 && v <= 5) { s.sum[k] = (s.sum[k] || 0) + v; s.cnt[k] = (s.cnt[k] || 0) + 1; any = true; }
      }
      if (any) s.voters++;
    }
  };
  for (const [vid, d] of S.votes) if (vid !== S.uid) add(d && d.ratings);
  if (S.uid) add(S.my);
  const out = {};
  for (const p of S.players) {
    const s = st[p.id], avg = {}; let tot = 0, n = 0;
    for (const { k } of SKILLS) {
      avg[k] = s.cnt[k] ? s.sum[k] / s.cnt[k] : null;
      if (avg[k] != null) { tot += avg[k]; n++; }
    }
    out[p.id] = { avg, overall: n ? tot / n : null, voters: s.voters, complete: n === SKILLS.length };
  }
  return out;
}

/* ---------- generazione squadre ---------- */
function generate(sel, stats) {
  const n = sel.length, h = n / 2;
  const vals = sel.map(pid => SKILLS.map(({ k }) => {
    const a = stats[pid] && stats[pid].avg[k];
    return a == null ? FALLBACK : a;
  }));
  const totAll = SKILLS.map((_, j) => vals.reduce((s, v) => s + v[j], 0));
  const res = [], idx = [0];   // il primo giocatore sta sempre in A: niente doppioni speculari
  const evalSplit = () => {
    const sA = SKILLS.map((_, j) => idx.reduce((s, i) => s + vals[i][j], 0));
    const mA = sA.map(v => v / h), mB = sA.map((v, j) => (totAll[j] - v) / h);
    const dS = mA.map((v, j) => Math.abs(v - mB[j]));
    const gA = mA.reduce((a, b) => a + b, 0) / SKILLS.length;
    const gB = mB.reduce((a, b) => a + b, 0) / SKILLS.length;
    const dG = Math.abs(gA - gB);
    const dAvg = dS.reduce((a, b) => a + b, 0) / dS.length;
    const dMax = Math.max(...dS);
    const cost = 0.4 * dG + 0.4 * dAvg + 0.2 * dMax;
    res.push({ a: idx.slice(), cost, dG, dAvg, dMax, dS, mA, mB, gA, gB, eq: Math.max(0, Math.round(100 * (1 - cost))) });
  };
  const rec = start => {
    if (idx.length === h) { evalSplit(); return; }
    for (let i = start; i <= n - (h - idx.length); i++) { idx.push(i); rec(i + 1); idx.pop(); }
  };
  rec(1);
  res.sort((x, y) => x.cost - y.cost || x.dG - y.dG);
  return res.map(r => {
    const set = new Set(r.a);
    return { ...r, A: r.a.map(i => sel[i]), B: sel.filter((_, i) => !set.has(i)) };
  });
}

/* ---------- selezione della settimana ---------- */
function validIds(list) { const ids = new Set(S.players.map(p => p.id)); return list.filter(id => ids.has(id)); }
function currentSel() {
  if (S.localSel) return validIds(S.localSel);
  return validIds((S.week && S.week.selected) || []);
}
function setSel(list) {
  S.localSel = list; S.shown = STEP;
  if (S.isAdmin) { clearTimeout(S.weekTimer); S.weekTimer = setTimeout(saveWeek, 500); }
  render();
}
async function saveWeek() {
  if (S.weekSaving) { S.weekTimer = setTimeout(saveWeek, 400); return; }
  S.weekTimer = null; S.weekSaving = true;
  try { await setDoc(doc(db, "week", "current"), { selected: (S.localSel || []).slice(), updatedAt: Date.now() }); }
  catch (e) { flash("Selezione non salvata. Riprova.", "warn"); }
  S.weekSaving = false;
}

/* ---------- voti ---------- */
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
    flash("Voti salvati. Le medie si aggiornano per tutti.", "ok");
  } catch (e) {
    S.dirty = true;
    flash("Salvataggio non riuscito, riprovo tra poco.", "warn");
    S.saveTimer = setTimeout(saveVotes, 2500 + Math.random() * 1500);
  }
  S.saving = false;
  render();
}

/* ---------- gestione giocatori (solo admin) ---------- */
async function addPlayers(names) {
  const list = names.map(n => n.trim()).filter(Boolean);
  if (!list.length) return;
  const existing = new Set(S.players.map(p => (p.name || "").toLowerCase()));
  const fresh = list.filter(n => !existing.has(n.toLowerCase()));
  try {
    for (let i = 0; i < fresh.length; i += 400) {
      const b = writeBatch(db);
      fresh.slice(i, i + 400).forEach(name => b.set(doc(collection(db, "players")), { name, createdAt: Date.now() }));
      await b.commit();
    }
    S.newName = ""; S.bulk = "";
    const skipped = list.length - fresh.length;
    flash(`Aggiunti ${fresh.length} giocatori` + (skipped ? ` (${skipped} già presenti)` : "") + ".", "ok");
  } catch (e) { flash("Giocatori non aggiunti: controlla di essere entrato come " + ADMIN_EMAIL + ".", "warn"); }
  render();
}
async function renamePlayer(pid, name) {
  name = name.trim(); const p = S.players.find(x => x.id === pid);
  if (!name || !p || p.name === name) return;
  try { await updateDoc(doc(db, "players", pid), { name }); } catch (e) { flash("Nome non aggiornato.", "warn"); }
}
async function removePlayer(pid) {
  try { await deleteDoc(doc(db, "players", pid)); } catch (e) { flash("Giocatore non rimosso.", "warn"); }
  S.confirmDel = null; render();
}

/* ---------- messaggi ---------- */
let flashTimer = null, flashMsg = null;
function flash(msg, kind) {
  flashMsg = { msg, kind }; renderStatus();
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashMsg = null; renderStatus(); }, 3000);
}
function renderStatus() {
  if (S.phase !== "ready") { $status.hidden = true; return; }
  let msg, kind = "";
  if (flashMsg) { msg = flashMsg.msg; kind = flashMsg.kind; }
  else if (S.failed) { msg = S.failed; kind = "warn"; }
  else if (S.tab === "roster") msg = "Tocca le stelle per votare (tocca di nuovo la stessa stella per togliere il voto). Hai un voto per skill per ogni giocatore e puoi cambiarlo quando vuoi.";
  else msg = S.isAdmin ? "I convocati che scegli qui li vedono tutti." : "Convocati scelti da Nicola. Puoi provare altre combinazioni: restano solo sul tuo dispositivo.";
  $status.hidden = false;
  $status.className = "status" + (kind ? " " + kind : "");
  $status.textContent = msg;
}

/* ---------- render ---------- */
function render() {
  const ae = document.activeElement;
  const active = ae && ae.id;
  const keep = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") ? { v: ae.value, s: ae.selectionStart, e: ae.selectionEnd } : null;

  if (S.phase === "ready") {
    $tabs.hidden = false;
    $tabs.innerHTML = [["roster", "Roster"], ["squadre", "Squadre della settimana"]]
      .map(([t, l]) => `<button class="tab" role="tab" id="tab-${t}" data-tab="${t}" aria-selected="${S.tab === t}">${l}</button>`).join("");
    $userbar.hidden = false;
    $userbar.innerHTML = `<span>Entrato come <strong>${esc(S.user.email)}</strong>${S.isAdmin ? " · amministratore" : ""}</span><button class="linkbtn" id="logout" data-act="logout">Esci</button>`;
  } else { $tabs.hidden = true; $userbar.hidden = true; }
  renderStatus();

  if (S.phase === "loading") $view.innerHTML = `<div class="empty" style="margin-top:18px">Caricamento…</div>`;
  else if (S.phase === "signedout") $view.innerHTML = loginHTML();
  else {
    const stats = computeStats();
    $view.innerHTML = S.tab === "roster" ? rosterHTML(stats) : teamsHTML(stats);
  }

  if (active) {
    const el = document.getElementById(active);
    if (el) {
      if (keep && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.value = keep.v; try { el.setSelectionRange(keep.s, keep.e); } catch (_) { } }
      el.focus({ preventScroll: true });
    }
  }
}

function loginHTML() {
  return `<section class="gate">
    <h2>Vota i compagni</h2>
    <p>Entra con il tuo account Google per dare i voti da 1 a 5 stelle su ricezione, alzata, attacco e muro, vedere le medie di tutti e le squadre della settimana.</p>
    <button class="btn primary" id="login" data-act="login">Accedi con Google</button>
    ${S.loginErr ? `<p class="hint" style="color:var(--bad)">${esc(S.loginErr)}</p>` : ""}
    ${inAppBrowser ? `<p class="hint" style="color:var(--warn)">Sembra che tu abbia aperto il link dentro un'app (Instagram, Facebook, Telegram…). Se l'accesso non funziona, apri la pagina in Chrome o Safari.</p>` : ""}
    <p class="hint">Dal tuo account usiamo solo l'email, per riconoscere i tuoi voti.</p>
  </section>`;
}

function starsHTML(pid, k, mine) {
  let h = '<div class="stars" role="group" aria-label="Il tuo voto">';
  for (let v = 1; v <= 5; v++) {
    h += `<button class="star${v <= mine ? " on" : ""}" id="st-${pid}-${k}-${v}" data-act="rate" data-pid="${pid}" data-k="${k}" data-v="${v}" aria-label="${v} stell${v > 1 ? "e" : "a"}" aria-pressed="${v === mine}">${STAR}</button>`;
  }
  return h + "</div>";
}

function rosterHTML(stats) {
  let list = S.players.slice();
  const f = S.filter.trim().toLowerCase();
  if (f) list = list.filter(p => (p.name || "").toLowerCase().includes(f));
  if (S.sort === "avg") list.sort((a, b) => (stats[b.id].overall ?? -1) - (stats[a.id].overall ?? -1) || byName(a, b));
  else list.sort(byName);
  const ratedByMe = S.players.filter(p => S.my[p.id] && Object.keys(S.my[p.id]).length).length;

  let h = `<div class="bar">
    <div class="grow"><input class="field" id="filter" type="search" placeholder="Cerca giocatore" value="${esc(S.filter)}" aria-label="Cerca giocatore"></div>
    <div class="seg" role="group" aria-label="Ordina">
      <button id="sort-name" data-act="sort" data-v="name" aria-pressed="${S.sort === "name"}">A–Z</button>
      <button id="sort-avg" data-act="sort" data-v="avg" aria-pressed="${S.sort === "avg"}">Media</button>
    </div>
    ${S.isAdmin ? `<button class="btn" id="manage" data-act="manage">${S.manage ? "Fine modifiche" : "Modifica elenco"}</button>` : ""}
  </div>
  <div class="legend">
    <span><i style="background:var(--accent)"></i>Il tuo voto</span>
    <span><i style="background:var(--ink);opacity:.75"></i>Media di tutte le valutazioni</span>
    <span class="num">${S.players.length} giocatori · ne hai valutati ${ratedByMe}</span>
  </div>`;

  if (S.isAdmin && S.manage) {
    h += `<form class="card" id="addform" style="margin-bottom:14px">
      <strong>Aggiungi giocatori</strong>
      <div class="manage-row">
        <input class="field" id="newname" placeholder="Nome e cognome" value="${esc(S.newName)}" autocomplete="off">
        <button class="btn primary" id="addbtn" type="submit">Aggiungi</button>
      </div>
      <label class="meta" for="bulk">Oppure incolla un elenco, un nome per riga:</label>
      <textarea class="field" id="bulk" placeholder="Mario Rossi&#10;Anna Bianchi&#10;…">${esc(S.bulk)}</textarea>
      <div class="manage-row"><button class="btn" id="bulkbtn" type="button" data-act="bulk">Aggiungi elenco</button>
      <span class="meta">I nomi già presenti vengono saltati. I voti di un giocatore rimosso non contano più.</span></div>
    </form>`;
  }

  if (S.failed && !S.players.length) return h + `<div class="empty">${esc(S.failed)}</div>`;
  if (!S.players.length) return h + `<div class="empty">Il roster è vuoto. ${S.isAdmin ? "Usa “Modifica elenco” per aggiungere i giocatori." : "Nicola non ha ancora inserito i giocatori."}</div>`;
  if (!list.length) return h + `<div class="empty">Nessun giocatore corrisponde a “${esc(S.filter)}”.</div>`;

  h += '<div class="grid">';
  for (const p of list) {
    const s = stats[p.id], mine = S.my[p.id] || {};
    h += `<article class="card">
      <div class="card-h">
        <h3>${esc(p.name)}</h3>
        <div style="text-align:right">
          <div class="ovr num">${fmt(s.overall)}<small>/5</small></div>
          <div class="votes num">${s.voters ? `${s.voters} valutazion${s.voters > 1 ? "i" : "e"}` : "nessun voto"}</div>
        </div>
      </div>`;
    for (const { k, l } of SKILLS) {
      const a = s.avg[k];
      h += `<div class="skill">
        <span class="lbl">${l}</span>
        ${starsHTML(p.id, k, mine[k] || 0)}
        <div class="track" aria-hidden="true"><b style="width:${a == null ? 0 : (a / 5 * 100).toFixed(1)}%"></b></div>
        <span class="avg num${a == null ? " none" : ""}" title="Media">${fmt(a)}</span>
      </div>`;
    }
    if (S.isAdmin && S.manage) {
      const c = S.confirmDel === p.id;
      h += `<div class="manage-row">
        <input class="field" id="rn-${p.id}" data-act="rename" data-pid="${p.id}" value="${esc(p.name)}" aria-label="Rinomina ${esc(p.name)}">
        ${c ? `<button class="btn danger" id="del-${p.id}" data-act="del-yes" data-pid="${p.id}">Conferma rimozione</button>
               <button class="btn" id="delno-${p.id}" data-act="del-no">Annulla</button>`
          : `<button class="btn danger" id="del-${p.id}" data-act="del" data-pid="${p.id}">Rimuovi</button>`}
      </div>`;
    }
    h += `</article>`;
  }
  return h + "</div>";
}

const eqClass = e => e >= 90 ? "g" : e >= 75 ? "w" : "b";

function teamHTML(side, ids, means, g, stats) {
  const rows = ids.map(id => {
    const p = S.players.find(x => x.id === id), s = stats[id];
    return { name: p ? p.name : "?", ov: s && s.overall, warn: !s || !s.complete };
  }).sort((a, b) => (b.ov ?? 0) - (a.ov ?? 0));
  let h = `<section class="team ${side}">
    <div class="team-h"><h4>Squadra ${side}</h4><div class="tg num">${g.toFixed(2)}<small> media globale</small></div></div>
    <ul class="plist">${rows.map(r => `<li><span>${esc(r.name)}</span><span class="num${r.warn ? " warnp" : ""}" title="${r.warn ? "Voti mancanti: usato 3 dove manca" : "Media del giocatore"}">${r.ov == null ? "3.0*" : r.ov.toFixed(1) + (r.warn ? "*" : "")}</span></li>`).join("")}</ul>
    <div class="tstats">`;
  SKILLS.forEach(({ l }, j) => {
    h += `<div class="ts"><span class="lbl">${l}</span><div class="track"><b style="width:${(means[j] / 5 * 100).toFixed(1)}%"></b></div><span class="num" style="text-align:right;font-weight:600">${means[j].toFixed(2)}</span></div>`;
  });
  return h + `</div><div class="meta num">Somma globale: ${(g * ids.length).toFixed(1)}</div></section>`;
}

function teamsHTML(stats) {
  const sel = currentSel(), selSet = new Set(sel), n = sel.length;
  const okCount = n >= 4 && n % 2 === 0 && n <= MAX_SEL;
  const isLocal = !S.isAdmin && S.localSel;

  let h = `<div class="sel-head">
    <h2>Convocati</h2>
    <span class="count num ${n === 12 ? "okc" : okCount ? "" : "badc"}">${n} / 12</span>
    <span class="meta">${S.isAdmin ? "Selezione condivisa con tutti." : isLocal ? "Selezione modificata solo su questo dispositivo." : "Selezione impostata da Nicola."}</span>
  </div>
  <div class="bar" style="margin-top:0">
    <button class="btn" id="sel-none" data-act="sel-none">Svuota</button>
    <button class="btn" id="sel-all" data-act="sel-all">Seleziona tutti</button>
    ${isLocal ? `<button class="btn" id="sel-reset" data-act="sel-reset">Torna ai convocati di Nicola</button>` : ""}
  </div>`;
  if (!S.players.length) return h + `<div class="empty">Nessun giocatore nel roster.</div>`;
  h += `<div class="chips">`;
  for (const p of S.players.slice().sort(byName)) {
    h += `<button class="chip" id="ch-${p.id}" data-act="toggle" data-pid="${p.id}" aria-pressed="${selSet.has(p.id)}"><span class="dot"></span>${esc(p.name)}<span class="s num">${fmt(stats[p.id].overall)}</span></button>`;
  }
  h += `</div>`;

  if (!okCount) {
    const why = n > MAX_SEL ? `Seleziona al massimo ${MAX_SEL} giocatori.`
      : n % 2 ? "Serve un numero pari di giocatori per fare due squadre."
        : "Seleziona i 12 giocatori della settimana per generare le squadre.";
    return h + `<div class="empty" style="margin-top:22px">${why}</div>`;
  }

  const key = JSON.stringify([sel, sel.map(id => stats[id].avg)]);
  if (key !== S.memoKey) { S.memoKey = key; S.memo = generate(sel, stats); }
  const all = S.memo;
  const missing = sel.filter(id => !stats[id].complete).length;
  h += `<p class="note num">${all.length} combinazioni valutate, dalla più equilibrata alla meno equilibrata.
    L'equità (0–100) combina la differenza di media globale (40%), la differenza media tra le skill (40%) e la skill più sbilanciata (20%).
    ${missing ? `<br><span style="color:var(--warn)">* ${missing} convocat${missing > 1 ? "i hanno" : "o ha"} voti mancanti: dove manca un voto si usa 3.</span>` : ""}</p>`;

  h += `<div class="variants">`;
  all.slice(0, S.shown).forEach((r, i) => {
    const worst = SKILLS[r.dS.indexOf(r.dMax)].l;
    h += `<article class="variant">
      <div class="v-head">
        <h3>Variante ${i + 1}</h3>
        <span class="eq ${eqClass(r.eq)} num">Equità ${r.eq}</span>
        <span class="v-meta num">Δ globale ${r.dG.toFixed(2)} · Δ medio skill ${r.dAvg.toFixed(2)} · più sbilanciata: ${worst} (Δ ${r.dMax.toFixed(2)})</span>
      </div>
      <div class="teams">${teamHTML("A", r.A, r.mA, r.gA, stats)}${teamHTML("B", r.B, r.mB, r.gB, stats)}</div>
    </article>`;
  });
  h += `</div><div class="more">`;
  if (S.shown < all.length) h += `<button class="btn" id="more" data-act="more">Mostra altre ${Math.min(STEP, all.length - S.shown)} varianti</button>`;
  if (S.shown > STEP) h += `<button class="btn" id="less" data-act="less">Mostra solo le prime ${STEP}</button>`;
  return h + `</div><p class="note num" style="text-align:center">Mostrate ${Math.min(S.shown, all.length)} di ${all.length}. Variante meno equilibrata: equità ${all[all.length - 1].eq}.</p>`;
}

/* ---------- eventi ---------- */
$tabs.addEventListener("click", e => {
  const t = e.target.closest(".tab"); if (!t) return;
  S.tab = t.dataset.tab;
  try { history.replaceState(null, "", "#" + S.tab); } catch (_) { }
  render();
});
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, pid = b.dataset.pid;
  if (a === "login") login();
  else if (a === "logout") signOut(auth);
  else if (a === "rate") rate(pid, b.dataset.k, Number(b.dataset.v));
  else if (a === "sort") { S.sort = b.dataset.v; render(); }
  else if (a === "manage") { S.manage = !S.manage; S.confirmDel = null; render(); }
  else if (a === "del") { S.confirmDel = pid; render(); }
  else if (a === "del-no") { S.confirmDel = null; render(); }
  else if (a === "del-yes") removePlayer(pid);
  else if (a === "bulk") addPlayers(S.bulk.split(/\r?\n/));
  else if (a === "toggle") {
    const sel = currentSel(); const i = sel.indexOf(pid);
    if (i >= 0) sel.splice(i, 1); else sel.push(pid);
    setSel(sel);
  }
  else if (a === "sel-none") setSel([]);
  else if (a === "sel-all") setSel(S.players.map(p => p.id));
  else if (a === "sel-reset") { S.localSel = null; S.shown = STEP; render(); }
  else if (a === "more") { S.shown += STEP; render(); }
  else if (a === "less") { S.shown = STEP; render(); }
});
$view.addEventListener("input", e => {
  if (e.target.id === "filter") { S.filter = e.target.value; render(); }
  else if (e.target.id === "newname") S.newName = e.target.value;
  else if (e.target.id === "bulk") S.bulk = e.target.value;
});
$view.addEventListener("change", e => {
  if (e.target.dataset.act === "rename") renamePlayer(e.target.dataset.pid, e.target.value);
});
$view.addEventListener("submit", e => {
  if (e.target.id === "addform") { e.preventDefault(); addPlayers([S.newName]); }
});
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1); if (h === "roster" || h === "squadre") { S.tab = h; render(); }
});
{ const h = location.hash.slice(1); if (h === "roster" || h === "squadre") S.tab = h; }
render();
