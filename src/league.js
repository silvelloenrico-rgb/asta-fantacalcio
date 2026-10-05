import { DurableObject } from 'cloudflare:workers';
import { sendPush, generateVapidKeys } from './push.js';

const ADMIN_EMAIL = 'silvello.enrico@gmail.com';
const ROLES = ['P', 'D', 'C', 'A'];
const ROLE_NAME = { P: 'Portiere', D: 'Difensore', C: 'Centrocampista', A: 'Attaccante' };
const SESSION_DAYS = 90;

const DEFAULTS = {
  phase: 'setup', // setup | running | paused | finished
  turn_team_id: '',
  scambi_as_cambi: '1',
  max_scambi: '0',
  global_extra: '0',
  base_mode: 'uno', // uno | quotazione
  min_raise: '1',
  roster_max: '25',
  release_refund: 'none', // none | half | full | min
  default_cambi: '3',
};
const PUBLIC_SETTINGS = Object.keys(DEFAULTS);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, team_id INTEGER, is_admin INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, sheet_order INTEGER, credits INTEGER DEFAULT 0, cambi_max INTEGER DEFAULT 0, cambi_used INTEGER DEFAULT 0, scambi_used INTEGER DEFAULT 0, turn_order INTEGER);
CREATE TABLE IF NOT EXISTS players(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, club TEXT, role TEXT NOT NULL, quotazione INTEGER, team_id INTEGER, cost INTEGER, acquired_at INTEGER);
CREATE INDEX IF NOT EXISTS players_team ON players(team_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS auctions(id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, caller_team_id INTEGER NOT NULL, status TEXT NOT NULL, current_bid INTEGER, leader_team_id INTEGER, winner_team_id INTEGER, started_at INTEGER, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS auction_participants(auction_id INTEGER, team_id INTEGER, status TEXT, PRIMARY KEY(auction_id, team_id));
CREATE TABLE IF NOT EXISTS bids(id INTEGER PRIMARY KEY AUTOINCREMENT, auction_id INTEGER, team_id INTEGER, amount INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT, from_team_id INTEGER, to_team_id INTEGER, offered_player_id INTEGER, requested_player_id INTEGER, credits INTEGER DEFAULT 0, status TEXT, note TEXT, created_at INTEGER, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS pending_releases(id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER, role TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS push_subs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS listone(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, club TEXT, role TEXT, quotazione INTEGER);
CREATE TABLE IF NOT EXISTS moves(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, team_id INTEGER, player_name TEXT, player_role TEXT, player_club TEXT, amount INTEGER, other_team_id INTEGER, other_player_name TEXT, other_player_role TEXT, other_player_club TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, text TEXT);
`;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (m) => { throw new HttpError(400, m); };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const now = () => Date.now();
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const te = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hashPassword(pw, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: toB64(bits), salt: toB64(salt) };
}
const randomToken = () => toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, '');

export class League extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.outbox = [];
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      if (!this.getS('vapid_pub')) {
        const v = await generateVapidKeys();
        this.setS('vapid_pub', v.publicKey);
        this.setS('vapid_priv', v.privateJwk);
      }
    });
  }

  // ---------- sql helpers ----------
  q(sql, ...b) { return this.sql.exec(sql, ...b.map((x) => (x === undefined ? null : x))).toArray(); }
  one(sql, ...b) { return this.q(sql, ...b)[0] || null; }
  run(sql, ...b) { this.sql.exec(sql, ...b.map((x) => (x === undefined ? null : x))); }
  lastId() { return this.one('SELECT last_insert_rowid() AS id').id; }
  getS(k) { const r = this.one('SELECT value FROM settings WHERE key=?', k); return r ? r.value : DEFAULTS[k]; }
  N(k) { return int(this.getS(k)); }
  setS(k, v) { this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v)); }
  log(kind, text) { this.run('INSERT INTO events(ts,kind,text) VALUES(?,?,?)', now(), kind, text); }

  // ---------- domain helpers ----------
  team(id) { return id ? this.one('SELECT * FROM teams WHERE id=?', id) : null; }
  teamOrFail(id) { const t = this.team(id); if (!t) bad('Squadra non trovata'); return t; }
  player(id) { return this.one('SELECT * FROM players WHERE id=?', id); }
  counts(teamId) {
    const c = { P: 0, D: 0, C: 0, A: 0 };
    for (const r of this.q('SELECT role, COUNT(*) AS n FROM players WHERE team_id=? GROUP BY role', teamId)) c[r.role] = r.n;
    return c;
  }
  avail(t) { return t.credits + this.N('global_extra'); }
  rosterCount(teamId) { return this.one('SELECT COUNT(*) AS n FROM players WHERE team_id=?', teamId).n; }
  move(kind, teamId, p, amount, otherTeamId, op) {
    this.run('INSERT INTO moves(ts,kind,team_id,player_name,player_role,player_club,amount,other_team_id,other_player_name,other_player_role,other_player_club) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      now(), kind, teamId, p.name, p.role, p.club, amount ?? null, otherTeamId ?? null, op ? op.name : null, op ? op.role : null, op ? op.club : null);
  }
  cambiLeft(t) { return t.cambi_max - t.cambi_used; }
  tradesSeparate() { return this.getS('scambi_as_cambi') !== '1'; }
  scambiLeft(t) {
    if (!this.tradesSeparate()) return this.cambiLeft(t);
    const m = this.N('max_scambi');
    return m === 0 ? Infinity : m - t.scambi_used;
  }
  coachOf(teamId) { return this.one('SELECT id, name FROM users WHERE team_id=?', teamId); }
  hasPendingRelease(teamId) { return !!this.one('SELECT id FROM pending_releases WHERE team_id=?', teamId); }
  canTakeTurn(t) { return !!this.coachOf(t.id) && (this.cambiLeft(t) > 0 || this.scambiLeft(t) > 0); }
  basePrice(p) { return this.getS('base_mode') === 'quotazione' ? Math.max(1, p.quotazione || 1) : 1; }
  openAuction() { return this.one("SELECT * FROM auctions WHERE status='open' ORDER BY id DESC LIMIT 1"); }
  turnTeamId() { return int(this.getS('turn_team_id'), 0) || null; }
  tName(id) { const t = this.team(id); return t ? t.name : '?'; }

  // ---------- notifications ----------
  notifyTeams(teamIds, payload) {
    const ids = [...new Set(teamIds.filter(Boolean))];
    if (!ids.length) return;
    const users = this.q(`SELECT id FROM users WHERE team_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((u) => u.id);
    this.notifyUsers(users, payload);
  }
  notifyUsers(userIds, payload) {
    if (!userIds.length) return;
    const subs = this.q(`SELECT * FROM push_subs WHERE user_id IN (${userIds.map(() => '?').join(',')})`, ...userIds);
    for (const s of subs) this.outbox.push({ sub: s, payload: { url: '/', ...payload } });
  }
  async flushOutbox() {
    const items = this.outbox;
    this.outbox = [];
    if (!items.length) return;
    const vapid = { publicKey: this.getS('vapid_pub'), privateJwk: this.getS('vapid_priv') };
    await Promise.allSettled(items.map(async ({ sub, payload }) => {
      try {
        const status = await sendPush(sub, payload, vapid, 'mailto:' + ADMIN_EMAIL);
        if (status === 404 || status === 410) this.run('DELETE FROM push_subs WHERE id=?', sub.id);
      } catch (e) { console.log('push error', e && e.message); }
    }));
  }
  broadcast() {
    const msg = JSON.stringify({ t: 'u', ts: now() });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} }
  }

  // ---------- auth ----------
  cookieToken(req) {
    const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([^;]+)/);
    return m ? m[1] : null;
  }
  currentUser(req) {
    const tok = this.cookieToken(req);
    if (!tok) return null;
    const s = this.one('SELECT * FROM sessions WHERE token=?', tok);
    if (!s || s.expires_at < now()) return null;
    return this.one('SELECT * FROM users WHERE id=?', s.user_id);
  }
  sessionCookie(token, req) {
    const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
    return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
  }
  newSession(userId) {
    const token = randomToken();
    this.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, userId, now() + SESSION_DAYS * 86400000);
    return token;
  }

  // ---------- entry ----------
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/ws') {
        const user = this.currentUser(req);
        if (!user) return new Response('unauthorized', { status: 401 });
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], ['u' + user.id]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (req.method === 'GET' && path === '/api/public') return json(this.publicInfo());
      if (req.method === 'POST' && path === '/api/register') return await this.register(req);
      if (req.method === 'POST' && path === '/api/login') return await this.login(req);
      if (req.method === 'POST' && path === '/api/logout') {
        const tok = this.cookieToken(req);
        if (tok) this.run('DELETE FROM sessions WHERE token=?', tok);
        return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      }

      const user = this.currentUser(req);
      if (!user) throw new HttpError(401, 'Non autenticato');
      if (req.method === 'GET' && path === '/api/state') return json(this.state(user));

      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      let result;
      if (path === '/api/me/team') result = this.mutate(() => this.chooseTeam(user, body));
      else if (path === '/api/push/subscribe') result = this.mutate(() => this.subscribe(user, body));
      else if (path === '/api/push/unsubscribe') result = this.mutate(() => { this.run('DELETE FROM push_subs WHERE endpoint=?', body.endpoint); return { ok: true }; });
      else if (path === '/api/push/test') result = this.mutate(() => {
        this.notifyUsers([user.id], { title: '🔔 Notifica di prova', body: 'Le notifiche dell\'asta funzionano!', tag: 'test' });
        return { ok: true, subs: this.one('SELECT COUNT(*) n FROM push_subs WHERE user_id=?', user.id).n };
      });
      else if (path === '/api/action') result = this.mutate(() => this.action(user, body));
      else if (path === '/api/admin') {
        if (!user.is_admin) throw new HttpError(403, 'Solo l\'admin può farlo');
        if (body.type === 'user_reset_password') result = await this.resetPassword(body);
        else result = this.mutate(() => this.admin(user, body));
      } else throw new HttpError(404, 'Not found');
      return json(result ?? { ok: true });
    } catch (e) {
      this.outbox = [];
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log('ERR', e && e.stack);
      return json({ error: 'Errore interno: ' + (e && e.message) }, 500);
    }
  }

  // Runs a mutation atomically, then broadcasts + sends notifications
  mutate(fn) {
    this.outbox = [];
    const res = this.ctx.storage.transactionSync(fn);
    this.broadcast();
    this.ctx.waitUntil(this.flushOutbox());
    return res;
  }

  async webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('pong'); }
  async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }

  // ---------- auth handlers ----------
  publicInfo() {
    return {
      teams: this.q('SELECT t.id, t.name, (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id) AS claimed FROM teams t ORDER BY sheet_order, name'),
    };
  }
  async register(req) {
    const b = await req.json().catch(() => ({}));
    const email = norm(b.email);
    const name = String(b.name || '').trim();
    const pw = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Email non valida');
    if (name.length < 2) bad('Inserisci il tuo nome');
    if (pw.length < 6) bad('La password deve avere almeno 6 caratteri');
    const { hash, salt } = await hashPassword(pw);
    const res = this.mutate(() => {
      if (this.one('SELECT id FROM users WHERE email=?', email)) bad('Esiste già un account con questa email');
      const teamId = int(b.team_id) || null;
      if (teamId) {
        this.teamOrFail(teamId);
        if (this.coachOf(teamId)) bad('Questa squadra è già stata scelta da un altro allenatore');
      }
      const isAdmin = email === ADMIN_EMAIL ? 1 : 0;
      this.run('INSERT INTO users(email,name,pass_hash,salt,team_id,is_admin,created_at) VALUES(?,?,?,?,?,?,?)', email, name, hash, salt, teamId, isAdmin, now());
      const uid = this.lastId();
      this.log('user', `${name} si è iscritto${teamId ? ' con ' + this.tName(teamId) : ''}`);
      return { token: this.newSession(uid) };
    });
    return json({ ok: true }, 200, { 'set-cookie': this.sessionCookie(res.token, req) });
  }
  async login(req) {
    const b = await req.json().catch(() => ({}));
    const u = this.one('SELECT * FROM users WHERE email=?', norm(b.email));
    if (!u) bad('Email o password errati');
    const { hash } = await hashPassword(String(b.password || ''), u.salt);
    if (hash !== u.pass_hash) bad('Email o password errati');
    const token = this.newSession(u.id);
    return json({ ok: true }, 200, { 'set-cookie': this.sessionCookie(token, req) });
  }
  async resetPassword(b) {
    const pw = String(b.password || '');
    if (pw.length < 6) bad('La password deve avere almeno 6 caratteri');
    const { hash, salt } = await hashPassword(pw);
    return this.mutate(() => {
      this.run('UPDATE users SET pass_hash=?, salt=? WHERE id=?', hash, salt, int(b.user_id));
      this.run('DELETE FROM sessions WHERE user_id=?', int(b.user_id));
      return { ok: true };
    });
  }
  chooseTeam(user, b) {
    const teamId = int(b.team_id);
    this.teamOrFail(teamId);
    if (user.team_id && !user.is_admin) bad('Hai già una squadra: chiedi all\'admin per cambiarla');
    const c = this.coachOf(teamId);
    if (c && c.id !== user.id) bad('Questa squadra è già stata scelta');
    this.run('UPDATE users SET team_id=? WHERE id=?', teamId, user.id);
    this.log('user', `${user.name} allena ${this.tName(teamId)}`);
    return { ok: true };
  }
  subscribe(user, b) {
    if (!b.endpoint || !b.keys || !b.keys.p256dh || !b.keys.auth) bad('Sottoscrizione non valida');
    this.run(`INSERT INTO push_subs(user_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
    user.id, b.endpoint, b.keys.p256dh, b.keys.auth, now());
    return { ok: true };
  }

  // ---------- state ----------
  state(user) {
    const settings = {};
    for (const k of PUBLIC_SETTINGS) settings[k] = this.getS(k);
    const teams = this.q('SELECT * FROM teams ORDER BY sheet_order, name').map((t) => {
      const coach = this.coachOf(t.id);
      const sl = this.scambiLeft(t);
      return {
        ...t,
        coach: coach ? coach.name : null,
        avail: this.avail(t),
        counts: this.counts(t.id),
        cambi_left: this.cambiLeft(t),
        scambi_left: sl === Infinity ? -1 : sl,
        roster: this.rosterCount(t.id),
        pending_release: this.q('SELECT id FROM pending_releases WHERE team_id=?', t.id).map(() => 1),
      };
    });
    const players = this.q('SELECT id,name,club,role,quotazione,team_id,cost FROM players ORDER BY role, name');
    let auction = this.openAuction() || this.one("SELECT * FROM auctions WHERE status!='open' ORDER BY id DESC LIMIT 1");
    if (auction) {
      auction = {
        ...auction,
        player: this.player(auction.player_id),
        participants: this.q('SELECT team_id, status FROM auction_participants WHERE auction_id=?', auction.id),
        bids: this.q('SELECT team_id, amount, created_at FROM bids WHERE auction_id=? ORDER BY id DESC LIMIT 30', auction.id),
      };
    }
    const tradeCols = 'id,from_team_id,to_team_id,offered_player_id,requested_player_id,credits,status,note,created_at,resolved_at';
    const trades = user.is_admin
      ? this.q(`SELECT ${tradeCols} FROM trades ORDER BY id DESC LIMIT 100`)
      : this.q(`SELECT ${tradeCols} FROM trades WHERE status='accepted' OR from_team_id=? OR to_team_id=? ORDER BY id DESC LIMIT 100`, user.team_id || -1, user.team_id || -1);
    const out = {
      me: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin, team_id: user.team_id },
      settings,
      teams,
      players,
      auction,
      trades,
      events: this.q('SELECT * FROM events ORDER BY id DESC LIMIT 100'),
      vapidPublicKey: this.getS('vapid_pub'),
      mySubs: this.one('SELECT COUNT(*) n FROM push_subs WHERE user_id=?', user.id).n,
      listoneCount: this.one('SELECT COUNT(*) n FROM listone').n,
      moves: this.q('SELECT * FROM moves ORDER BY id DESC LIMIT 1000'),
    };
    if (user.is_admin) out.users = this.q('SELECT id,email,name,team_id,is_admin,created_at, (SELECT COUNT(*) FROM push_subs p WHERE p.user_id=users.id) AS subs FROM users ORDER BY name');
    return out;
  }

  // ---------- game actions ----------
  action(user, b) {
    let teamId = user.team_id;
    if (b.as_team && user.is_admin) teamId = int(b.as_team);
    if (!teamId) bad('Non hai ancora una squadra');
    const t = this.teamOrFail(teamId);
    const actor = user.is_admin && teamId !== user.team_id ? `${t.name} (via admin)` : t.name;
    switch (b.type) {
      case 'call': return this.callPlayer(t, int(b.player_id), int(b.amount), actor);
      case 'raise': return this.raise(t, int(b.amount), actor);
      case 'withdraw': return this.withdraw(t, actor);
      case 'pass': return this.pass(t, actor);
      case 'release': return this.release(t, int(b.player_id), actor);
      case 'trade_propose': return this.proposeTrade(t, b, actor);
      case 'trade_accept': return this.answerTrade(t, int(b.trade_id), true);
      case 'trade_reject': return this.answerTrade(t, int(b.trade_id), false);
      case 'trade_cancel': return this.cancelTrade(t, int(b.trade_id));
      default: bad('Azione sconosciuta');
    }
  }

  requireRunning() {
    const ph = this.getS('phase');
    if (ph === 'paused') bad('L\'asta è in pausa');
    if (ph !== 'running') bad('L\'asta non è in corso');
  }
  requireTurn(t) {
    this.requireRunning();
    if (this.turnTeamId() !== t.id) bad('Non è il tuo turno');
  }

  callPlayer(t, playerId, amount, actor) {
    this.requireTurn(t);
    if (this.openAuction()) bad('C\'è già un\'asta in corso');
    if (this.one("SELECT id FROM trades WHERE from_team_id=? AND status='pending'", t.id)) bad('Hai una proposta di scambio in attesa: annullala prima di chiamare un giocatore');
    if (this.cambiLeft(t) <= 0) bad('Non hai più cambi disponibili');
    if (this.hasPendingRelease(t.id)) bad('Prima devi svincolare un giocatore');
    const pend = this.one('SELECT team_id FROM pending_releases ORDER BY id LIMIT 1');
    if (pend) bad(`Aspetta che ${this.tName(pend.team_id)} svincoli un giocatore prima della prossima asta`);
    const p = this.player(playerId);
    if (!p) bad('Giocatore non trovato');
    if (p.team_id) bad('Il giocatore non è svincolato');
    const base = this.basePrice(p);
    if (!amount) amount = base;
    if (amount < base) bad(`La base d'asta per ${p.name} è ${base}`);
    this.run('INSERT INTO auctions(player_id,caller_team_id,status,current_bid,leader_team_id,started_at) VALUES(?,?,?,?,?,?)', p.id, t.id, 'open', amount, t.id, now());
    const aid = this.lastId();
    this.run('INSERT INTO bids(auction_id,team_id,amount,created_at) VALUES(?,?,?,?)', aid, t.id, amount, now());
    const minRaise = Math.max(1, this.N('min_raise'));
    const active = [];
    for (const o of this.q('SELECT t.* FROM teams t WHERE EXISTS (SELECT 1 FROM users u WHERE u.team_id=t.id)')) {
      let st = 'active';
      if (o.id !== t.id) {
        // only coaches with cambi left take part
        if (this.cambiLeft(o) <= 0 || this.hasPendingRelease(o.id)) st = 'out';
      }
      this.run('INSERT INTO auction_participants(auction_id,team_id,status) VALUES(?,?,?)', aid, o.id, st);
      if (st === 'active' && o.id !== t.id) active.push(o.id);
    }
    this.log('auction', `🔨 ${actor} chiama ${p.name} (${p.role}, ${p.club}) a ${amount}`);
    this.notifyTeams(active, {
      title: `🔨 Asta aperta: ${p.name} (${p.role})`,
      body: `${t.name} chiama ${p.name} (${p.club}) a ${amount}. Rilancia o ritirati.`,
      tag: 'auction-' + aid,
    });
    this.checkClose(aid);
    return { ok: true, auction_id: aid };
  }

  raise(t, amount, actor) {
    this.requireRunning();
    const a = this.openAuction();
    if (!a) bad('Nessuna asta in corso');
    const part = this.one('SELECT * FROM auction_participants WHERE auction_id=? AND team_id=?', a.id, t.id);
    if (!part || part.status !== 'active') bad('Non partecipi più a questa asta');
    if (a.leader_team_id === t.id) bad('Sei già il migliore offerente');
    const p = this.player(a.player_id);
    const minRaise = Math.max(1, this.N('min_raise'));
    if (!amount || amount < a.current_bid + minRaise) bad(`L'offerta minima è ${a.current_bid + minRaise}`);
    this.run('UPDATE auctions SET current_bid=?, leader_team_id=? WHERE id=?', amount, t.id, a.id);
    this.run('INSERT INTO bids(auction_id,team_id,amount,created_at) VALUES(?,?,?,?)', a.id, t.id, amount, now());
    const stillActive = this.q("SELECT team_id FROM auction_participants WHERE auction_id=? AND status='active' AND team_id!=?", a.id, t.id).map((o) => o.team_id);
    this.log('bid', `⬆️ ${actor} rilancia ${amount} su ${p.name}`);
    this.notifyTeams(stillActive, {
      title: `⬆️ ${p.name}: ${amount}`,
      body: `${t.name} rilancia a ${amount} su ${p.name}. Rilancia o ritirati.`,
      tag: 'auction-' + a.id,
    });
    this.checkClose(a.id);
    return { ok: true };
  }

  withdraw(t, actor) {
    const a = this.openAuction();
    if (!a) bad('Nessuna asta in corso');
    const part = this.one('SELECT * FROM auction_participants WHERE auction_id=? AND team_id=?', a.id, t.id);
    if (!part || part.status !== 'active') bad('Non partecipi a questa asta');
    if (a.leader_team_id === t.id) bad('Sei il migliore offerente: non puoi ritirarti');
    this.run("UPDATE auction_participants SET status='withdrawn' WHERE auction_id=? AND team_id=?", a.id, t.id);
    this.log('withdraw', `🏳️ ${actor} si ritira dall'asta per ${this.player(a.player_id).name}`);
    this.checkClose(a.id);
    return { ok: true };
  }

  checkClose(aid) {
    const a = this.one('SELECT * FROM auctions WHERE id=?', aid);
    if (!a || a.status !== 'open') return;
    const left = this.one("SELECT COUNT(*) AS n FROM auction_participants WHERE auction_id=? AND status='active' AND team_id!=?", aid, a.leader_team_id).n;
    if (left === 0) this.closeAuction(a);
  }

  closeAuction(a, byAdmin = false) {
    const winner = this.team(a.leader_team_id);
    const p = this.player(a.player_id);
    this.run('UPDATE players SET team_id=?, cost=?, acquired_at=? WHERE id=?', winner.id, a.current_bid, now(), p.id);
    this.run('UPDATE teams SET credits=credits-?, cambi_used=cambi_used+1 WHERE id=?', a.current_bid, winner.id);
    this.run("UPDATE auctions SET status='closed', winner_team_id=?, ended_at=? WHERE id=?", winner.id, now(), a.id);
    this.log('won', `✅ ${p.name} va a ${winner.name} per ${a.current_bid}${byAdmin ? ' (chiusa dall\'admin)' : ''}`);
    this.notifyTeams([winner.id], { title: `✅ Hai preso ${p.name}!`, body: `${p.name} è tuo per ${a.current_bid} crediti.`, tag: 'auction-' + a.id });
    if (a.caller_team_id !== winner.id) {
      this.notifyTeams([a.caller_team_id], { title: `${p.name} va a ${winner.name}`, body: `Aggiudicato per ${a.current_bid}. È ancora il tuo turno: chiama un altro giocatore.`, tag: 'auction-' + a.id });
    }
    this.move('acquisto', winner.id, p, a.current_bid);
    const max = this.N('roster_max');
    if (max && this.rosterCount(winner.id) > max) {
      this.run('INSERT INTO pending_releases(team_id,role,created_at) VALUES(?,?,?)', winner.id, null, now());
      this.notifyTeams([winner.id], { title: '✂️ Devi svincolare un giocatore', body: `Hai più di ${max} giocatori: scegli chi svincolare (qualsiasi ruolo). La prossima asta aspetta te.`, tag: 'release' });
    }
    if (this.turnTeamId() === winner.id) this.advanceTurn(winner.id, `${winner.name} ha acquistato ${p.name}`);
  }

  pass(t, actor) {
    this.requireTurn(t);
    if (this.openAuction()) bad('C\'è un\'asta in corso');
    this.log('turn', `⏭️ ${actor} passa il turno`);
    this.advanceTurn(t.id);
    return { ok: true };
  }

  advanceTurn(fromTeamId, reason) {
    // cancel pending trades proposed by the team that is losing the turn
    for (const tr of this.q("SELECT * FROM trades WHERE from_team_id=? AND status='pending'", fromTeamId)) {
      this.run("UPDATE trades SET status='cancelled', resolved_at=? WHERE id=?", now(), tr.id);
      this.notifyTeams([tr.to_team_id], { title: 'Proposta di scambio annullata', body: `${this.tName(fromTeamId)} ha terminato il turno.`, tag: 'trade-' + tr.id });
    }
    const order = this.q('SELECT * FROM teams WHERE turn_order IS NOT NULL ORDER BY turn_order, id');
    const idx = order.findIndex((x) => x.id === fromTeamId);
    for (let i = 1; i <= order.length; i++) {
      const cand = order[(idx + i + order.length) % order.length];
      if (this.canTakeTurn(cand)) { this.setTurn(cand.id, reason); return; }
    }
    this.setS('turn_team_id', '');
    this.setS('phase', 'finished');
    this.log('phase', '🏁 Nessuna squadra ha più cambi o scambi: asta terminata');
    this.notifyTeams(this.q('SELECT id FROM teams').map((x) => x.id), { title: '🏁 Asta terminata', body: 'Tutti i cambi e gli scambi sono stati utilizzati.', tag: 'phase' });
  }

  setTurn(teamId, reason) {
    this.setS('turn_team_id', teamId);
    const t = this.team(teamId);
    this.log('turn', `👉 Tocca a ${t.name}`);
    const cl = this.cambiLeft(t);
    this.notifyTeams([teamId], {
      title: '👉 Tocca a te!',
      body: `${reason ? reason + '. ' : ''}È il turno di ${t.name}: chiama un giocatore${this.scambiLeft(t) > 0 ? ' o proponi uno scambio' : ''} (${cl} cambi rimasti).`,
      tag: 'turn',
    });
  }

  release(t, playerId, actor) {
    const p = this.player(playerId);
    if (!p || p.team_id !== t.id) bad('Il giocatore non è nella tua rosa');
    const pr = this.one('SELECT * FROM pending_releases WHERE team_id=? ORDER BY id LIMIT 1', t.id);
    if (!pr) bad('Non devi svincolare giocatori');
    const refund = this.refundFor(p);
    this.run('UPDATE players SET team_id=NULL, cost=NULL, acquired_at=NULL WHERE id=?', p.id);
    if (refund) this.run('UPDATE teams SET credits=credits+? WHERE id=?', refund, t.id);
    this.run('DELETE FROM pending_releases WHERE id=?', pr.id);
    this.move('svincolo', t.id, p, refund);
    this.log('release', `✂️ ${actor} svincola ${p.name}${refund ? ` (+${refund} crediti)` : ''}`);
    // the next auction was waiting for this release: tell whoever holds the turn
    const turn = this.turnTeamId();
    if (!this.one('SELECT id FROM pending_releases') && this.getS('phase') === 'running' && turn && turn !== t.id) {
      this.notifyTeams([turn], { title: '👉 Puoi chiamare il prossimo giocatore', body: `${t.name} ha svincolato ${p.name}. Tocca a te!`, tag: 'turn' });
    }
    return { ok: true };
  }

  refundFor(p) {
    const mode = this.getS('release_refund');
    const cost = p.cost || 0;
    if (mode === 'full') return cost;
    if (mode === 'half') return Math.ceil(cost / 2);
    if (mode === 'min') return p.quotazione == null ? cost : Math.min(cost, p.quotazione);
    return 0;
  }

  tradeCheckCapacity(t) {
    if (this.scambiLeft(t) <= 0) bad(`${t.name} non ha più ${this.tradesSeparate() ? 'scambi' : 'cambi'} disponibili`);
  }

  proposeTrade(t, b, actor) {
    this.requireTurn(t);
    if (this.openAuction()) bad('C\'è un\'asta in corso');
    if (this.one("SELECT id FROM trades WHERE from_team_id=? AND status='pending'", t.id)) bad('Hai già una proposta di scambio in attesa');
    const offered = this.player(int(b.offered_player_id));
    const requested = this.player(int(b.requested_player_id));
    if (!offered || offered.team_id !== t.id) bad('Scegli un giocatore della tua rosa');
    if (!requested || !requested.team_id || requested.team_id === t.id) bad('Scegli un giocatore di un\'altra squadra');
    const other = this.team(requested.team_id);
    if (!this.coachOf(other.id)) bad('Quella squadra non ha ancora un allenatore iscritto');
    this.tradeCheckCapacity(t);
    this.tradeCheckCapacity(other);
    const credits = int(b.credits);
    this.run("INSERT INTO trades(from_team_id,to_team_id,offered_player_id,requested_player_id,credits,status,note,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
      t.id, other.id, offered.id, requested.id, credits, String(b.note || '').slice(0, 200), now());
    const id = this.lastId();
    const cr = credits > 0 ? ` + ${credits} crediti a te` : credits < 0 ? ` e chiede ${-credits} crediti` : '';
    this.log('trade', `🔄 ${actor} propone uno scambio a ${other.name}`);
    this.notifyTeams([other.id], {
      title: `🔄 Proposta di scambio da ${t.name}`,
      body: `Ti offre ${offered.name} (${offered.role})${cr} per ${requested.name} (${requested.role}).`,
      tag: 'trade-' + id,
    });
    return { ok: true, trade_id: id };
  }

  answerTrade(t, tradeId, accept) {
    const tr = this.one('SELECT * FROM trades WHERE id=?', tradeId);
    if (!tr || tr.status !== 'pending') bad('Proposta non più valida');
    if (tr.to_team_id !== t.id) bad('Questa proposta non è rivolta a te');
    const from = this.team(tr.from_team_id);
    const to = this.team(tr.to_team_id);
    const offered = this.player(tr.offered_player_id);
    const requested = this.player(tr.requested_player_id);
    if (!accept) {
      this.run("UPDATE trades SET status='rejected', resolved_at=? WHERE id=?", now(), tr.id);
      this.log('trade', `❌ ${to.name} rifiuta lo scambio proposto da ${from.name}`);
      this.notifyTeams([from.id], { title: '❌ Scambio rifiutato', body: `${to.name} ha rifiutato: ${offered.name} ⇄ ${requested.name}.`, tag: 'trade-' + tr.id });
      return { ok: true };
    }
    if (this.getS('phase') !== 'running') bad('L\'asta non è in corso');
    if (offered.team_id !== from.id || requested.team_id !== to.id) bad('I giocatori non sono più nelle rispettive rose');
    this.tradeCheckCapacity(from);
    this.tradeCheckCapacity(to);
    this.run('UPDATE players SET team_id=? WHERE id=?', to.id, offered.id);
    this.run('UPDATE players SET team_id=? WHERE id=?', from.id, requested.id);
    if (tr.credits) {
      this.run('UPDATE teams SET credits=credits-? WHERE id=?', tr.credits, from.id);
      this.run('UPDATE teams SET credits=credits+? WHERE id=?', tr.credits, to.id);
    }
    const col = this.tradesSeparate() ? 'scambi_used' : 'cambi_used';
    this.run(`UPDATE teams SET ${col}=${col}+1 WHERE id IN (?,?)`, from.id, to.id);
    this.run("UPDATE trades SET status='accepted', resolved_at=? WHERE id=?", now(), tr.id);
    this.move('scambio', from.id, offered, tr.credits, to.id, requested);
    // other pending proposals involving these players are no longer valid
    for (const o of this.q("SELECT * FROM trades WHERE status='pending' AND (offered_player_id IN (?,?) OR requested_player_id IN (?,?))", offered.id, requested.id, offered.id, requested.id)) {
      this.run("UPDATE trades SET status='cancelled', resolved_at=? WHERE id=?", now(), o.id);
    }
    const cr = tr.credits > 0 ? ` (+${tr.credits} cr. a ${to.name})` : tr.credits < 0 ? ` (+${-tr.credits} cr. a ${from.name})` : '';
    this.log('trade', `🤝 Scambio: ${offered.name} → ${to.name}, ${requested.name} → ${from.name}${cr}`);
    this.notifyTeams([from.id], { title: '🤝 Scambio accettato!', body: `${to.name} ha accettato: ${requested.name} è tuo.`, tag: 'trade-' + tr.id });
    const others = this.q('SELECT id FROM teams WHERE id NOT IN (?,?)', from.id, to.id).map((x) => x.id);
    this.notifyTeams(others, { title: '🤝 Scambio concluso', body: `${from.name} ⇄ ${to.name}: ${offered.name} per ${requested.name}${cr}`, tag: 'trade-' + tr.id });
    if (this.turnTeamId() === from.id) this.advanceTurn(from.id, `${from.name} ha concluso uno scambio`);
    return { ok: true };
  }

  cancelTrade(t, tradeId) {
    const tr = this.one('SELECT * FROM trades WHERE id=?', tradeId);
    if (!tr || tr.status !== 'pending') bad('Proposta non più valida');
    if (tr.from_team_id !== t.id) bad('Puoi annullare solo le tue proposte');
    this.run("UPDATE trades SET status='cancelled', resolved_at=? WHERE id=?", now(), tr.id);
    this.notifyTeams([tr.to_team_id], { title: 'Proposta di scambio ritirata', body: `${t.name} ha ritirato la proposta.`, tag: 'trade-' + tr.id });
    return { ok: true };
  }

  // ---------- admin ----------
  admin(user, b) {
    switch (b.type) {
      case 'import_rose': return this.importRose(b.teams || []);
      case 'import_listone': case 'import_svincolati': return this.importListone(b.players || []);
      case 'settings': {
        for (const [k, v] of Object.entries(b.settings || {})) {
          if (!PUBLIC_SETTINGS.includes(k) || k === 'phase' || k === 'turn_team_id') continue;
          this.setS(k, v);
        }
        if (b.apply_cambi_all) this.run('UPDATE teams SET cambi_max=?', this.N('default_cambi'));
        this.log('admin', '⚙️ Regole aggiornate dall\'admin');
        return { ok: true };
      }
      case 'team_update': {
        const t = this.teamOrFail(int(b.team_id));
        const f = {};
        for (const k of ['credits', 'cambi_max', 'cambi_used', 'scambi_used']) if (b[k] !== undefined && b[k] !== '') f[k] = int(b[k]);
        for (const [k, v] of Object.entries(f)) this.run(`UPDATE teams SET ${k}=? WHERE id=?`, v, t.id);
        this.log('admin', `⚙️ Admin modifica ${t.name}`);
        return { ok: true };
      }
      case 'set_order': {
        const ids = (b.team_ids || []).map((x) => int(x));
        this.run('UPDATE teams SET turn_order=NULL');
        ids.forEach((id, i) => this.run('UPDATE teams SET turn_order=? WHERE id=?', i + 1, id));
        this.log('admin', '🔢 Ordine dei turni aggiornato: ' + ids.map((id) => this.tName(id)).join(' → '));
        return { ok: true };
      }
      case 'start': {
        if (!this.one('SELECT id FROM teams')) bad('Carica prima il file Rose');
        if (!this.one('SELECT id FROM players WHERE team_id IS NULL')) bad('Carica prima il listone');
        this.setS('phase', 'running');
        this.log('phase', '🚀 L\'asta è iniziata!');
        const others = this.q('SELECT id FROM teams').map((x) => x.id);
        this.notifyTeams(others, { title: '🚀 L\'asta è iniziata!', body: 'Apri l\'app per seguire i turni.', tag: 'phase' });
        const cur = this.team(this.turnTeamId());
        if (cur && this.canTakeTurn(cur)) this.setTurn(cur.id);
        else {
          const first = this.q('SELECT * FROM teams WHERE turn_order IS NOT NULL ORDER BY turn_order, id').find((x) => this.canTakeTurn(x));
          if (!first) bad('Nessuna squadra può giocare: controlla che gli allenatori siano iscritti e abbiano cambi');
          this.setTurn(first.id);
        }
        return { ok: true };
      }
      case 'pause': this.setS('phase', 'paused'); this.log('phase', '⏸️ Asta in pausa'); return { ok: true };
      case 'resume': this.setS('phase', 'running'); this.log('phase', '▶️ Asta ripresa'); return { ok: true };
      case 'finish': {
        if (this.openAuction()) bad('Chiudi o annulla prima l\'asta in corso');
        this.setS('phase', 'finished'); this.setS('turn_team_id', '');
        this.log('phase', '🏁 Asta terminata dall\'admin');
        return { ok: true };
      }
      case 'skip_turn': {
        if (this.openAuction()) bad('C\'è un\'asta in corso');
        const cur = this.turnTeamId();
        if (!cur) bad('Nessun turno attivo');
        this.log('turn', `⏭️ L'admin salta il turno di ${this.tName(cur)}`);
        this.advanceTurn(cur);
        return { ok: true };
      }
      case 'set_turn': {
        if (this.openAuction()) bad('C\'è un\'asta in corso');
        const t = this.teamOrFail(int(b.team_id));
        const cur = this.turnTeamId();
        if (cur && cur !== t.id) for (const tr of this.q("SELECT id FROM trades WHERE from_team_id=? AND status='pending'", cur)) this.run("UPDATE trades SET status='cancelled', resolved_at=? WHERE id=?", now(), tr.id);
        this.setTurn(t.id, 'L\'admin ti ha assegnato il turno');
        return { ok: true };
      }
      case 'force_withdraw': {
        const a = this.openAuction(); if (!a) bad('Nessuna asta in corso');
        if (a.leader_team_id === int(b.team_id)) bad('Non puoi ritirare il migliore offerente');
        this.run("UPDATE auction_participants SET status='withdrawn' WHERE auction_id=? AND team_id=?", a.id, int(b.team_id));
        this.log('withdraw', `🏳️ L'admin ritira ${this.tName(int(b.team_id))} dall'asta`);
        this.checkClose(a.id);
        return { ok: true };
      }
      case 'close_auction': {
        const a = this.openAuction(); if (!a) bad('Nessuna asta in corso');
        this.run("UPDATE auction_participants SET status='withdrawn' WHERE auction_id=? AND status='active' AND team_id!=?", a.id, a.leader_team_id);
        this.closeAuction(a, true);
        return { ok: true };
      }
      case 'cancel_auction': {
        const a = this.openAuction(); if (!a) bad('Nessuna asta in corso');
        this.run("UPDATE auctions SET status='cancelled', ended_at=? WHERE id=?", now(), a.id);
        const p = this.player(a.player_id);
        this.log('admin', `🚫 L'admin annulla l'asta per ${p.name}`);
        const act = this.q("SELECT team_id FROM auction_participants WHERE auction_id=? AND status='active'", a.id).map((x) => x.team_id);
        this.notifyTeams(act, { title: `🚫 Asta annullata: ${p.name}`, body: 'L\'admin ha annullato l\'asta.', tag: 'auction-' + a.id });
        return { ok: true };
      }
      case 'cancel_trade': {
        this.run("UPDATE trades SET status='cancelled', resolved_at=? WHERE id=? AND status='pending'", now(), int(b.trade_id));
        return { ok: true };
      }
      case 'force_release': {
        const p = this.player(int(b.player_id));
        if (!p || !p.team_id) bad('Giocatore non in rosa');
        return this.release(this.team(p.team_id), p.id, 'Admin');
      }
      case 'move_player': {
        // manual correction: assign a player to a team (or free him) without touching credits
        const p = this.player(int(b.player_id)); if (!p) bad('Giocatore non trovato');
        const tid = int(b.team_id) || null;
        this.run('UPDATE players SET team_id=?, cost=? WHERE id=?', tid, tid ? int(b.cost, p.cost || 0) : null, p.id);
        this.log('admin', `⚙️ Admin sposta ${p.name} → ${tid ? this.tName(tid) : 'svincolati'}`);
        return { ok: true };
      }
      case 'user_update': {
        const uid = int(b.user_id);
        const u = this.one('SELECT * FROM users WHERE id=?', uid); if (!u) bad('Utente non trovato');
        if (b.team_id !== undefined) {
          const tid = int(b.team_id) || null;
          if (tid) { const c = this.coachOf(tid); if (c && c.id !== uid) bad(`La squadra è già di ${c.name}`); }
          this.run('UPDATE users SET team_id=? WHERE id=?', tid, uid);
        }
        if (b.is_admin !== undefined) {
          if (u.email === ADMIN_EMAIL) bad('L\'admin principale non può perdere i permessi');
          this.run('UPDATE users SET is_admin=? WHERE id=?', b.is_admin ? 1 : 0, uid);
          this.log('admin', b.is_admin ? `👑 ${u.name} è ora admin` : `${u.name} non è più admin`);
          if (b.is_admin) this.notifyUsers([uid], { title: '👑 Ora sei admin', body: 'Puoi gestire l\'asta dal cockpit admin.', tag: 'admin' });
        }
        return { ok: true };
      }
      case 'user_delete': {
        const u = this.one('SELECT * FROM users WHERE id=?', int(b.user_id));
        if (!u) bad('Utente non trovato');
        if (u.email === ADMIN_EMAIL) bad('Non puoi eliminare l\'admin');
        this.run('DELETE FROM sessions WHERE user_id=?', u.id);
        this.run('DELETE FROM push_subs WHERE user_id=?', u.id);
        this.run('DELETE FROM users WHERE id=?', u.id);
        return { ok: true };
      }
      case 'reset_all': {
        for (const tb of ['teams', 'players', 'listone', 'auctions', 'auction_participants', 'bids', 'trades', 'pending_releases', 'events', 'moves']) this.run(`DELETE FROM ${tb}`);
        this.run('UPDATE users SET team_id=NULL');
        this.setS('phase', 'setup'); this.setS('turn_team_id', '');
        this.log('admin', '♻️ Dati azzerati dall\'admin');
        return { ok: true };
      }
      default: bad('Comando admin sconosciuto');
    }
  }

  importRose(teams) {
    if (!teams.length) bad('Il file non contiene squadre');
    if (this.openAuction()) bad('C\'è un\'asta in corso');
    const existing = new Map(this.q('SELECT * FROM teams').map((t) => [norm(t.name), t]));
    const keep = new Set();
    const defCambi = this.N('default_cambi');
    teams.forEach((t, i) => {
      const name = String(t.name || '').trim();
      if (!name) return;
      const ex = existing.get(norm(name));
      if (ex) {
        this.run('UPDATE teams SET name=?, sheet_order=?, credits=?, turn_order=COALESCE(turn_order, ?) WHERE id=?', name, i + 1, int(t.credits), i + 1, ex.id);
        keep.add(ex.id);
      } else {
        this.run('INSERT INTO teams(name,sheet_order,credits,cambi_max,turn_order) VALUES(?,?,?,?,?)', name, i + 1, int(t.credits), defCambi, i + 1);
        keep.add(this.lastId());
      }
    });
    for (const t of existing.values()) {
      if (!keep.has(t.id)) {
        this.run('UPDATE users SET team_id=NULL WHERE team_id=?', t.id);
        this.run('DELETE FROM teams WHERE id=?', t.id);
      }
    }
    this.run('DELETE FROM players WHERE team_id IS NOT NULL');
    this.run('DELETE FROM pending_releases');
    const ids = new Map(this.q('SELECT id, name FROM teams').map((t) => [norm(t.name), t.id]));
    let n = 0;
    for (const t of teams) {
      const tid = ids.get(norm(t.name));
      for (const p of t.players || []) {
        if (!p.name || !ROLES.includes(p.role)) continue;
        this.run('INSERT INTO players(name,club,role,team_id,cost) VALUES(?,?,?,?,?)', String(p.name).trim(), String(p.club || '').trim(), p.role, tid, int(p.cost));
        n++;
      }
    }
    const r = this.rebuildFromListone();
    this.log('admin', `📥 Caricate le rose: ${teams.length} squadre, ${n} giocatori`);
    return { ok: true, teams: teams.length, players: n, ...r };
  }

  // The listone is the full list of Serie A players with their current quotazione.
  // Free agents = listone minus everyone currently in a roster.
  importListone(players) {
    if (!players.length) bad('Il file non contiene giocatori');
    if (this.openAuction()) bad('C\'è un\'asta in corso');
    this.run('DELETE FROM listone');
    const seen = new Set();
    for (const p of players) {
      if (!p.name || !ROLES.includes(p.role)) continue;
      const key = norm(p.name) + '|' + norm(p.club);
      if (seen.has(key)) continue;
      seen.add(key);
      const q = p.quotazione === '' || p.quotazione == null ? null : int(p.quotazione);
      this.run('INSERT INTO listone(name,club,role,quotazione) VALUES(?,?,?,?)', String(p.name).trim(), String(p.club || '').trim(), p.role, q);
    }
    const r = this.rebuildFromListone();
    this.log('admin', `📥 Caricato il listone: ${seen.size} giocatori, ${r.free} svincolati`);
    return { ok: true, listone: seen.size, ...r };
  }

  rebuildFromListone() {
    const listone = this.q('SELECT * FROM listone');
    if (!listone.length) return { free: this.one('SELECT COUNT(*) n FROM players WHERE team_id IS NULL').n, matched: 0, missing: [] };
    const rostered = this.q('SELECT id, name, club, role FROM players WHERE team_id IS NOT NULL');
    const byNC = new Map(rostered.map((p) => [norm(p.name) + '|' + norm(p.club), p]));
    const byNR = new Map();
    for (const p of rostered) { const k = norm(p.name) + '|' + p.role; byNR.set(k, (byNR.get(k) || []).concat(p)); }
    const used = new Set();
    this.run('DELETE FROM players WHERE team_id IS NULL');
    let free = 0;
    for (const l of listone) {
      let p = byNC.get(norm(l.name) + '|' + norm(l.club));
      if (!p || used.has(p.id)) {
        // player changed club: match by name + role when unambiguous
        const c = (byNR.get(norm(l.name) + '|' + l.role) || []).filter((x) => !used.has(x.id));
        p = c.length === 1 ? c[0] : null;
      }
      if (p) {
        used.add(p.id);
        this.run('UPDATE players SET quotazione=?, club=? WHERE id=?', l.quotazione, l.club, p.id);
      } else {
        this.run('INSERT INTO players(name,club,role,quotazione) VALUES(?,?,?,?)', l.name, l.club, l.role, l.quotazione);
        free++;
      }
    }
    const missing = rostered.filter((p) => !used.has(p.id));
    for (const p of missing) this.run('UPDATE players SET quotazione=NULL WHERE id=?', p.id);
    return { free, matched: used.size, missing: missing.map((p) => `${p.name} (${p.club})`) };
  }

}
