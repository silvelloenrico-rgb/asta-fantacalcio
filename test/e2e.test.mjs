// End-to-end test of the whole auction against a running server.
// 1) in the project root:  npx wrangler dev --port 8787
// 2) in test/:             npm install && npm test
// ATTENTION: it wipes all data (reset_all) on the target server. Never point it at production.
import XLSX from 'xlsx';
import { parseRose, parseSvincolati } from '../public/xlsx-parse.js';

const B = process.env.BASE_URL || 'http://localhost:8787';
const ADMIN = { email: 'silvello.enrico@gmail.com', password: process.env.ADMIN_PASSWORD || 'secret1', name: 'Admin' };
const rose = parseRose(XLSX, XLSX.readFile(new URL('./fixtures/rose-esempio.xlsx', import.meta.url).pathname));
const listone = parseSvincolati(XLSX, XLSX.readFile(new URL('./fixtures/listone-esempio.xlsx', import.meta.url).pathname));

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) failures++; };
const jar = {};
async function api(who, path, body) {
  const r = await fetch(B + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: jar[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const j = await r.json(); if (j.error) throw new Error(j.error); return j;
}
const rejects = async (p, msg) => { try { await p; ok(false, msg + ' (doveva essere bloccato)'); } catch (e) { ok(true, `${msg} → "${e.message}"`); } };

console.log('Setup');
try { await api('admin', '/api/register', ADMIN); } catch { await api('admin', '/api/login', ADMIN); }
await api('admin', '/api/admin', { type: 'reset_all' });
await api('admin', '/api/admin', { type: 'settings', settings: { roster_max: '25', release_refund: 'none', base_mode: 'uno', min_raise: '1', global_extra: '0', scambi_as_cambi: '1', max_scambi: '0' } });
const r1 = await api('admin', '/api/admin', { type: 'import_listone', players: listone });
const r2 = await api('admin', '/api/admin', { type: 'import_rose', teams: rose });
let st = await api('admin', '/api/state');
const nRost = rose.reduce((n, t) => n + t.players.length, 0);
ok(r2.teams === 12 && st.teams.length === 12, '12 squadre importate');
ok(st.players.filter((p) => p.team_id).length === nRost, `${nRost} giocatori in rosa`);
ok(st.players.filter((p) => !p.team_id).length === r1.listone - nRost, `svincolati = listone (${r1.listone}) − in rosa (${nRost})`);
ok(new Set(st.players.map((p) => p.name + '|' + p.club)).size === st.players.length, 'nessun giocatore doppio');
ok(st.players.filter((p) => p.team_id && p.quotazione == null).length === 0, 'quotazioni assegnate ai giocatori in rosa');
ok(st.teams[0].credits === 0 && st.teams[2].credits === 500, 'crediti letti dal titolo del foglio');

const T = (i) => st.teams[i].id; // by sheet order
const ADMIN_TEAM = 7;
await api('admin', '/api/me/team', { team_id: T(ADMIN_TEAM) });
for (let i = 0; i < 12; i++) {
  if (i === ADMIN_TEAM) continue;
  const u = { email: `coach${i}@esempio.it`, name: 'Coach ' + i, password: 'password', team_id: T(i) };
  try { await api('u' + i, '/api/register', u); } catch { // account left over from a previous run
    await api('u' + i, '/api/login', u);
    const me = (await api('u' + i, '/api/state')).me;
    await api('admin', '/api/admin', { type: 'user_update', user_id: me.id, team_id: T(i) });
  }
}
// detach any other leftover account (e.g. from ui.test) so only these 12 coaches play
for (const u of (await api('admin', '/api/state')).users) if (!/^coach\d+@esempio\.it$/.test(u.email) && u.email !== ADMIN.email) await api('admin', '/api/admin', { type: 'user_update', user_id: u.id, team_id: '' });
await rejects(api('x', '/api/register', { email: 'x@esempio.it', name: 'Xavier', password: 'password', team_id: T(0) }), 'squadra già scelta');
const who = (id) => { const i = st.teams.findIndex((t) => t.id === id); return i === ADMIN_TEAM ? 'admin' : 'u' + i; };

await api('admin', '/api/admin', { type: 'settings', settings: { default_cambi: '2', release_refund: 'min' }, apply_cambi_all: true });
for (let i = 7; i < 12; i++) await api('admin', '/api/admin', { type: 'team_update', team_id: T(i), cambi_max: 0 });
await rejects(api('u0', '/api/action', { type: 'call', player_id: st.players.find((p) => !p.team_id).id }), 'chiamata prima dell\'avvio');
await api('admin', '/api/admin', { type: 'start' });
st = await api('admin', '/api/state');
ok(+st.settings.turn_team_id === T(0), 'il primo turno è della prima squadra');

console.log('Asta');
const t1 = T(0);
const def = st.players.find((p) => !p.team_id && p.role === 'D');
await rejects(api('u1', '/api/action', { type: 'call', player_id: def.id }), 'chiamata fuori turno');
await api(who(t1), '/api/action', { type: 'call', player_id: def.id, amount: 1 });
st = await api('admin', '/api/state');
ok(st.auction.status === 'open' && st.auction.current_bid === 1, 'asta aperta a 1');
ok(st.auction.participants.filter((p) => p.status === 'active').length === 7, 'partecipano solo i 7 con cambi');
const t2 = T(1);
await rejects(api(who(t2), '/api/action', { type: 'raise', amount: 1 }), 'rilancio sotto il minimo');
await api(who(t2), '/api/action', { type: 'raise', amount: 10 });
await api(who(t1), '/api/action', { type: 'raise', amount: 15 });
await rejects(api(who(t1), '/api/action', { type: 'withdraw' }), 'il migliore offerente non può ritirarsi');
for (const p of st.auction.participants) if (p.status === 'active' && p.team_id !== t1) await api(who(p.team_id), '/api/action', { type: 'withdraw' });
st = await api('admin', '/api/state');
const w = st.teams.find((t) => t.id === t1);
ok(st.auction.status === 'closed' && st.auction.winner_team_id === t1, 'vince l\'ultimo rimasto');
ok(w.avail === -15, 'crediti in negativo ammessi (0 − 15 = −15)');
ok(w.cambi_used === 1, 'l\'acquisto consuma 1 cambio');
ok(w.roster === 26 && w.pending_release.length === 1, 'oltre 25 giocatori → svincolo obbligatorio');
ok(+st.settings.turn_team_id === t2, 'chi compra perde il turno, tocca al successivo');
ok(st.moves[0].kind === 'acquisto' && st.moves[0].amount === 15, 'movimento "acquisto" registrato');

console.log('Svincolo');
const other = st.players.find((p) => !p.team_id && p.role === 'A');
await rejects(api(who(t2), '/api/action', { type: 'call', player_id: other.id }), 'nuova asta prima dello svincolo');
const relC = st.players.filter((p) => p.team_id === t1 && p.role === 'C' && p.quotazione != null).sort((a, b) => (b.cost - b.quotazione) - (a.cost - a.quotazione))[0];
const before = w.credits;
await api(who(t1), '/api/action', { type: 'release', player_id: relC.id });
st = await api('admin', '/api/state');
const w2 = st.teams.find((t) => t.id === t1);
ok(w2.credits - before === Math.min(relC.cost, relC.quotazione), `rimborso = min(costo ${relC.cost}, quotazione ${relC.quotazione})`);
ok(w2.counts.D === 9 && w2.counts.C === 7 && w2.roster === 25, 'svincolo di un ruolo diverso (compro D, svincolo C)');
ok(!st.players.find((p) => p.id === relC.id).team_id, 'il giocatore svincolato torna tra gli svincolati');
ok(st.moves[0].kind === 'svincolo', 'movimento "svincolo" registrato');

console.log('Scambio');
const t3 = T(3);
const mine = st.players.find((p) => p.team_id === t2 && p.role === 'A');
const theirs = st.players.find((p) => p.team_id === t3 && p.role === 'P');
const tr = await api(who(t2), '/api/action', { type: 'trade_propose', offered_player_id: mine.id, requested_player_id: theirs.id, credits: 100 });
await rejects(api(who(t2), '/api/action', { type: 'call', player_id: other.id }), 'chiamata con scambio in attesa');
const c2 = st.teams.find((t) => t.id === t2).credits;
await api(who(t3), '/api/action', { type: 'trade_accept', trade_id: tr.trade_id });
st = await api('admin', '/api/state');
ok(st.players.find((p) => p.id === mine.id).team_id === t3 && st.players.find((p) => p.id === theirs.id).team_id === t2, 'giocatori scambiati (anche ruoli diversi)');
ok(st.teams.find((t) => t.id === t2).credits === c2 - 100, 'crediti trasferiti, anche andando in negativo');
ok(st.teams.find((t) => t.id === t3).cambi_used === 1, 'lo scambio consuma un cambio anche all\'altra squadra');
ok(+st.settings.turn_team_id !== t2, 'dopo lo scambio il turno passa');
ok(st.moves[0].kind === 'scambio', 'movimento "scambio" registrato');

console.log('Turni e fine');
const cur = +st.settings.turn_team_id;
await api(who(cur), '/api/action', { type: 'pass' });
st = await api('admin', '/api/state');
ok(+st.settings.turn_team_id !== cur, 'passo il turno');
for (const t of st.teams) await api('admin', '/api/admin', { type: 'team_update', team_id: t.id, cambi_max: t.cambi_used });
await api('admin', '/api/admin', { type: 'skip_turn' });
st = await api('admin', '/api/state');
ok(st.settings.phase === 'finished', 'senza più cambi l\'asta termina da sola');

console.log('Admin aggiuntivi');
const coach1 = st.users.find((u) => u.email === 'coach1@esempio.it');
await rejects(api('u1', '/api/admin', { type: 'pause' }), 'un allenatore normale non può usare il cockpit');
await api('admin', '/api/admin', { type: 'user_update', user_id: coach1.id, is_admin: true });
ok((await api('u1', '/api/state')).me.is_admin === true, 'l\'admin nomina un altro admin');
await api('u1', '/api/admin', { type: 'set_order', team_ids: st.teams.map((t) => t.id) });
ok(true, 'il nuovo admin può usare il cockpit');
const main = st.users.find((u) => u.email === ADMIN.email);
await rejects(api('u1', '/api/admin', { type: 'user_update', user_id: main.id, is_admin: false }), 'l\'admin principale non può essere revocato');
await api('admin', '/api/admin', { type: 'user_update', user_id: coach1.id, is_admin: false });
await rejects(api('u1', '/api/admin', { type: 'pause' }), 'admin revocato: niente più cockpit');

console.log('Notifiche (registrazione)');
await api('u0', '/api/push/subscribe', { endpoint: 'https://example.invalid/push/1', keys: { p256dh: 'BOr3jEk3VUe3ccxw3c0hXk7nbHq1RTWv7Xx2JzOq3P1LqSPq6R0h2zJ0yQq7v3Hk0gT0j1J9mXn6c8ZP3x1y2nM', auth: 'c2VjcmV0c2VjcmV0MTIz' } });
const pt = await api('u0', '/api/push/test', {});
ok(pt.subs === 1, 'sottoscrizione push salvata');
ok(typeof st.vapidPublicKey === 'string' && st.vapidPublicKey.length > 80, 'chiave pubblica VAPID esposta');

console.log(failures ? `\n${failures} CONTROLLI FALLITI` : '\nTUTTI I CONTROLLI SUPERATI');
process.exit(failures ? 1 : 0);
