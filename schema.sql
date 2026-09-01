-- SoccerBoom schema. Paste into Supabase → SQL Editor → Run.

create table if not exists competitions (
  id text primary key,
  name text,
  country text
);

create table if not exists seasons (
  id text primary key,
  competition_id text,
  year text,
  is_current boolean
);

create table if not exists matches (
  id text primary key,
  competition_id text,
  season_id text,
  utc_date timestamptz,
  home_id text,
  home_name text,
  away_id text,
  away_name text,
  home_goals int,
  away_goals int
);
create index if not exists matches_home_idx on matches(home_id);
create index if not exists matches_away_idx on matches(away_id);
create index if not exists matches_comp_idx on matches(competition_id);

create table if not exists sync_state (
  id text primary key,
  value jsonb,
  updated_at timestamptz default now()
);

-- One row per team-perspective per match.
create or replace view team_matches as
select m.id as match_id, m.competition_id, m.utc_date,
       m.home_id as team_id, m.home_name as team_name,
       m.home_goals as gf, m.away_goals as ga
from matches m
union all
select m.id, m.competition_id, m.utc_date,
       m.away_id, m.away_name, m.away_goals, m.home_goals
from matches m;

-- Rank every team by how often they hit an exact score.
create or replace function score_rank(p_gf int, p_ga int, p_min_games int default 20)
returns table (
  team_id text, team_name text, competition text, country text,
  games bigint, hits bigint, pct numeric,
  gf_avg numeric, ga_avg numeric,
  wins bigint, draws bigint, losses bigint,
  win_gf_avg numeric, win_ga_avg numeric,
  modal_score text, top_scores text
)
language sql stable as $$
with tm as (select * from team_matches),
agg as (
  select team_id, max(team_name) as team_name,
    count(*) as games,
    count(*) filter (where gf = p_gf and ga = p_ga) as hits,
    avg(gf) as gf_avg, avg(ga) as ga_avg,
    count(*) filter (where gf > ga) as wins,
    count(*) filter (where gf = ga) as draws,
    count(*) filter (where gf < ga) as losses,
    avg(gf) filter (where gf > ga) as win_gf_avg,
    avg(ga) filter (where gf > ga) as win_ga_avg
  from tm group by team_id having count(*) >= p_min_games
),
scores as (
  select team_id, gf || '-' || ga as score, count(*) as c
  from tm group by team_id, gf, ga
),
ranked as (
  select team_id, score, c,
    row_number() over (partition by team_id order by c desc, score) as rn
  from scores
),
tops as (
  select team_id,
    max(score) filter (where rn = 1) as modal_score,
    string_agg(score || ' (' || c || '×)', ', ' order by rn) filter (where rn <= 5) as top_scores
  from ranked group by team_id
),
primary_comp as (
  select distinct on (team_id) team_id, competition_id
  from (select team_id, competition_id, count(*) as c from tm group by 1, 2) x
  order by team_id, c desc
)
select a.team_id, a.team_name, c.name, c.country,
  a.games, a.hits,
  round(a.hits::numeric / a.games * 100, 1),
  round(a.gf_avg, 2), round(a.ga_avg, 2),
  a.wins, a.draws, a.losses,
  round(a.win_gf_avg, 1), round(a.win_ga_avg, 1),
  t.modal_score, t.top_scores
from agg a
join tops t using (team_id)
left join primary_comp pc using (team_id)
left join competitions c on c.id = pc.competition_id
order by a.hits::numeric / a.games desc, a.hits desc
limit 400;
$$;

-- v5: team_form takes p_before so predictions & backtests never see the future.
drop function if exists team_form(text[]);
create or replace function team_form(p_ids text[], p_before timestamptz default now())
returns table (team_id text, home_n int, home_gf numeric, home_ga numeric, away_n int, away_gf numeric, away_ga numeric)
language sql stable as $$
with x as (
  select home_id as team_id, true as h, home_goals as gf, away_goals as ga, utc_date from matches where home_id = any(p_ids) and utc_date < p_before
  union all
  select away_id, false, away_goals, home_goals, utc_date from matches where away_id = any(p_ids) and utc_date < p_before
), w as (
  select *, power(0.97, row_number() over (partition by team_id, h order by utc_date desc) - 1) as wt from x
)
select team_id,
  count(*) filter (where h)::int,
  round(sum(gf*wt) filter (where h) / nullif(sum(wt) filter (where h),0), 3),
  round(sum(ga*wt) filter (where h) / nullif(sum(wt) filter (where h),0), 3),
  count(*) filter (where not h)::int,
  round(sum(gf*wt) filter (where not h) / nullif(sum(wt) filter (where not h),0), 3),
  round(sum(ga*wt) filter (where not h) / nullif(sum(wt) filter (where not h),0), 3)
from w group by team_id;
$$;

-- v6: captured bookmaker prices (UK matches) for ROI backtesting.
create table if not exists odds (
  match_id text primary key,
  captured_at timestamptz default now(),
  data jsonb
);
