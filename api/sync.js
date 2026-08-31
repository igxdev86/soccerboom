// SoccerBoom sync. Backfills every league's finished matches into Supabase
// in resumable batches, then switches to a cheap daily top-up.
// Trigger: GET /api/sync?secret=SYNC_SECRET   (or Vercel cron with CRON_SECRET)

const SB = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const KEY = process.env.THESTATSAPI_KEY;
const SEASONS_PER_COMP = +(process.env.SEASONS_PER_COMP || 2);
const MAX_CALLS = +(process.env.SYNC_MAX_CALLS || 120);
const TIME_BUDGET_MS = 45000;

async function sb(path, method = 'GET', body, prefer) {
  const r = await fetch(SB + '/rest/v1' + path, {
    method,
    headers: {
      apikey: SK, Authorization: 'Bearer ' + SK,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

let calls = 0;
async function tsa(path) {
  calls++;
  const r = await fetch('https://api.thestatsapi.com/api' + path, {
    headers: { Authorization: 'Bearer ' + KEY }
  });
  if (r.status === 429) { const e = new Error('rate limited'); e.rate = true; throw e; }
  if (!r.ok) throw new Error('TSA ' + r.status + ' ' + path);
  return r.json();
}

const upsert = (table, rows) =>
  rows.length ? sb('/' + table, 'POST', rows, 'resolution=merge-duplicates,return=minimal') : null;

const mapMatch = m => ({
  id: m.id, competition_id: m.competition_id, season_id: m.season_id, utc_date: m.utc_date,
  home_id: m.home_team.id, home_name: m.home_team.name,
  away_id: m.away_team.id, away_name: m.away_team.name,
  home_goals: m.score.home, away_goals: m.score.away
});

const iso = d => d.toISOString().slice(0, 10);

module.exports = async (req, res) => {
  const okQuery = process.env.SYNC_SECRET && req.query.secret === process.env.SYNC_SECRET;
  const okCron = process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET;
  if (!okQuery && !okCron) return res.status(401).json({ error: 'unauthorized' });
  if (!SB || !SK || !KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / THESTATSAPI_KEY' });

  const start = Date.now();
  const row = await sb('/sync_state?id=eq.main&select=value');
  const s = (row && row[0] && row[0].value) || {
    phase: 'backfill', comps: null, ci: 0, seasons: null, si: 0, page: 1, matches: 0
  };
  let note = '';

  try {
    while (calls < MAX_CALLS && Date.now() - start < TIME_BUDGET_MS) {
      if (s.phase === 'backfill') {
        if (!s.comps) {
          const ids = [], compRows = [];
          for (let p = 1; p <= 4; p++) {
            const r = await tsa(`/football/competitions?type=league&per_page=100&page=${p}`);
            r.data.forEach(c => { ids.push(c.id); compRows.push({ id: c.id, name: c.name, country: c.country }); });
            if (p >= r.meta.total_pages) break;
          }
          await upsert('competitions', compRows);
          s.comps = ids; s.ci = 0;
          continue;
        }
        if (s.ci >= s.comps.length) {
          s.phase = 'daily'; s.backfilled_at = new Date().toISOString();
          note = 'Backfill complete — switched to daily mode';
          break;
        }
        const comp = s.comps[s.ci];
        if (!s.seasons) {
          const r = await tsa(`/football/competitions/${comp}/seasons`);
          const take = r.data.slice(0, SEASONS_PER_COMP);
          await upsert('seasons', take.map(x => ({ id: x.id, competition_id: comp, year: x.year, is_current: !!x.is_current })));
          s.seasons = take.map(x => x.id); s.si = 0; s.page = 1;
          continue;
        }
        if (s.si >= s.seasons.length) { s.ci++; s.seasons = null; continue; }
        const season = s.seasons[s.si];
        const r = await tsa(`/football/matches?competition_id=${comp}&season_id=${season}&status=finished&per_page=100&page=${s.page}`);
        const rows = r.data.filter(m => m.score && m.score.home != null).map(mapMatch);
        await upsert('matches', rows);
        s.matches += rows.length;
        if (s.page >= (r.meta.total_pages || 1)) { s.si++; s.page = 1; } else s.page++;
      } else {
        // Daily: one global sweep of everything finished in the last 3 days.
        const to = new Date(), from = new Date(Date.now() - 3 * 864e5);
        let page = 1, added = 0;
        while (page <= 20) {
          const r = await tsa(`/football/matches?status=finished&date_from=${iso(from)}&date_to=${iso(to)}&per_page=100&page=${page}`);
          const rows = r.data.filter(m => m.score && m.score.home != null && s.comps.includes(m.competition_id)).map(mapMatch);
          await upsert('matches', rows);
          added += rows.length;
          if (page >= (r.meta.total_pages || 1)) break;
          page++;
        }
        s.matches += added;
        s.last_daily = new Date().toISOString();
        note = `Daily top-up: ${added} matches`;
        break;
      }
    }
  } catch (e) {
    note = e.rate ? 'Hit TheStatsAPI rate limit — progress saved, run again in a minute' : 'Error: ' + e.message;
  }

  s.last_run = new Date().toISOString();
  await sb('/sync_state', 'POST', [{ id: 'main', value: s, updated_at: s.last_run }], 'resolution=merge-duplicates,return=minimal');

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    phase: s.phase,
    progress: s.phase === 'backfill' && s.comps ? `${s.ci}/${s.comps.length} leagues` : 'complete',
    matches_stored: s.matches,
    api_calls_this_run: calls,
    seconds: Math.round((Date.now() - start) / 1000),
    note
  });
};
