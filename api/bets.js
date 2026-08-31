// GET /api/bets?team=tm_0406
// Next fixtures for a team, with bookmaker prices compared against a
// historical scoreline-frequency model built from the Supabase match store.
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, KEY = process.env.THESTATSAPI_KEY;
const BOOKS = 'bet365,pinnacle,betfair-exchange,paddy-power';
const MIN_GAMES = 15;

async function sbRows(team) {
  const r = await fetch(`${SB}/rest/v1/team_matches?team_id=eq.${encodeURIComponent(team)}&select=gf,ga,utc_date&order=utc_date.desc&limit=200`,
    { headers: { apikey: SK, Authorization: 'Bearer ' + SK } });
  return r.ok ? r.json() : [];
}
async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (!r.ok) throw new Error('TSA ' + r.status);
  return r.json();
}

// Profile: probabilities from a team's own perspective.
function profile(rows) {
  const n = rows.length;
  const p = { n, win: 0, draw: 0, loss: 0, btts: 0, o25: 0, u25: 0, scores: {} };
  if (!n) return p;
  rows.forEach(({ gf, ga }) => {
    if (gf > ga) p.win++; else if (gf < ga) p.loss++; else p.draw++;
    if (gf > 0 && ga > 0) p.btts++;
    if (gf + ga > 2.5) p.o25++; else p.u25++;
    const k = gf + '-' + ga; p.scores[k] = (p.scores[k] || 0) + 1;
  });
  for (const k of ['win', 'draw', 'loss', 'btts', 'o25', 'u25']) p[k] /= n;
  for (const k in p.scores) p.scores[k] /= n;
  return p;
}

const num = v => { const x = parseFloat(v && (v.last_seen || v.opening || v)); return x > 1 ? x : null; };
const scoreKey = k => { const m = String(k).match(/(\d+)\D+(\d+)/); return m ? m[1] + '-' + m[2] : null; };

// Best price per selection across bookmakers.
function bestPrices(bookmakers) {
  const best = {}; // key → {odds, book}
  const put = (key, v, book) => { const o = num(v); if (o && (!best[key] || o > best[key].odds)) best[key] = { odds: o, book }; };
  (bookmakers || []).forEach(b => {
    const m = b.markets || {}, name = b.bookmaker;
    if (m.match_odds) { put('1x2:home', m.match_odds.home, name); put('1x2:draw', m.match_odds.draw, name); put('1x2:away', m.match_odds.away, name); }
    if (m.btts) { put('btts:yes', m.btts.yes, name); put('btts:no', m.btts.no, name); }
    if (m.total_goals) for (const k in m.total_goals) {
      const line = parseFloat(String(k).match(/\d+(\.\d+)?/)?.[0]);
      if (line === 2.5) { put('ou:over', m.total_goals[k].over, name); put('ou:under', m.total_goals[k].under, name); }
    }
    if (m.correct_score) for (const k in m.correct_score) { const sk = scoreKey(k); if (sk) put('cs:' + sk, m.correct_score[k], name); }
  });
  return best;
}

module.exports = async (req, res) => {
  const team = req.query.team;
  if (!team || !/^tm_\w+$/.test(team)) return res.status(400).json({ error: 'team required' });
  if (!SB || !SK || !KEY) return res.status(500).json({ error: 'Missing env vars' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const [ownRows, fx] = await Promise.all([
      sbRows(team),
      tsa(`/football/matches?team_id=${team}&status=scheduled&date_from=${today}&per_page=5`)
    ]);
    const own = profile(ownRows);
    const fixtures = (fx.data || []).sort((a, b) => a.utc_date.localeCompare(b.utc_date)).slice(0, 2);
    const out = [];

    for (const m of fixtures) {
      const isHome = m.home_team.id === team;
      const opp = isHome ? m.away_team : m.home_team;
      const entry = { match_id: m.id, kickoff: m.utc_date, home: m.home_team.name, away: m.away_team.name, is_home: isHome, opponent: opp.name, bets: [], sample: own.n };
      if (own.n < MIN_GAMES) { entry.note = 'Not enough history yet'; out.push(entry); continue; }
      if (!m.odds_available) { entry.note = 'No odds yet'; out.push(entry); continue; }

      const [oppRows, oddsR] = await Promise.all([sbRows(opp.id), tsa(`/football/matches/${m.id}/odds?bookmaker=${BOOKS}`).catch(() => null)]);
      const oppP = profile(oppRows);
      const useOpp = oppP.n >= MIN_GAMES;
      const w = useOpp ? 0.5 : 1;
      entry.opp_sample = oppP.n;

      // Model from the fixture's home/away perspective.
      const H = isHome ? own : oppP, A = isHome ? oppP : own; // if opp sample too small, fall back to own only
      const blend = (fromH, fromA) => useOpp ? 0.5 * fromH + 0.5 * fromA : (isHome ? fromH : fromA);
      const model = {
        '1x2:home': blend(H.win, A.loss), '1x2:draw': blend(H.draw, A.draw), '1x2:away': blend(H.loss, A.win),
        'btts:yes': blend(H.btts, A.btts), 'btts:no': blend(1 - H.btts, 1 - A.btts),
        'ou:over': blend(H.o25, A.o25), 'ou:under': blend(H.u25, A.u25)
      };
      const keys = new Set([...Object.keys(H.scores), ...Object.keys(A.scores).map(k => k.split('-').reverse().join('-'))]);
      keys.forEach(k => {
        const [h, a] = k.split('-');
        const fromH = H.scores[k] || 0, fromA = A.scores[a + '-' + h] || 0;
        const p = blend(fromH, fromA);
        if (p > 0) model['cs:' + k] = p;
      });

      const prices = bestPrices(oddsR && oddsR.data && oddsR.data.bookmakers);
      const label = { '1x2:home': m.home_team.name + ' to win', '1x2:draw': 'Draw', '1x2:away': m.away_team.name + ' to win',
        'btts:yes': 'Both teams to score', 'btts:no': 'BTTS no', 'ou:over': 'Over 2.5 goals', 'ou:under': 'Under 2.5 goals' };
      for (const key in prices) {
        const p = model[key]; if (!p) continue;
        const implied = 1 / prices[key].odds;
        const edge = p - implied;
        if (edge <= 0.01) continue;
        entry.bets.push({
          market: key.startsWith('cs:') ? 'Correct score' : key.startsWith('1x2') ? 'Match result' : key.startsWith('btts') ? 'BTTS' : 'Total goals',
          selection: key.startsWith('cs:') ? key.slice(3).replace('-', '–') : label[key],
          odds: prices[key].odds, book: prices[key].book,
          model_pct: +(p * 100).toFixed(1), implied_pct: +(implied * 100).toFixed(1),
          edge_pct: +(edge * 100).toFixed(1), ev: +((p * prices[key].odds - 1) * 100).toFixed(0)
        });
      }
      entry.bets.sort((a, b) => b.ev - a.ev);
      entry.bets = entry.bets.slice(0, 6);
      if (!Object.keys(prices).length) entry.note = 'No prices captured yet';
      out.push(entry);
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');
    return res.status(200).json({ team, sample: own.n, fixtures: out });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
