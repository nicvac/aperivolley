# AperiVolley

Roster di pallavolo con voti condivisi (ricezione, alzata, attacco, muro, da 1 a 5 stelle) e generatore di squadre equilibrate con punteggio di equità.

- App: https://nicvac.github.io/aperivolley/
- Viste: `?p=vota`, `?p=formazioni`, `?p=classifica`; amministratori: `?p=partita`, `?p=roster`, `?p=utenti`
- Login e database: Firebase (progetto `aperivolley`), accesso con Google
- Regole di sicurezza del database: `firestore.rules` (da pubblicare nella console Firebase, Firestore → Regole)

I voti alle skill sono privati (li legge solo chi li ha dati e gli amministratori). Le medie dei giocatori le calcola solo il browser di un amministratore quando genera le formazioni: nel database finiscono solo i totali di squadra delle 5 formazioni più equilibrate.
