// Internationals study page backend.
// GET /api/intl?date=YYYY-MM-DD        → that day's international fixtures
// GET /api/intl?match=mt_xxx           → study card: form, h2h, model, Bet365 prices
const KEY = process.env.THESTATSAPI_KEY;
async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (!r.ok) throw new Error('TSA ' + r.status);
  return r.json();
}
function poisson(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function profile(rows, teamId) {
  const p = { n: rows.length, form: '', gf: 0, ga: 0 };
  let wsum = 0, gfw = 0, gaw = 0;
  rows.forEach((m, i) => {
    const home = m.home_team.id === teamId;
    const gf = home ? m.score.home : m.score.away, ga = home ? m.score.away : m.score.home;
    if (i < 6) p.form += gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    const w = Math.pow(0.9, i); wsum += w; gfw += gf * w; gaw += ga * w;
    p.gf += gf; p.ga += ga;
  });
  if (p.n) { p.gf_pg = +(p.gf / p.n).toFixed(2); p.ga_pg = +(p.ga / p.n).toFixed(2); p.att = gfw / wsum; p.def = gaw / wsum; }
  return p;
}
const num = v => { const x = parseFloat(v && (v.last_seen || v.opening || v)); return x > 1 ? x : null; };
const scoreKey = k => { const m = String(k).match(/(\d+)\D+(\d+)/); return m ? m[1] + '-' + m[2] : null; };

let compCache = null;
async function intlComps() {
  if (compCache && Date.now() - compCache.at < 864e5) return compCache.map;
  const map = {};
  for (const type of ['international', 'cup_international']) {
    try {
      for (let page = 1; page <= 2; page++) {
        const r = await tsa(`/football/competitions?type=${type}&per_page=100&page=${page}`);
        r.data.forEach(c => map[c.id] = c.name);
        if (page >= (r.meta.total_pages || 1)) break;
      }
    } catch (e) { /* type not supported → ignore */ }
  }
  compCache = { at: Date.now(), map };
  return map;
}

module.exports = async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'THESTATSAPI_KEY not set' });
  try {
    if (req.query.match) {
      const id = req.query.match;
      if (!/^\w+$/.test(id)) return res.status(400).json({ error: 'bad match id' });
      const det = (await tsa(`/football/matches/${id}`)).data;
      const H = det.home_team, A = det.away_team;
      const [hR, aR, oddsR] = await Promise.all([
        tsa(`/football/matches?team_id=${H.id}&status=finished&per_page=15`),
        tsa(`/football/matches?team_id=${A.id}&status=finished&per_page=15`),
        det.odds_available ? tsa(`/football/matches/${id}/odds?bookmaker=bet365`).catch(() => null) : null
      ]);
      const hRows = hR.data.filter(m => m.score && m.score.home != null).sort((a, b) => b.utc_date.localeCompare(a.utc_date));
      const aRows = aR.data.filter(m => m.score && m.score.home != null).sort((a, b) => b.utc_date.localeCompare(a.utc_date));
      const hp = profile(hRows, H.id), ap = profile(aRows, A.id);
      const h2h = hRows.filter(m => m.home_team.id === A.id || m.away_team.id === A.id).slice(0, 3)
        .map(m => `${m.home_team.name} ${m.score.home}–${m.score.away} ${m.away_team.name}`);

      let model = null;
      if (hp.n >= 6 && ap.n >= 6) {
        const lh = ((hp.att + ap.def) / 2) * 1.1, la = (ap.att + hp.def) / 2;
        const grid = []; let pH = 0, pD = 0, pA = 0, o25 = 0, btts = 0;
        for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++) {
          const p = poisson(h, lh) * poisson(a, la); grid.push({ h, a, p });
          if (h > a) pH += p; else if (h < a) pA += p; else pD += p;
          if (h + a > 2.5) o25 += p; if (h && a) btts += p;
        }
        grid.sort((x, y) => y.p - x.p);
        const outcome = pH >= pD && pH >= pA ? 'home' : pA >= pD ? 'away' : 'draw';
        const pick = grid.find(g => outcome === 'home' ? g.h > g.a : outcome === 'away' ? g.a > g.h : g.h === g.a);
        const pct = p => +(p * 100).toFixed(1);
        model = { outcome, outcome_pct: pct(outcome === 'home' ? pH : outcome === 'away' ? pA : pD),
          pick: { score: pick.h + '–' + pick.a, pct: pct(pick.p) },
          top: grid.slice(0, 3).map(g => ({ score: g.h + '–' + g.a, pct: pct(g.p) })),
          home_win: pct(pH), draw: pct(pD), away_win: pct(pA), over25: pct(o25), btts: pct(btts),
          xg: [+lh.toFixed(2), +la.toFixed(2)] };
      }
      let prices = null;
      const bk = oddsR && oddsR.data && (oddsR.data.bookmakers || []).find(b => /bet ?365/i.test(b.bookmaker));
      if (bk) {
        const m = bk.markets || {}; prices = {};
        if (m.match_odds) { prices.home = num(m.match_odds.home); prices.draw = num(m.match_odds.draw); prices.away = num(m.match_odds.away); }
        if (m.btts) prices.btts = num(m.btts.yes);
        if (m.total_goals) for (const k in m.total_goals) if (parseFloat(String(k).match(/\d+(\.\d+)?/)?.[0]) === 2.5) prices.over25 = num(m.total_goals[k].over);
        if (m.correct_score && model) { const cs = Object.entries(m.correct_score).find(([k]) => scoreKey(k) === model.pick.score.replace('–', '-')); if (cs) prices.pick = num(cs[1]); }
      }
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');
      return res.status(200).json({ id, home: H.name, away: A.name,
        home_form: hp.form, away_form: ap.form,
        home_goals: hp.n ? [hp.gf_pg, hp.ga_pg, hp.n] : null, away_goals: ap.n ? [ap.gf_pg, ap.ga_pg, ap.n] : null,
        h2h, model, prices });
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
    const comps = await intlComps();
    let fixtures = [];
    for (let page = 1; page <= 4; page++) {
      const r = await tsa(`/football/matches?date_from=${date}&date_to=${date}&per_page=100&page=${page}`);
      fixtures.push(...r.data);
      if (page >= (r.meta.total_pages || 1)) break;
    }
    fixtures = fixtures.filter(m => comps[m.competition_id])
      .map(m => ({ id: m.id, kickoff: m.utc_date, status: m.status, competition: comps[m.competition_id],
        home: m.home_team.name, away: m.away_team.name,
        result: m.score && m.score.home != null ? m.score.home + '–' + m.score.away : null,
        odds_available: !!m.odds_available }))
      .sort((a, b) => a.competition.localeCompare(b.competition) || a.kickoff.localeCompare(b.kickoff));
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json({ date, fixtures });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
