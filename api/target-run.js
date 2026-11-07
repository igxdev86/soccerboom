// GET /api/target-run → settles open bot bets, then places today's round of 100 bot bets if not yet placed.
// ?secret=SYNC_SECRET&force=1 places an extra round today regardless.
const { tsa, buildPool, build, settleLeg } = require("./_target");
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const sbH = { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" };
const sb = (path, opt = {}) => fetch(SB + "/rest/v1/" + path, { ...opt, headers: { ...sbH, ...(opt.method ? { Prefer: "return=minimal" } : {}) } });

const TARGETS = [10, 10, 10, 20, 20, 50, 50, 100, 100, 250, 500, 1000];
const STAKES = [1, 1, 1, 2, 2, 5, 5, 10, 20];
const RISKS = ["low", "mid", "high"];
const pick = (a, r) => a[Math.floor(r * a.length)];
// deterministic persona per bot: a risk tilt and a stake band
function persona(b) {
  const x = Math.sin(b * 9301 + 49297) * 233280, f = x - Math.floor(x);
  return { tilt: RISKS[Math.floor(f * 3)], big: f > 0.8 };
}

async function settle() {
  const r = await sb("target_bets?status=eq.open&select=id,legs,stake,odds");
  const open = await r.json();
  if (!Array.isArray(open) || !open.length) return { settled: 0, open: 0 };
  const ids = [...new Set(open.flatMap(b => b.legs.map(l => l.match)))];
  const cache = {};
  await Promise.all(ids.map(async id => { const m = await tsa(`/football/matches/${id}`); cache[id] = m && m.data; }));
  let settled = 0;
  for (const b of open) {
    const res = b.legs.map(l => ({ ...l, result: settleLeg(l, cache[l.match]) }));
    let status = "open";
    if (res.some(l => l.result === "lost")) status = "lost";
    else if (res.every(l => l.result === "won" || l.result === "void")) status = "won";
    if (status === "open" && !res.some(l => l.result !== "open")) continue;
    const odds = res.reduce((p, l) => p * (l.result === "void" ? 1 : l.price), 1);
    const body = { legs: res, odds: +odds.toFixed(2) };
    if (status !== "open") { body.status = status; body.returns = status === "won" ? +(b.stake * odds).toFixed(2) : 0; body.settled_at = new Date().toISOString(); settled++; }
    await sb(`target_bets?id=eq.${b.id}`, { method: "PATCH", body: JSON.stringify(body) });
  }
  return { settled, open: open.length - settled };
}

async function place(day) {
  const { pool, matches } = await buildPool(2, 60);
  if (!pool.length) return { placed: 0, matches };
  const rows = [];
  for (let b = 1; b <= 100; b++) {
    const p = persona(b);
    const risk = Math.random() < 0.5 ? p.tilt : pick(RISKS, Math.random());
    const stake = p.big ? pick([10, 20, 50], Math.random()) : pick(STAKES, Math.random());
    const target = pick(TARGETS, Math.random()) * (p.big ? 5 : 1);
    const R = Math.max(1.01, target / stake);
    const legs = build(pool, R, risk);
    if (!legs.length) { rows.push({ bot: b, day, target, stake, risk, legs: [], odds: 0, status: "nobet" }); continue; }
    const odds = legs.reduce((x, l) => x * l.price, 1);
    rows.push({ bot: b, day, target, stake, risk, legs, odds: +odds.toFixed(2), status: "open" });
  }
  const r = await sb("target_bets", { method: "POST", body: JSON.stringify(rows) });
  return { placed: rows.filter(x => x.status === "open").length, nobet: rows.filter(x => x.status === "nobet").length, matches, ok: r.ok, err: r.ok ? undefined : await r.text() };
}

module.exports = async (req, res) => {
  const out = { settle: await settle() };
  const today = new Date().toISOString().slice(0, 10);
  const force = req.query.force && process.env.SYNC_SECRET && req.query.secret === process.env.SYNC_SECRET;
  const have = await (await sb(`target_bets?day=like.${today}*&select=id&limit=1`)).json();
  if (force || !have.length) {
    const rounds = await (await sb(`target_bets?day=like.${today}*&select=day`)).json();
    const n = new Set(rounds.map(x => x.day)).size;
    out.place = await place(n ? `${today}#${n + 1}` : today);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
};
