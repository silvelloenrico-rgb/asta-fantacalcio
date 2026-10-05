import XLSX from 'xlsx';
import { parseRose, parseSvincolati } from '../public/xlsx-parse.js';
const B = 'http://localhost:8787', U = '/root/.claude/uploads/6071e3f5-f3e6-5fcc-ae06-ae77ef8892e2/';
const rose = parseRose(XLSX, XLSX.readFile(U + '1ffa4ff9-rose-308228-1.xlsx'));
const L = parseSvincolati(XLSX, XLSX.readFile(U + '70e4445d-quotazioni-valore.xlsx'));
const jar = {};
async function api(w, p, b) { const r = await fetch(B + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: jar[w] || '' }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) jar[w] = sc.split(';')[0]; const j = await r.json(); if (j.error) throw new Error(j.error); return j; }
const expectErr = async (p, l) => { try { await p; console.log('!! manca errore:', l); } catch (e) { console.log('  ok bloccato:', l, '→', e.message); } };
await api('admin', '/api/register', { email: 'silvello.enrico@gmail.com', name: 'Enrico', password: 'secret1' });
await api('admin', '/api/admin', { type: 'import_rose', teams: rose });
await api('admin', '/api/admin', { type: 'import_listone', players: L });
let st = await api('admin', '/api/state');
const T = (n) => st.teams.find((t) => t.name.includes(n)).id;
await api('admin', '/api/me/team', { team_id: T('Real Paese') });
let i = 0;
for (const t of st.teams) { if (t.name.includes('Real Paese')) continue; i++; await api('u' + t.id, '/api/register', { email: `u${i}@x.it`, name: 'Coach' + i, password: 'pwpwpw', team_id: t.id }); }
const who = (id) => (id === T('Real Paese') ? 'admin' : 'u' + id);
await api('admin', '/api/admin', { type: 'settings', settings: { default_cambi: '2', release_refund: 'min' }, apply_cambi_all: true });
// 5 teams with no cambi left
const noCambi = st.teams.slice(7).map((t) => t.id);
for (const id of noCambi) await api('admin', '/api/admin', { type: 'team_update', team_id: id, cambi_max: 0 });
await api('admin', '/api/admin', { type: 'start' });
st = await api('admin', '/api/state');
const tn = (id) => st.teams.find((t) => t.id === id).name;
const t1 = +st.settings.turn_team_id;
console.log('turno a', tn(t1), 'crediti', st.teams.find((t) => t.id === t1).avail);
// Ac Sciambolezze has 0 credits: calls a D at 1 and wins at 15 -> negative credits allowed
const def = st.players.find((p) => !p.team_id && p.role === 'D' && p.quotazione >= 8);
await api(who(t1), '/api/action', { type: 'call', player_id: def.id, amount: 1 });
st = await api('admin', '/api/state');
const act = st.auction.participants.filter((p) => p.status === 'active').length;
console.log('partecipanti attivi', act, '(attesi 7: 12 squadre meno 5 senza cambi)');
const t2 = st.auction.participants.find((p) => p.status === 'active' && p.team_id !== t1).team_id;
await api(who(t2), '/api/action', { type: 'raise', amount: 10 });
await api(who(t1), '/api/action', { type: 'raise', amount: 15 });
for (const p of st.auction.participants) if (p.status === 'active' && p.team_id !== t1) await api(who(p.team_id), '/api/action', { type: 'withdraw' });
st = await api('admin', '/api/state');
const w = st.teams.find((t) => t.id === t1);
console.log(def.name, '(D) →', tn(st.auction.winner_team_id), 'a', st.auction.current_bid, '| crediti ora', w.avail, '| rosa', w.roster, '| deve svincolare', w.pending_release.length === 1);
// release a C (different role)
const relC = st.players.filter((p) => p.team_id === t1 && p.role === 'C').sort((a, b) => b.cost - a.cost)[0];
await api(who(t1), '/api/action', { type: 'release', player_id: relC.id });
st = await api('admin', '/api/state');
const w2 = st.teams.find((t) => t.id === t1);
console.log('svincolato', relC.name, '(C) costo', relC.cost, 'quot', relC.quotazione, '| crediti', w2.avail, '| rosa', w2.roster, '| D', w2.counts.D, 'C', w2.counts.C);
// trade with credits beyond availability (negative allowed)
const cur = +st.settings.turn_team_id;
const mine = st.players.find((p) => p.team_id === cur && p.role === 'A');
const theirs = st.players.find((p) => p.team_id === T('Diva') && p.role === 'P');
const tr = await api(who(cur), '/api/action', { type: 'trade_propose', offered_player_id: mine.id, requested_player_id: theirs.id, credits: 100 });
await api(who(T('Diva')), '/api/action', { type: 'trade_accept', trade_id: tr.trade_id });
st = await api('admin', '/api/state');
console.log('scambio ruoli diversi (A per P) con 100 crediti: crediti', tn(cur), st.teams.find((t) => t.id === cur).avail);
console.log('movimenti:'); for (const m of st.moves.slice().reverse()) console.log('  ', m.kind, tn(m.team_id), m.player_name, m.player_role, m.amount, m.other_team_id ? '⇄ ' + tn(m.other_team_id) + ' ' + m.other_player_name : '');
