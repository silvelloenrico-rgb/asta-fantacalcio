import XLSX from 'xlsx';
import { parseRose, parseSvincolati } from '../public/xlsx-parse.js';
const BASE = 'http://localhost:8787';
const U = '/root/.claude/uploads/6071e3f5-f3e6-5fcc-ae06-ae77ef8892e2/';
const rose = parseRose(XLSX, XLSX.readFile(U + '1ffa4ff9-rose-308228-1.xlsx'));
const svi = parseSvincolati(XLSX, XLSX.readFile(U + 'e7f9d34f-svincolati-valore-308228.xlsx'));
console.log('rose:', rose.map(t => `${t.name}=${t.credits}cr/${t.players.length}p`).join(', '));
console.log('svincolati:', svi.length, svi.slice(0,2));
const jar = {};
async function api(who, path, body) {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: jar[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const j = await r.json(); if (j.error) throw new Error(`${who} ${path} ${JSON.stringify(body)} -> ${j.error}`); return j;
}
const expectErr = async (p, label) => { try { await p; console.log('!! EXPECTED ERROR missing:', label); } catch (e) { console.log('  ok rejected:', label, '→', e.message.split('-> ')[1]); } };
await api('admin', '/api/login', { email: 'silvello.enrico@gmail.com', password: 'secret1' });
console.log(await api('admin', '/api/admin', { type: 'import_rose', teams: rose }));
console.log(await api('admin', '/api/admin', { type: 'import_svincolati', players: svi }));
let st = await api('admin', '/api/state');
const teams = st.teams; const T = n => teams.find(t => t.name.includes(n)).id;
await api('admin', '/api/me/team', { team_id: T('Real Paese') });
let i = 0;
for (const t of teams) { if (t.name.includes('Real Paese')) continue; i++; await api('u' + t.id, '/api/register', { email: `u${i}@x.it`, name: 'Coach' + i, password: 'pwpwpw', team_id: t.id }); }
await expectErr(api('dup', '/api/register', { email: 'dup@x.it', name: 'Dup', password: 'pwpwpw', team_id: T('Diva') }), 'squadra già presa');
const who = id => id === T('Real Paese') ? 'admin' : 'u' + id;
await api('admin', '/api/admin', { type: 'settings', settings: { default_cambi: '2', global_extra: '10' }, apply_cambi_all: true });
await expectErr(api(who(T('Sciambolezze')), '/api/action', { type: 'call', player_id: 1 }), 'call prima di start');
await api('admin', '/api/admin', { type: 'start' });
st = await api('admin', '/api/state');
const tn = id => st.teams.find(t => t.id === id).name;
console.log('turno:', tn(+st.settings.turn_team_id));
const sow = st.players.find(p => p.name === 'Sow');
const t1 = T('Sciambolezze'), t2 = T('AtaLanza'), t3 = T('Bubble');
await expectErr(api(who(t2), '/api/action', { type: 'call', player_id: sow.id }), 'call fuori turno');
await api(who(t1), '/api/action', { type: 'call', player_id: sow.id, amount: 1 });
st = await api('admin', '/api/state');
console.log('asta:', st.auction.player.name, st.auction.current_bid, st.auction.participants.map(p => tn(p.team_id).slice(0,8) + ':' + p.status).join(' '));
await expectErr(api(who(t3), '/api/action', { type: 'raise', amount: 1 }), 'rilancio troppo basso');
await api(who(t3), '/api/action', { type: 'raise', amount: 5 });
await api(who(t2), '/api/action', { type: 'raise', amount: 6 });
await expectErr(api(who(t2), '/api/action', { type: 'withdraw' }), 'leader non può ritirarsi');
// everyone except t3 and t2 withdraws
for (const p of st.auction.participants) if (p.status === 'active' && ![t2, t3].includes(p.team_id)) await api(who(p.team_id), '/api/action', { type: 'withdraw' });
st = await api('admin', '/api/state'); console.log('still open:', st.auction.status, 'leader', tn(st.auction.leader_team_id), st.auction.current_bid);
await api(who(t3), '/api/action', { type: 'withdraw' });
st = await api('admin', '/api/state');
console.log('chiusa:', st.auction.status, 'vincitore', tn(st.auction.winner_team_id), 'turno ancora a', tn(+st.settings.turn_team_id));
const at2 = st.teams.find(t => t.id === t2); console.log('AtaLanza credits', at2.credits, 'avail', at2.avail, 'cambi_left', at2.cambi_left, 'pending', at2.pending_release, 'C count', at2.counts.C);
await expectErr(api(who(t2), '/api/action', { type: 'call', player_id: 2 }), 'non è turno');
// t2 releases a C
const relC = st.players.find(p => p.team_id === t2 && p.role === 'C');
await api(who(t2), '/api/action', { type: 'release', player_id: relC.id });
// caller t1 calls another and wins himself (everyone withdraws)
const loc = st.players.find(p => p.name === 'Locatelli M');
await api(who(t1), '/api/action', { type: 'call', player_id: loc.id, amount: 2 });
st = await api('admin', '/api/state');
for (const p of st.auction.participants) if (p.status === 'active' && p.team_id !== t1) await api(who(p.team_id), '/api/action', { type: 'withdraw' });
st = await api('admin', '/api/state');
console.log('Locatelli →', tn(st.auction.winner_team_id), '| turno ora a', tn(+st.settings.turn_team_id), '| t1 pending', st.teams.find(t=>t.id===t1).pending_release);
// t2 turn: propose trade to Diva Gold
const cur = +st.settings.turn_team_id;
const myP = st.players.find(p => p.team_id === cur && p.role === 'A');
const theirP = st.players.find(p => p.team_id === T('Diva') && p.role === 'A');
const tr = await api(who(cur), '/api/action', { type: 'trade_propose', offered_player_id: myP.id, requested_player_id: theirP.id, credits: -3 });
await expectErr(api(who(cur), '/api/action', { type: 'call', player_id: loc.id + 1 }), 'call con scambio pendente');
await api(who(T('Diva')), '/api/action', { type: 'trade_accept', trade_id: tr.trade_id });
st = await api('admin', '/api/state');
console.log('scambio ok:', st.players.find(p => p.id === myP.id).team_id === T('Diva'), '| turno ora a', tn(+st.settings.turn_team_id));
console.log('cambi:', st.teams.map(t => t.name.slice(0,10) + ' ' + t.cambi_used + '/' + t.cambi_max + ' cr' + t.credits).join(' | '));
console.log('Bubble maxBid', st.teams.find(t=>t.id===t3).maxBid);
console.log('events:\n' + st.events.slice(0, 14).reverse().map(e => '  ' + e.text).join('\n'));
