# AperiVolley

Roster di pallavolo con voti condivisi (ricezione, alzata, attacco, muro, da 1 a 5 stelle) e generatore di squadre equilibrate con punteggio di equità.

- App: https://nicvac.github.io/aperivolley/
- Pagina: `docs/` (GitHub Pages)
- Login e database: Firebase (progetto `aperivolley`), accesso con Google
- Regole di sicurezza del database: `firestore.rules` (da pubblicare nella console Firebase, Firestore → Regole)

Solo l'amministratore (nicola.vacca@gmail.com) modifica l'elenco giocatori e i convocati; ogni utente entrato con Google vota per sé.
