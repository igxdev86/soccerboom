// GET /api/target-bet?id=123 → one bet with username, plus who else copied/backed the same legs
const name = require("./_names");
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const sbH = { apikey: SK, Authorization: "Bearer " + SK };
module.exports = async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: "id" });
    const r = await (await fetch(SB + `/rest/v1/target_bets?id=eq.${id}&limit=1`, { headers: sbH })).json();
    if (!Array.isArray(r) || !r[0]) return res.status(404).json({ error: "not found" });
    const b = r[0];
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ...b, user: name(b.bot) });
  } catch (e) { res.status(200).json({ error: String(e) }); }
};
