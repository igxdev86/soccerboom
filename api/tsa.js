// SoccerBoom → TheStatsAPI proxy. Keeps THESTATSAPI_KEY server-side.
// Usage from frontend: /api/tsa?path=%2Ffootball%2Fmatches%3Fteam_id%3Dtm_x
module.exports = async (req, res) => {
  const path = req.query.path;

  if (
    !path ||
    typeof path !== 'string' ||
    path.includes('..') ||
    !/^\/(football|coverage|health)/.test(path)
  ) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const key = process.env.THESTATSAPI_KEY;
  if (!key) {
    return res.status(500).json({ error: 'THESTATSAPI_KEY env var not set in Vercel' });
  }

  try {
    const upstream = await fetch('https://api.thestatsapi.com/api' + path, {
      headers: { Authorization: 'Bearer ' + key }
    });
    const body = await upstream.text();

    // Historical data caches for a day at the CDN; live-ish data for 60s.
    // Protects the trial quota (metered at 10% of plan limits).
    const seconds = req.query.cache === 'long' ? 86400 : 60;
    res.setHeader('Cache-Control', `s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`);
    res.setHeader('Content-Type', 'application/json');

    if (upstream.status === 429) {
      return res.status(429).json({ error: 'Rate limited by TheStatsAPI — wait a minute and retry' });
    }
    return res.status(upstream.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach TheStatsAPI' });
  }
};
