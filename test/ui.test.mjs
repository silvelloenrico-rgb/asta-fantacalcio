// Browser test (Playwright): two coaches on two phones, realtime auction via WebSocket.
// Needs a running server (npx wrangler dev --port 8787). Wipes data. Never run against production.
import { chromium } from 'playwright';
import XLSX from 'xlsx';
import { parseRose, parseSvincolati } from '../public/xlsx-parse.js';
const B = process.env.BASE_URL || 'http://localhost:8787';
const ADMIN = { email: 'silvello.enrico@gmail.com', password: process.env.ADMIN_PASSWORD || 'secret1', name: 'Admin' };
const jar = {};
async function api(who, path, body) {
  const r = await fetch(B + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: jar[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const j = await r.json(); if (j.error) throw new Error(j.error); return j;
}
try { await api('a', '/api/register', ADMIN); } catch { await api('a', '/api/login', ADMIN); }
await api('a', '/api/admin', { type: 'reset_all' });
await api('a', '/api/admin', { type: 'import_rose', teams: parseRose(XLSX, XLSX.readFile(new URL('./fixtures/rose-esempio.xlsx', import.meta.url).pathname)) });
await api('a', '/api/admin', { type: 'import_listone', players: parseSvincolati(XLSX, XLSX.readFile(new URL('./fixtures/listone-esempio.xlsx', import.meta.url).pathname)) });
const st = await api('a', '/api/state');
for (const [i, t] of st.teams.slice(0, 2).entries()) { try { await api('c' + i, '/api/register', { email: `ui${i}@esempio.it`, name: 'Ui ' + i, password: 'password', team_id: t.id }); } catch {} }
await api('a', '/api/admin', { type: 'start' });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function phone(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('ERRORE JS', e.message); process.exitCode = 1; });
  await p.goto(B); await p.fill('input[name=email]', email); await p.fill('input[name=password]', 'password');
  await p.click('button[type=submit]'); await p.waitForSelector('nav.tabs');
  return p;
}
const a = await phone('ui0@esempio.it'), b = await phone('ui1@esempio.it');
await a.click('[data-tab=svincolati]'); await a.click('[data-call] >> nth=0'); await a.click('#docall');
await b.waitForSelector('.auction', { timeout: 5000 }); console.log('✔ B vede l\'asta aperta da A in tempo reale');
await b.click('[data-raise] >> nth=0');
await a.waitForFunction(() => document.querySelector('.bid .amt')?.textContent === '2', null, { timeout: 5000 }); console.log('✔ A vede il rilancio di B in tempo reale');
for (const t of ['rose', 'movimenti', 'log']) { await a.click(`[data-tab=${t}]`); await a.waitForTimeout(200); }
console.log('✔ tutte le sezioni si aprono senza errori');
await browser.close();
