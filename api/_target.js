// TARGET shared logic: pool from TheStatsAPI, bet builder, leg settlement.
const BASE = "https://api.thestatsapi.com/api";
const OK = ["England","Scotland","Wales","Northern Ireland","Spain","Germany","Italy","France","Netherlands","Portugal","Europe"];

async function tsa(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: "Bearer " + process.env.THESTATSAPI_KEY } });
  if (!r.ok) return null;
  return r.json();
}
const iso = d => d.toISOString().slice(0, 10);
const px = v => v && parseFloat(v.last_seen || v.opening);

async function compNames() {
  const names = {};
  for (let p = 1; p <= 3; p++) {
    const r = await tsa(`/football/competitions?per_page=100&page=${p}`);
    if (!r || !r.data) break;
    r.data.forEach(c => { if (OK.includes(c.country || "")) names[c.id] = (c.country ? c.country + " " : "") + c.name; });
    if (r.meta && p >= r.meta.total_pages) break;
  }
  return names;
}

// Pool of selections for matches kicking off in the next `days` days (from now, not midnight).
async function buildPool(days = 3, maxMatches = 60) {
  const names = await compNames();
  const d0 = new Date(), d1 = new Date(Date.now() + days * 864e5);
  let all = [];
  for (let p = 1; p <= 5; p++) {
    const m = await tsa(`/football/matches?status=scheduled&sort=utc_date&date_from=${iso(d0)}&date_to=${iso(d1)}&per_page=100&page=${p}`);
    if (!m || !m.data) break;
    all = all.concat(m.data);
    if (m.meta && p >= m.meta.total_pages) break;
  }
  const now = Date.now();
  const matches = all.filter(x => x.odds_available && names[x.competition_id] && new Date(x.utc_date).getTime() > now + 30 * 60e3).slice(0, maxMatches);
  const pool = [];
  await Promise.all(matches.map(async mt => {
    const o = await tsa(`/football/matches/${mt.id}/odds?bookmaker=bet365`);
    const bk = o && o.data && o.data.bookmakers && o.data.bookmakers[0];
    if (!bk) return;
    const mk = bk.markets || {};
    const base = { match: mt.id, home: mt.home_team.name, away: mt.away_team.name, ko: mt.utc_date, comp: names[mt.competition_id] };
    if (mk.match_odds) {
      pool.push({ ...base, market: "Match result", pick: mt.home_team.name, sel: "H", price: px(mk.match_odds.home) });
      pool.push({ ...base, market: "Match result", pick: "Draw", sel: "D", price: px(mk.match_odds.draw) });
      pool.push({ ...base, market: "Match result", pick: mt.away_team.name, sel: "A", price: px(mk.match_odds.away) });
    }
    if (mk.btts) {
      pool.push({ ...base, market: "BTTS", pick: "Yes", sel: "BY", price: px(mk.btts.yes) });
      pool.push({ ...base, market: "BTTS", pick: "No", sel: "BN", price: px(mk.btts.no) });
    }
    if (mk.total_goals) for (const line of Object.keys(mk.total_goals)) {
      const t = mk.total_goals[line], L = parseFloat(line);
      if (!(L > 0) || Number.isInteger(L)) continue;
      pool.push({ ...base, market: "Total goals", pick: "Over " + L, sel: "O" + L, price: px(t.over) });
      pool.push({ ...base, market: "Total goals", pick: "Under " + L, sel: "U" + L, price: px(t.under) });
    }
  }));
  return { pool: pool.filter(s => s.price > 1), matches: matches.length };
}

// ---- builder (same logic as target.html) ----
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const one = l => { const s = new Set(); return l.filter(x => !s.has(x.match) && s.add(x.match)); };
const greedy = (c, R) => { let p = 1, o = []; for (const s of c) { if (p >= R) break; o.push(s); p *= s.price; } return p >= R ? o : []; };

function build(POOL, R, risk) {
  let legs = [];
  if (risk === "low") legs = greedy(one(shuffle(POOL.filter(s => s.price >= 1.04 && s.price <= 1.5))).sort((a, b) => a.price - b.price), R);
  else if (risk === "mid") legs = greedy(one(shuffle(POOL.filter(s => s.price >= 1.7 && s.price <= 4.2))), R);
  else {
    const c = one(shuffle(POOL.filter(s => s.price >= 1.8)));
    const single = c.filter(s => s.price >= R && s.price <= R * 1.5).sort((a, b) => a.price - b.price)[0];
    if (single) legs = [single];
    else {
      let best = null, bp = 1e9;
      for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { if (c[i].match === c[j].match) continue; const p = c[i].price * c[j].price; if (p >= R && p < bp) { bp = p; best = [c[i], c[j]]; } }
      if (!best) for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let k = j + 1; k < c.length; k++) { if (new Set([c[i].match, c[j].match, c[k].match]).size < 3) continue; const p = c[i].price * c[j].price * c[k].price; if (p >= R && p < bp) { bp = p; best = [c[i], c[j], c[k]]; } }
      if (best) legs = best;
    }
  }
  return legs;
}

// ---- settlement ----
// match: TSA match object. Returns 'won' | 'lost' | 'void' | 'open'
function settleLeg(leg, match) {
  if (!match) return "open";
  if (["postponed", "cancelled"].includes(match.status)) return "void";
  if (match.status !== "finished" || !match.score || match.score.home == null) return "open";
  const h = +match.score.home, a = +match.score.away, t = h + a, s = leg.sel;
  if (s === "H") return h > a ? "won" : "lost";
  if (s === "D") return h === a ? "won" : "lost";
  if (s === "A") return a > h ? "won" : "lost";
  if (s === "BY") return h > 0 && a > 0 ? "won" : "lost";
  if (s === "BN") return h > 0 && a > 0 ? "lost" : "won";
  if (s[0] === "O") return t > parseFloat(s.slice(1)) ? "won" : "lost";
  if (s[0] === "U") return t < parseFloat(s.slice(1)) ? "won" : "lost";
  return "void";
}

module.exports = { tsa, buildPool, build, settleLeg };
