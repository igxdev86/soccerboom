-- TARGET bot lab
create table if not exists target_bets (
  id bigserial primary key,
  bot int not null,
  day text not null,
  target numeric not null,
  stake numeric not null,
  risk text not null,
  legs jsonb not null default '[]',
  odds numeric not null default 0,
  status text not null default 'open',   -- open | won | lost | nobet
  returns numeric not null default 0,
  placed_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (bot, day)
);
create index if not exists target_bets_status on target_bets(status);
