-- Apply right AFTER the Tracker version with the activity heartbeat is deployed.
-- A verified sign-in with no activity check-in for 60 minutes stops getting data.
create or replace function public.session_verified()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.verified_sessions v
    where v.session_id::text = coalesce((select auth.jwt()) ->> 'session_id', '')
      and v.user_id = (select auth.uid())
      and v.expires_at > now()
      and v.last_seen > now() - interval '60 minutes'
  );
$$;
