// GOALCASH API v2 — advance sales, lineup-confirmation player assignment, favourites, accounts, admin.
// Actions: buy (POST), tickets, pool, claim (POST), fav_add (POST), fav_del (POST), fav_list, admin
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, KEY = process.env.THESTATSAPI_KEY;
const sbH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

const TICKET_PENCE = 100;
// Guaranteed-win table: [pence, probability, multiplier-eligible]. Every ticket pays; 4p floor.
// £25+ are pure-cash jackpot instants — no event multiplier (tail-liability cap).
const CASH = [[10000, .0004, false], [5000, .001, false], [2500, .003, false],
  [1000, .002, true], [200, .01, true], [100, .025, true], [50, .04, true], [25, .07, true], [10, .15, true]];
const CASH_FLOOR = 5;
const BIG_CAP = 500; // max Big Match tickets per featured fixture
// Event multipliers applied to the instant win (cumulative): bonus = instant × Σ multipliers
const MULT = { goal: 10, yellow: 3, red: 20 };
const PER_GOAL = { G: 0, D: 0, M: 0, F: 0 }; // legacy column, unused in multiplier model
const SALE_WINDOW_H = 72;

async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (!r.ok) throw new Error('TSA ' + r.status);
  return r.json();
}
let covCache = null;
async function coveredComps() {
  if (covCache && Date.now() - covCache.at < 6 * 36e5) return covCache;
  const s = new Set(), names = {};
  for (let p = 1; p <= 2; p++) {
    const r = await tsa(`/coverage/leagues?data_type=lineups&per_page=200&page=${p}`);
    r.data.forEach(c => { const lu = c.data_types && c.data_types.lineups;
      if (lu && lu.available) { s.add(c.id); names[c.id] = ((c.country || '') + ' ' + (c.name || '')).trim(); } });
    if (p >= (r.meta.total_pages || 1)) break;
  }
  covCache = { at: Date.now(), s, names };
  return covCache;
}
function compTier(name) {
  const n = (name || '').toLowerCase();
  if (/u-?1\d|u-?2[0-3]|youth|junior/.test(n)) return 5;
  if (/world cup|champions league|premier league/.test(n)) return 100;
  if (/la liga|serie a|bundesliga|ligue 1|europa/.test(n)) return 80;
  if (/championship|eredivisie|primeira|scottish prem|fa cup|efl|carabao|copa del rey|dfb|coppa/.test(n)) return 60;
  if (/qualif|nations league|internation/.test(n)) return 45;
  return 10;
}
async function autoPickBig() {
  const { names } = await coveredComps();
  const f = await upcomingFixtures();
  if (!f.length) return null;
  let best = null, bestScore = -1e9;
  const now = Date.now();
  for (const m of f) {
    const hrs = (new Date(m.kickoff).getTime() - now) / 36e5;
    const score = compTier(names[m.competition_id]) - hrs * 0.3;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best) return null;
  const val = { match_id: best.id, fixture: best.home + ' v ' + best.away, kickoff: best.kickoff, auto: true };
  await fetch(SB + '/rest/v1/gc_config', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ key: 'featured', value: val }]) }).catch(() => {});
  return val;
}
let fxCache = null;
async function upcomingFixtures() {
  if (fxCache && Date.now() - fxCache.at < 15 * 6e4) return fxCache.f;
  const covered = (await coveredComps()).s;
  const d0 = new Date().toISOString().slice(0, 10);
  const d1 = new Date(Date.now() + SALE_WINDOW_H * 36e5).toISOString().slice(0, 10);
  let all = [];
  for (let p = 1; p <= 6; p++) {
    const r = await tsa(`/football/matches?status=scheduled&date_from=${d0}&date_to=${d1}&per_page=100&page=${p}`);
    all.push(...r.data);
    if (p >= (r.meta.total_pages || 1)) break;
  }
  const now = Date.now();
  const f = all.filter(m => covered.has(m.competition_id) && new Date(m.utc_date).getTime() > now)
    .map(m => ({ id: m.id, kickoff: m.utc_date, home: m.home_team.name, away: m.away_team.name, competition_id: m.competition_id }));
  fxCache = { at: Date.now(), f };
  return f;
}
const drawCash = () => { let r = Math.random(), acc = 0; for (const [p, pr, b] of CASH) { acc += pr; if (r < acc) return { pence: p, bonus: b }; } return { pence: CASH_FLOOR, bonus: true }; };
const pickFrom = a => a[Math.floor(Math.random() * a.length)];

const cpCache = {};
// Confirmed-XI pool for a match, or null if sheet not confirmed yet (played matches count as confirmed).
async function confirmedPool(matchId) {
  const hit = cpCache[matchId];
  if (hit && Date.now() - hit.at < 10 * 6e4) return hit.pool;
  try {
    const lu = (await tsa(`/football/matches/${matchId}/lineups`)).data;
    if (!lu || !lu.confirmed) return null;
    const out = [];
    ['home', 'away'].forEach(s => (lu[s].starting_xi || []).forEach(p =>
      out.push({ player_name: p.name, position: p.position || 'M', team_name: lu[s].name })));
    const pool = out.length ? out : null;
    cpCache[matchId] = { at: Date.now(), pool };
    return pool;
  } catch (e) { cpCache[matchId] = { at: Date.now(), pool: null }; return null; }
}
async function getFeatured() {
  try {
    const r = await (await fetch(SB + '/rest/v1/gc_config?key=eq.featured&select=value', { headers: sbH })).json();
    const f = r[0] && r[0].value;
    if (!f || !f.kickoff || new Date(f.kickoff).getTime() < Date.now()) return null; // expires at kickoff
    return f;
  } catch (e) { return null; }
}

async function authUser(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!tok) return null;
  try {
    const r = await fetch(SB + '/auth/v1/user', { headers: { apikey: process.env.SUPABASE_ANON_KEY || SK, Authorization: 'Bearer ' + tok } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? 'auth_' + u.id : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (!SB || !SK || !KEY) return res.status(500).json({ error: 'Missing env vars' });
  const action = req.query.action;
  const authed = await authUser(req);
  const user = authed || String(req.query.user || '').slice(0, 64);
  try {
    if (action === 'pool') {
      const f = await upcomingFixtures();
      let feat = await getFeatured();
      if (!feat) feat = await autoPickBig(); // self-healing: always a Big Match when fixtures exist
      res.setHeader('Cache-Control', 's-maxage=120');
      return res.status(200).json({ fixtures: f.length, window_h: SALE_WINDOW_H, featured: feat });
    }

    if (action === 'buy') {
      if (!authed) return res.status(401).json({ error: 'Sign in to play \u2014 your balance lives on your account.' });
      const big = req.query.kind === 'big';
      let feat = null;
      if (big) {
        feat = await getFeatured() || await autoPickBig();
        if (!feat) return res.status(409).json({ error: 'No Big Match pack on sale right now.' });
        const cnt = await fetch(SB + `/rest/v1/gc_tickets?match_id=eq.${feat.match_id}&select=id`, { headers: { ...sbH, Prefer: 'count=exact', Range: '0-0' } });
        const total = parseInt((cnt.headers.get('content-range') || '/0').split('/')[1] || '0', 10);
        if (total >= BIG_CAP) return res.status(409).json({ error: 'Big Match sold out for this fixture \u2014 standard packs still on sale.' });
      }
      const f = await upcomingFixtures();
      if (!big && !f.length) return res.status(409).json({ error: 'No trackable fixtures in the next ' + SALE_WINDOW_H + ' hours.' });
      const entries = []; let probes = 0;
      for (let i = 0; i < PACK_SIZE; i++) {
        const draw = drawCash();
        if (!draw.bonus) { entries.push({ cash_pence: draw.pence, match_id: null, fixture: null, kickoff: null, player_name: null, position: null, team_name: null, per_goal_pence: 0 }); continue; }
        const fx = big ? { id: feat.match_id, home: feat.fixture.split(' v ')[0], away: feat.fixture.split(' v ')[1] || '', kickoff: feat.kickoff } : pickFrom(f);
        let e = { cash_pence: draw.pence, match_id: fx.id, fixture: (fx.home || '') + ' v ' + (fx.away || ''), kickoff: fx.kickoff, player_name: null, position: null, team_name: null, per_goal_pence: 0 };
        if (big ? true : probes < 3) {
          const xi = await confirmedPool(fx.id); if (!cpCache[fx.id] || probes < 3) probes++;
          if (xi) { const p = pickFrom(xi); e = { ...e, player_name: p.player_name, position: p.position, team_name: p.team_name }; }
        }
        entries.push(e);
      }
      const totalCash = entries.reduce((s, e) => s + e.cash_pence, 0);
      const r = await fetch(SB + '/rest/v1/rpc/gc_buy_pack', { method: 'POST', headers: sbH,
        body: JSON.stringify({ p_user: authed, p_price: PACK_PRICE, p_cash: totalCash, p_entries: entries }) });
      if (!r.ok) return res.status(502).json({ error: 'DB: ' + (await r.text()).slice(0, 150) + ' \u2014 run the Squad Pack SQL' });
      const out = await r.json();
      if (out.error === 'insufficient') return res.status(402).json({ error: 'Balance too low \u2014 top-ups coming with payments.' });
      const rows = await (await fetch(SB + `/rest/v1/gc_tickets?pack_id=eq.${out.pack_id}&select=*&order=cash_pence.desc`, { headers: sbH })).json();
      // settle jackpot (cash-only) entries at purchase
      await fetch(SB + `/rest/v1/gc_tickets?pack_id=eq.${out.pack_id}&match_id=is.null`, { method: 'PATCH', headers: sbH,
        body: JSON.stringify({ settled: true, bonus_pence: 0 }) }).catch(() => {});
      return res.status(200).json({ pack: rows, pack_total_pence: totalCash, balance_pence: out.balance });
    }

    if (action === 'tickets') {
      if (!user) return res.status(400).json({ error: 'user required' });
      const uR = await fetch(SB + `/rest/v1/gc_tickets?user_key=eq.${encodeURIComponent(user)}&settled=eq.false&select=match_id`, { headers: sbH });
      const open = [...new Set((await uR.json()).map(t => t.match_id))].slice(0, 10);
      for (const mid of open) {
        try {
          const m = (await tsa(`/football/matches/${mid}`)).data;
          const tk = await (await fetch(SB + `/rest/v1/gc_tickets?match_id=eq.${mid}&settled=eq.false&select=id,user_key,player_name,per_goal_pence`, { headers: sbH })).json();
          const pending = tk.filter(t => !t.player_name);
          // 1) Assign players once the sheet is confirmed (or the match has been played).
          if (pending.length) {
            const xi = await confirmedPool(mid);
            if (xi) for (const t of pending) {
              const p = pickFrom(xi);
              await fetch(SB + `/rest/v1/gc_tickets?id=eq.${t.id}`, { method: 'PATCH', headers: sbH,
                body: JSON.stringify({ player_name: p.player_name, position: p.position, team_name: p.team_name, per_goal_pence: PER_GOAL[p.position] || PER_GOAL.M }) });
              t.player_name = p.player_name; t.per_goal_pence = PER_GOAL[p.position] || PER_GOAL.M;
            }
          }
          // 2) Settle finished matches for assigned tickets.
          if (m.status === 'finished') {
            let ev = {};
            const tally = (list) => (list || []).forEach(e => {
              if (!e.player) return;
              const p = ev[e.player.name] = ev[e.player.name] || { g: 0, y: 0, r: 0 };
              if (e.type === 'goal') p.g++;
              else if (e.type === 'yellow_card') p.y++;
              else if (/red/.test(e.type || '')) p.r++;
            });
            try {
              const tl = await tsa(`/football/matches/${mid}/timeline?event_type=goal,yellow_card,red_card`);
              tally(tl.data && tl.data.events);
            } catch (e1) {
              try { const tl = await tsa(`/football/matches/${mid}/timeline`); tally(tl.data && tl.data.events); } catch (e2) {}
            }
            // need cash_pence for multiplier — fetch fresh
            const tk2 = await (await fetch(SB + `/rest/v1/gc_tickets?match_id=eq.${mid}&settled=eq.false&select=id,user_key,player_name,cash_pence`, { headers: sbH })).json();
            for (const t of tk2) {
              if (!t.player_name) continue; // no sheet ever confirmed — leave open for manual review
              const e = ev[t.player_name] || { g: 0, y: 0, r: 0 };
              const mult = e.g * MULT.goal + e.y * MULT.yellow + e.r * MULT.red;
              const bonus = (t.cash_pence || 0) * mult;
              await fetch(SB + `/rest/v1/gc_tickets?id=eq.${t.id}`, { method: 'PATCH', headers: sbH,
                body: JSON.stringify({ settled: true, goals: e.g, cards: e.y, reds: e.r, bonus_pence: bonus }) });
              if (bonus > 0) await fetch(SB + '/rest/v1/rpc/gc_credit', { method: 'POST', headers: sbH,
                body: JSON.stringify({ p_user: t.user_key, p_amount: bonus, p_reason: 'event_bonus', p_ticket: t.id }) }).catch(() => {});
            }
          }
        } catch (e) {}
      }
      const all = await (await fetch(SB + `/rest/v1/gc_tickets?user_key=eq.${encodeURIComponent(user)}&select=*&order=created_at.desc&limit=50`, { headers: sbH })).json();
      const won = all.reduce((s, t) => s + (t.cash_pence || 0) + (t.bonus_pence || 0), 0);
      let balance = null;
      if (authed) {
        const w = await (await fetch(SB + `/rest/v1/gc_wallet?user_key=eq.${encodeURIComponent(authed)}&select=balance_pence`, { headers: sbH })).json();
        balance = w[0] ? w[0].balance_pence : null;
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ tickets: all, spent_pence: all.length * ENTRY_PENCE, won_pence: won, balance_pence: balance });
    }

    if (action === 'fav_add' || action === 'fav_del') {
      if (!user) return res.status(400).json({ error: 'user required' });
      const team_id = String(req.query.team_id || ''), team_name = String(req.query.team_name || '').slice(0, 80);
      if (!/^tm_\w+$/.test(team_id)) return res.status(400).json({ error: 'team_id required' });
      if (action === 'fav_add') {
        const r = await fetch(SB + '/rest/v1/gc_favs', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ user_key: user, team_id, team_name }]) });
        return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
      }
      const r = await fetch(SB + `/rest/v1/gc_favs?user_key=eq.${encodeURIComponent(user)}&team_id=eq.${team_id}`, { method: 'DELETE', headers: sbH });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
    }

    if (action === 'fav_list') {
      if (!user) return res.status(400).json({ error: 'user required' });
      const favs = await (await fetch(SB + `/rest/v1/gc_favs?user_key=eq.${encodeURIComponent(user)}&select=team_id,team_name&limit=10`, { headers: sbH })).json();
      const today = new Date().toISOString().slice(0, 10);
      const out = [];
      for (const f of favs.slice(0, 6)) {
        let next = null;
        try {
          const r = await tsa(`/football/matches?team_id=${f.team_id}&status=scheduled&date_from=${today}&per_page=3`);
          const m = (r.data || []).sort((a, b) => a.utc_date.localeCompare(b.utc_date))[0];
          if (m) next = { fixture: m.home_team.name + ' v ' + m.away_team.name, kickoff: m.utc_date };
        } catch (e) {}
        out.push({ ...f, next });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ favs: out });
    }

    if (action === 'claim') {
      if (!authed) return res.status(401).json({ error: 'sign in first' });
      const anon = String(req.query.anon || '').slice(0, 64);
      if (!anon || anon.startsWith('auth_')) return res.status(400).json({ error: 'anon key required' });
      await fetch(SB + `/rest/v1/gc_tickets?user_key=eq.${encodeURIComponent(anon)}`, { method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify({ user_key: authed }) });
      await fetch(SB + `/rest/v1/gc_favs?user_key=eq.${encodeURIComponent(anon)}`, { method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify({ user_key: authed }) }).catch(() => {});
      return res.status(200).json({ claimed: true });
    }

    if (action === 'upcoming') {
      if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const f = await upcomingFixtures();
      return res.status(200).json({ fixtures: f.slice(0, 50), featured: await getFeatured() });
    }

    if (action === 'feature') {
      if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'unauthorized' });
      if (req.query.clear) {
        await fetch(SB + '/rest/v1/gc_config?key=eq.featured', { method: 'DELETE', headers: sbH });
        return res.status(200).json({ featured: null });
      }
      const mid = String(req.query.match_id || '');
      const f = (await upcomingFixtures()).find(x => x.id === mid);
      if (!f) return res.status(404).json({ error: 'match not in the sale window' });
      const val = { match_id: f.id, fixture: f.home + ' v ' + f.away, kickoff: f.kickoff };
      await fetch(SB + '/rest/v1/gc_config', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ key: 'featured', value: val }]) });
      return res.status(200).json({ featured: val });
    }

    if (action === 'admin') {
      if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const all = await (await fetch(SB + '/rest/v1/gc_tickets?select=user_key,cash_pence,bonus_pence,goals,settled,position,created_at,player_name,fixture&order=created_at.desc&limit=10000', { headers: sbH })).json();
      const n = all.length, spent = n * ENTRY_PENCE;
      const cash = all.reduce((s, t) => s + (t.cash_pence || 0), 0);
      const bonus = all.reduce((s, t) => s + (t.bonus_pence || 0), 0);
      const byPos = {};
      all.forEach(t => { const k = t.position || 'pending'; const p = byPos[k] = byPos[k] || { n: 0, goals: 0, bonus: 0 }; p.n++; p.goals += t.goals || 0; p.bonus += t.bonus_pence || 0; });
      const wallets = await (await fetch(SB + '/rest/v1/gc_wallet?select=balance_pence&limit=10000', { headers: sbH })).json().catch(() => []);
      const liability = (wallets || []).reduce((s, w) => s + (w.balance_pence || 0), 0);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ tickets: n, users: new Set(all.map(t => t.user_key)).size,
        wallet_liability_pence: liability,
        revenue_pence: spent, instant_paid_pence: cash, bonus_paid_pence: bonus,
        rtp_pct: n ? +(((cash + bonus) / spent) * 100).toFixed(1) : null,
        unsettled: all.filter(t => !t.settled).length,
        awaiting_assignment: all.filter(t => !t.player_name && !t.settled).length,
        by_position: byPos, recent: all.slice(0, 25) });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
