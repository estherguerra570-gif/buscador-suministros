-- Panel de la administradora: tiempo de uso, acciones de cada usuario, bloqueo e intentos de entrada.
-- Los usuarios solo pueden anotar lo suyo; leer todo esto es solo para la administradora.

-- ---------- Bloqueo de usuarios ----------
alter table public.perfiles add column bloqueado boolean not null default false;

create or replace function public.esta_bloqueado() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select bloqueado from public.perfiles where id = auth.uid()), false)
$$;

-- un usuario bloqueado ya no ve ni cambia correcciones
drop policy "con sesión se leen" on public.correcciones;
drop policy "con sesión se agregan" on public.correcciones;
drop policy "con sesión se cambian" on public.correcciones;
drop policy "con sesión se borran" on public.correcciones;
create policy "con sesión se leen" on public.correcciones for select to authenticated using (not public.esta_bloqueado());
create policy "con sesión se agregan" on public.correcciones for insert to authenticated with check (not public.esta_bloqueado());
create policy "con sesión se cambian" on public.correcciones for update to authenticated
  using (not public.esta_bloqueado()) with check (not public.esta_bloqueado());
create policy "con sesión se borran" on public.correcciones for delete to authenticated using (not public.esta_bloqueado());

create or replace function public.admin_bloquear(p_usuario uuid, p_bloquear boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo la administradora'; end if;
  if p_usuario = auth.uid() then raise exception 'No puedes bloquearte a ti misma'; end if;
  update public.perfiles set bloqueado = p_bloquear where id = p_usuario;
end $$;
revoke execute on function public.admin_bloquear(uuid, boolean) from anon, public;
grant execute on function public.admin_bloquear(uuid, boolean) to authenticated;

-- ---------- Tiempo de uso: un tramo por cada vez que la app está abierta y a la vista ----------
create table public.tramos_uso (
  id uuid primary key,
  usuario_id uuid not null references auth.users (id) on delete cascade,
  inicio timestamptz not null default now(),
  ultimo timestamptz not null default now()
);
create index on public.tramos_uso (ultimo desc);
alter table public.tramos_uso enable row level security;
create policy "solo la admin ve el uso" on public.tramos_uso for select to authenticated using (public.es_admin());

-- la app lo llama cada minuto mientras está a la vista; un tramo no se puede alargar más de 3 min por llamada
create or replace function public.latido(p_tramo uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  insert into public.tramos_uso (id, usuario_id) values (p_tramo, auth.uid())
  on conflict (id) do update set ultimo = now()
    where public.tramos_uso.usuario_id = auth.uid() and public.tramos_uso.ultimo > now() - interval '3 minutes';
end $$;
revoke execute on function public.latido(uuid) from anon, public;
grant execute on function public.latido(uuid) to authenticated;

-- ---------- Acciones: buscar, ruta, plano, recorrido, corregir, agregar ----------
create table public.actividad (
  id bigint generated always as identity primary key,
  usuario_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tipo text not null check (tipo in ('entrar', 'buscar', 'ruta', 'plano', 'recorrido', 'corregir', 'agregar')),
  detalle text not null default '' check (char_length(detalle) <= 80),
  fecha timestamptz not null default now()
);
create index on public.actividad (fecha desc);
create index on public.actividad (usuario_id, fecha desc);
alter table public.actividad enable row level security;
create policy "cada uno anota lo suyo" on public.actividad for insert to authenticated
  with check (usuario_id = auth.uid() and not public.esta_bloqueado());
create policy "solo la admin ve la actividad" on public.actividad for select to authenticated using (public.es_admin());

-- quién y cuándo lo pone el servidor
create or replace function public.firmar_actividad() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.usuario_id := auth.uid();
  new.fecha := now();
  return new;
end $$;
create trigger firmar before insert on public.actividad
  for each row execute function public.firmar_actividad();

-- ---------- Intentos de entrar con Google que no terminaron (últimos 30 días) ----------
create or replace function public.admin_intentos() returns table (fecha timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo la administradora'; end if;
  return query select f.created_at from auth.flow_state f
    where f.auth_code_issued_at is null and f.created_at > now() - interval '30 days'
      and f.created_at < now() - interval '10 minutes' -- los recientes pueden estar entrando todavía
    order by f.created_at desc;
end $$;
revoke execute on function public.admin_intentos() from anon, public;
grant execute on function public.admin_intentos() to authenticated;

revoke all on public.tramos_uso, public.actividad from anon;

-- ---------- Tiempo real: la pestaña "En vivo" del panel ----------
alter publication supabase_realtime add table public.actividad;
