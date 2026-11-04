"use strict";
// Panel de la administradora: quién usa la app, cuánto tiempo, qué hace, registros nuevos y correcciones.
// Los datos solo los entrega Supabase a la cuenta de la administradora (permisos en supabase/migrations);
// cualquier otra cuenta ve "No tienes acceso" aunque abra esta página.

const SUPABASE_URL = "https://wknalygmlzghpucyvuoi.supabase.co";
const SUPABASE_CLAVE = "sb_publishable_8FAJR9zYDJUCcwItnHO7-A_HDQl8Wvm";
const CORREO_ADMIN = "estherguerra570@gmail.com";
const DIAS = 30; // cuántos días de uso y actividad se descargan
const ACTIVO_MIN = 2.5; // con un latido en estos minutos, está "usando ahora"

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_CLAVE, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

const $ = (s) => document.querySelector(s);
const escapar = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const diaDe = (f) => new Date(f).toLocaleDateString("sv-SE"); // AAAA-MM-DD en hora local
const hoy = () => diaDe(new Date());
const hora = (f) => new Date(f).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
const fechaHora = (f) => (diaDe(f) === hoy() ? `hoy ${hora(f)}` : new Date(f).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" }) + " " + hora(f));
const plural = (n, p, pl = p + "s") => `${n} ${n === 1 ? p : pl}`;

function haceCuanto(f) {
  const min = Math.round((Date.now() - new Date(f)) / 60000);
  if (min < 2) return "ahora";
  if (min < 60) return `hace ${min} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return fechaHora(f);
}
function duracion(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}
const minutosDe = (t) => Math.max(1, (new Date(t.ultimo) - new Date(t.inicio)) / 60000 + 1); // +1: el minuto del último latido

const ACCIONES = {
  entrar: (d) => "entró a la app",
  buscar: (d) => `buscó el suministro <b>${escapar(d)}</b>`,
  ruta: (d) => `creó una ruta de ${escapar(d)}`,
  plano: (d) => `vio el plano (${escapar(d)})`,
  recorrido: (d) => `inició el recorrido en vivo al <b>${escapar(d)}</b>`,
  agregar: (d) => `agregó el suministro nuevo <b>${escapar(d)}</b>`,
  corregir: (d) => `corrigió la ubicación del <b>${escapar(d)}</b>`,
  restaurar: (d) => `volvió el <b>${escapar(d)}</b> a la ubicación del plano`,
};
const ICONOS = { entrar: "🔓", buscar: "🔍", ruta: "🛵", plano: "🗺️", recorrido: "▶", agregar: "＋", corregir: "📌", restaurar: "↩︎" };

let yo = null;
let datos = null; // {perfiles, tramos, actividad, historial, correcciones, intentos}
let pestana = "resumen";
let usuarioAbierto = null; // id del usuario cuyo detalle se ve
let filtro = "";

// ---------- Entrada ----------
function mostrarEntrada(texto, conGoogle = true) {
  $("#entrada").hidden = false;
  $("#entrada-texto").textContent = texto;
  $("#btn-google").hidden = !conGoogle;
  $("#btn-app").hidden = conGoogle;
}

$("#btn-google").onclick = async () => {
  $("#btn-google").disabled = true;
  const { error } = await supa.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } },
  });
  if (error) { $("#btn-google").disabled = false; mostrarEntrada(`No se pudo abrir Google: ${error.message}`); }
};

(async () => {
  const { data } = await supa.auth.getSession();
  if (location.search.includes("code=")) history.replaceState(null, "", location.pathname);
  const u = data.session?.user;
  if (!u) return mostrarEntrada("Entra con tu cuenta de Google.");
  if ((u.email ?? "").toLowerCase() !== CORREO_ADMIN) return mostrarEntrada("No tienes acceso a esta página.", false);
  yo = u;
  $("#pestanas").hidden = false;
  await cargar();
  escucharEnVivo();
  setInterval(() => { if (!document.hidden) cargar(true); }, 60000);
})();

// ---------- Datos ----------
async function cargar(silencioso = false) {
  if (!silencioso) { $("#estado").hidden = false; $("#estado").textContent = "Cargando…"; }
  const desde = new Date(Date.now() - DIAS * 864e5).toISOString();
  const [perf, tram, act, hist, corr, intentos] = await Promise.all([
    supa.from("perfiles").select("*").order("ultimo_acceso", { ascending: false }),
    supa.from("tramos_uso").select("*").gt("ultimo", desde).limit(20000),
    supa.from("actividad").select("*").gt("fecha", desde).order("fecha", { ascending: false }).limit(10000),
    supa.from("historial_correcciones").select("*").order("fecha", { ascending: false }).limit(500),
    supa.from("correcciones").select("numero, fecha"),
    supa.rpc("admin_intentos"),
  ]);
  const error = [perf, tram, act, hist, corr, intentos].find((r) => r.error)?.error;
  if (error) {
    if (silencioso) return;
    $("#estado").hidden = false;
    $("#estado").innerHTML = `<span class="alerta">No se pudo cargar: ${escapar(error.message)}.<br>Revisa la conexión y toca ⟳.</span>`;
    return;
  }
  $("#estado").hidden = true;
  datos = {
    perfiles: perf.data, tramos: tram.data, actividad: act.data, historial: hist.data,
    correcciones: new Map(corr.data.map((c) => [c.numero, c.fecha])), intentos: intentos.data,
  };
  pintar();
}

let recarga = null;
function escucharEnVivo() {
  supa.channel("panel").on("postgres_changes", { event: "INSERT", schema: "public", table: "actividad" }, () => {
    clearTimeout(recarga);
    recarga = setTimeout(() => cargar(true), 1500);
  }).subscribe();
}

// lo que hizo cada usuario, junto: acciones + correcciones (vienen del historial, que guarda de dónde a dónde)
function eventos() {
  const a = datos.actividad.map((x) => ({ ...x, clave: "a" + x.id }));
  const h = datos.historial.map((x) => ({
    clave: "h" + x.id, tipo: x.accion, detalle: x.numero, usuario_id: x.usuario_id, fecha: x.fecha, nota: x.nota, numero: x.numero,
  }));
  return [...a, ...h].sort((x, y) => new Date(y.fecha) - new Date(x.fecha));
}

function porUsuario() {
  const m = new Map(datos.perfiles.map((p) => [p.id, { p, min: 0, minHoy: 0, activo: false, cuentas: {} }]));
  const limite = Date.now() - ACTIVO_MIN * 60000;
  for (const t of datos.tramos) {
    const u = m.get(t.usuario_id);
    if (!u) continue;
    u.min += minutosDe(t);
    if (diaDe(t.inicio) === hoy()) u.minHoy += minutosDe(t);
    if (new Date(t.ultimo) > limite) u.activo = true;
  }
  for (const e of eventos()) {
    const u = m.get(e.usuario_id);
    if (u) u.cuentas[e.tipo] = (u.cuentas[e.tipo] ?? 0) + 1;
  }
  return m;
}

// ---------- Pintar ----------
function pintar() {
  if (!datos) return;
  for (const p of ["resumen", "usuarios", "vivo"]) $(`#p-${p}`).hidden = p !== pestana;
  document.querySelectorAll(".pestana").forEach((b) => b.classList.toggle("activa", b.dataset.p === pestana));
  ({ resumen: pintarResumen, usuarios: pintarUsuarios, vivo: pintarVivo })[pestana]();
}
document.querySelectorAll(".pestana").forEach((b) => {
  b.onclick = () => { pestana = b.dataset.p; usuarioAbierto = null; pintar(); scrollTo(0, 0); };
});
$("#btn-recargar").onclick = () => cargar();

const foto = (p, clase = "foto-lista") => (p?.foto
  ? `<img class="${clase}" src="${escapar(p.foto)}" alt="" referrerpolicy="no-referrer">`
  : `<span class="avatar chico">${escapar((p?.nombre ?? "?").trim()[0]?.toUpperCase() ?? "?")}</span>`);
const nombreDe = (id) => datos.perfiles.find((p) => p.id === id)?.nombre ?? "Alguien";
const cuadro = (valor, texto, extra = "") => `<div class="cuadro ${extra}"><strong>${valor}</strong><span>${texto}</span></div>`;

function pintarResumen() {
  const usos = porUsuario();
  const lista = [...usos.values()];
  const nuevosHoy = datos.perfiles.filter((p) => diaDe(p.creado) === hoy());
  const nuevosSemana = datos.perfiles.filter((p) => Date.now() - new Date(p.creado) < 7 * 864e5).length;
  const activos = lista.filter((u) => u.activo);
  const usoHoy = lista.reduce((s, u) => s + u.minHoy, 0);

  // minutos de uso por día, últimos 7
  const dias = [...Array(7)].map((_, i) => {
    const d = new Date(Date.now() - (6 - i) * 864e5);
    return { clave: diaDe(d), letra: d.toLocaleDateString("es-PE", { weekday: "short" }).slice(0, 2), min: 0 };
  });
  for (const t of datos.tramos) { const d = dias.find((x) => x.clave === diaDe(t.inicio)); if (d) d.min += minutosDe(t); }
  const max = Math.max(...dias.map((d) => d.min), 1);
  const iMax = dias.findIndex((d) => d.min === max);

  const buscados = new Map();
  for (const a of datos.actividad) if (a.tipo === "buscar" && diaDe(a.fecha) === hoy()) buscados.set(a.detalle, (buscados.get(a.detalle) ?? 0) + 1);
  const top = [...buscados].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const desdeUso = datos.tramos.length ? Math.min(...datos.tramos.map((t) => new Date(t.inicio))) : null;

  $("#p-resumen").innerHTML = `
    <div class="cuadros">
      ${cuadro(datos.perfiles.length, "Usuarios")}
      ${cuadro(nuevosHoy.length, `Nuevos hoy · ${nuevosSemana} en 7 días`)}
      ${cuadro(`${activos.length ? "🟢 " : ""}${activos.length}`, "Usando ahora", activos.length ? "vivo" : "")}
      ${cuadro(duracion(usoHoy), "Uso hoy (todos)")}
    </div>
    ${activos.length ? `<p class="nota">🟢 Ahora: ${activos.map((u) => escapar(u.p.nombre.split(" ")[0])).join(", ")}</p>` : ""}

    <h3 class="subtitulo">Tiempo de uso por día</h3>
    <div class="grafico" role="list" aria-label="Minutos de uso de todos los usuarios, últimos 7 días">
      ${dias.map((d, i) => `
        <button class="barra-dia${d.clave === hoy() ? " hoy" : ""}" role="listitem" data-texto="${escapar(`${d.letra}: ${duracion(d.min)}`)}"
          aria-label="${escapar(`${d.letra} ${duracion(d.min)}`)}">
          <span class="valor">${(i === iMax || d.clave === hoy()) && d.min > 0 ? duracion(d.min) : ""}</span>
          <span class="columna" style="height:${d.min ? Math.max(4, (d.min / max) * 100) : 0}%"></span>
          <span class="letra">${escapar(d.letra)}</span>
        </button>`).join("")}
    </div>
    <p class="nota" id="dato-dia">${desdeUso ? `El tiempo de uso se cuenta desde: ${fechaHora(desdeUso)}` : "El tiempo de uso se empieza a contar cuando los usuarios abran la app."}</p>

    <h3 class="subtitulo">Más buscados hoy</h3>
    ${top.length ? `<ul class="lista">${top.map(([n, c]) => `
      <li><a class="num" href="./#${escapar(n)}">${escapar(n)}</a><span class="info">${plural(c, "vez", "veces")}</span></li>`).join("")}</ul>`
      : `<p class="vacio">Hoy todavía nadie buscó.</p>`}

    <h3 class="subtitulo">Registros nuevos</h3>
    <ul class="lista">${datos.perfiles.slice().sort((a, b) => new Date(b.creado) - new Date(a.creado)).slice(0, 5).map((p) => `
      <li data-u="${p.id}">${foto(p)}<span class="info"><strong class="texto">${escapar(p.nombre)}</strong><br>se registró ${fechaHora(p.creado)}</span></li>`).join("")}</ul>

    <h3 class="subtitulo">Intentos de entrar que no terminaron</h3>
    ${datos.intentos.length ? `<p class="nota">Tocaron “Entrar con Google” pero no volvieron. Suele pasar al abrir el link dentro de WhatsApp o Facebook en vez de Chrome.</p>
      <ul class="lista">${datos.intentos.slice(0, 10).map((i) => `<li><span class="info">⚠️ ${fechaHora(i.fecha)}</span></li>`).join("")}</ul>`
      : `<p class="vacio">Ninguno en los últimos 30 días.</p>`}`;

  document.querySelectorAll(".barra-dia").forEach((b) => { b.onclick = () => { $("#dato-dia").textContent = b.dataset.texto; }; });
  document.querySelectorAll("#p-resumen li[data-u]").forEach((li) => { li.onclick = () => abrirUsuario(li.dataset.u); });
}

function abrirUsuario(id) {
  pestana = "usuarios";
  usuarioAbierto = id;
  pintar();
  scrollTo(0, 0);
}

function pintarUsuarios() {
  const usos = porUsuario();
  if (usuarioAbierto && usos.has(usuarioAbierto)) return pintarDetalle(usos.get(usuarioAbierto));
  const f = filtro.trim().toLowerCase();
  const lista = [...usos.values()].filter((u) => !f || `${u.p.nombre} ${u.p.email}`.toLowerCase().includes(f));
  $("#p-usuarios").innerHTML = `
    <input id="filtro" type="search" placeholder="🔍 Buscar usuario…" value="${escapar(filtro)}">
    <ul class="lista">${lista.map((u) => `
      <li data-u="${u.p.id}">${foto(u.p)}
        <span class="info"><strong class="texto">${u.activo ? "🟢 " : ""}${escapar(u.p.nombre)}${diaDe(u.p.creado) === hoy() ? " 🆕" : ""}${u.p.bloqueado ? " 🚫" : ""}</strong><br>
          ${u.activo ? "usando la app ahora" : haceCuanto(u.p.ultimo_acceso)} · ${plural(u.p.accesos, "entrada")} · ${duracion(u.min)} de uso
          ${u.cuentas.corregir ? `· ${plural(u.cuentas.corregir, "corrección", "correcciones")}` : ""}</span>
        <span class="flecha">›</span></li>`).join("") || `<li><span class="info">Nadie con ese nombre.</span></li>`}</ul>
    <p class="nota">🟢 usando ahora · 🆕 registrado hoy · 🚫 bloqueado. El tiempo de uso es de los últimos ${DIAS} días.</p>`;
  const entrada = $("#filtro");
  entrada.oninput = () => { filtro = entrada.value; pintarUsuarios(); const e = $("#filtro"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); };
  document.querySelectorAll("#p-usuarios li[data-u]").forEach((li) => { li.onclick = () => abrirUsuario(li.dataset.u); });
}

function pintarDetalle(u) {
  const p = u.p;
  const suyos = eventos().filter((e) => e.usuario_id === p.id);
  const c = (t) => u.cuentas[t] ?? 0;
  $("#p-usuarios").innerHTML = `
    <button class="btn" id="d-volver">← Todos los usuarios</button>
    <div class="tarjeta perfil">${foto(p, "foto-perfil")}
      <div><strong>${escapar(p.nombre)}</strong>${p.bloqueado ? ` <span class="etiqueta mal">🚫 Bloqueado</span>` : ""}
        <div class="nota">${escapar(p.email)}</div>
        <div class="nota">${u.activo ? "🟢 Usando la app ahora" : `Último acceso: ${haceCuanto(p.ultimo_acceso)}`}</div></div>
    </div>
    <div class="cuadros">
      ${cuadro(duracion(u.minHoy), "Uso hoy")}
      ${cuadro(duracion(u.min), `Uso en ${DIAS} días`)}
      ${cuadro(p.accesos, "Entradas")}
      ${cuadro(c("buscar"), "Búsquedas")}
      ${cuadro(c("ruta"), "Rutas creadas")}
      ${cuadro(c("corregir"), "Correcciones")}
    </div>
    <p class="nota">Se registró: ${fechaHora(p.creado)} · También: ${plural(c("plano"), "plano visto", "planos vistos")}, ${plural(c("recorrido"), "recorrido en vivo", "recorridos en vivo")}, ${plural(c("agregar"), "suministro agregado", "suministros agregados")}.</p>
    <h3 class="subtitulo">Últimas acciones</h3>
    ${suyos.length ? listaEventos(suyos.slice(0, 60), false) : `<p class="vacio">Todavía no hay acciones registradas.</p>`}
    ${p.email?.toLowerCase() === CORREO_ADMIN ? "" : `<div class="fila"><button class="btn ${p.bloqueado ? "primario" : "peligro"}" id="d-bloquear">
      ${p.bloqueado ? "✅ Desbloquear usuario" : "🚫 Bloquear usuario"}</button></div>
      <p class="nota">${p.bloqueado ? "No puede entrar a la app." : "Si lo bloqueas, ya no podrá entrar a la app ni corregir ubicaciones."}</p>`}`;
  $("#d-volver").onclick = () => { usuarioAbierto = null; pintar(); };
  const b = $("#d-bloquear");
  if (b) b.onclick = async () => {
    const bloquear = !p.bloqueado;
    if (!confirm(bloquear ? `¿Bloquear a ${p.nombre}? Ya no podrá usar la app.` : `¿Desbloquear a ${p.nombre}?`)) return;
    b.disabled = true;
    const { error } = await supa.rpc("admin_bloquear", { p_usuario: p.id, p_bloquear: bloquear });
    if (error) { alert(`No se pudo: ${error.message}`); b.disabled = false; return; }
    await cargar(true);
  };
  activarEventos("#p-usuarios");
}

function listaEventos(lista, conNombre = true) {
  return `<ul class="lista eventos">${lista.map((e) => {
    const vigente = e.tipo === "corregir" && datos.correcciones.get(e.numero) === e.fecha; // es la corrección que está puesta ahora
    const numero = ["buscar", "recorrido", "agregar", "corregir", "restaurar"].includes(e.tipo) ? e.detalle : null;
    return `<li><span class="icono">${ICONOS[e.tipo] ?? "•"}</span>
      <span class="info"><span class="texto">${conNombre ? `<b>${escapar(nombreDe(e.usuario_id).split(" ")[0])}</b> ` : ""}${ACCIONES[e.tipo]?.(e.detalle) ?? escapar(e.tipo)}</span>
        ${e.nota ? `<br>“${escapar(e.nota)}”` : ""}<br>${fechaHora(e.fecha)}
        ${numero || vigente ? `<span class="acciones">
          ${numero ? `<a class="btn chico" href="./#${escapar(numero)}">Ver en mapa</a>` : ""}
          ${vigente ? `<button class="btn chico" data-deshacer="${escapar(e.numero)}">↩︎ Deshacer</button>` : ""}</span>` : ""}
      </span></li>`;
  }).join("")}</ul>`;
}

function activarEventos(donde) {
  document.querySelectorAll(`${donde} [data-deshacer]`).forEach((b) => {
    b.onclick = async () => {
      const n = b.dataset.deshacer;
      if (!confirm(`¿Volver el suministro ${n} a la ubicación del plano? Se quita la corrección para todos.`)) return;
      b.disabled = true;
      const { error } = await supa.from("correcciones").delete().eq("numero", n);
      if (error) { alert(`No se pudo: ${error.message}`); b.disabled = false; return; }
      await cargar(true);
    };
  });
}

function pintarVivo() {
  const lista = eventos().slice(0, 150);
  $("#p-vivo").innerHTML = `
    <p class="nota">Se actualiza solo. Lo último arriba.</p>
    ${lista.length ? listaEventos(lista) : `<p class="vacio">Todavía no hay actividad.</p>`}`;
  activarEventos("#p-vivo");
}
