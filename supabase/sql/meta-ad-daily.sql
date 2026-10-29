-- Daily numbers per ad for SGS's own ad account(s): which campaigns, ad sets and ads bring leads.
create table if not exists public.meta_ad_daily (
  ad_id text not null,
  day date not null,
  ad_account_id text not null,
  campaign_id text not null default '',
  campaign_name text not null default '',
  adset_id text not null default '',
  adset_name text not null default '',
  ad_name text not null default '',
  spend numeric not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  link_clicks integer not null default 0,
  leads integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (ad_id, day)
);
create index if not exists meta_ad_daily_acct_day on public.meta_ad_daily (ad_account_id, day);
alter table public.meta_ad_daily enable row level security;
drop policy if exists "team reads ad daily" on public.meta_ad_daily;
create policy "team reads ad daily" on public.meta_ad_daily for select to authenticated using (public.is_team());
revoke all on public.meta_ad_daily from anon;
grant select on public.meta_ad_daily to authenticated;
