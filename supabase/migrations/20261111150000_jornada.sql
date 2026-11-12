-- Subir la foto de la jornada: la IA lee los contratos de la hoja y la app arma la ruta.
-- Se anota cada lectura (sin guardar la foto) para el panel y para poner un límite diario por persona.

-- nuevas acciones para el panel
alter table public.actividad drop constraint actividad_tipo_check;
alter table public.actividad add constraint actividad_tipo_check check (tipo in
  ('entrar', 'buscar', 'ruta', 'plano', 'recorrido', 'corregir', 'agregar', 'jornada', 'foto_borrosa', 'deshacer_jornada'));

create table public.lecturas_jornada (
  id bigint generated always as identity primary key,
  usuario_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fecha timestamptz not null default now(),
  fotos smallint not null default 1,
  tipo text not null default '' check (char_length(tipo) <= 20),
  leidos smallint not null default 0,
  dudosos smallint not null default 0,
  legible boolean not null default true,
  modelo text not null default '' check (char_length(modelo) <= 40),
  ms integer not null default 0
);
create index on public.lecturas_jornada (usuario_id, fecha desc);
alter table public.lecturas_jornada enable row level security;
create policy "solo la admin ve las lecturas" on public.lecturas_jornada for select to authenticated using (public.es_admin());
revoke all on public.lecturas_jornada from anon;

-- cuántas lecturas le quedan hoy (hora de Perú) a quien llama; la Edge Function lo revisa antes de usar la IA
create or replace function public.jornada_cupo(p_limite int default 20) returns int
language sql stable security definer set search_path = '' as $$
  select greatest(0, p_limite - count(*)::int) from public.lecturas_jornada
  where usuario_id = auth.uid()
    and fecha >= ((now() at time zone 'America/Lima')::date::timestamp at time zone 'America/Lima')
$$;

-- la Edge Function anota cada lectura con la sesión del usuario (quién y cuándo los pone el servidor)
create or replace function public.jornada_anotar(p_fotos int, p_tipo text, p_leidos int, p_dudosos int, p_legible boolean,
  p_modelo text, p_ms int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  insert into public.lecturas_jornada (usuario_id, fotos, tipo, leidos, dudosos, legible, modelo, ms)
  values (auth.uid(), least(greatest(p_fotos, 0), 10), left(coalesce(p_tipo, ''), 20), least(greatest(p_leidos, 0), 500),
    least(greatest(p_dudosos, 0), 500), coalesce(p_legible, true), left(coalesce(p_modelo, ''), 40), greatest(p_ms, 0));
end $$;

revoke execute on function public.jornada_cupo(int), public.jornada_anotar(int, text, int, int, boolean, text, int) from anon, public;
grant execute on function public.jornada_cupo(int), public.jornada_anotar(int, text, int, int, boolean, text, int) to authenticated;

-- el panel ve las lecturas sumadas por día junto con el resto del uso
create or replace function public.admin_lecturas_diarias(p_desde date) returns table (dia date, usuario_id uuid, lecturas bigint,
  borrosas bigint, leidos bigint, dudosos bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo la administradora'; end if;
  return query
    select (l.fecha at time zone 'America/Lima')::date, l.usuario_id, count(*), count(*) filter (where not l.legible),
      coalesce(sum(l.leidos), 0)::bigint, coalesce(sum(l.dudosos), 0)::bigint
    from public.lecturas_jornada l
    where l.fecha >= (p_desde::timestamp at time zone 'America/Lima')
    group by 1, 2;
end $$;
revoke execute on function public.admin_lecturas_diarias(date) from anon, public;
grant execute on function public.admin_lecturas_diarias(date) to authenticated;
