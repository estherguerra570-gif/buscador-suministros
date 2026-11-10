-- Panel de la administradora: uso sumado por día (hora de Perú) y por usuario, para ver días, semanas y meses
-- sin descargar cada registro. Solo la administradora puede llamarlas.

-- minutos de uso de cada usuario en cada día (igual que el panel: el tramo cuenta desde que empezó hasta el último latido + 1 min)
create or replace function public.admin_uso_diario(p_desde date) returns table (dia date, usuario_id uuid, minutos numeric, tramos bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo la administradora'; end if;
  return query
    select (t.inicio at time zone 'America/Lima')::date, t.usuario_id,
      round(sum(greatest(1, extract(epoch from t.ultimo - t.inicio) / 60 + 1)), 1), count(*)
    from public.tramos_uso t
    where t.inicio >= (p_desde::timestamp at time zone 'America/Lima')
    group by 1, 2;
end $$;

-- cuántas acciones de cada tipo hizo cada usuario cada día (las correcciones salen del historial)
create or replace function public.admin_acciones_diarias(p_desde date) returns table (dia date, usuario_id uuid, tipo text, cantidad bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo la administradora'; end if;
  return query
    select (a.fecha at time zone 'America/Lima')::date, a.usuario_id, a.tipo, count(*)
    from public.actividad a
    where a.fecha >= (p_desde::timestamp at time zone 'America/Lima')
    group by 1, 2, 3
    union all
    select (h.fecha at time zone 'America/Lima')::date, h.usuario_id, h.accion, count(*)
    from public.historial_correcciones h
    where h.fecha >= (p_desde::timestamp at time zone 'America/Lima')
    group by 1, 2, 3;
end $$;

revoke execute on function public.admin_uso_diario(date), public.admin_acciones_diarias(date) from anon, public;
grant execute on function public.admin_uso_diario(date), public.admin_acciones_diarias(date) to authenticated;
