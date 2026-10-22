-- PSMT FAST launch site: waitlist reservations and Stripe orders.
-- Both tables have RLS on and no policies, so the public (publishable/anon) key can't read or
-- write them directly. Visitors reserve through reserve_pillow(); orders are written by the
-- psmt-checkout and psmt-stripe-webhook edge functions with the service role.

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservations_email_format check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text unique,
  status text not null default 'created' check (status in ('created', 'paid', 'expired')),
  items jsonb not null,
  amount_total integer not null check (amount_total >= 0), -- cents
  currency text not null default 'usd',
  customer_email text,
  shipping jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reservations enable row level security;
alter table public.orders enable row level security;

-- Public entry point for the "Reserve without paying" form. Re-reserving with the same email
-- updates the cart instead of creating a duplicate.
create or replace function public.reserve_pillow(p_email text, p_items jsonb default '[]'::jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_inserted boolean;
begin
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 20 or length(p_items::text) > 4000 then
    p_items := '[]'::jsonb;
  end if;

  insert into public.reservations (email, items)
  values (v_email, p_items)
  on conflict (email) do update set items = excluded.items, updated_at = now()
  returning (xmax = 0) into v_inserted;

  return case when v_inserted then 'created' else 'updated' end;
end;
$$;

revoke all on function public.reserve_pillow(text, jsonb) from public;
grant execute on function public.reserve_pillow(text, jsonb) to anon, authenticated;
-- (applied as a follow-up migration) the site has no sign-in, so only anon needs it:
revoke execute on function public.reserve_pillow(text, jsonb) from authenticated;
