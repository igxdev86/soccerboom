// GET /api/predict?date=YYYY-MM-DD → every fixture that day with most likely correct score + %
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, KEY = process.env.THESTATSAPI_KEY;
const MIN_N = 6;

const sbH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (!r.ok) throw new Error('TSA ' + r.status);
  return r.json();
}
function poisson(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

function predict(H, A) {
  // Expected goals: attack of one side v defence of the other, home/away specific.
  const ok = x => x != null;
  const hAtt = H.home_n >= MIN_N ? +H.home_gf : null, hDef = H.home_n >= MIN_N ? +H.home_ga : null;
  const aAtt = A.away_n >= MIN_N ? +A.away_gf : null, aDef = A.away_n >= MIN_N ? +A.away_ga : null;
  if (![hAtt, hDef, aAtt, aDef].every(ok)) return null;
  const lh = (hAtt + aDef) / 2, la = (aAtt + hDef) / 2;
  const grid = [];
  let pH = 0, pD = 0, pA = 0;
  for (let h = 0; h <= 7; h++) for (let a = 0; a <= 7; a++) {
    const p = poisson(h, lh) * poisson(a, la);
    grid.push({ h, a, p });
    if (h > a) pH += p; else if (h < a) pA += p; else pD += p;
  }
  grid.sort((x, y) => y.p - x.p);
  const pct = p => +(p * 100).toFixed(1);
  return {
    xg_home: +lh.toFixed(2), xg_away: +la.toFixed(2),
    likely: grid.slice(0, 3).map(g => ({ score: g.h + '–' + g.a, pct: pct(g.p) })),
    home_win: pct(pH), draw: pct(pD), away_win: pct(pA),
    over25: pct(grid.filter(g => g.h + g.a > 2.5).reduce((s, g) => s + g.p, 0)),
    btts: pct(grid.filter(g => g.h > 0 && g.a > 0).reduce((s, g) => s + g.p, 0)),
    sample: Math.min(H.home_n, A.away_n)
  };
}

module.exports = async (req, res) => {
  if (!SB || !SK || !KEY) return res.status(500).json({ error: 'Missing env vars' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  try {
    let fixtures = [];
    for (let page = 1; page <= 4; page++) {
      const r = await tsa(`/football/matches?date_from=${date}&date_to=${date}&per_page=100&page=${page}`);
      fixtures.push(...r.data);
      if (page >= (r.meta.total_pages || 1)) break;
    }
    fixtures = fixtures.filter(m => m.status !== 'cancelled' && m.status !== 'postponed');
    if (!fixtures.length) return res.status(200).json({ date, fixtures: [] });

    const ids = [...new Set(fixtures.flatMap(m => [m.home_team.id, m.away_team.id]))];
    const compIds = [...new Set(fixtures.map(m => m.competition_id))];
    const [formR, compR] = await Promise.all([
      fetch(SB + '/rest/v1/rpc/team_form', { method: 'POST', headers: sbH, body: JSON.stringify({ p_ids: ids, p_before: date + 'T00:00:00Z' }) }),
      fetch(SB + `/rest/v1/competitions?id=in.(${compIds.join(',')})&select=id,name,country`, { headers: sbH })
    ]);
    if (!formR.ok) return res.status(502).json({ error: 'Supabase: ' + (await formR.text()).slice(0, 200) + ' — run the v5 SQL (team_form with p_before)' });
    const form = {}; (await formR.json()).forEach(t => form[t.team_id] = t);
    const comps = {}; (compR.ok ? await compR.json() : []).forEach(c => comps[c.id] = c);

    const out = fixtures.map(m => {
      const H = form[m.home_team.id], A = form[m.away_team.id];
      const c = comps[m.competition_id] || {};
      const base = { id: m.id, kickoff: m.utc_date, status: m.status, home: m.home_team.name, away: m.away_team.name,
        competition: c.name || null, country: c.country || null,
        result: m.score && m.score.home != null ? m.score.home + '–' + m.score.away : null };
      const p = H && A ? predict(H, A) : null;
      return p ? { ...base, ...p } : { ...base, note: 'Not enough history for one side' };
    }).filter(f => f.competition) // only leagues we track
      .sort((a, b) => (a.country || 'zz').localeCompare(b.country || 'zz') || a.kickoff.localeCompare(b.kickoff));

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');
    return res.status(200).json({ date, fixtures: out });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
