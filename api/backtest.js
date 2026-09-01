// GET /api/backtest?days=30&country=uk|all → how the model would have done, no look-ahead.
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const sbH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const MIN_N = 6, UK = ['England', 'Scotland', 'Wales', 'Northern Ireland'];
function poisson(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function predict(H, A) {
  if (!H || !A || H.home_n < MIN_N || A.away_n < MIN_N) return null;
  const lh = (+H.home_gf + +A.away_ga) / 2, la = (+A.away_gf + +H.home_ga) / 2;
  let best = null, pH = 0, pD = 0, pA = 0, o25 = 0, btts = 0;
  for (let h = 0; h <= 7; h++) for (let a = 0; a <= 7; a++) {
    const p = poisson(h, lh) * poisson(a, la);
    if (!best || p > best.p) best = { h, a, p };
    if (h > a) pH += p; else if (h < a) pA += p; else pD += p;
    if (h + a > 2.5) o25 += p; if (h && a) btts += p;
  }
  return { h: best.h, a: best.a, p: best.p, pH, pD, pA, o25, btts };
}
module.exports = async (req, res) => {
  if (!SB || !SK) return res.status(500).json({ error: 'Missing env vars' });
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10)));
  const ukOnly = (req.query.country || 'uk') === 'uk';
  const since = new Date(Date.now() - days * 864e5).toISOString();
  try {
    const [mR, cR] = await Promise.all([
      fetch(SB + `/rest/v1/matches?utc_date=gte.${since}&utc_date=lte.${new Date().toISOString()}&select=id,competition_id,utc_date,home_id,away_id,home_goals,away_goals&order=utc_date.asc&limit=4000`, { headers: sbH }),
      fetch(SB + '/rest/v1/competitions?select=id,country', { headers: sbH })
    ]);
    const comps = {}; (await cR.json()).forEach(c => comps[c.id] = c.country);
    let matches = await mR.json();
    if (ukOnly) matches = matches.filter(m => UK.includes(comps[m.competition_id]));
    const byDay = {};
    matches.forEach(m => { const d = m.utc_date.slice(0, 10); (byDay[d] = byDay[d] || []).push(m); });

    const S = { n: 0, exact: 0, result: 0, home_pick: 0, top_pct_sum: 0, o25_n: 0, o25_hit: 0, btts_n: 0, btts_hit: 0, skipped: 0,
      naive_home: 0, naive_11: 0, buckets: {} };
    const bucket = p => p >= .15 ? '15%+' : p >= .12 ? '12-15%' : p >= .10 ? '10-12%' : p >= .08 ? '8-10%' : '<8%';
    const daily = [];
    for (const d of Object.keys(byDay).sort()) {
      const ms = byDay[d];
      const ids = [...new Set(ms.flatMap(m => [m.home_id, m.away_id]))];
      const fR = await fetch(SB + '/rest/v1/rpc/team_form', { method: 'POST', headers: sbH, body: JSON.stringify({ p_ids: ids, p_before: d + 'T00:00:00Z' }) });
      if (!fR.ok) return res.status(502).json({ error: 'Supabase: ' + (await fR.text()).slice(0, 200) + ' — run the v5 SQL (team_form with p_before)' });
      const form = {}; (await fR.json()).forEach(t => form[t.team_id] = t);
      let dn = 0, dexact = 0, dres = 0;
      ms.forEach(m => {
        const p = predict(form[m.home_id], form[m.away_id]);
        if (!p) { S.skipped++; return; }
        S.n++; dn++;
        const actual = m.home_goals > m.away_goals ? 'H' : m.home_goals < m.away_goals ? 'A' : 'D';
        const pick = p.pH >= p.pD && p.pH >= p.pA ? 'H' : p.pA >= p.pD ? 'A' : 'D';
        const exactHit = p.h === m.home_goals && p.a === m.away_goals;
        if (exactHit) { S.exact++; dexact++; }
        if (pick === actual) { S.result++; dres++; }
        if (actual === 'H') S.naive_home++;
        if (m.home_goals === 1 && m.away_goals === 1) S.naive_11++;
        S.top_pct_sum += p.p;
        const b = bucket(p.p); S.buckets[b] = S.buckets[b] || { n: 0, hit: 0 }; S.buckets[b].n++; if (exactHit) S.buckets[b].hit++;
        if (Math.abs(p.o25 - .5) >= .1) { S.o25_n++; if ((p.o25 > .5) === (m.home_goals + m.away_goals > 2.5)) S.o25_hit++; }
        if (Math.abs(p.btts - .5) >= .1) { S.btts_n++; if ((p.btts > .5) === (m.home_goals > 0 && m.away_goals > 0)) S.btts_hit++; }
      });
      if (dn) daily.push({ date: d, games: dn, exact: dexact, result: dres });
    }
    const pct = (a, b) => b ? +(a / b * 100).toFixed(1) : null;
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({
      days, scope: ukOnly ? 'UK' : 'all', games: S.n, skipped_no_history: S.skipped,
      exact_score: { hits: S.exact, pct: pct(S.exact, S.n), model_said_pct: pct(S.top_pct_sum, S.n), always_1_1_pct: pct(S.naive_11, S.n) },
      match_result: { hits: S.result, pct: pct(S.result, S.n), always_home_pct: pct(S.naive_home, S.n) },
      over_under_25: { confident_calls: S.o25_n, pct: pct(S.o25_hit, S.o25_n) },
      btts: { confident_calls: S.btts_n, pct: pct(S.btts_hit, S.btts_n) },
      calibration: Object.fromEntries(Object.entries(S.buckets).map(([k, v]) => [k, { games: v.n, hit_pct: pct(v.hit, v.n) }])),
      daily
    });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
