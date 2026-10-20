/* Configurazione e funzioni condivise tra index.html (app) e db.html (gestione database) */

export const firebaseConfig = {
  apiKey: "AIzaSyAQE4EXaYxFgJHb_9iMGbtOGghIFQyGWqo",
  authDomain: "aperivolley.firebaseapp.com",
  projectId: "aperivolley",
  storageBucket: "aperivolley.firebasestorage.app",
  messagingSenderId: "785233193282",
  appId: "1:785233193282:web:ceba7bbbbab7757f0040db"
};
export const SUPER_ADMIN = "nicola.vacca@gmail.com";   // deve coincidere con firestore.rules

export const SKILLS = [
  { k: "bat", l: "Battuta" },
  { k: "ric", l: "Ricezione" },
  { k: "alz", l: "Alzata" },
  { k: "att", l: "Attacco" },
  { k: "mur", l: "Muro" },
  { k: "rec", l: "Recupero palloni" }
];

export const TEST_PLAYERS = [
  "Marco Lorusso", "Giulia De Santis", "Antonio Carofiglio", "Francesca Papagni",
  "Davide Ranieri", "Elena Mastrorilli", "Luca Pastore", "Sara Colella",
  "Vito Amoruso", "Chiara Lattanzio", "Pietro Grimaldi", "Martina Sasso",
  "Nicola Fanelli", "Alessia Debenedictis", "Gianluca Ventura", "Roberta Cassano"
];

/* Converte le statistiche assolute di una formazione (stelle) in percentuali:
   la skill più alta tra le due squadre = 100, le altre in proporzione;
   nel totale la squadra più forte = 100. */
export function toRelative(f) {
  const vals = SKILLS.flatMap(({ k }) => [Number(f.sA?.[k]) || 0, Number(f.sB?.[k]) || 0]);
  const ref = Math.max(...vals) || 1;
  const gref = Math.max(Number(f.gA) || 0, Number(f.gB) || 0) || 1;
  const pct = v => Math.round((Number(v) || 0) / ref * 100);
  const map = st => Object.fromEntries(SKILLS.map(({ k }) => [k, pct(st?.[k])]));
  return {
    sA: map(f.sA), sB: map(f.sB),
    gA: Math.round((Number(f.gA) || 0) / gref * 100),
    gB: Math.round((Number(f.gB) || 0) / gref * 100),
    rel: true
  };
}
