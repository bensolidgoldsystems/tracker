-- Apply AFTER the email-2FA Tracker UI is deployed and Resend is sending.
-- From then on, Tracker data is only readable from sign-in sessions that passed the email code.
create or replace function public.is_team()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.session_verified() and exists (
    select 1 from public.team_members
    where lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );
$$;
create or replace function public.my_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.team_members
  where lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    and public.session_verified();
$$;
