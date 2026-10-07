export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  const sbH = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const action = req.query.action || 'board';
  const user = (req.query.user || '').slice(0, 64);
  try {
    if (action === 'board') {
      const w = await (await fetch(SB + '/rest/v1/gc_wheels?active=eq.true&select=id,sold,price_pence,prize_pence&order=id.asc&limit=1', { headers: sbH })).json();
      if (!w[0]) return res.status(200).json({ error: 'no wheel' });
      const t = await (await fetch(SB + `/rest/v1/gc_wheel_tickets?wheel_id=eq.${w[0].id}&select=num`, { headers: sbH })).json();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ wheel: w[0].id, sold: w[0].sold, taken: t.map(x => x.num), price: w[0].price_pence, prize: w[0].prize_pence });
    }
    if (action === 'buy') {
      if (!user) return res.status(400).json({ error: 'no user' });
      const num = parseInt(req.query.num, 10);
      if (!(num >= 0 && num <= 36)) return res.status(400).json({ error: 'bad number' });
      const r = await fetch(SB + '/rest/v1/rpc/gc_wheel_buy', { method: 'POST', headers: sbH, body: JSON.stringify({ p_user: user, p_num: num }) });
      const j = await r.json();
      if (j && j.error) return res.status(400).json(j);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(j);
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
