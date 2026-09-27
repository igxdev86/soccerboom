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
    const w = Math.pow(0.9, i); wsum += w;
    gfw += Math.min(gf, 4) * w; gaw += Math.min(ga, 4) * w; // cap: a 7-0 over a minnow counts as 4
    p.gf += gf; p.ga += ga;
  });
  if (p.n) {
    p.gf_pg = +(p.gf / p.n).toFixed(2); p.ga_pg = +(p.ga / p.n).toFixed(2);
    const K = 6, MEAN = 1.35; // shrink thin samples toward the international scoring mean
    p.att = (gfw / wsum * p.n + MEAN * K) / (p.n + K);
    p.def = (gaw / wsum * p.n + MEAN * K) / (p.n + K);
  }
  return p;
}
const num = v => { const x = parseFloat(v && (v.last_seen || v.opening || v)); return x > 1 ? x : null; };
const scoreKey = k => { const m = String(k).match(/(\d+)\D+(\d+)/); return m ? m[1] + '-' + m[2] : null; };

let compCache = null;
const REGIONS = ['international', 'world', 'europe', 'africa', 'asia', 'south america', 'north america', 'oceania', 'central america'];
const NAME_RE = /nations league|world cup|friendl|qualif|euro(?!pa)|copa am|cup of nations|gold cup|asian cup|confederations|finalissima|international/i;
async function intlComps() {
  if (compCache && Date.now() - compCache.at < 864e5) return compCache.map;
  const map = {};
  for (let page = 1; page <= 4; page++) {
    const r = await tsa(`/football/competitions?per_page=100&page=${page}`);
    r.data.forEach(c => {
      const country = (c.country || '').toLowerCase();
      if (!country || REGIONS.includes(country) || NAME_RE.test(c.name || '')) map[c.id] = c.name;
    });
    if (page >= (r.meta.total_pages || 1)) break;
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
      const settle = p => p.then(v => v).catch(() => null);
      const [hR, aR, oddsR, sqH, sqA, injH, injA] = await Promise.all([
        tsa(`/football/matches?team_id=${H.id}&status=finished&per_page=15`),
        tsa(`/football/matches?team_id=${A.id}&status=finished&per_page=15`),
        det.odds_available ? settle(tsa(`/football/matches/${id}/odds?bookmaker=bet365`)) : null,
        settle(tsa(`/football/teams/${H.id}/players`)),
        settle(tsa(`/football/teams/${A.id}/players`)),
        settle(tsa(`/football/teams/${H.id}/injuries-suspensions`)),
        settle(tsa(`/football/teams/${A.id}/injuries-suspensions`))
      ]);
      const hRows = hR.data.filter(m => m.score && m.score.home != null).sort((a, b) => b.utc_date.localeCompare(a.utc_date));
      const aRows = aR.data.filter(m => m.score && m.score.home != null).sort((a, b) => b.utc_date.localeCompare(a.utc_date));
      const hp = profile(hRows, H.id), ap = profile(aRows, A.id);
      // Full head-to-head: page through the home nation's last ~300 matches and keep meetings.
      let meetings = [];
      for (let page = 1; page <= 3; page++) {
        let r; try { r = await tsa(`/football/matches?team_id=${H.id}&status=finished&per_page=100&page=${page}`); } catch (e) { break; }
        meetings.push(...r.data.filter(m => (m.home_team.id === A.id || m.away_team.id === A.id) && m.score && m.score.home != null));
        if (page >= (r.meta.total_pages || 1)) break;
      }
      meetings.sort((a, b) => b.utc_date.localeCompare(a.utc_date));
      const rec = { w: 0, d: 0, l: 0, gf: 0, ga: 0 };
      const h2h = meetings.map(m => {
        const hIsHome = m.home_team.id === H.id;
        const gf = hIsHome ? m.score.home : m.score.away, ga = hIsHome ? m.score.away : m.score.home;
        rec.gf += gf; rec.ga += ga;
        if (gf > ga) rec.w++; else if (gf < ga) rec.l++; else rec.d++;
        return { year: m.utc_date.slice(0, 4), line: `${m.home_team.name} ${m.score.home}\u2013${m.score.away} ${m.away_team.name}` };
      });
      const h2h_record = h2h.length ? { ...rec, n: h2h.length } : null;

      // ---- squad analysis ----
      const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
      const sbH = { apikey: SK, Authorization: 'Bearer ' + SK };
      let curSeason = {}; // competition_id -> current season_id (from our DB)
      if (SB && SK) {
        try {
          const r = await fetch(SB + '/rest/v1/seasons?is_current=eq.true&select=id,competition_id', { headers: sbH });
          if (r.ok) (await r.json()).forEach(s => curSeason[s.competition_id] = s.id);
        } catch (e) {}
      }
      // club -> competition via our matches table (one query per side's club list)
      async function clubComps(clubIds) {
        const map = {};
        if (!SB || !SK || !clubIds.length) return map;
        try {
          const q = clubIds.map(encodeURIComponent).join(',');
          const r = await fetch(SB + `/rest/v1/matches?home_id=in.(${q})&select=home_id,competition_id&limit=1000`, { headers: sbH });
          if (r.ok) {
            const cnt = {};
            (await r.json()).forEach(m => { const k = m.home_id + '|' + m.competition_id; cnt[k] = (cnt[k] || 0) + 1; });
            Object.entries(cnt).sort((a, b) => b[1] - a[1]).forEach(([k]) => { const [club, comp] = k.split('|'); if (!map[club]) map[club] = comp; });
          }
        } catch (e) {}
        return map;
      }
      const inj = r => { const d = r && r.data ? r.data : { injuries: [], suspensions: [] };
        const out = new Set();
        (d.injuries || []).forEach(x => { if (x.active) out.add(x.player_id); });
        (d.suspensions || []).forEach(x => { if (x.active) out.add(x.player_id); });
        return out; };
      async function squad(sq, injuries) {
        const players = (sq && sq.data ? sq.data : []).filter(p => p.age);
        if (!players.length) return null;
        const ages = players.map(p => p.age);
        const avg_age = +(ages.reduce((s, a) => s + a, 0) / ages.length).toFixed(1);
        const mv = players.reduce((s, p) => s + (p.market_value || 0), 0);
        const key = players.slice().sort((a, b) => (b.market_value || 0) - (a.market_value || 0)).slice(0, 12);
        const clubs = [...new Set(key.map(p => p.current_team && p.current_team.id).filter(Boolean))];
        const comps = await clubComps(clubs);
        const stats = await Promise.all(key.map(async p => {
          const club = p.current_team && p.current_team.id;
          const season = club && comps[club] && curSeason[comps[club]];
          if (!season) return null;
          try { return (await tsa(`/football/players/${p.id}/stats?season_id=${season}`)).data; } catch (e) { return null; }
        }));
        const key_out = key.map((p, i) => {
          const s = stats[i];
          return { name: p.short_name || p.name, age: p.age, pos: p.position,
            club: p.current_team ? p.current_team.name : null,
            mv: p.market_value ? +(p.market_value / 1e6).toFixed(1) : null,
            rating: s && s.rating ? +s.rating.toFixed(2) : null,
            apps: s ? s.appearances : null, goals: s && s.scoring ? s.scoring.goals : null,
            assists: s && s.scoring ? s.scoring.assists : null,
            out: injuries.has(p.id) };
        });
        const rated = key_out.filter(p => p.rating);
        const avg_rating = rated.length >= 4 ? +(rated.reduce((s, p) => s + p.rating, 0) / rated.length).toFixed(2) : null;
        const outs = key_out.filter(p => p.out).length;
        return { size: players.length, avg_age,
          u23: players.filter(p => p.age < 23).length, o30: players.filter(p => p.age > 30).length,
          mv_m: mv ? Math.round(mv / 1e6) : null, avg_rating, key_out_count: outs, key: key_out };
      }
      const [sqHome, sqAway] = await Promise.all([squad(sqH, inj(injH)), squad(sqA, inj(injA))]);

      // ---- squad-informed adjustment (small, transparent) ----
      function adjust(sq) {
        const a = { form: 0, age: 0, inj: 0 };
        if (!sq) return { factor: 1, parts: a };
        if (sq.avg_rating) a.form = Math.max(-6, Math.min(6, Math.round((sq.avg_rating - 6.9) * 8)));
        const band = sq.avg_age < 24 ? sq.avg_age - 24 : sq.avg_age > 29 ? 29 - sq.avg_age : 0;
        a.age = Math.max(-4, Math.round(band));
        a.inj = -Math.min(5, Math.round(sq.key_out_count * 1.5));
        return { factor: 1 + (a.form + a.age + a.inj) / 100, parts: a };
      }
      const adjH = adjust(sqHome), adjA = adjust(sqAway);

      let model = null;
      if (hp.n >= 6 && ap.n >= 6) {
        const homeBoost = det.is_neutral === true ? 1.0 : 1.1;
        const lh = ((hp.att + ap.def) / 2) * homeBoost * adjH.factor;
        const la = ((ap.att + hp.def) / 2) * adjA.factor;
        const rho = -0.1, tau = (h, a) =>
          h === 0 && a === 0 ? 1 - lh * la * rho : h === 1 && a === 0 ? 1 + la * rho :
          h === 0 && a === 1 ? 1 + lh * rho : h === 1 && a === 1 ? 1 - rho : 1;
        const grid = []; let Z = 0;
        for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++) {
          const p = poisson(h, lh) * poisson(a, la) * tau(h, a); grid.push({ h, a, p }); Z += p;
        }
        let pH = 0, pD = 0, pA = 0, o25 = 0, btts = 0;
        grid.forEach(g => { g.p /= Z;
          if (g.h > g.a) pH += g.p; else if (g.h < g.a) pA += g.p; else pD += g.p;
          if (g.h + g.a > 2.5) o25 += g.p; if (g.h && g.a) btts += g.p; });
        grid.sort((x, y) => y.p - x.p);
        const outcome = pH >= pD && pH >= pA ? 'home' : pA >= pD ? 'away' : 'draw';
        const pick = grid.find(g => outcome === 'home' ? g.h > g.a : outcome === 'away' ? g.a > g.h : g.h === g.a);
        const pct = p => +(p * 100).toFixed(1);
        model = { outcome, outcome_pct: pct(outcome === 'home' ? pH : outcome === 'away' ? pA : pD),
          pick: { score: pick.h + '\u2013' + pick.a, pct: pct(pick.p) },
          top: grid.slice(0, 3).map(g => ({ score: g.h + '\u2013' + g.a, pct: pct(g.p) })),
          home_win: pct(pH), draw: pct(pD), away_win: pct(pA), over25: pct(o25), btts: pct(btts),
          xg: [+lh.toFixed(2), +la.toFixed(2)], neutral: det.is_neutral === true,
          adj: { home: adjH.parts, away: adjA.parts } };
      }
      let prices = null;
      const bk = oddsR && oddsR.data && (oddsR.data.bookmakers || []).find(b => /bet ?365/i.test(b.bookmaker));
      if (bk) {
        const m = bk.markets || {}; prices = {};
        if (m.match_odds) { prices.home = num(m.match_odds.home); prices.draw = num(m.match_odds.draw); prices.away = num(m.match_odds.away); }
        if (m.btts) prices.btts = num(m.btts.yes);
        if (m.total_goals) for (const k in m.total_goals) if (parseFloat(String(k).match(/\d+(\.\d+)?/)?.[0]) === 2.5) prices.over25 = num(m.total_goals[k].over);
        if (m.correct_score && model) { const cs = Object.entries(m.correct_score).find(([k]) => scoreKey(k) === model.pick.score.replace('\u2013', '-')); if (cs) prices.pick = num(cs[1]); }
      }
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
      return res.status(200).json({ id, home: H.name, away: A.name,
        home_form: hp.form, away_form: ap.form,
        home_goals: hp.n ? [hp.gf_pg, hp.ga_pg, hp.n] : null, away_goals: ap.n ? [ap.gf_pg, ap.ga_pg, ap.n] : null,
        h2h, h2h_record, model, prices, squad_home: sqHome, squad_away: sqAway });
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
    const comps = await intlComps();
    let fixtures = [];
    for (let page = 1; page <= 4; page++) {
      const r = await tsa(`/football/matches?date_from=${date}&date_to=${date}&per_page=100&page=${page}`);
      fixtures.push(...r.data);
      if (page >= (r.meta.total_pages || 1)) break;
    }
    if (req.query.debug) {
      const seen = {};
      fixtures.forEach(m => seen[m.competition_id] = (seen[m.competition_id] || 0) + 1);
      return res.status(200).json({ date, total: fixtures.length,
        comps_today: Object.entries(seen).map(([id, n]) => ({ id, n, name: comps[id] || '(filtered out)' })) });
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
