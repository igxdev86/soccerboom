// GET /api/target-event?m=mt_123 → fixture, Bet365 prices, form, h2h, bets on it. Cached 10 min.
const { tsa } = require("./_target");
const name = require("./_names");
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const sbH = { apikey: SK, Authorization: "Bearer " + SK };
const px = v => v && parseFloat(v.last_seen || v.opening);

function form(teamId, matches) {
  return matches.map(m => {
    const home = m.home_team.id === teamId, gf = home ? m.score.home : m.score.away, ga = home ? m.score.away : m.score.home;
    return { date: m.utc_date, opp: home ? m.away_team.name : m.home_team.name, home, gf, ga, r: gf > ga ? "W" : gf < ga ? "L" : "D" };
  });
}

module.exports = async (req, res) => {
  try {
    const id = req.query.m;
    if (!/^mt_\w+$/.test(id || "")) return res.status(400).json({ error: "m" });
    const mr = await tsa(`/football/matches/${id}`);
    const m = mr && mr.data;
    if (!m) return res.status(404).json({ error: "not found" });
    const [o, hf, af, br] = await Promise.all([
      m.odds_available ? tsa(`/football/matches/${id}/odds?bookmaker=bet365`) : null,
      tsa(`/football/matches?team_id=${m.home_team.id}&status=finished&per_page=8`),
      tsa(`/football/matches?team_id=${m.away_team.id}&status=finished&per_page=8`),
      fetch(SB + `/rest/v1/target_bets?legs=cs.${encodeURIComponent(JSON.stringify([{ match: id }]))}&status=neq.nobet&select=id,bot,stake,target,risk,odds,status,legs,placed_at&order=placed_at.desc&limit=50`, { headers: sbH }).then(r => r.json())
    ]);
    const mk = (o && o.data && o.data.bookmakers && o.data.bookmakers[0] && o.data.bookmakers[0].markets) || {};
    const odds = {};
    if (mk.match_odds) odds.result = { home: px(mk.match_odds.home), draw: px(mk.match_odds.draw), away: px(mk.match_odds.away) };
    if (mk.btts) odds.btts = { yes: px(mk.btts.yes), no: px(mk.btts.no) };
    if (mk.total_goals) odds.totals = Object.fromEntries(Object.entries(mk.total_goals).filter(([k]) => !Number.isInteger(parseFloat(k))).map(([k, v]) => [k, { over: px(v.over), under: px(v.under) }]));
    const hm = ((hf && hf.data) || []).filter(x => x.score && x.score.home != null).slice(0, 6);
    const am = ((af && af.data) || []).filter(x => x.score && x.score.home != null).slice(0, 6);
    const h2h = [...hm, ...((af && af.data) || [])].filter(x => x.score && x.score.home != null && [x.home_team.id, x.away_team.id].includes(m.home_team.id) && [x.home_team.id, x.away_team.id].includes(m.away_team.id));
    const seen = new Set();
    const bets = (Array.isArray(br) ? br : []).map(b => ({ ...b, user: name(b.bot), leg: b.legs.find(l => l.match === id) }));
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    res.status(200).json({
      match: { id: m.id, status: m.status, ko: m.utc_date, home: m.home_team, away: m.away_team, score: m.score, competition_id: m.competition_id, matchday: m.matchday },
      odds, home_form: form(m.home_team.id, hm), away_form: form(m.away_team.id, am),
      h2h: h2h.filter(x => !seen.has(x.id) && seen.add(x.id)).slice(0, 5).map(x => ({ date: x.utc_date, home: x.home_team.name, away: x.away_team.name, hg: x.score.home, ag: x.score.away })),
      bets
    });
  } catch (e) { res.status(200).json({ error: String(e && e.stack || e) }); }
};
