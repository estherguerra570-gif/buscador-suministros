-- Buscador de Suministros: usuarios (Google) y ubicaciones corregidas compartidas por todos.

-- ---------- Administradora ----------
create or replace function public.es_admin() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'estherguerra570@gmail.com'
$$;

-- ---------- Perfiles: quién usa la app ----------
create table public.perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  nombre text,
  foto text,
  creado timestamptz not null default now(),
  ultimo_acceso timestamptz not null default now(),
  accesos integer not null default 0
);
alter table public.perfiles enable row level security;
create policy "cada uno ve su perfil y la admin todos" on public.perfiles
  for select to authenticated using (id = auth.uid() or public.es_admin());

-- al registrarse con Google se crea su perfil
create or replace function public.crear_perfil() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfiles (id, email, nombre, foto)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
          new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;
create trigger al_crear_usuario after insert on auth.users
  for each row execute function public.crear_perfil();

-- la app lo llama al abrir: último acceso, cantidad de accesos y datos frescos de Google
create or replace function public.registrar_acceso() returns public.perfiles
language plpgsql security definer set search_path = '' as $$
declare
  u auth.users;
  p public.perfiles;
begin
  select * into u from auth.users where id = auth.uid();
  if u.id is null then raise exception 'Sin sesión'; end if;
  insert into public.perfiles (id, email, nombre, foto, accesos)
  values (u.id, u.email,
          coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)),
          u.raw_user_meta_data ->> 'avatar_url', 1)
  on conflict (id) do update set
    email = excluded.email, nombre = excluded.nombre, foto = excluded.foto,
    ultimo_acceso = now(), accesos = public.perfiles.accesos + 1
  returning * into p;
  return p;
end $$;
revoke execute on function public.registrar_acceso() from anon, public;
grant execute on function public.registrar_acceso() to authenticated;

-- ---------- Ubicaciones corregidas (una por suministro) ----------
create table public.correcciones (
  numero text primary key check (numero ~ '^[0-9]{1,6}$'),
  lat double precision not null check (lat between -17.2 and -15.6),
  lng double precision not null check (lng between -72.6 and -70.8),
  nota text not null default '' check (char_length(nota) <= 200),
  usuario_id uuid references auth.users (id) on delete set null,
  usuario_nombre text,
  fecha timestamptz not null default now()
);
alter table public.correcciones enable row level security;
create policy "con sesión se leen" on public.correcciones for select to authenticated using (true);
create policy "con sesión se agregan" on public.correcciones for insert to authenticated with check (true);
create policy "con sesión se cambian" on public.correcciones for update to authenticated using (true) with check (true);
create policy "con sesión se borran" on public.correcciones for delete to authenticated using (true);

-- quién y cuándo lo pone el servidor, no el celular
create or replace function public.firmar_correccion() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.usuario_id := auth.uid();
  new.usuario_nombre := (select nombre from public.perfiles where id = auth.uid());
  new.fecha := now();
  return new;
end $$;
create trigger firmar before insert or update on public.correcciones
  for each row execute function public.firmar_correccion();

-- ---------- Historial: nunca se borra ----------
create table public.historial_correcciones (
  id bigint generated always as identity primary key,
  numero text not null,
  accion text not null check (accion in ('corregir', 'restaurar')),
  lat double precision,
  lng double precision,
  lat_antes double precision,
  lng_antes double precision,
  nota text,
  usuario_id uuid references auth.users (id) on delete set null,
  usuario_nombre text,
  fecha timestamptz not null default now()
);
create index on public.historial_correcciones (fecha desc);
alter table public.historial_correcciones enable row level security;
create policy "solo la admin ve el historial" on public.historial_correcciones
  for select to authenticated using (public.es_admin());

create or replace function public.anotar_historial() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.historial_correcciones (numero, accion, lat_antes, lng_antes, usuario_id, usuario_nombre)
    values (old.numero, 'restaurar', old.lat, old.lng, auth.uid(),
            (select nombre from public.perfiles where id = auth.uid()));
    return old;
  end if;
  insert into public.historial_correcciones (numero, accion, lat, lng, lat_antes, lng_antes, nota, usuario_id, usuario_nombre)
  values (new.numero, 'corregir', new.lat, new.lng,
          case when tg_op = 'UPDATE' then old.lat end, case when tg_op = 'UPDATE' then old.lng end,
          new.nota, new.usuario_id, new.usuario_nombre);
  return new;
end $$;
create trigger anotar after insert or update or delete on public.correcciones
  for each row execute function public.anotar_historial();

-- ---------- Sin sesión no se ve nada ----------
revoke all on public.perfiles, public.correcciones, public.historial_correcciones from anon;

-- ---------- Tiempo real: las correcciones de otros llegan al instante ----------
alter publication supabase_realtime add table public.correcciones;
