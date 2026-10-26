import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, SUPER_ADMIN, TEST_PLAYERS, toRelative } from "./shared.js";

/* Pagina di gestione del database, riservata agli amministratori.
   Non è collegata dall'app: si apre digitando .../db.html
   Le regole di Firestore impediscono comunque qualsiasi scrittura a chi non è amministratore. */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const $view = document.getElementById("view");
const $status = document.getElementById("status");
const $userbar = document.getElementById("userbar");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = { phase: "loading", user: null, admin: false, scan: null, busy: false, log: "", confirm: false, resetText: "" };

function status(msg, kind = "") {
  $status.hidden = !msg; $status.className = "status" + (kind ? " " + kind : ""); $status.textContent = msg || "";
}

onAuthStateChanged(auth, async user => {
  S.user = user; S.scan = null; S.log = "";
  if (!user) { S.phase = "signedout"; render(); return; }
  const sup = user.emailVerified && (user.email || "").toLowerCase() === SUPER_ADMIN;
  let adm = sup;
  if (!adm) { try { adm = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch (e) { adm = false; } }
  S.admin = adm; S.phase = adm ? "ready" : "denied";
  render();
  if (adm) scan();
});

/* ---------- Analisi ---------- */
const isRel = f => f && f.rel === true;
const isNewBal = f => f && f.bal === 2;
// vecchia scala: s = 100·(1 − x), con 0 come minimo → x = 1 − s/100 (se s = 0, x ≥ 1: si usa 1)
const oldToNewBal = s => s == null ? s : Math.max(0, Math.min(100, Math.round(100 - 25 * (1 - Number(s) / 100))));
const needsFix = f => !isRel(f) || !isNewBal(f);
async function scan() {
  S.busy = true; render();
  try {
    const [players, users, admins, votes, matches, week, state] = await Promise.all([
      getDocs(collection(db, "players")), getDocs(collection(db, "users")), getDocs(collection(db, "admins")),
      getDocs(collection(db, "votes")), getDocs(collection(db, "matches")), getDocs(collection(db, "week")),
      getDoc(doc(db, "config", "state"))
    ]);
    const pids = new Set(players.docs.map(d => d.id));
    const ms = matches.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
    const toConvert = ms.filter(m => Array.isArray(m.formations) && m.formations.some(needsFix));
    const playedWithFormations = ms.filter(m => m.status === "played" && m.formations);
    const cur = state.exists() ? state.data().currentMatch : null;
    const curMatch = cur ? ms.find(m => m.id === cur) : null;
    const dangling = cur && (!curMatch || curMatch.status !== "voting");
    let orphanVotes = 0;
    votes.docs.forEach(d => Object.keys(d.data().ratings || {}).forEach(pid => { if (!pids.has(pid)) orphanVotes++; }));
    S.scan = {
      counts: {
        players: players.docs.length, users: users.docs.length, admins: admins.docs.length + 1, votes: votes.docs.length,
        voting: ms.filter(m => m.status === "voting").length, played: ms.filter(m => m.status === "played").length
      },
      toConvert, playedWithFormations, week: week.docs, dangling, cur, orphanVotes
    };
  } catch (e) { status("Lettura del database non riuscita: " + (e.code || e.message), "warn"); }
  S.busy = false; render();
}

/* ---------- Allineamento ---------- */
async function align() {
  const sc = S.scan; if (!sc) return;
  S.busy = true; render();
  const log = [];
  try {
    const b = writeBatch(db);
    let ops = 0;
    for (const m of sc.toConvert) {
      const formations = m.formations.map(f => {
        let g = isRel(f) ? f : { ...f, ...toRelative(f) };
        if (!isNewBal(g)) g = { ...g, req: oldToNewBal(g.req), eq: oldToNewBal(g.eq), bal: 2 };
        return g;
      });
      b.update(m.ref, { formations }); ops++;
      log.push(`Partita ${m.id}: ${m.formations.filter(needsFix).length} formazioni aggiornate (valori relativi e nuova scala dell'equilibrio).`);
    }
    for (const m of sc.playedWithFormations) {
      b.update(m.ref, { formations: deleteField() }); ops++;
      log.push(`Partita ${m.id} (giocata): statistiche delle formazioni rimosse.`);
    }
    for (const d of sc.week) { b.delete(d.ref); ops++; }
    if (sc.week.length) log.push(`Rimossi ${sc.week.length} documenti della vecchia collezione "week".`);
    if (sc.dangling) { b.set(doc(db, "config", "state"), { currentMatch: null, updatedAt: Date.now() }); ops++; log.push("Riferimento alla partita in corso non valido: azzerato."); }
    if (ops) await b.commit();
    S.log = ops ? log.join("\n") : "Niente da allineare: il database è già coerente.";
    status(ops ? "Database allineato." : "Il database era già coerente.", "ok");
  } catch (e) { status("Allineamento non riuscito: " + (e.code || e.message), "warn"); }
  S.busy = false;
  await scan();
}

/* ---------- Azzeramento ---------- */
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
    S.log = `Cancellati ${refs.length} documenti. Caricati ${TEST_PLAYERS.length} giocatori di prova.`;
    status("Dati azzerati e giocatori di prova caricati.", "ok");
  } catch (e) { status("Azzeramento non riuscito: " + (e.code || e.message), "warn"); }
  S.confirm = false; S.resetText = ""; S.busy = false;
  await scan();
}

/* ---------- Render ---------- */
function render() {
  const ae = document.activeElement, keepFocus = ae && ae.id === "resettext";
  if (S.user) {
    $userbar.hidden = false;
    $userbar.innerHTML = `<span>Entrato come <strong>${esc(S.user.email)}</strong></span><button class="linkbtn" id="logout">Esci</button>`;
  } else $userbar.hidden = true;

  if (S.phase === "loading") $view.innerHTML = `<div class="empty">Caricamento…</div>`;
  else if (S.phase === "signedout") $view.innerHTML = `<section class="gate"><h2>Database</h2><p>Pagina riservata agli amministratori.</p><button class="btn primary" id="login">Accedi con Google</button></section>`;
  else if (S.phase === "denied") $view.innerHTML = `<div class="empty">Questa pagina è riservata agli amministratori. <a href="./">Torna all'app</a></div>`;
  else $view.innerHTML = readyHTML();

  if (keepFocus) { const el = document.getElementById("resettext"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
}

function readyHTML() {
  const sc = S.scan;
  if (!sc) return `<div class="empty">${S.busy ? "Analisi del database…" : "Nessun dato."}</div>`;
  const c = sc.counts;
  const issues = [];
  if (sc.toConvert.length) issues.push(`${sc.toConvert.length} partit${sc.toConvert.length === 1 ? "a ha" : "e hanno"} formazioni da aggiornare (valori assoluti o vecchia scala dell'equilibrio).`);
  if (sc.playedWithFormations.length) issues.push(`${sc.playedWithFormations.length} partite giocate conservano ancora le statistiche delle formazioni.`);
  if (sc.week.length) issues.push(`${sc.week.length} documenti della vecchia collezione "week" (prima versione dell'app).`);
  if (sc.dangling) issues.push("Il riferimento alla partita in corso punta a una partita inesistente o già chiusa.");

  return `
  <div class="sec-head"><h2>Stato del database</h2><button class="btn sm" id="rescan" ${S.busy ? "disabled" : ""}>Aggiorna</button></div>
  <div class="kv">
    <div><b class="num">${c.players}</b><span>giocatori</span></div>
    <div><b class="num">${c.users}</b><span>utenti</span></div>
    <div><b class="num">${c.admins}</b><span>amministratori</span></div>
    <div><b class="num">${c.votes}</b><span>persone che hanno votato</span></div>
    <div><b class="num">${c.voting}</b><span>partite in votazione</span></div>
    <div><b class="num">${c.played}</b><span>partite giocate</span></div>
  </div>
  ${sc.orphanVotes ? `<p class="note">${sc.orphanVotes} voti riguardano giocatori rimossi dal roster: non vengono conteggiati e non danno problemi.</p>` : ""}

  <div class="sec-head" style="margin-top:28px"><h2>Allinea il database</h2></div>
  <div class="card">
    ${issues.length
      ? `<strong class="issue">Da sistemare</strong><ul>${issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`
      : `<strong class="okc">Il database è coerente.</strong>`}
    <span class="meta">Converte in percentuale le formazioni salvate con valori assoluti (la skill più alta = 100%), porta l'equilibrio (ruoli e forza) alla nuova scala percentuale lineare, toglie le statistiche dalle partite già giocate, elimina i dati della prima versione e corregge riferimenti non validi. Voti, giocatori, utenti e risultati non vengono toccati.</span>
    <div class="manage-row"><button class="btn primary" id="align" ${issues.length && !S.busy ? "" : "disabled"}>Allinea il database</button></div>
    ${S.log ? `<pre class="log">${esc(S.log)}</pre>` : ""}
  </div>

  <div class="sec-head" style="margin-top:28px"><h2>Azzera i dati</h2></div>
  <div class="card danger-zone">
    <span class="meta">Cancella tutti i giocatori, tutti i voti e tutte le partite, poi carica ${TEST_PLAYERS.length} giocatori di prova. Utenti e amministratori restano. Non si può annullare.</span>
    ${S.confirm
      ? `<label class="meta" for="resettext">Scrivi <b>AZZERA</b> per confermare:</label>
         <div class="manage-row"><input class="field" id="resettext" value="${esc(S.resetText)}" autocomplete="off">
         <button class="btn danger" id="reset-yes" ${S.resetText.trim() === "AZZERA" && !S.busy ? "" : "disabled"}>Azzera e carica i giocatori di prova</button>
         <button class="btn" id="reset-no">Annulla</button></div>`
      : `<div class="manage-row"><button class="btn danger-o" id="reset-ask" ${S.busy ? "disabled" : ""}>Azzera i dati…</button></div>`}
  </div>`;
}

/* ---------- Eventi ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t || t.disabled) return;
  const id = t.id;
  if (id === "login") signInWithPopup(auth, provider).catch(err => { if (err.code !== "auth/popup-closed-by-user") status("Accesso non riuscito: " + err.code, "warn"); });
  else if (id === "logout") signOut(auth);
  else if (id === "rescan") scan();
  else if (id === "align") align();
  else if (id === "reset-ask") { S.confirm = true; render(); }
  else if (id === "reset-no") { S.confirm = false; S.resetText = ""; render(); }
  else if (id === "reset-yes") resetTestData();
});
$view.addEventListener("input", e => {
  if (e.target.id === "resettext") { S.resetText = e.target.value; render(); }
});
render();
