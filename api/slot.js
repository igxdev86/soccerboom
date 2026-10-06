// GOALRUSH SLOT API — free prize-draw slot: spins come from free codes, server-side outcomes, real-prize ready.
// Actions: state, daily (POST), claim (POST,&code=), spin (POST), mkcode (secret)
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const sbH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const TICKET_PRICE = 100;
const DAILY_SPINS = 5; // free tickets per day — the online promo route; postal is the formal free route
// GOALRUSH SLOT core — 5x3, 10 lines, left-to-right
const SYM = { W:'\u2b50', SC:'\ud83c\udfc6', GOAL:'\u26bd', RED:'\ud83d\udfe5', BOOT:'\ud83d\udc5f', GLOVE:'\ud83e\uddf4', YEL:'\ud83d\udfe8', SHIRT:'\ud83d\udc55', WHIS:'\ud83d\udce3' };
// Reel strips (weights by repetition). Tuned by simulation.
const STRIPS = [
 'GOAL RED BOOT YEL SHIRT WHIS BOOT GLOVE YEL SHIRT WHIS W GOAL BOOT YEL SHIRT WHIS GLOVE SC BOOT YEL SHIRT WHIS GLOVE RED YEL SHIRT WHIS BOOT GLOVE SHIRT WHIS'.split(' '),
 'RED GOAL BOOT YEL SHIRT WHIS GLOVE BOOT YEL SHIRT WHIS W GOAL YEL SHIRT WHIS GLOVE SC BOOT YEL SHIRT WHIS GLOVE RED SHIRT WHIS BOOT YEL GLOVE SHIRT WHIS GOAL'.split(' '),
 'GOAL BOOT YEL SHIRT WHIS GLOVE RED BOOT YEL SHIRT WHIS W YEL SHIRT WHIS GLOVE SC GOAL BOOT YEL SHIRT WHIS GLOVE RED SHIRT WHIS BOOT YEL GLOVE SHIRT WHIS SC'.split(' '),
 'BOOT GOAL YEL SHIRT WHIS GLOVE RED BOOT YEL SHIRT WHIS W YEL SHIRT WHIS GLOVE SC GOAL BOOT YEL SHIRT WHIS GLOVE SHIRT WHIS BOOT YEL GLOVE SHIRT WHIS RED GOAL'.split(' '),
 'YEL GOAL BOOT SHIRT WHIS GLOVE RED BOOT YEL SHIRT WHIS W SHIRT WHIS GLOVE SC GOAL BOOT YEL SHIRT WHIS GLOVE SHIRT WHIS BOOT YEL GLOVE SHIRT WHIS RED SC GOAL'.split(' ')];
const LINES = [[1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0],[1,0,1,2,1],[1,2,1,0,1],[0,1,1,1,2]];
// pays in line-bet multiples for 3/4/5
const PAYS = { GOAL:[50,150,1000], RED:[35,100,400], BOOT:[20,50,150], GLOVE:[15,40,120], YEL:[10,25,80], SHIRT:[5,15,50], WHIS:[5,12,40], W:[60,250,2000] };
const SCATTER_PAY = [3,15,100]; // total-bet multiples for 3/4/5 SC

function spinGrid(rng){
  const g=[];
  for(let r=0;r<5;r++){const s=STRIPS[r],i=Math.floor(rng()*s.length);g.push([s[i],s[(i+1)%s.length],s[(i+2)%s.length]]);}
  return g; // g[reel][row]
}
function evaluate(grid, totalBet, rng){
  const lineBet = totalBet/10;
  let win=0; const hits=[];
  for(let li=0;li<10;li++){
    const line=LINES[li];
    const syms=line.map((row,reel)=>grid[reel][row]);
    let first=syms[0]==='W'?null:syms[0], n=0;
    for(const s of syms){
      if(s==='SC')break;
      if(s==='W'){n++;continue;}
      if(first===null)first=s;
      if(s===first)n++;else break;
    }
    if(first===null)first='W';
    if(first==='SC')continue;
    if(n>=3&&PAYS[first]){const p=PAYS[first][n-3]*lineBet;win+=p;hits.push({line:li,n,sym:first,pay:p});}
  }
  const scN=grid.flat().filter(s=>s==='SC').length;
  let scPay=0, frees=0;
  if(scN>=3){scPay=SCATTER_PAY[Math.min(scN,5)-3]*totalBet;win+=scPay;frees=8;}
  // VAR CHECK: ~1/90 spins, multiplies a winning spin x2-x20 (weighted), or awards 1x bet on a dead spin
  let varMult=0;
  if(rng()<1/90){
    if(win>0){const r=rng();varMult=r<.6?2:r<.85?3:r<.96?5:r<.995?10:20;win*=varMult;}
    else{varMult=1;win+=totalBet;}
  }
  return {win, hits, scatters:scN, scatterPay:scPay, frees, varMult};
}


async function spins(user) {
  const r = await (await fetch(SB + `/rest/v1/gc_spins?user_key=eq.${encodeURIComponent(user)}&select=spins`, { headers: sbH })).json();
  return r[0] ? r[0].spins : 0;
}
async function addSpins(user, n) {
  await fetch(SB + '/rest/v1/gc_spins', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_key: user, spins: 0 }]) });
  await fetch(SB + '/rest/v1/rpc/gc_add_spins', { method: 'POST', headers: sbH, body: JSON.stringify({ p_user: user, p_n: n }) });
}
module.exports = async (req, res) => {
  if (!SB || !SK) return res.status(500).json({ error: 'Missing env vars' });
  const action = req.query.action;
  const user = String(req.query.user || '').slice(0, 64);
  if (!user) return res.status(400).json({ error: 'user required' });
  try {
    if (action === 'grantme') {
      if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) return res.status(403).json({ error: 'forbidden' });
      await fetch(SB + '/rest/v1/gc_wallet', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=ignore-duplicates' }, body: JSON.stringify({ user_key: user, balance_pence: 0 }) });
      const r = await fetch(SB + '/rest/v1/rpc/gc_credit', { method: 'POST', headers: sbH, body: JSON.stringify({ p_user: user, p_amount: 50000, p_reason: 'test_credit' }) });
      const j = await r.json().catch(() => null);
      const w = await (await fetch(SB + `/rest/v1/gc_wallet?user_key=eq.${encodeURIComponent(user)}&select=balance_pence`, { headers: sbH })).json();
      return res.status(200).json({ balance_pence: w[0] ? w[0].balance_pence : null });
    }
    if (action === 'state') {
      const r = await (await fetch(SB + `/rest/v1/gc_spins?user_key=eq.${encodeURIComponent(user)}&select=spins,won_pence`, { headers: sbH })).json();
      const w = await (await fetch(SB + `/rest/v1/gc_wallet?user_key=eq.${encodeURIComponent(user)}&select=balance_pence`, { headers: sbH })).json();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ spins: r[0] ? r[0].spins : 0, won_pence: r[0] ? (r[0].won_pence || 0) : 0, balance_pence: w[0] ? w[0].balance_pence : 0 });
    }
    if (action === 'daily') {
      const code = 'DAILY-' + new Date().toISOString().slice(0, 10);
      const r = await fetch(SB + '/rest/v1/gc_code_claims', { method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
        body: JSON.stringify([{ user_key: user, code }]) });
      if (!r.ok) return res.status(409).json({ error: 'Today\u2019s free spins already claimed \u2014 back tomorrow.' });
      await addSpins(user, DAILY_SPINS);
      return res.status(200).json({ granted: DAILY_SPINS, spins: await spins(user) });
    }
    if (action === 'claim') {
      const code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
      if (!code) return res.status(400).json({ error: 'code required' });
      const cr = await (await fetch(SB + `/rest/v1/gc_codes?code=eq.${code}&select=*`, { headers: sbH })).json();
      const c = cr[0];
      if (!c) return res.status(404).json({ error: 'Code not recognised.' });
      if (c.max_claims && c.claimed >= c.max_claims) return res.status(409).json({ error: 'Code fully claimed.' });
      if (c.expires && new Date(c.expires) < new Date()) return res.status(409).json({ error: 'Code expired.' });
      const r = await fetch(SB + '/rest/v1/gc_code_claims', { method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
        body: JSON.stringify([{ user_key: user, code }]) });
      if (!r.ok) return res.status(409).json({ error: 'You\u2019ve already claimed this code.' });
      await fetch(SB + `/rest/v1/gc_codes?code=eq.${code}`, { method: 'PATCH', headers: sbH, body: JSON.stringify({ claimed: (c.claimed || 0) + 1 }) });
      await addSpins(user, c.spins);
      return res.status(200).json({ granted: c.spins, spins: await spins(user) });
    }
    if (action === 'series') {
      const game = parseInt(req.query.game || '3', 10);
      const s = await (await fetch(SB + `/rest/v1/gc_slot_series?id=eq.${game}&active=eq.true&select=*&limit=1`, { headers: sbH })).json();
      if (!s[0]) return res.status(404).json({ error: 'No active series.' });
      res.setHeader('Cache-Control', 's-maxage=60');
      return res.status(200).json({ series: { id: s[0].id, name: s[0].name, price_pence: s[0].price_pence, total: s[0].total, sold: s[0].sold, prizes_left: s[0].prizes_left } });
    }
    if (action === 'spin') {
      // Predetermined instant-win draw: outcome allocated server-side from the finite pool; reels only display it.
      const game = parseInt(req.query.game || '3', 10);
      const r = await fetch(SB + '/rest/v1/rpc/gc_slot_draw', { method: 'POST', headers: sbH,
        body: JSON.stringify({ p_user: user, p_series: game }) });
      if (!r.ok) return res.status(502).json({ error: 'DB: ' + (await r.text()).slice(0, 140) + ' \u2014 run the series SQL' });
      const out = await r.json();
      if (out.error) return res.status(402).json({ error: out.error === 'insufficient' ? 'No free tickets and balance too low.' : out.error === 'soldout' ? 'This series is sold out \u2014 next series soon.' : out.error });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ prize_pence: out.prize, base_pence: out.base || out.prize, mult: out.mult || 1, paid: out.paid, spins: out.free_left, balance_pence: out.balance, won_pence: out.won, remaining: out.remaining });
    }
    if (action === 'mkcode') {
      if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
      const n = Math.max(1, Math.min(100, parseInt(req.query.spins || '5', 10)));
      const max = Math.max(0, parseInt(req.query.max || '0', 10));
      const r = await fetch(SB + '/rest/v1/gc_codes', { method: 'POST', headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ code, spins: n, max_claims: max || null, claimed: 0 }]) });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, code, spins: n, max_claims: max || null });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) { return res.status(502).json({ error: e.message }); }
};
