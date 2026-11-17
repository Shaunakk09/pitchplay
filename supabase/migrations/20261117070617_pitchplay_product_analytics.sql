-- Privacy-minimal PitchPlay analytics. No board contents, titles, passwords,
-- player names, search queries, IP addresses, or raw user-agent strings.
create table if not exists public.pitchplay_product_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_]{2,49}$'),
  visitor_id uuid not null,
  session_id uuid not null,
  user_id uuid references auth.users(id) on delete set null,
  surface text not null check (surface in ('app','playbook','editor','discover','account','analytics')),
  detail text check (detail is null or detail ~ '^[a-z0-9_:-]{1,40}$')
);

create index if not exists pitchplay_product_events_when_idx
  on public.pitchplay_product_events (occurred_at desc);
create index if not exists pitchplay_product_events_type_when_idx
  on public.pitchplay_product_events (event_name, occurred_at desc);
create index if not exists pitchplay_product_events_user_when_idx
  on public.pitchplay_product_events (user_id, occurred_at desc) where user_id is not null;

alter table public.pitchplay_product_events enable row level security;
revoke all on public.pitchplay_product_events from anon, authenticated;
grant insert on public.pitchplay_product_events to anon, authenticated;
grant usage, select on sequence public.pitchplay_product_events_id_seq to anon, authenticated;

create policy "Clients can only record events for their own identity"
  on public.pitchplay_product_events for insert to anon, authenticated
  with check (user_id is not distinct from (select auth.uid()));

-- This is security-invoker; client identity is always supplied by the JWT,
-- never accepted as an input. Data API callers cannot SELECT the raw events.
create or replace function public.pitchplay_track_event(
  p_event_name text,
  p_visitor_id uuid,
  p_session_id uuid,
  p_surface text,
  p_detail text default null
) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.pitchplay_product_events
    (event_name,visitor_id,session_id,user_id,surface,detail)
  values
    (p_event_name,p_visitor_id,p_session_id,(select auth.uid()),p_surface,p_detail);
end;
$$;
revoke all on function public.pitchplay_track_event(text,uuid,uuid,text,text) from public;
grant execute on function public.pitchplay_track_event(text,uuid,uuid,text,text) to anon, authenticated;

-- Authenticated founders only. Do not grant access to the raw event rows.
-- SECURITY DEFINER is necessary to aggregate RLS-protected rows and read
-- auth.users; email verification and auth.uid() are checked before any query.
create or replace function public.pitchplay_admin_analytics()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  local_today date := (now() at time zone 'Asia/Singapore')::date;
  result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' and not exists (
    select 1 from auth.users u
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
      and lower(u.email) in ('shaunakahluwalia@gmail.com','adimasbagusdp@gmail.com')
  ) then
    raise exception 'Founder analytics access denied' using errcode='42501';
  end if;

  with enriched as (
    select e.*, (e.occurred_at at time zone 'Asia/Singapore')::date as sg_day,
      coalesce(e.user_id::text,'guest:'||e.visitor_id::text) as identity_key
    from public.pitchplay_product_events e
  ), periods as (
    select label,from_day,ord from (values
      ('today',local_today,1),
      ('week',local_today-6,2),
      ('month',local_today-29,3),
      ('all',date '1970-01-01',4)
    ) p(label,from_day,ord)
  ), totals as (
    select p.label,p.ord,
      jsonb_build_object(
        'events',count(e.id),
        'visitors',count(distinct e.identity_key),
        'sessions',count(distinct e.session_id),
        'page_views',count(e.id) filter (where e.event_name='page_view'),
        'logins',count(e.id) filter (where e.event_name='login_success'),
        'signups',count(e.id) filter (where e.event_name='signup_completed'),
        'boards_created',count(e.id) filter (where e.event_name='board_created'),
        'boards_edited',count(e.id) filter (where e.event_name='board_edited'),
        'exports',count(e.id) filter (where e.event_name='export_completed'),
        'discover_views',count(e.id) filter (where e.event_name='discover_opened')
      ) as metrics
    from periods p left join enriched e on e.sg_day>=p.from_day
    group by p.label,p.ord
  ), daily as (
    select d.day::date as day,
      jsonb_build_object(
        'day',to_char(d.day,'YYYY-MM-DD'),
        'visitors',count(distinct e.identity_key),
        'sessions',count(distinct e.session_id),
        'events',count(e.id),
        'page_views',count(e.id) filter (where e.event_name='page_view'),
        'logins',count(e.id) filter (where e.event_name='login_success'),
        'signups',count(e.id) filter (where e.event_name='signup_completed'),
        'boards_created',count(e.id) filter (where e.event_name='board_created'),
        'boards_edited',count(e.id) filter (where e.event_name='board_edited'),
        'discover_views',count(e.id) filter (where e.event_name='discover_opened'),
        'exports',count(e.id) filter (where e.event_name='export_completed')
      ) as metrics
    from generate_series(local_today-29,local_today,interval '1 day') d(day)
      left join enriched e on e.sg_day=d.day::date
    group by d.day
  ), event_breakdown as (
    select event_name,count(*) as total
    from enriched where sg_day>=local_today-29
    group by event_name order by total desc limit 30
  ), recent_logins as (
    select e.occurred_at,u.email
    from enriched e join auth.users u on u.id=e.user_id
    where e.event_name='login_success'
    order by e.occurred_at desc limit 20
  )
  select jsonb_build_object(
    'timezone','Asia/Singapore',
    'generated_at',now(),
    'totals',(select jsonb_object_agg(label,metrics) from totals),
    'daily',(select coalesce(jsonb_agg(metrics order by day),'[]'::jsonb) from daily),
    'events',(select coalesce(jsonb_agg(jsonb_build_object('name',event_name,'count',total) order by total desc),'[]'::jsonb) from event_breakdown),
    'recent_logins',(select coalesce(jsonb_agg(jsonb_build_object('email',email,'at',occurred_at) order by occurred_at desc),'[]'::jsonb) from recent_logins)
  ) into result;
  return result;
end;
$$;

revoke all on function public.pitchplay_admin_analytics() from public, anon;
grant execute on function public.pitchplay_admin_analytics() to authenticated;
grant execute on function public.pitchplay_admin_analytics() to service_role;

-- Idempotency ledger for a future transactional-email function; not exposed.
create table if not exists public.pitchplay_login_email_receipts (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.pitchplay_login_email_receipts enable row level security;
revoke all on public.pitchplay_login_email_receipts from anon, authenticated;

create table if not exists public.pitchplay_analytics_digest_receipts (
  day_sgt date primary key,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.pitchplay_analytics_digest_receipts enable row level security;
revoke all on public.pitchplay_analytics_digest_receipts from anon, authenticated;
