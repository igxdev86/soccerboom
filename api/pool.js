// Vercel serverless: builds a flat selection pool from TheStatsAPI (Bet365 prices).
// Env: THESTATSAPI_KEY. Cached 10 min at the edge.
const BASE = "https://api.thestatsapi.com/api";

async function tsa(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: "Bearer " + process.env.THESTATSAPI_KEY } });
  if (!r.ok) return null;
  return r.json();
}

module.exports = async (req, res) => {
  const days = Math.min(parseInt(req.query.days || "3", 10), 7);
  const d0 = new Date(), d1 = new Date(Date.now() + days * 864e5);
  const iso = d => d.toISOString().slice(0, 10);
  const m = await tsa(`/football/matches?status=scheduled&sort=utc_date&date_from=${iso(d0)}&date_to=${iso(d1)}&per_page=100`);
  const matches = (m && m.data || []).filter(x => x.odds_available).slice(0, 40);
  const pool = [];
  await Promise.all(matches.map(async mt => {
    const o = await tsa(`/football/matches/${mt.id}/odds?bookmaker=bet365`);
    const bk = o && o.data && o.data.bookmakers && o.data.bookmakers[0];
    if (!bk) return;
    const mk = bk.markets || {};
    const base = { match: mt.id, home: mt.home_team.name, away: mt.away_team.name, ko: mt.utc_date, comp: mt.competition_id };
    const px = v => v && parseFloat(v.last_seen || v.opening);
    if (mk.match_odds) {
      pool.push({ ...base, market: "Match result", pick: mt.home_team.name, price: px(mk.match_odds.home) });
      pool.push({ ...base, market: "Match result", pick: "Draw", price: px(mk.match_odds.draw) });
      pool.push({ ...base, market: "Match result", pick: mt.away_team.name, price: px(mk.match_odds.away) });
    }
    if (mk.double_chance) for (const k of Object.keys(mk.double_chance))
      pool.push({ ...base, market: "Double chance", pick: k.replace(/_/g, " "), price: px(mk.double_chance[k]) });
    if (mk.btts) {
      pool.push({ ...base, market: "BTTS", pick: "Yes", price: px(mk.btts.yes) });
      pool.push({ ...base, market: "BTTS", pick: "No", price: px(mk.btts.no) });
    }
    if (mk.total_goals) for (const line of Object.keys(mk.total_goals)) {
      const t = mk.total_goals[line];
      pool.push({ ...base, market: "Total goals", pick: "Over " + line, price: px(t.over) });
      pool.push({ ...base, market: "Total goals", pick: "Under " + line, price: px(t.under) });
    }
  }));
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
  res.status(200).json({ pool: pool.filter(s => s.price > 1), matches: matches.length, generated: new Date().toISOString() });
};
