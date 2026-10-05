# Asta CFP

Web app per l'asta di riparazione della lega CFP. Gira interamente su Cloudflare:

- **Worker** serve l'app (PWA in `public/`) e le API.
- **Durable Object `League`** (SQLite integrato) contiene tutti i dati e gestisce aste, rilanci, turni e scambi in modo atomico, più i WebSocket per gli aggiornamenti in tempo reale.
- **Web Push** (VAPID, chiavi generate automaticamente al primo avvio) per le notifiche su Android, iPhone (app aggiunta alla schermata Home) e desktop.

## Pubblicazione

Collegato a Cloudflare Workers Builds: ogni push su `main` viene pubblicato con `npx wrangler deploy`. Nessun segreto da configurare.

## Primo avvio

1. Apri l'app e iscriviti con `silvello.enrico@gmail.com` (diventa automaticamente admin).
2. Admin → File: carica il file **Rose** (un foglio per squadra, riga 1 "Nome squadra (N MILIONI)") e il **listone completo** con le quotazioni (foglio "Tutti"). Gli svincolati sono calcolati: listone meno i giocatori già in rosa.
3. Admin → Regole: cambi per squadra, scambi come cambi, fantamilioni extra, base d'asta, giocatori massimi in rosa, rimborso svincolo.
4. Condividi il link: ogni allenatore si iscrive e sceglie la propria squadra.
5. Admin → ordine dei turni → **Avvia asta**.

## Regole implementate

- Chi ha il turno chiama uno svincolato con un'offerta di apertura; partecipano solo gli allenatori che hanno ancora cambi (chi li ha finiti non viene conteggiato).
- Ognuno rilancia o si ritira; quando resta solo il migliore offerente, vince. Nessun tetto alle offerte: i crediti possono andare in negativo.
- Il turno resta a chi lo ha finché non acquista un giocatore o conclude uno scambio (o passa); poi va al successivo che ha ancora cambi/scambi.
- Ogni acquisto consuma 1 cambio a chi vince; se supera i giocatori massimi in rosa (25) deve svincolare un giocatore di qualsiasi ruolo. La prossima asta parte solo dopo lo svincolo.
- Rimborso svincolo: nessuno, metà del costo, costo pieno, oppure il minore tra costo pagato (dalla rosa) e quotazione attuale (dal listone).
- Scambio: 1 giocatore contro 1 (anche di ruoli diversi) + crediti in una direzione; se gli scambi valgono come cambi consuma 1 cambio a entrambe.
- Sezione Movimenti: storico di acquisti, svincoli e scambi, filtrabile per squadra.
- Notifiche: asta aperta, rilanci (solo a chi è ancora in gara), aggiudicazione, turno, scambi proposti/accettati/rifiutati.

## Sviluppo locale

```
npm install
npx wrangler dev
```
I test (`test/`) usano i file Excel reali: `flow.test.mjs` (API) e `ui.test.mjs` (Playwright).
