-- Audit fixes, Oct 30 2026 (already applied to the live database as migrations
-- rls_initplan_and_indexes and ghl_manual_client_and_form_latest).

-- Evaluate is_team() once per query, not once per row.
alter policy "team reads meta pages" on public.meta_pages using ((select public.is_team()));
alter policy "team updates meta pages" on public.meta_pages using ((select public.is_team())) with check ((select public.is_team()));
alter policy "team reads ghl contacts" on public.ghl_contacts using ((select public.is_team()));
alter policy "team updates ghl contacts" on public.ghl_contacts using ((select public.is_team())) with check ((select public.is_team()));
alter policy "team reads ad daily" on public.meta_ad_daily using ((select public.is_team()));
alter policy "team reads ghl runs" on public.ghl_sync_runs using ((select public.is_team()));
alter policy "team manages money" on public.money_entries using ((select public.is_team())) with check ((select public.is_team()));
alter policy "team reads meta accounts" on public.meta_ad_accounts using ((select public.is_team()));
alter policy "team reads meta daily" on public.meta_daily using ((select public.is_team()));
alter policy "team reads meta runs" on public.meta_sync_runs using ((select public.is_team()));
alter policy "team reads meta leads" on public.meta_leads using ((select public.is_team()));
alter policy "team updates meta lead client" on public.meta_leads using ((select public.is_team())) with check ((select public.is_team()));
alter policy "team reads superseded" on public.money_entries_superseded using ((select public.is_team()));
alter policy "team reads stripe runs" on public.stripe_sync_runs using ((select public.is_team()));
alter policy "team reads pnl" on public.qbo_pnl using ((select public.is_team()));

-- Session check compares as uuid so the primary key index is used.
create or replace function public.session_verified() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.verified_sessions v
    where v.session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
      and v.user_id = (select auth.uid())
      and v.expires_at > now()
      and v.last_seen > now() - interval '60 minutes'
  );
$$;
create index if not exists team_members_lower_email on public.team_members (lower(email));

-- Indexes for the 2-minute leads job and foreign keys.
create index if not exists meta_leads_form_created on public.meta_leads (form_id, created_time desc);
create index if not exists ghl_contacts_client_idx on public.ghl_contacts (client_id);
create index if not exists meta_pages_client_idx on public.meta_pages (client_id);
create index if not exists client_services_service_idx on public.client_services (service_id);
create index if not exists money_entries_partner_idx on public.money_entries (partner_id);

-- A client picked by hand in Tracker for a GHL lead; ghl-sync never overwrites it.
alter table public.ghl_contacts add column if not exists client_manual boolean not null default false;

-- Newest lead per Meta form (one query for the 2-minute leads job).
create or replace view public.meta_form_latest with (security_invoker = true) as
  select form_id, max(created_time) as latest from public.meta_leads group by form_id;
revoke all on public.meta_form_latest from anon, authenticated;

-- Schedule: new Meta leads every 2 minutes (the full Meta sync stays hourly).
-- select cron.schedule('meta-leads-2min', '*/2 * * * *', $$select net.http_post(
--   url:='https://hipuhixrfabjnbtwrldn.supabase.co/functions/v1/meta-sync',
--   headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',public.meta_sync_secret()),
--   body:='{"action":"leads"}'::jsonb, timeout_milliseconds:=120000)$$);
