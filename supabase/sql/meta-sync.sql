-- Daily Meta sync: schedule + the secret the schedule sends (already applied).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'meta_sync_secret', 'Sent by the daily pg_cron job to the meta-sync Edge Function');

create or replace function public.meta_sync_secret() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_secret' limit 1;
$$;
revoke all on function public.meta_sync_secret() from public, anon, authenticated;
grant execute on function public.meta_sync_secret() to service_role;

-- 6:20am New York time (10:20 UTC; 11:20 in winter is fine too)
select cron.schedule('meta-sync-daily', '20 * * * *', $$
  select net.http_post(
    url := 'https://hipuhixrfabjnbtwrldn.supabase.co/functions/v1/meta-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.meta_sync_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
