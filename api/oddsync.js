// GET /api/oddsync?secret=SYNC_SECRET → capture Bet365/Pinnacle/Betfair/PP prices for UK matches
// (last 30 days finished + next 7 days scheduled) into the odds table. Resumable, ~80 calls/run.
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, KEY = process.env.THESTATSAPI_KEY;
const sbH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const UK = ['England', 'Scotland', 'Wales', 'Northern Ireland'];
const MAX_CALLS = +(process.env.ODDS_MAX_CALLS || 80), BOOKS = 'bet365,pinnacle,betfair-exchange,paddy-power';

const num = v => { const x = parseFloat(v && (v.last_seen || v.opening || v)); return x > 1 ? x : null; };
const scoreKey = k => { const m = String(k).match(/(\d+)\D+(\d+)/); return m ? m[1] + '-' + m[2] : null; };
function extract(bookmakers) {
  const best = {};
  const put = (key, v, book) => { const o = num(v); if (o && (!best[key] || o > best[key].o)) best[key] = { o, b: book }; };
  (bookmakers || []).forEach(bk => {
    const m = bk.markets || {}, n = bk.bookmaker;
    if (m.match_odds) { put('H', m.match_odds.home, n); put('D', m.match_odds.draw, n); put('A', m.match_odds.away, n); }
    if (m.btts) { put('BTTS_Y', m.btts.yes, n); put('BTTS_N', m.btts.no, n); }
    if (m.total_goals) for (const k in m.total_goals) if (parseFloat(String(k).match(/\d+(\.\d+)?/)?.[0]) === 2.5) { put('O25', m.total_goals[k].over, n); put('U25', m.total_goals[k].under, n); }
    if (m.correct_score) for (const k in m.correct_score) { const s = scoreKey(k); if (s) put('CS_' + s, m.correct_score[k], n); }
  });
  return best;
}
async function tsa(path) {
  const r = await fetch('https://api.thestatsapi.com/api' + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (r.status === 429) { const e = new Error('rate'); e.rate = true; throw e; }
  if (!r.ok) throw new Error('TSA ' + r.status);
  return r.json();
}
const iso = d => d.toISOString().slice(0, 10);

module.exports = async (req, res) => {
  const ok = (process.env.SYNC_SECRET && req.query.secret === process.env.SYNC_SECRET) ||
             (process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  const start = Date.now(); let calls = 0, saved = 0, note = '';
  try {
    const comps = (await (await fetch(SB + '/rest/v1/competitions?select=id,country', { headers: sbH })).json())
      .filter(c => UK.includes(c.country)).map(c => c.id);
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    // Finished UK matches from the DB that have no odds row yet.
    const [mR, oR] = await Promise.all([
      fetch(SB + `/rest/v1/matches?competition_id=in.(${comps.join(',')})&utc_date=gte.${since}&select=id,utc_date&order=utc_date.desc&limit=1500`, { headers: sbH }),
      fetch(SB + `/rest/v1/odds?select=match_id,captured_at`, { headers: sbH })
    ]);
    const have = {}; (await oR.json()).forEach(o => have[o.match_id] = o.captured_at);
    let queue = (await mR.json()).filter(m => !have[m.id]).map(m => m.id);
    // Upcoming UK matches (next 7 days): capture, and refresh if last capture > 20h old.
    const today = new Date(), wk = new Date(Date.now() + 7 * 864e5);
    for (let page = 1; page <= 3 && calls < 6; page++) {
      const r = await tsa(`/football/matches?status=scheduled&date_from=${iso(today)}&date_to=${iso(wk)}&per_page=100&page=${page}`); calls++;
      r.data.filter(m => comps.includes(m.competition_id) && m.odds_available)
        .forEach(m => { if (!have[m.id] || Date.now() - new Date(have[m.id]) > 20 * 36e5) queue.unshift(m.id); });
      if (page >= (r.meta.total_pages || 1)) break;
    }
    queue = [...new Set(queue)];
    const rows = [];
    for (const id of queue) {
      if (calls >= MAX_CALLS || Date.now() - start > 45000) break;
      let data = null;
      try { const r = await tsa(`/football/matches/${id}/odds?bookmaker=${BOOKS}`); calls++; data = extract(r.data && r.data.bookmakers); }
      catch (e) { calls++; if (e.rate) { note = 'Rate limited — run again in a minute'; break; } data = {}; }
      rows.push({ match_id: id, captured_at: new Date().toISOString(), data });
    }
    if (rows.length) {
      const r = await fetch(SB + '/rest/v1/odds', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 200) + ' — run the v6 SQL (odds table)');
      saved = rows.length;
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ saved, remaining: Math.max(0, queue.length - saved), api_calls: calls, done: queue.length - saved <= 0, note });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
