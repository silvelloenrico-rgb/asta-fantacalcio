import { chromium } from 'playwright';
const B = 'http://localhost:8787';
const OUT = '/tmp/claude-0/shots/'; import fs from 'fs'; fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
async function user(email, pw) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route(/cdnjs\.cloudflare\.com.*xlsx/, r => r.fulfill({ path: 'node_modules/xlsx/dist/xlsx.full.min.js', contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR', email, e.message));
  p.on('console', m => { if (m.type() === 'error' && !m.text().includes('fonts')) console.log('CONSOLE', email, m.text()); });
  await p.goto(B);
  await p.fill('input[name=email]', email); await p.fill('input[name=password]', pw);
  await p.click('button[type=submit]'); await p.waitForSelector('nav.tabs');
  return p;
}
const shot = (p, n) => p.screenshot({ path: OUT + n + '.png', fullPage: false });
// login page screenshot
{ const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage(); await p.goto(B); await p.click('[data-auth=register]'); await p.waitForTimeout(300); await shot(p, '00-register'); }
const bubble = await user('u3@x.it', 'pwpwpw'); // Bubble Cheese = 3rd team, u2 (i starts at 1 skipping Real Paese) 
const name = await bubble.textContent('.brand small'); console.log('u2 team:', name);
const diva = await user('u4@x.it', 'pwpwpw');
console.log('u3 team:', await diva.textContent('.brand small'));
const admin = await user('silvello.enrico@gmail.com', 'secret1');
await shot(bubble, '01-turno');
// Bubble calls a player via UI
await bubble.click('[data-tab=svincolati]');
await bubble.fill('#search', 'bartes'); await bubble.waitForTimeout(200);
await shot(bubble, '02-svincolati');
await bubble.click('[data-call]'); await bubble.fill('#openbid', '3'); await shot(bubble, '03-chiama');
await bubble.click('#docall'); await bubble.waitForTimeout(600);
await shot(bubble, '04-leader');
await diva.waitForSelector('.auction', { timeout: 5000 }); // realtime via websocket
await shot(diva, '05-asta-live-diva');
await diva.click('[data-raise]'); await diva.waitForTimeout(500);
await bubble.waitForFunction(() => document.querySelector('.bid .amt')?.textContent === '4', null, { timeout: 5000 });
console.log('realtime raise visible to bubble: OK');
await shot(admin, '06-admin-asta');
await admin.click('[data-tab=admin]'); await admin.waitForTimeout(300);
await admin.screenshot({ path: OUT + '07-admin.png', fullPage: true });
await diva.click('[data-tab=rose]'); await diva.click('.tcard >> nth=0'); await diva.waitForTimeout(200);
await shot(diva, '08-rosa');
await browser.close();
