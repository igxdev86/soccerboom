// GET /api/score?gf=2&ga=0&min=20 → every team ranked by frequency of that exact score
module.exports = async (req, res) => {
  const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SB || !SK) return res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });

  const gf = parseInt(req.query.gf, 10), ga = parseInt(req.query.ga, 10);
  const min = Math.max(1, parseInt(req.query.min || '20', 10));
  if (!(gf >= 0 && gf <= 9 && ga >= 0 && ga <= 9)) return res.status(400).json({ error: 'gf and ga must be 0-9' });

  const headers = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  try {
    const [rankR, stateR] = await Promise.all([
      fetch(SB + '/rest/v1/rpc/score_rank', { method: 'POST', headers, body: JSON.stringify({ p_gf: gf, p_ga: ga, p_min_games: min }) }),
      fetch(SB + '/rest/v1/sync_state?id=eq.main&select=value', { headers })
    ]);
    if (!rankR.ok) return res.status(502).json({ error: 'Supabase: ' + (await rankR.text()).slice(0, 200) });
    const data = await rankR.json();
    const st = (await stateR.json().catch(() => []))[0];
    const meta = st ? { phase: st.value.phase, matches: st.value.matches, last_run: st.value.last_run } : null;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json({ data, meta });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Supabase' });
  }
};
