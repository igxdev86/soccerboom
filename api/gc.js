// GOALCASH prototype. One endpoint, three actions:
//  POST /api/gc?action=buy&user=KEY   → instant cash prize + random player from tonight's confirmed XIs
//  GET  /api/gc?action=tickets&user=  → user's tickets (lazy-settles finished matches first)
//  GET  /api/gc?action=pool           → tonight's eligible player count (for the page header)
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, KEY = process.env.THESTATSAPI_KEY;
const sbH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

const TICKET_PENCE = 100;
// Instant cash table (pence, cumulative probability). ~34% hit rate, ~55p EV.
const CASH = [[50, .20], [100, .08], [200, .04], [500, .015], [1000, .004], [10000, .0005]];
// Per-goal bonus by position (pence). Keepers are the lottery ticket.
const PER_GOAL = { G: 25000, D: 2500, M: 500, F: 200 };

async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (!r.ok) throw new Error('TSA ' + r.status);
  return r.json();
}
let squadPoolCache = null;
async function pool() {
  const base = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://soccerboom.vercel.app';
  const j = await (await fetch(base + '/api/today')).json().catch(() => ({}));
  const players = [];
  (j.fixtures || []).forEach(f => {
    if (f.status === 'finished') return;
    ['home', 'away'].forEach(side => {
      (f.lineup[side].xi || []).forEach(p => players.push({
        player_name: p.name, pos: p.pos || 'M', team_name: f.lineup[side].name,
        match_id: f.id, fixture: f.home + ' v ' + f.away, kickoff: f.kickoff, source: 'xi'
      }));
    });
  });
  if (players.length) return players;
  // Daytime fallback: no team sheets yet → allocate from full squads of today's
  // remaining fixtures in lineup-covered competitions. Non-starters score 0; that's the game.
  if (squadPoolCache && Date.now() - squadPoolCache.at < 36e5) return squadPoolCache.p;
  const d = new Date().toISOString().slice(0, 10);
  const covered = new Set();
  for (let p = 1; p <= 2; p++) {
    const r = await tsa(`/coverage/leagues?data_type=lineups&per_page=200&page=${p}`);
    r.data.forEach(c => { const lu = c.data_types && c.data_types.lineups; if (lu && lu.available) covered.add(c.id); });
    if (p >= (r.meta.total_pages || 1)) break;
  }
  let fx = [];
  for (let p = 1; p <= 4; p++) {
    const r = await tsa(`/football/matches?date_from=${d}&date_to=${d}&per_page=100&page=${p}`);
    fx.push(...r.data);
    if (p >= (r.meta.total_pages || 1)) break;
  }
  fx = fx.filter(m => m.status === 'scheduled' && covered.has(m.competition_id))
    .sort((a, b) => a.utc_date.localeCompare(b.utc_date)).slice(0, 8);
  const out = [];
  for (const m of fx) {
    for (const side of [m.home_team, m.away_team]) {
      try {
        const sq = (await tsa(`/football/teams/${side.id}/players`)).data || [];
        sq.forEach(p => out.push({ player_name: p.short_name || p.name, pos: p.position || 'M',
          team_name: side.name, match_id: m.id,
          fixture: m.home_team.name + ' v ' + m.away_team.name, kickoff: m.utc_date, source: 'squad' }));
      } catch (e) {}
    }
  }
  squadPoolCache = { at: Date.now(), p: out };
  return out;
}
const drawCash = () => { let r = Math.random(), acc = 0; for (const [p, pr] of CASH) { acc += pr; if (r < acc) return p; } return 0; };

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
      const p = await pool();
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.status(200).json({ players: p.length, matches: [...new Set(p.map(x => x.match_id))].length });
    }

    if (action === 'buy') {
      if (!user) return res.status(400).json({ error: 'user required' });
      const p = await pool();
      if (!p.length) return res.status(409).json({ error: 'No eligible matches right now — tickets open when team sheets are in for upcoming games.' });
      const pick = p[Math.floor(Math.random() * p.length)];
      const cash = drawCash();
      const per_goal = PER_GOAL[pick.pos] || PER_GOAL.M;
      const t = { user_key: user, player_name: pick.player_name, position: pick.pos,
        team_name: pick.team_name, match_id: pick.match_id, fixture: pick.fixture, kickoff: pick.kickoff,
        cash_pence: cash, per_goal_pence: per_goal, settled: false };
      const r = await fetch(SB + '/rest/v1/gc_tickets', { method: 'POST', headers: { ...sbH, Prefer: 'return=representation' }, body: JSON.stringify([t]) });
      if (!r.ok) return res.status(502).json({ error: 'DB: ' + (await r.text()).slice(0, 150) + ' — run the GOALCASH SQL' });
      return res.status(200).json({ ticket: (await r.json())[0] });
    }

    if (action === 'tickets') {
      if (!user) return res.status(400).json({ error: 'user required' });
      // Lazy settlement: finished matches among this user's unsettled tickets.
      const uR = await fetch(SB + `/rest/v1/gc_tickets?user_key=eq.${encodeURIComponent(user)}&settled=eq.false&select=match_id`, { headers: sbH });
      const open = [...new Set((await uR.json()).map(t => t.match_id))].slice(0, 10);
      for (const mid of open) {
        try {
          const m = (await tsa(`/football/matches/${mid}`)).data;
          if (m.status !== 'finished') continue;
          let goals = {};
          try {
            const tl = await tsa(`/football/matches/${mid}/timeline?event_type=goal`);
            ((tl.data && tl.data.events) || []).forEach(e => { if (e.player) goals[e.player.name] = (goals[e.player.name] || 0) + 1; });
          } catch (e) {}
          const tk = await (await fetch(SB + `/rest/v1/gc_tickets?match_id=eq.${mid}&settled=eq.false&select=id,player_name,per_goal_pence`, { headers: sbH })).json();
          for (const t of tk) {
            const g = goals[t.player_name] || 0;
            await fetch(SB + `/rest/v1/gc_tickets?id=eq.${t.id}`, { method: 'PATCH', headers: sbH,
              body: JSON.stringify({ settled: true, goals: g, bonus_pence: g * t.per_goal_pence }) });
          }
        } catch (e) {}
      }
      const all = await (await fetch(SB + `/rest/v1/gc_tickets?user_key=eq.${encodeURIComponent(user)}&select=*&order=created_at.desc&limit=50`, { headers: sbH })).json();
      const won = all.reduce((s, t) => s + (t.cash_pence || 0) + (t.bonus_pence || 0), 0);
      const spent = all.length * TICKET_PENCE;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ tickets: all, spent_pence: spent, won_pence: won });
    }

    if (action === 'claim') {
      if (!authed) return res.status(401).json({ error: 'sign in first' });
      const anon = String(req.query.anon || '').slice(0, 64);
      if (!anon || anon.startsWith('auth_')) return res.status(400).json({ error: 'anon key required' });
      const r = await fetch(SB + `/rest/v1/gc_tickets?user_key=eq.${encodeURIComponent(anon)}`, {
        method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify({ user_key: authed }) });
      return res.status(r.ok ? 200 : 502).json({ claimed: r.ok });
    }

    if (action === 'admin') {
      if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const all = await (await fetch(SB + '/rest/v1/gc_tickets?select=user_key,cash_pence,bonus_pence,goals,settled,position,created_at,player_name,fixture&order=created_at.desc&limit=10000', { headers: sbH })).json();
      const n = all.length, spent = n * TICKET_PENCE;
      const cash = all.reduce((s, t) => s + (t.cash_pence || 0), 0);
      const bonus = all.reduce((s, t) => s + (t.bonus_pence || 0), 0);
      const byPos = {};
      all.forEach(t => { const p = byPos[t.position] = byPos[t.position] || { n: 0, goals: 0, bonus: 0 }; p.n++; p.goals += t.goals || 0; p.bonus += t.bonus_pence || 0; });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ tickets: n, users: new Set(all.map(t => t.user_key)).size,
        revenue_pence: spent, instant_paid_pence: cash, bonus_paid_pence: bonus,
        rtp_pct: n ? +(((cash + bonus) / spent) * 100).toFixed(1) : null,
        unsettled: all.filter(t => !t.settled).length, by_position: byPos, recent: all.slice(0, 25) });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
