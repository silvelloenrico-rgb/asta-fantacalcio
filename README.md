# Asta CFP

Web app per l'asta di riparazione della lega CFP. Gira interamente su Cloudflare:

- **Worker** serve l'app (PWA in `public/`) e le API.
- **Durable Object `League`** (SQLite integrato) contiene tutti i dati e gestisce aste, rilanci, turni e scambi in modo atomico, più i WebSocket per gli aggiornamenti in tempo reale.
- **Web Push** (VAPID, chiavi generate automaticamente al primo avvio) per le notifiche su Android, iPhone (app aggiunta alla schermata Home) e desktop.

## Pubblicazione

Collegato a Cloudflare Workers Builds: ogni push su `main` viene pubblicato con `npx wrangler deploy`. Nessun segreto da configurare.

## Primo avvio

1. Apri l'app e iscriviti con `silvello.enrico@gmail.com` (diventa automaticamente admin).
2. Admin → File: carica il file **Rose** (un foglio per squadra, riga 1 "Nome squadra (N MILIONI)") e il file **Svincolati** (usa il foglio "Tutti").
3. Admin → Regole: cambi per squadra, scambi come cambi, fantamilioni extra, base d'asta, limiti rosa.
4. Condividi il link: ogni allenatore si iscrive e sceglie la propria squadra.
5. Admin → ordine dei turni → **Avvia asta**.

## Regole implementate

- Chi ha il turno chiama uno svincolato con un'offerta di apertura; tutti gli allenatori con cambi disponibili partecipano.
- Ognuno rilancia o si ritira; quando resta solo il migliore offerente, vince. Chi non può più permettersi il rilancio esce in automatico.
- Il turno resta a chi lo ha finché non acquista un giocatore o conclude uno scambio (o passa); poi va al successivo che ha ancora cambi/scambi.
- Ogni acquisto consuma 1 cambio a chi vince; se il ruolo è pieno deve svincolare un giocatore dello stesso ruolo.
- Scambio: 1 giocatore contro 1 + crediti in una direzione; se gli scambi valgono come cambi consuma 1 cambio a entrambe.
- Notifiche: asta aperta, rilanci (solo a chi è ancora in gara), aggiudicazione, turno, scambi proposti/accettati/rifiutati.

## Sviluppo locale

```
npm install
npx wrangler dev
```
I test (`test/`) usano i file Excel reali: `flow.test.mjs` (API) e `ui.test.mjs` (Playwright).
