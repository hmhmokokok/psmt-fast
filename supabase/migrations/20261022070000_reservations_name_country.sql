-- Reservations collect an optional name and country. Payments are off for now.
alter table public.reservations
  add column name text check (length(name) <= 120),
  add column country text check (length(country) <= 80);

drop function public.reserve_pillow(text, jsonb);

create function public.reserve_pillow(p_email text, p_items jsonb default '[]'::jsonb, p_name text default null, p_country text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_country text := nullif(left(btrim(coalesce(p_country, '')), 80), '');
  v_inserted boolean;
begin
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 20 or length(p_items::text) > 4000 then
    p_items := '[]'::jsonb;
  end if;

  insert into public.reservations (email, items, name, country)
  values (v_email, p_items, v_name, v_country)
  on conflict (email) do update
    set items = excluded.items,
        name = coalesce(excluded.name, public.reservations.name),
        country = coalesce(excluded.country, public.reservations.country),
        updated_at = now()
  returning (xmax = 0) into v_inserted;

  return case when v_inserted then 'created' else 'updated' end;
end;
$$;

revoke all on function public.reserve_pillow(text, jsonb, text, text) from public;
grant execute on function public.reserve_pillow(text, jsonb, text, text) to anon;
