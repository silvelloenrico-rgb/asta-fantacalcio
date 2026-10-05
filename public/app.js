import { parseRose, parseSvincolati } from './xlsx-parse.js';

const ROLES = ['P', 'D', 'C', 'A'];
const ROLE_LBL = { P: 'Portieri', D: 'Difensori', C: 'Centrocampisti', A: 'Attaccanti' };
const ROLE_ONE = { P: 'portiere', D: 'difensore', C: 'centrocampista', A: 'attaccante' };
const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

let S = null; // server state
const ui = {
  tab: (location.hash || '#asta').slice(1),
  authMode: 'login',
  search: '', role: '', onlyAffordable: false,
  teamView: null,
  actingTeam: null,
  lastEventId: null,
  lastBid: null,
};

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = (ts) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const dayhm = (ts) => new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---------------- api ----------------
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j.error) { const e = new Error(j.error || 'Errore di rete (' + r.status + ')'); e.status = r.status; throw e; }
  return j;
}
async function act(type, extra = {}) {
  const body = { type, ...extra };
  if (ui.actingTeam) body.as_team = ui.actingTeam;
  try { await api('/api/action', body); await load(); return true; } catch (e) { toast(e.message, true); return false; }
}
async function admin(type, extra = {}, okMsg) {
  try { const r = await api('/api/admin', { type, ...extra }); if (okMsg) toast(okMsg); await load(); return r; } catch (e) { toast(e.message, true); return null; }
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 5000 : 3500);
}

// ---------------- data load + realtime ----------------
let loading = null, again = false;
async function load() {
  if (loading) { again = true; return loading; }
  loading = (async () => {
    try {
      const st = await api('/api/state');
      const fresh = !S;
      S = st;
      if (!fresh) announceNewEvents();
      ui.lastEventId = S.events[0]?.id ?? 0;
      render();
      connectWS();
    } catch (e) {
      if (e.status === 401) { S = null; renderAuth(); } else toast(e.message, true);
    }
  })();
  await loading;
  loading = null;
  if (again) { again = false; return load(); }
}

function announceNewEvents() {
  const news = S.events.filter((e) => e.id > (ui.lastEventId ?? Infinity)).slice(0, 3).reverse();
  for (const e of news) if (['auction', 'bid', 'won', 'trade', 'turn', 'phase'].includes(e.kind)) toast(e.text);
}

let ws = null, wsTimer = null, wsBackoff = 1000;
function connectWS() {
  if (ws && ws.readyState <= 1) return;
  try {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  } catch { return; }
  ws.onopen = () => { wsBackoff = 1000; };
  ws.onmessage = (m) => { if (m.data !== 'pong') scheduleLoad(); };
  ws.onclose = () => { ws = null; clearTimeout(wsTimer); wsTimer = setTimeout(() => { if (S) { connectWS(); load(); } }, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 15000); };
}
let schedT = null;
function scheduleLoad() { clearTimeout(schedT); schedT = setTimeout(load, 120); }
setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 25000);
setInterval(() => { if (S && document.visibilityState === 'visible') load(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S) load(); });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'push') scheduleLoad(); });

// ---------------- derived helpers ----------------
const team = (id) => S.teams.find((t) => t.id === id);
const tname = (id) => team(id)?.name ?? '—';
const player = (id) => S.players.find((p) => p.id === id);
const myTeamId = () => ui.actingTeam || S.me.team_id;
const myTeam = () => team(myTeamId());
const turnId = () => parseInt(S.settings.turn_team_id) || null;
const openAuction = () => (S.auction && S.auction.status === 'open' ? S.auction : null);
const isMyTurn = () => S.settings.phase === 'running' && turnId() && turnId() === myTeamId();
const myPendingTrade = () => S.trades.find((t) => t.status === 'pending' && t.from_team_id === myTeamId());
const incomingTrades = () => S.trades.filter((t) => t.status === 'pending' && t.to_team_id === myTeamId());
const basePrice = (p) => (S.settings.base_mode === 'quotazione' ? Math.max(1, p.quotazione || 1) : 1);
const canCall = () => isMyTurn() && !openAuction() && !myPendingTrade() && myTeam()?.cambi_left > 0 && !myTeam()?.pending_release.length;
const canTrade = () => isMyTurn() && !openAuction() && !myPendingTrade() && myTeam()?.scambi_left !== 0;
const scambiLbl = (t) => (t.scambi_left === -1 ? '∞' : t.scambi_left);
const tradesSeparate = () => S.settings.scambi_as_cambi !== '1';
const lim = (r) => parseInt(S.settings['lim_' + r]) || 0;
const rosterSize = () => ROLES.reduce((n, r) => n + lim(r), 0);
const pill = (r) => `<span class="pill ${r}">${r}</span>`;

// ---------------- rendering ----------------
function keepInputs(fn) {
  const active = document.activeElement;
  const activeId = active && active.id;
  const sel = activeId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  const vals = {};
  $app.querySelectorAll('input[id],select[id],textarea[id]').forEach((el) => { if (el.dataset.keep !== undefined) vals[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  fn();
  for (const [id, v] of Object.entries(vals)) { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } }
  if (activeId) { const el = document.getElementById(activeId); if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} } }
}

function render() {
  if (!S) return renderAuth();
  if (!S.me.team_id && !S.me.is_admin) return renderPickTeam();
  keepInputs(() => {
    const t = myTeam();
    const tabs = [
      ['asta', '🔨', 'Asta'],
      ['svincolati', '📋', 'Svincolati'],
      ['rose', '👥', 'Rose'],
      ['scambi', '🔄', 'Scambi', incomingTrades().length],
      ['log', '🕒', 'Diario'],
      ...(S.me.is_admin ? [['admin', '⚙️', 'Admin']] : []),
    ];
    if (!tabs.some((x) => x[0] === ui.tab)) ui.tab = 'asta';
    const pushOn = S.mySubs > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    $app.innerHTML = `
      <div class="shell">
        <header class="top">
          <div class="brand">Asta CFP<small>${t ? esc(t.name) : 'Admin'}${ui.actingTeam ? ' · via admin' : ''}</small></div>
          <div class="spacer"></div>
          ${t ? `<div class="wallet"><b>${t.avail}</b><span>crediti · ${t.cambi_left} cambi</span></div>` : ''}
          <button class="iconbtn ${pushOn ? 'on' : 'off'}" data-a="push" title="Notifiche">🔔</button>
        </header>
        ${S.me.is_admin ? actingBar() : ''}
        <main>${views[ui.tab]()}</main>
      </div>
      <nav class="tabs"><div class="in">${tabs.map(([k, ic, l, b]) => `<button class="${ui.tab === k ? 'active' : ''}" data-tab="${k}"><span class="ic">${ic}</span>${l}${b ? `<span class="badge">${b}</span>` : ''}</button>`).join('')}</div></nav>`;
  });
  flashBid();
}

function actingBar() {
  const opts = S.teams.map((t) => `<option value="${t.id}" ${ui.actingTeam === t.id ? 'selected' : ''}>${esc(t.name)}${t.coach ? '' : ' (senza allenatore)'}</option>`).join('');
  return `<div class="acting ${ui.actingTeam ? '' : 'idle'}" style="${ui.actingTeam ? '' : 'background:var(--card);color:var(--muted)'}">
    <span>Agisci come:</span>
    <select id="acting" style="min-height:32px;padding:4px 8px;flex:1;background:transparent;border-color:currentColor;color:inherit">
      <option value="">${S.me.team_id ? 'La mia squadra (' + esc(tname(S.me.team_id)) + ')' : '— nessuna —'}</option>${opts}
    </select></div>`;
}

function flashBid() {
  const a = openAuction();
  const key = a ? a.id + ':' + a.current_bid : null;
  if (key && ui.lastBid && key !== ui.lastBid) document.querySelector('.bid')?.classList.add('flash');
  ui.lastBid = key;
}

// ---------- auth ----------
async function renderAuth() {
  let teams = [];
  try { teams = (await api('/api/public')).teams; } catch {}
  const free = teams.filter((t) => !t.claimed);
  $app.innerHTML = `
  <div class="auth">
    <div class="logo">Asta<br><em>CFP</em></div>
    <p class="muted">Asta di riparazione della Confederazione Paese Fantacalcio.</p>
    <div class="seg"><button class="${ui.authMode === 'login' ? 'on' : ''}" data-auth="login">Accedi</button><button class="${ui.authMode === 'register' ? 'on' : ''}" data-auth="register">Iscriviti</button></div>
    <form id="authform" class="card">
      ${ui.authMode === 'register' ? `<label class="f"><span>Il tuo nome</span><input type="text" name="name" required autocomplete="name"></label>` : ''}
      <label class="f"><span>Email</span><input type="email" name="email" required autocomplete="email"></label>
      <label class="f"><span>Password</span><input type="password" name="password" required minlength="6" autocomplete="${ui.authMode === 'register' ? 'new-password' : 'current-password'}"></label>
      ${ui.authMode === 'register' ? `<label class="f"><span>La tua squadra</span>
        <select name="team_id"><option value="">${teams.length ? '— scegli la tua squadra —' : 'Le squadre non sono ancora state caricate'}</option>
        ${free.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
        ${teams.length && !free.length ? '<p class="small muted">Tutte le squadre sono già state scelte.</p>' : ''}` : ''}
      <button class="btn primary block big" type="submit" style="margin-top:8px">${ui.authMode === 'login' ? 'Entra' : 'Crea account'}</button>
    </form>
    ${ui.authMode === 'login' ? '<p class="small muted">Password dimenticata? Chiedi all\'admin di reimpostarla.</p>' : ''}
  </div>`;
  document.getElementById('authform').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api(ui.authMode === 'login' ? '/api/login' : '/api/register', fd);
      await load();
    } catch (err) { toast(err.message, true); }
  };
}

function renderPickTeam() {
  const free = S.teams.filter((t) => !t.coach);
  $app.innerHTML = `<div class="auth">
    <div class="logo">Ciao<br><em>${esc(S.me.name)}</em></div>
    <h2>Scegli la tua squadra</h2>
    ${S.teams.length ? '' : '<div class="banner">L\'admin non ha ancora caricato le rose. Torna più tardi!</div>'}
    <div class="list">${free.map((t) => `<div class="li click" data-pick="${t.id}"><div class="grow"><div class="name">${esc(t.name)}</div><div class="sub">${t.avail} crediti</div></div><span>›</span></div>`).join('')}</div>
    <p style="margin-top:24px"><button class="btn ghost" data-a="logout">Esci</button></p>
  </div>`;
}

// ---------- views ----------
const views = {
  asta() {
    const t = myTeam();
    const a = openAuction();
    let h = '';
    const pushOn = S.mySubs > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    if (!pushOn) h += `<div class="card hl"><div class="row"><div class="grow"><b>Attiva le notifiche</b><div class="small muted">Così saprai subito quando si apre un'asta, qualcuno rilancia o ti propongono uno scambio.</div></div><button class="btn primary" data-a="push">Attiva</button></div></div>`;
    if (!t && S.me.is_admin && !ui.actingTeam) h += `<div class="banner small">Sei admin senza squadra: scegline una in <b>Rose</b> oppure usa “Agisci come”.</div>`;

    // obligations
    if (t && t.pending_release.length) h += releaseCard(t);
    for (const tr of incomingTrades()) h += tradeCard(tr, true);

    const ph = S.settings.phase;
    if (ph === 'setup') h += `<div class="card"><h3>L'asta non è ancora iniziata</h3><p class="muted small">L'admin sta preparando rose, svincolati e regole. Riceverai una notifica appena parte.</p></div>`;
    if (ph === 'paused') h += `<div class="card warn"><h3>⏸️ Asta in pausa</h3><p class="small muted">L'admin ha messo in pausa l'asta.</p></div>`;
    if (ph === 'finished') h += `<div class="card good"><h3>🏁 Asta terminata</h3><p class="small muted">Controlla le rose finali nella sezione Rose.</p></div>`;

    if (a) h += auctionCard(a);
    else if (S.auction && S.auction.status === 'closed' && Date.now() - S.auction.ended_at < 10 * 60000) {
      const p = S.auction.player;
      h += `<div class="card good"><div class="small muted">Ultima asta · ${hm(S.auction.ended_at)}</div><div class="row" style="margin-top:6px">${pill(p.role)}<div class="grow"><b>${esc(p.name)}</b> → ${esc(tname(S.auction.winner_team_id))}</div><div class="num">${S.auction.current_bid}</div></div></div>`;
    }

    if (ph === 'running' || ph === 'paused') h += turnCard();
    return h;
  },

  svincolati() {
    const t = myTeam();
    const call = canCall();
    let list = S.players.filter((p) => !p.team_id);
    if (ui.role) list = list.filter((p) => p.role === ui.role);
    if (ui.search) { const q = ui.search.toLowerCase(); list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.club || '').toLowerCase().includes(q)); }
    if (ui.onlyAffordable && t) list = list.filter((p) => basePrice(p) <= t.maxBid[p.role]);
    list.sort((a, b) => (b.quotazione || 0) - (a.quotazione || 0) || a.name.localeCompare(b.name));
    return `
      <h2>Svincolati</h2>
      ${call ? '<div class="banner small">👉 È il tuo turno: tocca <b>Chiama</b> su un giocatore per aprire l\'asta.</div>' : ''}
      <input type="search" id="search" data-keep placeholder="Cerca giocatore o squadra…" value="${esc(ui.search)}">
      <div class="chips" style="margin:10px 0">
        <span class="chip ${!ui.role ? 'on' : ''}" data-role="">Tutti</span>
        ${ROLES.map((r) => `<span class="chip ${ui.role === r ? 'on' : ''}" data-role="${r}">${pill(r)} ${ROLE_LBL[r]}</span>`).join('')}
        ${t ? `<span class="chip ${ui.onlyAffordable ? 'on' : ''}" data-a="afford">Alla mia portata</span>` : ''}
      </div>
      <div class="small muted" style="margin-bottom:6px">${list.length} giocatori · base d'asta: ${S.settings.base_mode === 'quotazione' ? 'quotazione' : '1 credito'}</div>
      <div class="list">${list.slice(0, 300).map((p) => `
        <div class="li">${pill(p.role)}<div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.club)}</div></div>
        <div class="right"><div class="num">${p.quotazione ?? '–'}</div><div class="sub">quot.</div></div>
        ${call ? `<button class="btn sm primary" data-call="${p.id}" ${basePrice(p) > t.maxBid[p.role] ? 'disabled' : ''}>Chiama</button>` : ''}</div>`).join('') || '<div class="empty">Nessun giocatore</div>'}</div>`;
  },

  rose() {
    if (ui.teamView) return teamDetail(team(ui.teamView));
    const me = myTeamId();
    return `<h2>Rose</h2>
      ${canTrade() ? '<div class="banner small">👉 È il tuo turno: apri la rosa di un avversario e tocca <b>Scambia</b> su un giocatore.</div>' : ''}
      ${S.me.is_admin && !S.me.team_id ? '<div class="banner small">Sei admin: se partecipi anche tu all\'asta, apri la tua squadra e tocca “Questa è la mia squadra”.</div>' : ''}
      <div class="teams-grid">${S.teams.map((t) => {
        const n = ROLES.reduce((s, r) => s + t.counts[r], 0);
        return `<div class="tcard ${t.id === me ? 'me' : ''}" data-team="${t.id}">
          <div class="tn">${esc(t.name)}</div><div class="small muted">${t.coach ? esc(t.coach) : '<i>nessun allenatore</i>'}</div>
          <div class="stats"><span><b>${t.avail}</b> cr</span><span><b>${t.cambi_left}</b> cambi</span>${tradesSeparate() ? `<span><b>${scambiLbl(t)}</b> scambi</span>` : ''}<span><b>${n}</b>/${rosterSize()}</span></div>
        </div>`;
      }).join('') || '<div class="empty">Le rose non sono ancora state caricate.</div>'}</div>`;
  },

  scambi() {
    const mine = myTeamId();
    const inc = incomingTrades();
    const out = S.trades.filter((t) => t.status === 'pending' && t.from_team_id === mine);
    const hist = S.trades.filter((t) => t.status !== 'pending');
    const others = S.me.is_admin ? S.trades.filter((t) => t.status === 'pending' && t.from_team_id !== mine && t.to_team_id !== mine) : [];
    return `<h2>Scambi</h2>
      ${canTrade() ? '<div class="banner small">Per proporre uno scambio vai in <b>Rose</b>, apri una squadra e tocca <b>Scambia</b>.</div>' : ''}
      <h3>Ricevute</h3>${inc.map((t) => tradeCard(t, true)).join('') || '<div class="empty small">Nessuna proposta ricevuta</div>'}
      <h3 style="margin-top:18px">Inviate</h3>${out.map((t) => tradeCard(t, false)).join('') || '<div class="empty small">Nessuna proposta in attesa</div>'}
      ${others.length ? `<h3 style="margin-top:18px">Altre in attesa (admin)</h3>${others.map((t) => tradeCard(t, false, true)).join('')}` : ''}
      <h3 style="margin-top:18px">Storico</h3>
      <div class="list">${hist.map((t) => `<div class="li"><div class="grow small">${tradeText(t)}</div><span class="small" style="color:${t.status === 'accepted' ? 'var(--good)' : 'var(--muted)'}">${{ accepted: 'Accettato', rejected: 'Rifiutato', cancelled: 'Annullato' }[t.status]}</span></div>`).join('') || '<div class="empty small">Ancora nessuno scambio</div>'}</div>`;
  },

  log() {
    return `<h2>Diario dell'asta</h2><div class="list">${S.events.map((e) => `<div class="li"><span class="small muted" style="width:44px;flex:none">${hm(e.ts)}</span><div class="grow small">${esc(e.text)}</div></div>`).join('') || '<div class="empty">Ancora niente</div>'}</div>`;
  },

  admin() { return adminView(); },
};

function releaseCard(t) {
  const role = t.pending_release[0];
  const mine = S.players.filter((p) => p.team_id === t.id && p.role === role).sort((a, b) => (a.cost || 0) - (b.cost || 0));
  const refund = { none: 'senza rimborso', half: 'con rimborso di metà del costo', full: 'con rimborso del costo' }[S.settings.release_refund];
  return `<div class="card warn"><h3>✂️ Devi svincolare un ${ROLE_ONE[role]}</h3>
    <p class="small muted">Hai superato il limite di ${lim(role)} ${ROLE_LBL[role].toLowerCase()}. Scegli chi lasciare (${refund}). Finché non lo fai non puoi partecipare alle aste.</p>
    <div class="list">${mine.map((p) => `<div class="li">${pill(p.role)}<div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.club)} · pagato ${p.cost ?? 0}</div></div><button class="btn sm danger" data-release="${p.id}">Svincola</button></div>`).join('')}</div></div>`;
}

function tradeText(t) {
  const op = player(t.offered_player_id), rp = player(t.requested_player_id);
  const cr = t.credits > 0 ? ` + <b>${t.credits}</b> cr da ${esc(tname(t.from_team_id))}` : t.credits < 0 ? ` + <b>${-t.credits}</b> cr da ${esc(tname(t.to_team_id))}` : '';
  return `<b>${esc(tname(t.from_team_id))}</b> dà ${op ? pill(op.role) + ' ' + esc(op.name) : '?'} a <b>${esc(tname(t.to_team_id))}</b> per ${rp ? pill(rp.role) + ' ' + esc(rp.name) : '?'}${cr}`;
}

function tradeCard(t, incoming, adminView = false) {
  const op = player(t.offered_player_id), rp = player(t.requested_player_id);
  let creditLine = '';
  if (incoming) {
    if (t.credits > 0) creditLine = `<div class="small" style="color:var(--good)">+ ricevi ${t.credits} crediti</div>`;
    if (t.credits < 0) creditLine = `<div class="small" style="color:var(--bad)">− paghi ${-t.credits} crediti</div>`;
  }
  return `<div class="card ${incoming ? 'hl' : ''}">
    <div class="small muted">${incoming ? 'Proposta da' : 'Proposta a'} <b>${esc(tname(incoming ? t.from_team_id : t.to_team_id))}</b> · ${hm(t.created_at)}</div>
    ${incoming ? `<div class="row" style="margin-top:8px"><div class="grow"><div class="small muted">Ricevi</div>${op ? pill(op.role) + ' <b>' + esc(op.name) + '</b>' : ''} <span class="small muted">${esc(op?.club)}</span></div>
      <div class="grow"><div class="small muted">Cedi</div>${rp ? pill(rp.role) + ' <b>' + esc(rp.name) + '</b>' : ''} <span class="small muted">${esc(rp?.club)}</span></div></div>${creditLine}`
    : `<div class="small" style="margin-top:8px">${tradeText(t)}</div>`}
    ${t.note ? `<div class="small muted" style="margin-top:6px">“${esc(t.note)}”</div>` : ''}
    <div class="row" style="margin-top:10px">
      ${incoming ? `<button class="btn good grow" data-trade-accept="${t.id}">Accetta</button><button class="btn danger grow" data-trade-reject="${t.id}">Rifiuta</button>`
      : adminView ? `<button class="btn sm danger" data-admin-cancel-trade="${t.id}">Annulla (admin)</button>` : `<button class="btn sm danger" data-trade-cancel="${t.id}">Ritira proposta</button>`}
    </div></div>`;
}

function auctionCard(a) {
  const p = a.player;
  const me = myTeamId();
  const part = a.participants.find((x) => x.team_id === me);
  const t = myTeam();
  const minRaise = Math.max(1, parseInt(S.settings.min_raise) || 1);
  const next = a.current_bid + minRaise;
  const maxB = t ? t.maxBid[p.role] : 0;
  const amLeader = a.leader_team_id === me;
  let controls = '';
  if (part && part.status === 'active' && !amLeader) {
    const steps = [minRaise, minRaise * 2, 5, 10].filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 4);
    controls = `
      <div class="raise-grid">${steps.map((s) => `<button class="btn primary" data-raise="${a.current_bid + s}" ${a.current_bid + s > maxB ? 'disabled' : ''}>+${s}</button>`).join('')}</div>
      <div class="row"><input type="number" id="custombid" data-keep inputmode="numeric" min="${next}" max="${maxB}" placeholder="Offerta (min ${next})" class="grow"><button class="btn primary" data-a="custombid">Offri</button></div>
      <div class="small muted" style="margin:6px 0 10px">Puoi offrire fino a <b>${maxB}</b> crediti.</div>
      <button class="btn danger block" data-a="withdraw">🏳️ Mi ritiro</button>`;
  } else if (amLeader) controls = `<div class="banner" style="text-align:center">🏆 <b>Sei il migliore offerente.</b> Aspetta che gli altri rilancino o si ritirino.</div>`;
  else if (part && part.status !== 'active') controls = `<div class="banner small" style="text-align:center">${part.status === 'out' ? 'Non puoi partecipare a questa asta (crediti, cambi o svincolo in sospeso).' : 'Ti sei ritirato da questa asta: non riceverai più notifiche per questo giocatore.'}</div>`;
  else if (t) controls = `<div class="banner small" style="text-align:center">Non partecipi a questa asta.</div>`;
  const parts = a.participants.slice().sort((x, y) => (x.team_id === a.leader_team_id ? -1 : 0) - (y.team_id === a.leader_team_id ? -1 : 0) || (x.status === 'active' ? -1 : 1) - (y.status === 'active' ? -1 : 1));
  const activeN = a.participants.filter((x) => x.status === 'active').length;
  const adminCtl = S.me.is_admin ? `<hr class="sep"><div class="small muted" style="margin-bottom:6px">Controlli admin</div>
    <div class="row wrap"><button class="btn sm" data-admin="close_auction" data-confirm="Assegnare subito ${esc(p.name)} a ${esc(tname(a.leader_team_id))} per ${a.current_bid}?">Aggiudica ora</button><button class="btn sm danger" data-admin="cancel_auction" data-confirm="Annullare l'asta per ${esc(p.name)}?">Annulla asta</button></div>` : '';
  return `<div class="card hl auction">
    <div class="row"><span class="live">Asta in corso</span><span class="grow"></span><span class="small muted">chiamato da ${esc(tname(a.caller_team_id))}</span></div>
    <div class="pname">${esc(p.name)}</div>
    <div class="row small muted">${pill(p.role)} ${esc(p.club)} · quot. ${p.quotazione ?? '–'}</div>
    <div class="bid"><div><div class="small muted">Offerta attuale</div><div class="amt">${a.current_bid}</div></div>
      <div class="lead"><span class="small muted">in testa</span><b>${esc(tname(a.leader_team_id))}</b><span class="small muted">${activeN - 1} ancora in gara</span></div></div>
    ${controls}
    <div class="parts">${parts.map((x) => `<div class="part ${x.status} ${x.team_id === a.leader_team_id ? 'leader' : ''}"><span class="dot"></span>${esc(tname(x.team_id))}${S.me.is_admin && x.status === 'active' && x.team_id !== a.leader_team_id ? ` <button class="btn sm ghost" style="min-height:22px;padding:0 6px;margin-left:auto" data-force-withdraw="${x.team_id}" title="Ritira (admin)">✕</button>` : ''}</div>`).join('')}</div>
    <details style="margin-top:10px"><summary class="small muted">Offerte (${a.bids.length})</summary>
      <div class="small" style="margin-top:6px">${a.bids.map((b) => `<div class="row"><span class="muted" style="width:44px">${hm(b.created_at)}</span><span class="grow">${esc(tname(b.team_id))}</span><b>${b.amount}</b></div>`).join('')}</div></details>
    ${adminCtl}
  </div>`;
}

function turnCard() {
  const tid = turnId();
  const t = team(tid);
  const mine = isMyTurn();
  const a = openAuction();
  const order = S.teams.filter((x) => x.turn_order != null).sort((x, y) => x.turn_order - y.turn_order);
  let h = `<div class="card ${mine && !a ? 'hl' : ''}">
    <div class="small muted">${mine ? 'Tocca a te' : 'Turno di'}</div>
    <div class="turn"><div class="who grow">${t ? esc(t.name) : '—'}</div>${t ? `<span class="small muted">${t.coach ? esc(t.coach) : ''}</span>` : ''}</div>`;
  if (mine && !a) {
    const pt = myPendingTrade();
    h += `<p class="small muted" style="margin:8px 0">Il turno resta tuo finché non compri un giocatore o concludi uno scambio.</p>`;
    if (pt) h += `<div class="banner small">Hai una proposta di scambio in attesa con <b>${esc(tname(pt.to_team_id))}</b>. <a href="#scambi" data-tab="scambi">Vedi</a></div>`;
    h += `<div class="row wrap">
      <button class="btn primary grow big" data-tab="svincolati" ${canCall() ? '' : 'disabled'}>🔨 Chiama un giocatore</button>
      <button class="btn grow big" data-tab="rose" ${canTrade() ? '' : 'disabled'}>🔄 Proponi scambio</button></div>
      <button class="btn ghost block" style="margin-top:8px" data-a="pass">⏭️ Passo il turno</button>`;
  }
  if (S.me.is_admin && !a) h += `<hr class="sep"><div class="row wrap"><button class="btn sm" data-admin="skip_turn" data-confirm="Saltare il turno di ${esc(t?.name)}?">Salta turno (admin)</button></div>`;
  h += `<div class="small muted" style="margin:14px 0 4px">Ordine dei turni</div><div class="order">${order.map((x) => {
    const dead = !x.coach || (x.cambi_left <= 0 && x.scambi_left === 0);
    return `<div class="o ${x.id === tid ? 'cur' : ''} ${dead ? 'dead' : ''}">${esc(x.name)} · ${x.cambi_left}c${tradesSeparate() ? '/' + scambiLbl(x) + 's' : ''}</div>`;
  }).join('')}</div></div>`;
  return h;
}

function teamDetail(t) {
  if (!t) { ui.teamView = null; return views.rose(); }
  const me = myTeamId();
  const isMine = t.id === me;
  const trade = !isMine && canTrade() && t.coach;
  const ps = S.players.filter((p) => p.team_id === t.id);
  const claim = S.me.is_admin && !S.me.team_id && !t.coach ? `<button class="btn sm primary" data-claim="${t.id}">Questa è la mia squadra</button>` : '';
  return `<p><button class="btn sm ghost" data-team="">‹ Tutte le squadre</button></p>
    <div class="card ${isMine ? 'hl' : ''}">
      <div class="row"><div class="grow"><h3 style="font-size:26px;margin:0">${esc(t.name)}</h3><div class="small muted">${t.coach ? 'Allenatore: ' + esc(t.coach) : 'Nessun allenatore iscritto'}</div></div>${claim}</div>
      <div class="stats"><span><b>${t.avail}</b> crediti</span><span><b>${t.cambi_left}</b>/${t.cambi_max} cambi</span>${tradesSeparate() ? `<span><b>${scambiLbl(t)}</b> scambi</span>` : ''}</div>
    </div>
    ${isMine && t.pending_release.length ? releaseCard(t) : ''}
    ${trade ? '<div class="banner small">Tocca <b>Scambia</b> sul giocatore che vuoi.</div>' : ''}
    ${ROLES.map((r) => {
      const list = ps.filter((p) => p.role === r).sort((a, b) => (b.cost || 0) - (a.cost || 0));
      return `<h3 style="margin-top:16px">${ROLE_LBL[r]} <span class="muted small">${list.length}/${lim(r)}</span></h3>
      <div class="list">${list.map((p) => `<div class="li">${pill(r)}<div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.club)}${p.quotazione != null ? ' · quot. ' + p.quotazione : ''}</div></div>
        <div class="right"><div class="num">${p.cost ?? '–'}</div><div class="sub">costo</div></div>
        ${trade ? `<button class="btn sm primary" data-trade="${p.id}">Scambia</button>` : ''}</div>`).join('') || '<div class="empty small">—</div>'}</div>`;
    }).join('')}`;
}

// ---------- modals ----------
function openModal(html, onMount) {
  $modal.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  const bg = $modal.firstElementChild;
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) closeModal(); });
  onMount && onMount($modal.querySelector('.modal'));
}
function closeModal() { $modal.innerHTML = ''; }

function callModal(pid) {
  const p = player(pid), t = myTeam();
  const base = basePrice(p), maxB = t.maxBid[p.role];
  const full = t.counts[p.role] >= lim(p.role);
  openModal(`<h3>Chiama ${esc(p.name)}</h3>
    <div class="row small muted">${pill(p.role)} ${esc(p.club)} · quot. ${p.quotazione ?? '–'}</div>
    ${full ? `<div class="banner small">Hai già ${lim(p.role)} ${ROLE_LBL[p.role].toLowerCase()}: se lo vinci dovrai svincolarne uno.</div>` : ''}
    <label class="f"><span>Offerta di apertura (base ${base}, max ${maxB})</span><input type="number" id="openbid" inputmode="numeric" min="${base}" max="${maxB}" value="${base}"></label>
    <p class="small muted">Tutti gli allenatori riceveranno una notifica. Vince chi resta per ultimo quando gli altri si ritirano.</p>
    <div class="row"><button class="btn ghost grow" data-close>Annulla</button><button class="btn primary grow big" id="docall">🔨 Apri l'asta</button></div>`, (m) => {
    m.querySelector('#docall').onclick = async () => {
      const amount = parseInt(m.querySelector('#openbid').value);
      if (await act('call', { player_id: pid, amount })) { closeModal(); ui.tab = 'asta'; location.hash = 'asta'; render(); }
    };
  });
}

function tradeModal(reqId) {
  const rp = player(reqId), t = myTeam();
  const mine = S.players.filter((p) => p.team_id === t.id).sort((a, b) => (a.role === rp.role ? -1 : 0) - (b.role === rp.role ? -1 : 0) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || (b.cost || 0) - (a.cost || 0));
  openModal(`<h3>Proposta di scambio</h3>
    <div class="small muted">Chiedi a <b>${esc(tname(rp.team_id))}</b></div>
    <div class="card" style="margin:8px 0">${pill(rp.role)} <b>${esc(rp.name)}</b> <span class="small muted">${esc(rp.club)} · costo ${rp.cost ?? '–'}</span></div>
    <label class="f"><span>In cambio offri</span><select id="offered">${mine.map((p) => `<option value="${p.id}">${p.role} · ${esc(p.name)} (${esc(p.club)}, ${p.cost ?? 0})</option>`).join('')}</select></label>
    <label class="f"><span>Crediti</span><div class="row">
      <select id="crdir" style="width:auto;flex:none"><option value="0">Nessun credito</option><option value="1">Offro</option><option value="-1">Chiedo</option></select>
      <input type="number" id="cramt" inputmode="numeric" min="0" value="0" class="grow"></div></label>
    <label class="f"><span>Messaggio (facoltativo)</span><input type="text" id="tnote" maxlength="200"></label>
    <p class="small muted">${tradesSeparate() ? 'Lo scambio conta come scambio per entrambe le squadre.' : 'Lo scambio consuma 1 cambio a entrambe le squadre.'} Se viene accettato il tuo turno finisce.</p>
    <div class="row"><button class="btn ghost grow" data-close>Annulla</button><button class="btn primary grow big" id="dotrade">Invia proposta</button></div>`, (m) => {
    m.querySelector('#dotrade').onclick = async () => {
      const dir = parseInt(m.querySelector('#crdir').value);
      const credits = dir * Math.abs(parseInt(m.querySelector('#cramt').value) || 0);
      if (await act('trade_propose', { offered_player_id: parseInt(m.querySelector('#offered').value), requested_player_id: reqId, credits, note: m.querySelector('#tnote').value })) {
        closeModal(); toast('Proposta inviata'); ui.tab = 'scambi'; location.hash = 'scambi'; render();
      }
    };
  });
}

function confirmModal(text, onYes, yesLabel = 'Conferma', danger = false) {
  openModal(`<p style="font-size:16px">${text}</p><div class="row"><button class="btn ghost grow" data-close>Annulla</button><button class="btn ${danger ? 'danger' : 'primary'} grow" id="yes">${yesLabel}</button></div>`, (m) => {
    m.querySelector('#yes').onclick = async () => { closeModal(); await onYes(); };
  });
}

// ---------- push ----------
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function urlB64ToUint8(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }

async function pushPanel() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  if (isIOS() && !isStandalone()) {
    return openModal(`<h3>Notifiche su iPhone</h3><p>Su iPhone le notifiche funzionano solo se l'app è installata sulla schermata Home:</p>
      <ol><li>Tocca il pulsante <b>Condividi</b> di Safari (il quadrato con la freccia)</li><li>Scegli <b>Aggiungi alla schermata Home</b></li><li>Apri <b>Asta CFP</b> dall'icona e tocca di nuovo 🔔</li></ol>
      <button class="btn primary block" data-close>Ho capito</button>`);
  }
  if (!supported) return openModal(`<h3>Notifiche non supportate</h3><p class="muted">Questo browser non supporta le notifiche push. Usa Chrome, Edge, Firefox o Safari aggiornati.</p><button class="btn block" data-close>Ok</button>`);
  const granted = Notification.permission === 'granted' && S.mySubs > 0;
  openModal(`<h3>🔔 Notifiche</h3>
    <p class="small muted">Ricevi una notifica quando: si apre un'asta, qualcuno rilancia su un giocatore per cui sei ancora in gara, tocca a te, ricevi o ti rispondono a uno scambio. Quando ti ritiri da un'asta non ricevi più notifiche per quel giocatore.</p>
    ${Notification.permission === 'denied' ? '<div class="banner small">Hai bloccato le notifiche per questo sito: riattivale dalle impostazioni del browser.</div>' : ''}
    <div class="stack">
      <button class="btn primary block big" id="pushon">${granted ? 'Riattiva su questo dispositivo' : 'Attiva notifiche'}</button>
      ${granted ? '<button class="btn block" id="pushtest">Invia notifica di prova</button>' : ''}
      ${granted ? '<button class="btn danger block" id="pushoff">Disattiva su questo dispositivo</button>' : ''}
      <button class="btn ghost block" data-a="logout">Esci dall'account</button>
    </div>`, (m) => {
    m.querySelector('#pushon').onclick = enablePush;
    m.querySelector('#pushtest') && (m.querySelector('#pushtest').onclick = async () => { try { const r = await api('/api/push/test', {}); toast(`Inviata a ${r.subs} dispositivi`); } catch (e) { toast(e.message, true); } });
    m.querySelector('#pushoff') && (m.querySelector('#pushoff').onclick = async () => {
      const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
      if (sub) { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      closeModal(); load();
    });
  });
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Permesso negato per le notifiche', true); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = urlB64ToUint8(S.vapidPublicKey);
    if (sub) {
      const cur = sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
      if (cur && cur.join() !== key.join()) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/push/subscribe', sub.toJSON());
    closeModal();
    toast('Notifiche attivate ✅');
    await load();
  } catch (e) { toast('Impossibile attivare le notifiche: ' + e.message, true); }
}

// keep the server subscription in sync if the browser rotated it
async function syncPush() {
  if (!('serviceWorker' in navigator) || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !S) return;
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await api('/api/push/subscribe', sub.toJSON()); } catch {}
}

// ---------- admin ----------
function adminView() {
  const s = S.settings;
  const order = S.teams.slice().sort((a, b) => (a.turn_order ?? 999) - (b.turn_order ?? 999));
  const ph = s.phase;
  const phaseLbl = { setup: 'In preparazione', running: 'In corso', paused: 'In pausa', finished: 'Terminata' }[ph];
  const nFree = S.players.filter((p) => !p.team_id).length;
  const sel = (k, opts) => `<select id="set_${k}" data-keep>${opts.map(([v, l]) => `<option value="${v}" ${s[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<h2>Cockpit admin</h2>
  <div class="card ${ph === 'running' ? 'good' : ''}">
    <div class="row"><div class="grow"><div class="small muted">Stato asta</div><div class="num">${phaseLbl}</div></div>
      ${ph === 'setup' || ph === 'finished' ? `<button class="btn primary" data-admin="start" data-confirm="Avviare l'asta? Tutti gli allenatori riceveranno una notifica.">🚀 Avvia asta</button>` : ''}
      ${ph === 'running' ? `<button class="btn" data-admin="pause">⏸️ Pausa</button>` : ''}
      ${ph === 'paused' ? `<button class="btn primary" data-admin="resume">▶️ Riprendi</button>` : ''}
      ${ph === 'running' || ph === 'paused' ? `<button class="btn danger" data-admin="finish" data-confirm="Terminare definitivamente l'asta?">🏁 Termina</button>` : ''}
    </div>
    ${ph === 'running' || ph === 'paused' ? `<hr class="sep"><label class="f"><span>Assegna il turno a</span><div class="row"><select id="setturn" data-keep>${order.map((t) => `<option value="${t.id}" ${t.id === turnId() ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button class="btn" data-a="setturn">Imposta</button><button class="btn" data-admin="skip_turn">Salta</button></div></label>` : ''}
  </div>

  <h3 style="margin-top:20px">1 · File</h3>
  <div class="card">
    <label class="f"><span>Rose (un foglio per squadra)</span><input type="file" id="file_rose" accept=".xlsx,.xls"></label>
    <div class="small muted">${S.teams.length} squadre · ${S.players.filter((p) => p.team_id).length} giocatori in rosa</div>
    <hr class="sep">
    <label class="f"><span>Svincolati con quotazioni</span><input type="file" id="file_svi" accept=".xlsx,.xls"></label>
    <div class="small muted">${nFree} svincolati</div>
    <hr class="sep">
    <button class="btn sm" data-a="export">⬇️ Esporta rose attuali (.xlsx)</button>
  </div>

  <h3 style="margin-top:20px">2 · Regole</h3>
  <div class="card">
    <label class="f"><span>Cambi per squadra</span><div class="row"><input type="number" id="set_default_cambi" data-keep min="0" value="${esc(s.default_cambi)}"><label class="check" style="margin:0;white-space:nowrap"><input type="checkbox" id="apply_all" data-keep checked> applica a tutte</label></div></label>
    <label class="check"><input type="checkbox" id="set_scambi_as_cambi" data-keep ${s.scambi_as_cambi === '1' ? 'checked' : ''}> Gli scambi valgono come cambi</label>
    <label class="f" ${s.scambi_as_cambi === '1' ? 'style="opacity:.5"' : ''}><span>Scambi massimi per squadra (0 = illimitati) — solo se non valgono come cambi</span><input type="number" id="set_max_scambi" data-keep min="0" value="${esc(s.max_scambi)}"></label>
    <label class="f"><span>Fantamilioni extra per ogni squadra</span><input type="number" id="set_global_extra" data-keep value="${esc(s.global_extra)}"></label>
    <label class="f"><span>Base d'asta</span>${sel('base_mode', [['uno', '1 credito'], ['quotazione', 'Quotazione del listone']])}</label>
    <label class="f"><span>Rilancio minimo</span><input type="number" id="set_min_raise" data-keep min="1" value="${esc(s.min_raise)}"></label>
    <label class="f"><span>Limiti rosa P / D / C / A</span><div class="row">${ROLES.map((r) => `<input type="number" id="set_lim_${r}" data-keep min="0" value="${esc(s['lim_' + r])}">`).join('')}</div></label>
    <label class="check"><input type="checkbox" id="set_reserve_slots" data-keep ${s.reserve_slots === '1' ? 'checked' : ''}> Tieni 1 credito per ogni posto vuoto in rosa</label>
    <label class="f"><span>Rimborso quando si svincola</span>${sel('release_refund', [['none', 'Nessun rimborso'], ['half', 'Metà del costo'], ['full', 'Costo pieno']])}</label>
    <button class="btn primary block" data-a="savesettings">Salva regole</button>
  </div>

  <h3 style="margin-top:20px">3 · Squadre e ordine dei turni</h3>
  <div class="card scroll-x"><table class="adm">
    <tr><th>#</th><th>Squadra</th><th>Crediti</th><th>Cambi max</th><th>Usati</th>${tradesSeparate() ? '<th>Scambi</th>' : ''}<th></th></tr>
    ${order.map((t, i) => `<tr>
      <td><div class="row" style="gap:2px"><button class="btn sm ghost" data-move="${t.id}:-1" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn sm ghost" data-move="${t.id}:1" ${i === order.length - 1 ? 'disabled' : ''}>▼</button></div></td>
      <td><b>${esc(t.name)}</b><div class="small muted">${t.coach ? esc(t.coach) : '—'} · disp. ${t.avail}</div></td>
      <td><input type="number" id="tc_${t.id}" data-keep value="${t.credits}"></td>
      <td><input type="number" id="tm_${t.id}" data-keep value="${t.cambi_max}"></td>
      <td><input type="number" id="tu_${t.id}" data-keep value="${t.cambi_used}"></td>
      ${tradesSeparate() ? `<td><input type="number" id="ts_${t.id}" data-keep value="${t.scambi_used}"></td>` : ''}
      <td><button class="btn sm" data-saveteam="${t.id}">Salva</button></td></tr>`).join('')}
  </table>
  <div class="row" style="margin-top:10px"><button class="btn sm" data-a="shuffle">🎲 Ordine casuale</button><span class="small muted">I crediti sono quelli del file; i fantamilioni extra si sommano.</span></div></div>

  <h3 style="margin-top:20px">4 · Allenatori</h3>
  <div class="list">${(S.users || []).map((u) => `<div class="li" style="flex-wrap:wrap">
    <div style="flex:1 1 100%;min-width:0"><div class="name">${esc(u.name)} ${u.is_admin ? '<span class="small" style="color:var(--accent)">admin</span>' : ''}</div><div class="sub">${esc(u.email)} · ${u.subs ? '🔔 notifiche attive' : '🔕 notifiche spente'}</div></div>
    <select data-userteam="${u.id}" style="flex:1;min-width:0;min-height:36px;padding:4px 8px"><option value="">— nessuna —</option>${S.teams.map((t) => `<option value="${t.id}" ${u.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <button class="btn sm" data-resetpw="${u.id}">Password</button>
    ${u.email !== 'silvello.enrico@gmail.com' ? `<button class="btn sm danger" data-deluser="${u.id}">✕</button>` : ''}
  </div>`).join('') || '<div class="empty">Nessun iscritto</div>'}</div>
  <p class="small muted">Condividi il link dell'app: ognuno si iscrive e sceglie la propria squadra. Per chi non si iscrive puoi giocare tu con “Agisci come”.</p>

  <h3 style="margin-top:20px">5 · Correzioni manuali</h3>
  <div class="card">
    <label class="f"><span>Sposta un giocatore (senza toccare i crediti)</span><input type="search" id="mv_q" data-keep placeholder="Cerca giocatore…" list="allplayers"></label>
    <datalist id="allplayers">${S.players.map((p) => `<option value="${esc(p.name)} · ${esc(p.club)} #${p.id}">`).join('')}</datalist>
    <div class="row"><select id="mv_team" data-keep><option value="">→ Svincolati</option>${S.teams.map((t) => `<option value="${t.id}">→ ${esc(t.name)}</option>`).join('')}</select><input type="number" id="mv_cost" data-keep placeholder="Costo" style="width:90px"><button class="btn" data-a="move">Sposta</button></div>
  </div>

  <h3 style="margin-top:20px">Zona pericolosa</h3>
  <div class="card warn"><p class="small">Cancella squadre, giocatori, aste, scambi e diario (gli account restano). Dovrai ricaricare i file.</p>
  <button class="btn danger" data-admin="reset_all" data-confirm="Cancellare TUTTI i dati dell'asta? Non si può annullare." data-danger>♻️ Azzera tutto</button></div>`;
}

let xlsxReady = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return xlsxReady ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = XLSX_CDN; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Impossibile caricare il lettore Excel'));
    document.head.appendChild(s);
  });
}
async function readWorkbook(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  return [XLSX, XLSX.read(buf, { type: 'array' })];
}
async function uploadRose(file) {
  try {
    const [XLSX, wb] = await readWorkbook(file);
    const teams = parseRose(XLSX, wb);
    const np = teams.reduce((n, t) => n + t.players.length, 0);
    confirmModal(`Caricare <b>${teams.length} squadre</b> e <b>${np} giocatori</b>?<div class="small muted" style="margin-top:8px">${teams.map((t) => `${esc(t.name)}: ${t.players.length} gioc., ${t.credits} cr`).join('<br>')}</div><div class="small muted" style="margin-top:8px">Le rose attuali verranno sostituite. Gli allenatori restano associati alle squadre con lo stesso nome.</div>`,
      async () => { const r = await admin('import_rose', { teams }); if (r) toast(`Caricate ${r.teams} squadre e ${r.players} giocatori`); }, 'Carica');
  } catch (e) { toast(e.message, true); }
}
async function uploadSvincolati(file) {
  try {
    const [XLSX, wb] = await readWorkbook(file);
    const players = parseSvincolati(XLSX, wb);
    const by = ROLES.map((r) => `${r}: ${players.filter((p) => p.role === r).length}`).join(' · ');
    confirmModal(`Caricare <b>${players.length} svincolati</b>?<div class="small muted" style="margin-top:6px">${by}</div><div class="small muted" style="margin-top:8px">La lista attuale degli svincolati verrà sostituita.</div>`,
      async () => { const r = await admin('import_svincolati', { players }); if (r) toast(`Caricati ${r.players} svincolati`); }, 'Carica');
  } catch (e) { toast(e.message, true); }
}
async function exportRose() {
  try {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    S.teams.forEach((t, i) => {
      const ps = S.players.filter((p) => p.team_id === t.id).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || (b.cost || 0) - (a.cost || 0));
      const rows = [[`${t.name} (${t.avail} MILIONI)`], ['Nome', 'Squadra', 'Ruolo', 'Costo'], ...ps.map((p) => [p.name, p.club, p.role, p.cost ?? 0])];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
      XLSX.utils.book_append_sheet(wb, ws, `${i + 1}. ${t.name}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31));
    });
    XLSX.writeFile(wb, `rose-asta-cfp-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) { toast(e.message, true); }
}

// ---------------- events ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-a],[data-auth],[data-pick],[data-role],[data-call],[data-raise],[data-team],[data-trade],[data-trade-accept],[data-trade-reject],[data-trade-cancel],[data-release],[data-admin],[data-admin-cancel-trade],[data-force-withdraw],[data-saveteam],[data-move],[data-resetpw],[data-deluser],[data-claim]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.tab !== undefined) { e.preventDefault(); closeModal(); ui.tab = d.tab; ui.teamView = null; location.hash = d.tab; render(); window.scrollTo(0, 0); return; }
  if (d.auth) { ui.authMode = d.auth; renderAuth(); return; }
  if (d.pick) { try { await api('/api/me/team', { team_id: +d.pick }); await load(); } catch (err) { toast(err.message, true); } return; }
  if (d.claim) { try { await api('/api/me/team', { team_id: +d.claim }); await load(); } catch (err) { toast(err.message, true); } return; }
  if (d.role !== undefined) { ui.role = d.role; render(); return; }
  if (d.team !== undefined) { ui.teamView = d.team ? +d.team : null; render(); window.scrollTo(0, 0); return; }
  if (d.call) return callModal(+d.call);
  if (d.trade) return tradeModal(+d.trade);
  if (d.raise) return act('raise', { amount: +d.raise });
  if (d.tradeAccept) return confirmModal('Accettare lo scambio?', () => act('trade_accept', { trade_id: +d.tradeAccept }), 'Accetta');
  if (d.tradeReject) return act('trade_reject', { trade_id: +d.tradeReject });
  if (d.tradeCancel) return act('trade_cancel', { trade_id: +d.tradeCancel });
  if (d.release) { const p = player(+d.release); return confirmModal(`Svincolare <b>${esc(p.name)}</b>?`, () => act('release', { player_id: +d.release }), 'Svincola', true); }
  if (d.adminCancelTrade) return admin('cancel_trade', { trade_id: +d.adminCancelTrade });
  if (d.forceWithdraw) return confirmModal(`Ritirare ${esc(tname(+d.forceWithdraw))} dall'asta?`, () => admin('force_withdraw', { team_id: +d.forceWithdraw }));
  if (d.admin) { const run = () => admin(d.admin); return d.confirm ? confirmModal(d.confirm, run, 'Conferma', d.danger !== undefined) : run(); }
  if (d.saveteam) {
    const id = d.saveteam; const v = (p) => document.getElementById(p + id)?.value;
    return admin('team_update', { team_id: +id, credits: v('tc_'), cambi_max: v('tm_'), cambi_used: v('tu_'), scambi_used: v('ts_') }, 'Squadra aggiornata');
  }
  if (d.move) {
    const [id, dir] = d.move.split(':').map(Number);
    const order = S.teams.slice().sort((a, b) => (a.turn_order ?? 999) - (b.turn_order ?? 999)).map((t) => t.id);
    const i = order.indexOf(id); const j = i + dir; [order[i], order[j]] = [order[j], order[i]];
    return admin('set_order', { team_ids: order });
  }
  if (d.resetpw) {
    const u = S.users.find((x) => x.id === +d.resetpw);
    return openModal(`<h3>Nuova password per ${esc(u.name)}</h3><label class="f"><span>Password (min 6)</span><input type="text" id="npw" value="${Math.random().toString(36).slice(2, 10)}"></label><p class="small muted">Comunicala tu all'allenatore.</p><div class="row"><button class="btn ghost grow" data-close>Annulla</button><button class="btn primary grow" id="dopw">Imposta</button></div>`, (m) => {
      m.querySelector('#dopw').onclick = async () => { const r = await admin('user_reset_password', { user_id: u.id, password: m.querySelector('#npw').value }, 'Password aggiornata'); if (r) closeModal(); };
    });
  }
  if (d.deluser) { const u = S.users.find((x) => x.id === +d.deluser); return confirmModal(`Eliminare l'account di ${esc(u.name)}?`, () => admin('user_delete', { user_id: u.id }), 'Elimina', true); }

  switch (d.a) {
    case 'push': return pushPanel();
    case 'logout': await api('/api/logout', {}); S = null; closeModal(); try { ws && ws.close(); } catch {} return renderAuth();
    case 'afford': ui.onlyAffordable = !ui.onlyAffordable; return render();
    case 'withdraw': return confirmModal(`Ritirarti dall'asta per <b>${esc(openAuction()?.player.name)}</b>? Non potrai rientrare.`, () => act('withdraw'), 'Mi ritiro', true);
    case 'pass': return confirmModal('Passare il turno al prossimo allenatore?', () => act('pass'), 'Passo');
    case 'custombid': {
      const v = parseInt(document.getElementById('custombid').value);
      if (!v) return toast('Inserisci un\'offerta', true);
      if (await act('raise', { amount: v })) { const i = document.getElementById('custombid'); if (i) i.value = ''; }
      return;
    }
    case 'savesettings': {
      const g = (k) => document.getElementById('set_' + k);
      const settings = {
        default_cambi: g('default_cambi').value, scambi_as_cambi: g('scambi_as_cambi').checked ? '1' : '0', max_scambi: g('max_scambi').value,
        global_extra: g('global_extra').value, base_mode: g('base_mode').value, min_raise: g('min_raise').value,
        reserve_slots: g('reserve_slots').checked ? '1' : '0', release_refund: g('release_refund').value,
      };
      for (const r of ROLES) settings['lim_' + r] = g('lim_' + r).value;
      return admin('settings', { settings, apply_cambi_all: document.getElementById('apply_all').checked }, 'Regole salvate');
    }
    case 'setturn': return admin('set_turn', { team_id: +document.getElementById('setturn').value }, 'Turno assegnato');
    case 'shuffle': {
      const ids = S.teams.map((t) => t.id).sort(() => Math.random() - 0.5);
      return confirmModal('Mescolare a caso l\'ordine dei turni?', () => admin('set_order', { team_ids: ids }, 'Ordine estratto'));
    }
    case 'export': return exportRose();
    case 'move': {
      const m = (document.getElementById('mv_q').value || '').match(/#(\d+)$/);
      if (!m) return toast('Scegli un giocatore dalla lista', true);
      return admin('move_player', { player_id: +m[1], team_id: document.getElementById('mv_team').value, cost: document.getElementById('mv_cost').value }, 'Giocatore spostato');
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') { ui.search = e.target.value; render(); }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'acting') { ui.actingTeam = t.value ? +t.value : null; render(); return; }
  if (t.id === 'file_rose' && t.files[0]) { await uploadRose(t.files[0]); t.value = ''; return; }
  if (t.id === 'file_svi' && t.files[0]) { await uploadSvincolati(t.files[0]); t.value = ''; return; }
  if (t.dataset.userteam) { await admin('user_update', { user_id: +t.dataset.userteam, team_id: t.value }, 'Allenatore aggiornato'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'custombid') { e.preventDefault(); document.querySelector('[data-a="custombid"]')?.click(); }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== ui.tab && S) { ui.tab = h; ui.teamView = null; render(); } });

// ---------------- boot ----------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
load().then(syncPush);
