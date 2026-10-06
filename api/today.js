// GET /api/today → today's fixtures that actually HAVE a lineup (predicted or confirmed),
// with the XIs bundled. Probes are capped and CDN-cached to protect quota.
const KEY = process.env.THESTATSAPI_KEY;
const MAX_PROBES = 80, CONCURRENCY = 8, MIN_COVERAGE_PCT = 50;
let compCache = null;

async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (!r.ok) { const e = new Error('TSA ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

async function comps() {
  if (compCache && Date.now() - compCache.at < 6 * 36e5) return compCache;
  const names = {};
  for (let p = 1; p <= 4; p++) {
    const r = await tsa(`/football/competitions?per_page=100&page=${p}`);
    r.data.forEach(c => names[c.id] = { name: c.name, country: c.country || '' });
    if (p >= (r.meta.total_pages || 1)) break;
  }
  const covered = new Set();
  for (let p = 1; p <= 2; p++) {
    const r = await tsa(`/coverage/leagues?data_type=lineups&per_page=200&page=${p}`);
    r.data.forEach(c => {
      const lu = c.data_types && c.data_types.lineups;
      if (lu && lu.available && (lu.coverage_pct == null || lu.coverage_pct >= MIN_COVERAGE_PCT)) covered.add(c.id);
    });
    if (p >= (r.meta.total_pages || 1)) break;
  }
  compCache = { at: Date.now(), names, covered };
  return compCache;
}

module.exports = async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'THESTATSAPI_KEY not set' });
  try {
    const { names, covered } = await comps();
    const d = new Date().toISOString().slice(0, 10);
    let all = [];
    for (let p = 1; p <= 4; p++) {
      const r = await tsa(`/football/matches?date_from=${d}&date_to=${d}&per_page=100&page=${p}`);
      all.push(...r.data);
      if (p >= (r.meta.total_pages || 1)) break;
    }
    const now = Date.now();
    const candidates = all.filter(m =>
      m.status !== 'cancelled' && m.status !== 'postponed' &&
      covered.has(m.competition_id) &&
      new Date(m.utc_date).getTime() > now - 12 * 36e5 && new Date(m.utc_date).getTime() < now + 12 * 36e5
    ).slice(0, MAX_PROBES);

    const out = [];
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async m => {
        try {
          const lu = (await tsa(`/football/matches/${m.id}/lineups`)).data;
          if (!lu || !lu.home || !(lu.home.starting_xi || []).length) return null;
          const side = s => ({ name: s.name, formation: s.formation || null,
            xi: (s.starting_xi || []).map(p => ({ n: p.jersey_number, name: p.name, pos: p.position })) });
          return { id: m.id, competition_id: m.competition_id,
            competition: names[m.competition_id] ? (names[m.competition_id].country ? names[m.competition_id].country + ' — ' : '') + names[m.competition_id].name : 'Other',
            kickoff: m.utc_date, status: m.status,
            home: m.home_team.name, away: m.away_team.name,
            score: m.score && m.score.home != null ? m.score.home + '–' + m.score.away : null,
            minute: m.live && m.live.elapsed_minutes || null,
            lineup: { type: lu.type, confirmed: !!lu.confirmed, home: side(lu.home), away: side(lu.away) } };
        } catch (e) { return null; }
      }));
      out.push(...results.filter(Boolean));
    }
    out.sort((a, b) => a.competition.localeCompare(b.competition) || a.kickoff.localeCompare(b.kickoff));
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ date: d, checked: candidates.length, with_lineups: out.length, fixtures: out });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
