# Asta CFP: documento tecnico per l'integrazione

> **Per chi riceve questo progetto:** dai al tuo Claude (Claude Code o un altro agente di programmazione) il link a questo repository e scrivigli, per esempio:
> *"Leggi INTEGRAZIONE.md del repository github.com/silvelloenrico-rgb/asta-fantacalcio e integra l'asta nella mia app [descrivi la tua app]. Deve funzionare tutto esattamente come l'originale, notifiche comprese. Alla fine esegui i test descritti nella sezione 12."*

> **Per l'agente che esegue l'integrazione:** questo documento è la specifica. Il comportamento descritto nelle sezioni 2 e 8 è **vincolante**: regole d'asta, destinatari delle notifiche e tempo reale devono restare identici. Prima di dichiarare il lavoro finito, la suite `test/` deve passare (sezione 12). Se la piattaforma di destinazione ti obbliga a cambiare qualcosa di vincolante, fermati e chiedi all'utente invece di semplificare.

---

## 1. Cos'è

Web app (PWA installabile) per gestire l'**asta di riparazione** di una lega di fantacalcio da 12 squadre, in tempo reale da più telefoni, con notifiche push. È in produzione su Cloudflare Workers:

- Worker che serve la PWA statica (`public/`) e le API (`/api/*`, `/ws`).
- **Un solo Durable Object** (`League`, istanza `idFromName('cfp')`) con SQLite integrato. Contiene **tutti** i dati e **serializza tutte le operazioni**, così due rilanci simultanei non possono sovrapporsi.
- Web Push (VAPID + crittografia `aes128gcm`) implementato solo con WebCrypto, senza librerie esterne né segreti da configurare.
- Nessuna dipendenza runtime e nessun build step: il frontend è JavaScript "vanilla" a moduli ES; l'unica dipendenza di sviluppo è `wrangler`.

## 2. Regole funzionali (vincolanti)

### 2.1 Preparazione (admin)
1. L'admin è l'utente con email uguale alla costante `ADMIN_EMAIL` in `src/league.js` (oggi `silvello.enrico@gmail.com`); diventa admin automaticamente all'iscrizione.
2. **File Rose** (.xlsx, un foglio per squadra, formato FantaMaster): la cella A1 contiene `Nome squadra (N MILIONI)`, da cui si leggono il nome e i crediti iniziali (N). Più sotto c'è una riga di intestazione `Nome | Squadra | Ruolo | Costo` seguita dai giocatori. Il ruolo è uno tra P, D, C, A. Una squadra può avere la rosa vuota (es. squadra nuova con 500 crediti).
3. **Listone** (.xlsx FantaMaster "Quotazioni"): l'app usa il foglio `Tutti` (se manca, unisce tutti i fogli), con intestazione `Nome | Squadra | Ruolo | Quotazione`. **Gli svincolati non vengono caricati: vengono calcolati** come *listone meno i giocatori già in rosa*. Per riconoscere un giocatore in rosa si confrontano nome e squadra (senza distinguere maiuscole e spazi); se non combaciano si prova con nome e ruolo, ma solo se c'è un'unica corrispondenza (il giocatore ha cambiato squadra). Ai giocatori in rosa vengono assegnate la quotazione e la squadra prese dal listone. I file si possono caricare in qualsiasi ordine e più volte: ogni import ricalcola gli svincolati (`rebuildFromListone`).
4. Regole configurabili (tabella `settings`, sezione 5): cambi per squadra (globale, con eccezioni per singola squadra), scambi che valgono o no come cambi, numero massimo di scambi, fantamilioni extra per tutte le squadre, base d'asta (1 credito oppure la quotazione), rilancio minimo, giocatori massimi in rosa (25), rimborso allo svincolo.
5. Ordine dei turni stabilito dall'admin (anche casuale); l'admin avvia, mette in pausa, riprende e termina l'asta.

### 2.2 Iscrizione
Chiunque si iscrive con email, nome e password e sceglie **una squadra libera**: una squadra può avere un solo allenatore. Le squadre senza allenatore non giocano e non partecipano alle aste.

### 2.3 Turno
- Il turno spetta a una sola squadra, e **resta suo finché non acquista un giocatore o conclude uno scambio** (oppure passa, o l'admin lo salta).
- Se chi ha il turno chiama un giocatore e l'asta la vince un altro, il turno resta a lui e chiama di nuovo.
- Il turno successivo va, in ordine circolare, alla prima squadra con allenatore che abbia ancora **cambi** (o scambi, se gli scambi non valgono come cambi). Se nessuna li ha più, l'asta termina da sola (`phase = finished`) e tutti ricevono una notifica.
- Quando il turno passa, le proposte di scambio ancora in attesa della squadra uscente vengono annullate.

### 2.4 Asta
1. Solo chi ha il turno può chiamare uno **svincolato**, con un'offerta di apertura ≥ base d'asta. La chiamata è bloccata se: c'è già un'asta aperta, c'è uno **svincolo obbligatorio in sospeso di qualunque squadra**, chi chiama ha una proposta di scambio in attesa, oppure ha finito i cambi.
2. **Partecipano solo le squadre con allenatore che hanno ancora cambi.** Le altre risultano `out` e non vengono conteggiate: con 12 squadre di cui 5 senza cambi, i partecipanti sono 7.
3. Ogni partecipante attivo **rilancia** (offerta ≥ attuale + rilancio minimo) oppure **si ritira**. Chi è in testa non può ritirarsi. Chi si ritira non rientra più.
4. **L'asta si chiude quando resta attivo solo il migliore offerente**, che vince. Non c'è timer: l'admin può forzare il ritiro di un assente, aggiudicare subito o annullare l'asta.
5. **Nessun tetto alle offerte: i crediti possono andare in negativo.**
6. Alla chiusura: il giocatore passa al vincitore con `cost` = prezzo; i crediti del vincitore scendono del prezzo; il vincitore consuma 1 cambio; viene registrato un movimento `acquisto`. Se il vincitore è chi aveva il turno, il turno passa.

### 2.5 Svincolo obbligatorio
- Se dopo un acquisto la rosa supera `roster_max` (25), il vincitore **deve svincolare un giocatore di qualsiasi ruolo**: si compra un D e si può svincolare un C. Non ci sono limiti per ruolo.
- **Finché lo svincolo non è fatto, nessuno può chiamare la prossima asta.** Quando lo svincolo è fatto, chi ha il turno riceve una notifica.
- Lo svincolato torna tra gli svincolati (mantiene la quotazione). Il rimborso dipende da `release_refund`: `none` = 0, `half` = metà del costo arrotondata per eccesso, `full` = costo, `min` = **il minore tra costo pagato e quotazione attuale** (se la quotazione manca, vale il costo). Viene registrato un movimento `svincolo` con il rimborso.

### 2.6 Scambi
- Solo chi ha il turno può proporre, e solo senza un'asta aperta. Si propone **1 giocatore contro 1** (anche di ruoli diversi) più eventuali crediti: `credits > 0` = chi propone li dà, `credits < 0` = li chiede. Si può avere una sola proposta in attesa alla volta. La squadra che riceve deve avere un allenatore.
- Chi riceve accetta o rifiuta; chi propone può ritirare la proposta.
- All'accettazione i giocatori si scambiano, i crediti passano (anche in negativo), ed entrambe le squadre consumano 1 cambio (oppure 1 scambio, se `scambi_as_cambi = 0`). Viene registrato un movimento `scambio`, le altre proposte che coinvolgono gli stessi giocatori vengono annullate e, se chi ha proposto aveva il turno, il turno passa.

### 2.7 Movimenti
È lo storico di **acquisti, svincoli e scambi** per squadra (tabella `moves`). I nomi dei giocatori vengono copiati nel movimento, perché i loro id cambiano quando si ricalcolano gli svincolati. In app si possono filtrare per squadra, con un riepilogo per ciascuna (numero di acquisti e spesa, svincoli e rimborsi, scambi, crediti, cambi rimasti).

### 2.8 Funzioni admin
"Agisci come" (l'admin gioca per una qualunque squadra con il parametro `as_team`), ritiro forzato, aggiudica subito, annulla asta, salta turno, assegna turno, correzione manuale (sposta un giocatore senza toccare i crediti), modifica di crediti e cambi per squadra, gestione utenti (squadra, reset password, eliminazione), esportazione delle rose in .xlsx nello stesso formato del file Rose, azzeramento totale (gli account restano).

## 3. Struttura dei file

| File | Ruolo |
|---|---|
| `wrangler.jsonc` | Configurazione del Worker: asset `public/` (SPA), `run_worker_first` per `/api/*` e `/ws`, binding del Durable Object `LEAGUE` → classe `League`, migrazione `new_sqlite_classes`. |
| `src/index.js` | Worker: inoltra `/api/*` e `/ws` al Durable Object `idFromName('cfp')`, il resto agli asset. |
| `src/league.js` | **Tutta** la logica: schema SQLite, autenticazione, regole, API, WebSocket, coda delle notifiche. |
| `src/push.js` | Web Push: generazione delle chiavi VAPID, JWT ES256, crittografia RFC 8291 `aes128gcm`, invio. |
| `public/index.html` | Struttura della pagina, meta per la PWA e per iOS. |
| `public/app.js` | Frontend SPA (render di stringhe HTML con delega degli eventi), WebSocket, sottoscrizione push, cockpit admin, import ed export Excel. |
| `public/xlsx-parse.js` | Lettura dei file Rose e Listone (lo stesso codice gira nel browser e nei test). SheetJS si carica da cdnjs solo quando serve. |
| `public/sw.js` | Service worker: mostra le notifiche, apre o mette a fuoco l'app al tocco, gestisce `pushsubscriptionchange`. |
| `public/manifest.webmanifest`, icone | PWA installabile (necessaria per le notifiche su iPhone). |
| `test/` | `push.test.mjs` (crittografia e VAPID), `e2e.test.mjs` (35 controlli sulle regole), `ui.test.mjs` (Playwright, due telefoni in tempo reale), `fixtures/` con file Excel di esempio. |

## 4. Architettura e concorrenza

- Tutte le richieste vanno allo **stesso** Durable Object. Ogni mutazione passa da `mutate(fn)`:
  1. `ctx.storage.transactionSync(fn)` esegue la mutazione in modo atomico: se `fn` lancia un errore viene annullato tutto, notifiche comprese.
  2. `broadcast()` invia `{"t":"u"}` a tutti i WebSocket.
  3. `ctx.waitUntil(flushOutbox())` invia le push accodate durante `fn`.
- La logica è **sincrona** (SQLite del Durable Object): finché non ci sono `await` dentro la mutazione, nessuna richiesta può infilarsi a metà. **Non introdurre `await` dentro `mutate`** e non spostare i dati su un database esterno (D1, Postgres…) senza un lock equivalente, altrimenti due rilanci simultanei possono corrompere l'asta.
- Le chiavi VAPID vengono generate al primo avvio (`blockConcurrencyWhile`) e salvate in `settings` (`vapid_pub`, `vapid_priv`).
- Gli errori di regola sono `HttpError(400, messaggio in italiano)` → risposta `{error}`; il client li mostra così come sono.

## 5. Modello dati (SQLite nel Durable Object)

```
users(id, email UNIQUE, name, pass_hash, salt, team_id, is_admin, created_at)
sessions(token PK, user_id, expires_at)                 -- cookie "sid", 90 giorni
teams(id, name UNIQUE, sheet_order, credits, cambi_max, cambi_used, scambi_used, turn_order)
players(id, name, club, role P|D|C|A, quotazione, team_id NULL=svincolato, cost, acquired_at)
listone(id, name, club, role, quotazione)              -- copia dell'ultimo listone caricato
settings(key PK, value)                                 -- regole + phase + turn_team_id + chiavi VAPID
auctions(id, player_id, caller_team_id, status open|closed|cancelled, current_bid, leader_team_id, winner_team_id, started_at, ended_at)
auction_participants(auction_id, team_id, status active|withdrawn|out)
bids(id, auction_id, team_id, amount, created_at)
trades(id, from_team_id, to_team_id, offered_player_id, requested_player_id, credits, status pending|accepted|rejected|cancelled, note, created_at, resolved_at)
pending_releases(id, team_id, role NULL, created_at)    -- svincoli obbligatori in sospeso
moves(id, ts, kind acquisto|svincolo|scambio, team_id, player_name, player_role, player_club, amount, other_team_id, other_player_name, other_player_role, other_player_club)
push_subs(id, user_id, endpoint UNIQUE, p256dh, auth, created_at)
events(id, ts, kind, text)                              -- diario leggibile
```

Crediti disponibili = `teams.credits + settings.global_extra` (possono essere negativi).

**Impostazioni** (`settings`, tutte stringhe): `phase` (`setup|running|paused|finished`), `turn_team_id`, `scambi_as_cambi` (`'1'`), `max_scambi` (`'0'` = illimitati, vale solo se gli scambi non sono cambi), `global_extra` (`'0'`), `base_mode` (`uno|quotazione`), `min_raise` (`'1'`), `roster_max` (`'25'`), `release_refund` (`none|half|full|min`), `default_cambi` (`'3'`).

## 6. API

Autenticazione: cookie di sessione `sid` (HttpOnly, SameSite=Lax, Secure in HTTPS), password con PBKDF2-SHA256 da 100.000 iterazioni. Tutte le risposte sono JSON; gli errori sono `{"error": "..."}` con status 400/401/403.

| Metodo e percorso | Corpo | Note |
|---|---|---|
| `GET /api/public` | – | `{teams:[{id,name,claimed}]}` per il modulo di iscrizione |
| `POST /api/register` | `{email,name,password,team_id?}` | imposta il cookie |
| `POST /api/login` | `{email,password}` | imposta il cookie |
| `POST /api/logout` | – | |
| `GET /api/state` | – | stato completo (sotto) |
| `POST /api/me/team` | `{team_id}` | sceglie una squadra libera |
| `POST /api/push/subscribe` | `PushSubscription.toJSON()` | upsert per `endpoint` |
| `POST /api/push/unsubscribe` | `{endpoint}` | |
| `POST /api/push/test` | – | notifica di prova a se stessi; risponde `{subs}` |
| `POST /api/action` | `{type, ..., as_team?}` | azioni di gioco; `as_team` vale solo per l'admin |
| `POST /api/admin` | `{type, ...}` | solo admin |
| `GET /ws` (upgrade) | – | WebSocket del tempo reale |

**Azioni (`/api/action`):** `call {player_id, amount}`, `raise {amount}`, `withdraw`, `pass`, `release {player_id}`, `trade_propose {offered_player_id, requested_player_id, credits, note}`, `trade_accept {trade_id}`, `trade_reject {trade_id}`, `trade_cancel {trade_id}`.

**Comandi admin (`/api/admin`):** `import_rose {teams:[{name,credits,players:[{name,club,role,cost}]}]}`, `import_listone {players:[{name,club,role,quotazione}]}` (alias storico `import_svincolati`), `settings {settings:{...}, apply_cambi_all?}`, `team_update {team_id, credits?, cambi_max?, cambi_used?, scambi_used?}`, `set_order {team_ids:[...]}`, `start`, `pause`, `resume`, `finish`, `skip_turn`, `set_turn {team_id}`, `force_withdraw {team_id}`, `close_auction`, `cancel_auction`, `cancel_trade {trade_id}`, `force_release {player_id}`, `move_player {player_id, team_id?, cost?}`, `user_update {user_id, team_id?, is_admin?}`, `user_reset_password {user_id, password}`, `user_delete {user_id}`, `reset_all`.

**`GET /api/state`** restituisce:
`me{id,name,email,is_admin,team_id}`, `settings{...}`, `teams[]` (ogni squadra ha anche `coach`, `avail`, `counts{P,D,C,A}`, `roster`, `cambi_left`, `scambi_left` (−1 = illimitati), `pending_release[]`), `players[]`, `auction` (quella aperta oppure l'ultima, con `player`, `participants[]` e `bids[]`), `trades[]` (l'admin le vede tutte; gli altri vedono quelle accettate e le proprie), `moves[]` (le ultime 1000), `events[]` (le ultime 100), `vapidPublicKey`, `mySubs`, `listoneCount`, e solo per l'admin `users[]`.

## 7. Tempo reale

- Il client apre `wss://<host>/ws` (il cookie autentica). Il server, dopo **ogni** mutazione, manda `{"t":"u"}`; il client rilegge `GET /api/state` (con un debounce di 120 ms). Ogni 25 s il client manda un `ping` (il server risponde `pong`) e si riconnette con backoff esponenziale (1 → 15 s).
- Riserva: un polling ogni 30 s e un ricaricamento quando la pagina torna visibile. Se arriva una push mentre l'app è aperta, il service worker manda un `postMessage({type:'push'})` e il client ricarica lo stato.
- Il server usa la **WebSocket Hibernation API** (`ctx.acceptWebSocket`), così le connessioni aperte non tengono sveglio il Durable Object.

## 8. Notifiche push (vincolanti)

### 8.1 Chi riceve cosa
| Evento | Destinatari | Titolo (es.) | `tag` |
|---|---|---|---|
| Asta aperta | partecipanti **attivi** tranne chi chiama | 🔨 Asta aperta: Nome (R) | `auction-<id>` |
| Rilancio | partecipanti **ancora attivi** tranne chi rilancia (**chi si è ritirato non riceve più nulla su quel giocatore**) | ⬆️ Nome: N | `auction-<id>` |
| Aggiudicazione | vincitore; chi ha chiamato, se diverso | ✅ Hai preso Nome! | `auction-<id>` |
| Asta annullata (admin) | partecipanti attivi | 🚫 Asta annullata | `auction-<id>` |
| Svincolo obbligatorio | vincitore | ✂️ Devi svincolare un giocatore | `release` |
| Svincolo fatto | chi ha il turno (se diverso) | 👉 Puoi chiamare il prossimo giocatore | `turn` |
| Cambio turno | nuova squadra di turno | 👉 Tocca a te! | `turn` |
| Proposta di scambio | chi riceve | 🔄 Proposta di scambio da X | `trade-<id>` |
| Scambio rifiutato / ritirato / annullato a fine turno | l'altra parte | ❌ / … | `trade-<id>` |
| Scambio accettato | chi ha proposto; tutte le altre squadre ricevono "Scambio concluso" | 🤝 | `trade-<id>` |
| Asta avviata / terminata | tutte le squadre | 🚀 / 🏁 | `phase` |

Il payload JSON è `{title, body, tag, url:'/'}`. Le notifiche con lo stesso `tag` si **sostituiscono** (`renotify: true`, quindi vibrano comunque): i rilanci sullo stesso giocatore non riempiono il centro notifiche.

### 8.2 Lato server (`src/push.js`)
- VAPID: JWT ES256 con `aud` = origin dell'endpoint, `exp` = 12 ore, `sub` = `mailto:` + ADMIN_EMAIL. Header `Authorization: vapid t=<jwt>, k=<chiave pubblica>`.
- Payload cifrato secondo RFC 8291 (`Content-Encoding: aes128gcm`, record size 4096, `TTL: 3600`, `Urgency: high`).
- Se il servizio push risponde 404 o 410, la sottoscrizione viene cancellata. Gli invii avvengono dopo il commit, con `waitUntil`.
- **Se migri i dati, porta con te `vapid_pub` e `vapid_priv`.** Cambiarli invalida tutte le sottoscrizioni esistenti e ogni utente dovrà riattivare le notifiche.

### 8.3 Lato client
- `sw.js` **deve** essere servito dalla radice dell'origin dell'app (scope `/`) ed è registrato all'avvio. Se l'app ospite ha già un service worker sullo stesso scope, **non registrarne un secondo**: unisci gli handler `push`, `notificationclick` e `pushsubscriptionchange` di `public/sw.js` in quello esistente.
- Attivazione (`enablePush` in `app.js`): `Notification.requestPermission()` → `pushManager.subscribe({userVisibleOnly:true, applicationServerKey: vapidPublicKey})` → `POST /api/push/subscribe`. All'avvio `syncPush()` ripubblica la sottoscrizione corrente (per gestire le rotazioni del browser); quando l'utente tocca "Attiva", se la sottoscrizione esistente usa una chiave VAPID diversa da quella del server, `enablePush()` la cancella e ne crea una nuova.
- **iPhone/iPad (iOS 16.4+):** le push funzionano solo se l'app è **installata sulla schermata Home** come PWA, con `manifest.webmanifest` (`display: standalone`) e i meta `apple-mobile-web-app-*` presenti in `index.html`, dalla stessa origin. L'app rileva Safari non installato e mostra le istruzioni.
- Le push richiedono **HTTPS** e una pagina di primo livello: **non funzionano dentro un iframe di un altro dominio** (il permesso viene negato). Non integrare l'asta in un iframe cross-origin.

## 9. Come integrarla (scegli una strada)

### A. App separata, collegata all'app ospite (consigliata, zero rischi)
1. Fai un fork del repository o importalo nel tuo account GitHub.
2. Cloudflare → Workers & Pages → Create → Continue with GitHub → seleziona il repository. Il deploy command è `npx wrangler deploy` e non serve configurare niente: il Durable Object, le chiavi VAPID e lo schema si creano da soli.
3. Opzionale: un dominio personalizzato (es. `asta.tuaapp.it`).
4. Nell'app ospite metti un link o un pulsante che apre l'asta (stessa scheda o nuova scheda, **non** un iframe).
5. Cambia `ADMIN_EMAIL` in `src/league.js` se l'admin è un altro.

### B. Dentro un Worker Cloudflare esistente
1. Copia `src/league.js` e `src/push.js`. Nel Worker ospite esporta la classe (`export { League } from './league.js'`) e inoltra le richieste come fa `src/index.js`.
2. In `wrangler.jsonc` dell'ospite aggiungi il binding `{name:"LEAGUE", class_name:"League"}` e una **nuova** voce `migrations` con un tag mai usato (es. `asta-v1`) e `new_sqlite_classes: ["League"]`. Se il nome `League` è già preso, rinomina la classe ovunque.
3. **Collisione di percorsi:** se l'ospite usa già `/api` o `/ws`, scegli un prefisso (es. `/asta`) e aggiornalo in **tutti** questi punti: il routing nel Worker ospite, i confronti `path === '/api/...'` e `'/ws'` in `league.js` (oppure togli il prefisso prima di inoltrare la richiesta al Durable Object, che è più semplice), tutte le `fetch('/api/...')` e `new WebSocket(.../ws)` in `app.js`, la `fetch('/api/push/subscribe')` in `sw.js`.
4. Asset: copia `public/` in una sottocartella degli asset dell'ospite, oppure servila sotto il prefisso. Attenzione: `sw.js` controlla solo il proprio scope. Se l'asta vive sotto `/asta/`, registra il service worker come `/asta/sw.js` con scope `/asta/` e aggiorna `start_url` e `scope` nel manifest. Su iOS la PWA installata deve essere quella dell'asta (o un'app ospite che includa questi handler push).
5. Gli stili di `public/style.css` usano selettori globali (`body`, `h2`, `.card`, …). Se l'asta convive con altre pagine nello stesso documento, mettili sotto un contenitore (es. `#asta-root`).

### C. App ospite NON su Cloudflare
Pubblica l'asta come in A (su un sottodominio della tua app) e collegala. Se proprio devi chiamare le API da un'altra origin, servono CORS con credenziali e il cookie `SameSite=None; Secure`. È sconsigliato: le push devono comunque essere sottoscritte da una pagina dell'origin dell'asta.

### Riutilizzare il login dell'app ospite (opzionale)
L'unico punto da toccare è `currentUser(req)` in `league.js`: oggi legge il cookie `sid`. Per usare il login dell'ospite, verifica lì il suo token (JWT, cookie di sessione o header aggiunto dal Worker ospite) e mappalo a una riga di `users` (creala al primo accesso con email e nome; la password può restare un valore casuale). Togli il modulo login/iscrizione da `renderAuth()` in `app.js` e lascia solo la scelta della squadra (`renderPickTeam`). **Non toccare** il resto: squadre, ruoli admin, `as_team` e notifiche dipendono solo da `users.id`, `users.team_id` e `users.is_admin`.

## 10. Cose da NON cambiare
- Un'unica istanza del Durable Object per lega (`idFromName('cfp')`; per più leghe, un nome per lega) e mutazioni sincrone dentro `transactionSync`.
- Destinatari, payload e `tag` delle notifiche (sezione 8.1).
- Regole della sezione 2: partecipano solo squadre con allenatore e cambi; vince l'ultimo rimasto; crediti negativi ammessi; svincolo di qualsiasi ruolo oltre `roster_max`; la prossima asta parte solo dopo lo svincolo; il turno resta finché non si acquista o si scambia.
- Gli svincolati si calcolano dal listone, non si caricano.
- Nomi dei giocatori copiati in `moves`.

## 11. Limitazioni note
- L'app non invia email: le password dimenticate le reimposta l'admin dal cockpit.
- Non c'è timer sulle aste: l'admin gestisce gli assenti con "ritira" o "aggiudica ora".
- Gli scambi sono 1 contro 1 (più crediti).
- Pensata per una lega di 12 squadre: lo stato completo viaggia a ogni aggiornamento (circa 70 KB). Va bene fino a qualche decina di utenti; oltre, conviene mandare aggiornamenti incrementali.

## 12. Verifica (obbligatoria dopo l'integrazione)
```bash
npm install
npx wrangler dev --port 8787          # terminale 1 (ambiente locale, MAI produzione)
cd test && npm install
npm test                               # crittografia push + 35 controlli sulle regole: deve finire con "TUTTI I CONTROLLI SUPERATI"
npx playwright install chromium && npm run test:ui   # due telefoni simulati, tempo reale
```
`BASE_URL` e `ADMIN_PASSWORD` sono variabili d'ambiente opzionali. I test **cancellano i dati** del server a cui puntano (`reset_all`): usali solo in locale o in un ambiente di prova. Se hai aggiunto un prefisso ai percorsi (9.B), aggiorna anche `api()` nei test.

Prova manuale delle notifiche, dopo il deploy in HTTPS:
1. Android (Chrome) e desktop: apri l'app → 🔔 → Attiva → "Invia notifica di prova".
2. iPhone: Safari → Condividi → Aggiungi alla schermata Home → apri dall'icona → 🔔 → Attiva → prova.
3. Con due account: A chiama un giocatore e B riceve "Asta aperta"; B rilancia e A riceve il rilancio; B si ritira e da quel momento **non riceve più** notifiche su quel giocatore.
