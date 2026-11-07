// GET /api/pool?days=3 → flat selection pool (Bet365 via TheStatsAPI). Cached 10 min.
const { buildPool } = require("./_target");
module.exports = async (req, res) => {
  const days = Math.min(parseInt(req.query.days || "3", 10), 7);
  const out = await buildPool(days);
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
  res.status(200).json({ ...out, generated: new Date().toISOString() });
};
