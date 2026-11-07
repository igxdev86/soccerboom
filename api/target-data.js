// GET /api/target-data → feed + machine stats + bot leaderboard
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const sbH = { apikey: SK, Authorization: "Bearer " + SK };
module.exports = async (req, res) => { try {
  const all = await (await fetch(SB + "/rest/v1/target_bets?select=id,bot,day,target,stake,risk,legs,odds,status,returns,placed_at,settled_at&order=placed_at.desc&limit=5000", { headers: sbH })).json();
  if (!Array.isArray(all)) return res.status(500).json({ error: all });
  const bets = all.filter(b => b.status !== "nobet");
  const agg = () => ({ n: 0, won: 0, lost: 0, open: 0, staked: 0, returned: 0, legs: 0 });
  const stats = { all: agg(), low: agg(), mid: agg(), high: agg() };
  const bots = {};
  for (const b of bets) {
    for (const s of [stats.all, stats[b.risk]]) {
      s.n++; s[b.status]++; s.staked += +b.stake; s.returned += +b.returns || 0; s.legs += b.legs.length;
    }
    const bt = bots[b.bot] = bots[b.bot] || { bot: b.bot, n: 0, won: 0, staked: 0, returned: 0 };
    bt.n++; if (b.status === "won") bt.won++; bt.staked += +b.stake; bt.returned += +b.returns || 0;
  }
  const feed = all.slice(0, 300);
  const settled = bets.filter(b => b.settled_at).sort((a, b) => a.settled_at < b.settled_at ? 1 : -1).slice(0, 100);
  const nobet = all.filter(b => b.status === "nobet").length;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ stats, bots: Object.values(bots).map(b => ({ ...b, pl: +(b.returned - b.staked).toFixed(2) })).sort((a, b) => b.pl - a.pl), feed, settled, nobet, total: all.length });
} catch (e) { res.status(200).json({ crashed: true, error: String(e && e.stack || e) }); } };
