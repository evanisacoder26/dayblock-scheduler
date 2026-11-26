-- Dayblock database for the GitHub Pages + Supabase version.
-- Accounts themselves live in Supabase Auth (auth.users). Run this once in the SQL editor,
-- or let scripts/setup-supabase.mjs run it for you. Safe to run again.

-- Each user's planner (tasks, focus mode, brain dump) as one JSON document.
create table if not exists public.plans (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"tasks": [], "focus": false, "dump": ""}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Login sessions that passed the emailed code. Data is only reachable from these.
create table if not exists public.verified_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Pending email codes (sign-in and email change). Only the edge function touches this.
create table if not exists public.email_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid,
  purpose text not null check (purpose in ('login', 'email-change')),
  email text not null,
  code_hash text not null,
  attempts int not null default 0,
  sends int not null default 1,
  last_sent timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists email_challenges_user_idx on public.email_challenges (user_id, created_at);

-- "Don't ask for a code on this device for 30 days". Only a hash of the token is stored.
create table if not exists public.trusted_devices (
  token_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists trusted_devices_user_idx on public.trusted_devices (user_id);

-- Row level security: the browser (anon key + user's login) can only reach its own rows,
-- and only from a session that entered the emailed code. The edge function uses the
-- service role, which bypasses these rules.
alter table public.plans enable row level security;
alter table public.verified_sessions enable row level security;
alter table public.email_challenges enable row level security;
alter table public.trusted_devices enable row level security;

create or replace function public.session_is_verified() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.verified_sessions v
    where v.user_id = auth.uid()
      and v.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
  );
$$;
revoke all on function public.session_is_verified() from public;
grant execute on function public.session_is_verified() to authenticated;

drop policy if exists plans_own on public.plans;
create policy plans_own on public.plans for all to authenticated
  using (user_id = auth.uid() and public.session_is_verified())
  with check (user_id = auth.uid() and public.session_is_verified());

drop policy if exists devices_read_own on public.trusted_devices;
create policy devices_read_own on public.trusted_devices for select to authenticated
  using (user_id = auth.uid() and public.session_is_verified());

drop policy if exists devices_delete_own on public.trusted_devices;
create policy devices_delete_own on public.trusted_devices for delete to authenticated
  using (user_id = auth.uid() and public.session_is_verified());

-- verified_sessions and email_challenges have no policies: the browser can't read or write them.

grant select, insert, update, delete on public.plans to authenticated;
grant select, delete on public.trusted_devices to authenticated;
revoke all on public.verified_sessions, public.email_challenges from anon, authenticated;
revoke all on public.plans, public.trusted_devices from anon;
