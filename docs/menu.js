"use strict";
// Menú de la esquina: usuario, suministros agregados a mano y búsquedas del día.
// Se guarda en el propio celular (localStorage), salvo las ubicaciones corregidas, que van al sistema (Supabase)
// para todos. Usa las funciones y variables globales de app.js y sesion.js.

const CLAVE_USUARIO = "usuario";
const CLAVE_PROPIOS = "suministros-propios";
const CLAVE_HISTORIAL = "historial-busquedas";
const CLAVE_CORRECCIONES = "ubicaciones-corregidas"; // pendientes de enviar al sistema
const CLAVE_SISTEMA = "correcciones-sistema"; // copia de las del sistema para abrir sin señal
const COLOR_NUEVO = "#7b1fa2";

let usuario = leer(CLAVE_USUARIO, "");
let propios = leer(CLAVE_PROPIOS, []);   // [{n, lat, lng, nota, por, fecha, c: "nuevo"}]
let pendientes = leer(CLAVE_CORRECCIONES, {}); // {numero: {lat, lng, nota, por, fecha} | {borrar: true}} sin enviar aún

const hoyISO = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-DD en hora local
const horaCorta = (d = new Date()) => d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
const escapar = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Abrir / cerrar ----------
function abrirMenu() {
  pintarCabeceraMenu();
  $("#menu").hidden = false;
  $("#menu-fondo").hidden = false;
  $("#btn-menu").setAttribute("aria-expanded", "true");
}
function cerrarMenu() {
  $("#menu").hidden = true;
  $("#menu-fondo").hidden = true;
  $("#btn-menu").setAttribute("aria-expanded", "false");
}
$("#btn-menu").onclick = abrirMenu;
$("#menu-fondo").onclick = cerrarMenu;

function abrirHoja(titulo, html) {
  $("#hoja-titulo").textContent = titulo;
  $("#hoja-cuerpo").innerHTML = html;
  $("#hoja").hidden = false;
}
function cerrarHoja() { $("#hoja").hidden = true; }
$("#hoja-cerrar").onclick = cerrarHoja;

const HOJAS = {
  usuario: hojaUsuario,
  historial: hojaHistorial,
  agregar: () => hojaAgregar(),
  corregir: () => hojaCorregir(),
  admin: hojaAdmin,
  "mis-puntos": hojaMisPuntos,
  ruta: () => { activarVista("ruta"); setTimeout(() => $("#numero-ruta").focus(), 50); },
};
document.querySelectorAll(".menu-item").forEach((b) => {
  b.onclick = () => { cerrarMenu(); HOJAS[b.dataset.hoja](); };
});

function pintarCabeceraMenu() {
  $("#menu-nombre").textContent = usuario || "Sin nombre";
  const foto = usuarioActual?.foto;
  $("#menu-avatar").innerHTML = foto ? `<img src="${escapar(foto)}" alt="" referrerpolicy="no-referrer">` : escapar(usuario ? usuario.trim()[0].toUpperCase() : "?");
  $("#menu-fecha").textContent = new Date().toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" });
  $("#cuenta-propios").textContent = propios.length || "";
  const sinEnviar = Object.keys(pendientes).length;
  $("#cuenta-corregidos").textContent = sinEnviar ? `⏳ ${sinEnviar}` : "";
  $("#cuenta-historial").textContent = historialDeHoy().length || "";
  $("#saludo").textContent = usuario ? `· ${usuario.split(" ")[0]}` : "";
}

// ---------- Usuario (cuenta de Google) ----------
/** Lo llama sesion.js al entrar (o este archivo al cargar, si ya había sesión). */
function alEntrar() {
  usuario = usuarioActual.nombre;
  guardar(CLAVE_USUARIO, usuario);
  $("#menu-admin").hidden = !usuarioActual.admin;
  pintarCabeceraMenu();
  if (Object.keys(pendientes).length) sincronizarPendientes(); // correcciones que quedaron sin enviar
}

function hojaUsuario() {
  const u = usuarioActual;
  abrirHoja("Usuario", u ? `
    <div class="tarjeta perfil">
      ${u.foto ? `<img class="foto-perfil" src="${escapar(u.foto)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${escapar(u.nombre.trim()[0]?.toUpperCase() ?? "?")}</div>`}
      <div><strong>${escapar(u.nombre)}</strong><div class="nota">${escapar(u.email)}${u.admin ? " · administradora" : ""}</div></div>
    </div>
    <p class="nota">Entraste con tu cuenta de Google. Tu nombre queda en cada ubicación que corrijas.</p>
    <div class="fila"><button id="u-salir" class="btn">Cerrar sesión</button></div>` : `<p class="vacio">No iniciaste sesión.</p>`);
  if (u) $("#u-salir").onclick = () => {
    if (!confirm("¿Cerrar sesión en este celular?")) return;
    cerrarHoja();
    cerrarSesion();
  };
}

// ---------- Panel de la administradora: quién usa la app y qué corrigió ----------
const haceCuanto = (fecha) => {
  const min = Math.round((Date.now() - new Date(fecha)) / 60000);
  if (min < 2) return "ahora";
  if (min < 60) return `hace ${min} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return new Date(fecha).toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric" });
};

async function hojaAdmin() {
  abrirHoja("Usuarios y actividad", `<p class="vacio">Cargando…</p>`);
  const [perf, hist] = await Promise.all([
    supa.from("perfiles").select("*").order("ultimo_acceso", { ascending: false }),
    supa.from("historial_correcciones").select("*").order("fecha", { ascending: false }).limit(300),
  ]);
  if (perf.error || hist.error) {
    abrirHoja("Usuarios y actividad", `<p class="nota alerta">No se pudo cargar: ${escapar((perf.error ?? hist.error).message)}. Revisa la conexión.</p>`);
    return;
  }
  const hechas = new Map();
  for (const h of hist.data) if (h.accion === "corregir") hechas.set(h.usuario_id, (hechas.get(h.usuario_id) ?? 0) + 1);
  const foto = (p) => (p.foto ? `<img class="foto-lista" src="${escapar(p.foto)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar chico">${escapar((p.nombre ?? "?").trim()[0]?.toUpperCase() ?? "?")}</span>`);
  const movida = (h) => (h.lat_antes != null && h.lat != null ? ` · ${formatoDist(dist({ lat: h.lat_antes, lng: h.lng_antes }, h))}` : "");
  abrirHoja("Usuarios y actividad", `
    <h3 class="subtitulo">Usuarios (${perf.data.length})</h3>
    <ul class="lista">${perf.data.map((p) => `
      <li>${foto(p)}<span class="info"><strong class="texto">${escapar(p.nombre)}</strong><br>${escapar(p.email)}<br>
        Último acceso: ${haceCuanto(p.ultimo_acceso)} · entró ${p.accesos} ${p.accesos === 1 ? "vez" : "veces"} ·
        ${plural(hechas.get(p.id) ?? 0, "corrección")}</span></li>`).join("")}</ul>
    <h3 class="subtitulo">Últimas correcciones</h3>
    ${hist.data.length ? `<ul class="lista">${hist.data.map((h) => `
      <li data-n="${escapar(h.numero)}"><span class="num">${escapar(h.numero)}</span>
        <span class="info">${h.accion === "corregir" ? "📌 Corregido" : "↩︎ Vuelto al plano"} por ${escapar(h.usuario_nombre ?? "—")}${movida(h)}<br>
        ${haceCuanto(h.fecha)}${h.nota ? " · " + escapar(h.nota) : ""}</span></li>`).join("")}</ul>`
      : `<p class="vacio">Todavía nadie corrigió una ubicación.</p>`}`);
  document.querySelectorAll("#hoja-cuerpo li[data-n]").forEach((li) => { li.onclick = () => hojaCorregir(li.dataset.n); });
}

// ---------- Búsquedas del día ----------
function historialDeHoy() {
  const h = leer(CLAVE_HISTORIAL, null);
  return h && h.fecha === hoyISO() ? h.items : [];
}

/** Se llama al abrir un suministro: lo pone primero en las búsquedas de hoy (se reinicia cada día). */
function registrarBusqueda(n) {
  const items = historialDeHoy().filter((x) => x.n !== n);
  items.unshift({ n, hora: horaCorta() });
  guardar(CLAVE_HISTORIAL, { fecha: hoyISO(), items: items.slice(0, 200) });
}

function hojaHistorial() {
  const items = historialDeHoy();
  abrirHoja("Búsquedas de hoy", items.length ? `
    <p class="nota">${plural(items.length, "suministro")} consultado${items.length === 1 ? "" : "s"} hoy. Se borra solo al día siguiente.</p>
    <div class="fila">
      <button id="h-ruta" class="btn primario">Pasar todos a la ruta del día</button>
      <button id="h-borrar" class="btn">Borrar</button>
    </div>
    <ul class="lista">${items.map((x) => {
      const s = indice.get(x.n);
      return `<li data-n="${x.n}"><span class="punto ${s?.c ?? ""}"></span><span class="num">${x.n}</span>
        <span class="info">${x.hora}${s?.p ? " · pág. " + s.p : s ? " · agregado" : " · ya no existe"}</span></li>`;
    }).join("")}</ul>` : `<p class="vacio">Todavía no buscaste suministros hoy.</p>`);

  document.querySelectorAll("#hoja-cuerpo li[data-n]").forEach((li) => {
    li.onclick = () => { cerrarHoja(); activarVista("buscar"); seleccionar(li.dataset.n); };
  });
  if (!items.length) return;
  $("#h-ruta").onclick = () => {
    agregarARuta(items.map((x) => x.n));
    cerrarHoja();
    activarVista("ruta");
  };
  $("#h-borrar").onclick = () => {
    if (!confirm("¿Borrar las búsquedas de hoy?")) return;
    guardar(CLAVE_HISTORIAL, null);
    hojaHistorial();
  };
}

// ---------- Suministros agregados por el usuario ----------
/** Une los suministros propios a los del plano (se llama al cargar los datos). */
function incorporarPropios() {
  for (const p of propios) {
    if (indice.has(p.n)) continue; // si ya vino en el plano, manda el plano
    const s = { ...p, c: "nuevo" };
    datos.suministros.push(s);
    indice.set(s.n, s);
  }
}

let borrador = null; // datos del formulario mientras se elige el punto en el mapa

function hojaAgregar(b = { n: "", nota: "", lat: null, lng: null }) {
  borrador = b;
  const tiene = b.lat != null;
  abrirHoja("Agregar suministro nuevo", `
    <label class="campo">Número de suministro
      <input id="a-numero" type="text" inputmode="numeric" maxlength="6" value="${escapar(b.n)}" placeholder="1 a 6 cifras">
    </label>
    <label class="campo">Referencia (opcional)
      <textarea id="a-nota" rows="2" placeholder="Ej.: casa verde, portón negro">${escapar(b.nota)}</textarea>
    </label>
    <div class="campo">Ubicación
      <div class="fila">
        <button id="a-gps" class="btn">📡 Usar mi ubicación</button>
        <button id="a-mapa" class="btn">🗺️ Elegir en el mapa</button>
      </div>
      <div id="a-ubicacion" class="ubicacion-elegida ${tiene ? "ok" : ""}">
        ${tiene ? `✓ ${b.lat.toFixed(6)}, ${b.lng.toFixed(6)}` : "Sin ubicación todavía"}
      </div>
    </div>
    <p id="a-error" class="nota alerta" hidden></p>
    <div class="fila"><button id="a-guardar" class="btn primario">Guardar suministro</button></div>
    <p class="nota">Se guarda en este celular${usuario ? ` a nombre de ${escapar(usuario)}` : ""}. Al buscarlo se muestra en el mapa.</p>`);

  const leerFormulario = () => {
    borrador.n = $("#a-numero").value.replace(/\D/g, "");
    borrador.nota = $("#a-nota").value.trim();
  };
  $("#a-gps").onclick = async () => {
    leerFormulario();
    $("#a-ubicacion").textContent = "Obteniendo ubicación…";
    const pos = await obtenerUbicacion().catch(() => null);
    if (!pos) { $("#a-ubicacion").textContent = "No se pudo obtener la ubicación. Revisa el GPS."; return; }
    hojaAgregar({ ...borrador, lat: pos.lat, lng: pos.lng });
  };
  $("#a-mapa").onclick = () => {
    leerFormulario();
    elegirEnMapa({
      alElegir: (ll) => hojaAgregar({ ...borrador, lat: ll.lat, lng: ll.lng }),
      alCancelar: () => hojaAgregar(borrador),
    });
  };
  $("#a-guardar").onclick = () => {
    leerFormulario();
    const error = validar(borrador);
    if (error) { $("#a-error").textContent = error; $("#a-error").hidden = false; return; }
    const nuevo = {
      n: borrador.n, lat: +borrador.lat.toFixed(6), lng: +borrador.lng.toFixed(6),
      nota: borrador.nota, por: usuario, fecha: new Date().toISOString(), c: "nuevo",
    };
    propios.push(nuevo);
    guardar(CLAVE_PROPIOS, propios);
    const s = { ...nuevo };
    datos.suministros.push(s);
    indice.set(s.n, s);
    cerrarHoja();
    activarVista("buscar");
    seleccionar(s.n);
  };
}

function validar(b) {
  if (!/^\d{1,6}$/.test(b.n)) return "El número debe tener de 1 a 6 cifras.";
  const existe = indice.get(b.n);
  if (existe) return existe.c === "nuevo"
    ? `El ${b.n} ya lo agregaste antes.`
    : `El ${b.n} ya existe en el plano (página ${existe.p}).`;
  if (b.lat == null) return "Falta la ubicación: usa tu GPS o elige el punto en el mapa.";
  return null;
}

/** Cierra la hoja y espera que se toque un punto del mapa (a pantalla completa). */
function elegirEnMapa({ alElegir, alCancelar, texto = "Toca el mapa donde está el suministro", centro = null, actual = null }) {
  cerrarHoja();
  activarVista("buscar");
  plegarPanel(true, "Eligiendo ubicación…");
  if (centro) mapa.setView([centro.lat, centro.lng], Math.max(mapa.getZoom(), 18));
  // la ubicación que tiene ahora, para comparar
  const referencia = actual ? L.circleMarker([actual.lat, actual.lng], {
    radius: 9, color: "#c62828", weight: 3, fillColor: "#fff", fillOpacity: 0.6, interactive: false,
  }).bindTooltip("Ubicación actual", { permanent: true, direction: "top", offset: [0, -8] }).addTo(mapa) : null;
  document.body.classList.add("eligiendo");
  $("#aviso-texto").textContent = texto;
  $("#aviso-mapa").hidden = false;
  const terminar = () => {
    document.body.classList.remove("eligiendo");
    $("#aviso-mapa").hidden = true;
    referencia?.remove();
    mapa.off("click", alTocar);
  };
  const alTocar = (e) => { terminar(); alElegir(e.latlng); };
  mapa.on("click", alTocar);
  $("#aviso-cancelar").onclick = () => { terminar(); alCancelar(); };
}

// ---------- Corregir la ubicación de un suministro (para todos los usuarios) ----------
// Las correcciones se guardan en el sistema (tabla "correcciones" de Supabase, que además anota cada cambio en
// un historial) y todos los celulares las aplican al abrir la app y al instante mientras está abierta.
// Sin señal o sin sesión quedan "pendientes" en este celular y se envían solas en cuanto se pueda.

let compartidas = {};   // las del sistema: {numero: {lat, lng, nota, por, fecha}}
const movidos = new Set(); // números que hoy están movidos en el mapa

/** Corrección vigente de un número: la pendiente de este celular manda sobre la del sistema. */
function correccionDe(n) {
  const p = pendientes[n];
  if (p) return p.borrar ? null : p;
  return compartidas[n] ?? null;
}
function todasLasCorrecciones() {
  const nums = new Set([...Object.keys(compartidas), ...Object.keys(pendientes)]);
  return [...nums].map((n) => [n, correccionDe(n)]).filter(([, c]) => c)
    .sort(([, a], [, b]) => (b.fecha ?? "").localeCompare(a.fecha ?? ""));
}

/** Pone una ubicación nueva a un suministro y guarda la del plano para poder volver a ella. */
function moverSuministro(s, c) {
  if (s.latPlano === undefined) { s.latPlano = s.lat; s.lngPlano = s.lng; s.zonaPlano = claveZona(s.lat, s.lng); }
  Object.assign(s, { lat: c.lat, lng: c.lng, corregido: c, nodoClave: null, _nodoVersion: undefined });
  movidos.add(s.n);
}
function restaurarSuministro(s) {
  movidos.delete(s.n);
  if (s.latPlano === undefined) return;
  const z = s.zonaPlano;
  Object.assign(s, { lat: s.latPlano, lng: s.lngPlano, corregido: null, _nodoVersion: undefined });
  delete s.latPlano; delete s.lngPlano; delete s.zonaPlano;
  zonas.delete(z); zonasListas.delete(z); // se vuelve a leer su acceso a la calle del plano
}

/** Deja cada suministro donde dicen las correcciones vigentes (y devuelve al plano los que ya no tienen). */
function aplicarTodas() {
  const vigentes = new Map(todasLasCorrecciones());
  for (const n of [...movidos]) if (!vigentes.has(n)) { const s = indice.get(n); if (s) restaurarSuministro(s); }
  for (const [n, c] of vigentes) {
    const s = indice.get(n);
    if (s && s.c !== "nuevo" && (s.corregido?.lat !== c.lat || s.corregido?.lng !== c.lng || s.corregido?.fecha !== c.fecha)) moverSuministro(s, c);
  }
}

async function descargarCompartidas() {
  await sesionLista;
  const { data, error } = await supa.from("correcciones").select("numero, lat, lng, nota, usuario_nombre, fecha");
  if (error) { compartidas = leer(CLAVE_SISTEMA, {}); return false; } // sin señal: la última copia
  compartidas = Object.fromEntries(data.map(aCorreccion));
  guardar(CLAVE_SISTEMA, compartidas);
  return true;
}
const aCorreccion = (f) => [f.numero, { lat: f.lat, lng: f.lng, nota: f.nota, por: f.usuario_nombre ?? "", fecha: f.fecha }];

/** Al cargar la app (app.js). */
async function aplicarCorrecciones() {
  compartidas = leer(CLAVE_SISTEMA, {}); // primero la copia guardada: el mapa no espera a la red
  aplicarTodas();
  sesionLista.then(async () => {
    if (await descargarCompartidas()) { aplicarTodas(); refrescarTrasMover(); }
    sincronizarPendientes();
    escucharCambios();
  });
}

/** Tiempo real: cuando otro usuario corrige o restaura, el punto se mueve aquí sin recargar. */
function escucharCambios() {
  supa.channel("correcciones")
    .on("postgres_changes", { event: "*", schema: "public", table: "correcciones" }, ({ eventType, new: nueva, old }) => {
      if (eventType === "DELETE") delete compartidas[old.numero];
      else { const [n, c] = aCorreccion(nueva); compartidas[n] = c; }
      guardar(CLAVE_SISTEMA, compartidas);
      aplicarTodas();
      refrescarTrasMover();
    })
    .subscribe();
}

/** Al volver a la app se traen las correcciones que hicieron los demás. */
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !datos) return;
  await sincronizarPendientes();
  if (await descargarCompartidas()) { aplicarTodas(); refrescarTrasMover(); }
});

/** Envía al sistema una corrección (c) o el regreso a la ubicación del plano (c = null). */
async function enviarCorreccion(n, c) {
  if (!usuarioActual?.id) return { ok: false, codigo: 401, error: "Falta iniciar sesión" };
  const { data, error } = c
    ? await supa.from("correcciones").upsert({ numero: n, lat: c.lat, lng: c.lng, nota: c.nota ?? "" })
      .select("numero, lat, lng, nota, usuario_nombre, fecha").single()
    : await supa.from("correcciones").delete().eq("numero", n);
  if (!error) return { ok: true, correccion: c ? aCorreccion(data)[1] : null };
  if (["23514", "22P02", "23502"].includes(error.code)) return { ok: false, codigo: 400, error: "La ubicación o el número no son válidos" };
  if (error.code === "42501" || error.code?.startsWith("PGRST3")) return { ok: false, codigo: 401, error: "La sesión venció: vuelve a entrar" };
  return { ok: false, codigo: 0, error: "Sin conexión" };
}

let colaEnvios = Promise.resolve();
/**
 * Manda lo pendiente de este celular. Devuelve el último problema encontrado (o null si quedó todo enviado).
 * Los envíos van en fila: si se pide otro mientras uno corre, se hace después con lo que haya pendiente entonces.
 */
function sincronizarPendientes() {
  const envio = colaEnvios.then(enviarPendientes);
  colaEnvios = envio.catch(() => {});
  return envio;
}
async function enviarPendientes() {
  let problema = null, enviadas = 0;
  for (const [n, p] of Object.entries(pendientes)) {
    if (!usuarioActual?.id) { problema = { codigo: 401, error: "Falta iniciar sesión" }; break; }
    const r = await enviarCorreccion(n, p.borrar ? null : p);
    if (!r.ok) {
      problema = r;
      if (r.codigo === 400) { delete pendientes[n]; continue; } // dato inválido: no tiene sentido reintentar
      break; // sin señal, clave mala o el sistema no responde: se reintenta más tarde
    }
    if (p.borrar) delete compartidas[n]; else compartidas[n] = r.correccion ?? p;
    delete pendientes[n];
    enviadas++;
  }
  if (enviadas && !problema) avisar(`✓ ${plural(enviadas, "corrección")} enviada${enviadas === 1 ? "" : "s"} a todos.`);
  guardar(CLAVE_SISTEMA, compartidas);
  guardar(CLAVE_CORRECCIONES, pendientes);
  pintarCabeceraMenu();
  return problema;
}

function mensajeEnvio(problema, n) {
  if (!problema) return `✓ Suministro ${n} corregido para todos.`;
  if (problema.codigo === 401) return `Guardado en este celular. ${problema.error} y se enviará solo.`;
  if (problema.codigo === 400) return `No se pudo corregir: ${problema.error}.`;
  return `Guardado en este celular (${problema.error}). Se enviará a todos cuando haya conexión.`;
}

/** Después de mover un punto: se redibuja la ruta y el menú. */
function refrescarTrasMover() {
  pintarRuta();
  pintarCabeceraMenu();
}

let edicion = null; // {n, lat, lng, nota} mientras se corrige

function hojaCorregir(n = "", e = null, aviso = "") {
  edicion = e ?? { n, lat: null, lng: null, nota: "" };
  const s = edicion.n ? indice.get(edicion.n) : null;
  const lista = todasLasCorrecciones();
  const tiene = edicion.lat != null;
  abrirHoja("Corregir ubicación", `
    ${aviso ? `<p class="aviso-envio">${escapar(aviso)}</p>` : ""}
    <form id="c-form" class="buscar-fila">
      <input id="c-numero" type="search" inputmode="numeric" enterkeyhint="search" autocomplete="off" maxlength="6"
             value="${escapar(edicion.n)}" placeholder="Número de suministro…" aria-label="Número de suministro a corregir">
      <button type="submit" class="btn primario">Buscar</button>
    </form>
    ${edicion.n && !s ? `<p class="nota alerta">No se encontró el suministro ${escapar(edicion.n)}.</p>` : ""}
    ${s ? `
      <div class="tarjeta">
        <h3><span class="punto ${s.c}"></span>${s.n}</h3>
        <p class="nota">${s.c === "nuevo" ? "Agregado a mano" : `Página ${s.p} del plano`} ·
          ubicación actual: ${s.lat}, ${s.lng}${s.corregido ? " (ya corregida)" : ""}</p>
        ${s.latPlano !== undefined ? `<p class="nota">En el plano: ${s.latPlano}, ${s.lngPlano}</p>` : ""}
      </div>
      <div class="campo">Nueva ubicación
        <div class="fila">
          <button id="c-gps" class="btn">📡 Estoy en el lugar</button>
          <button id="c-mapa" class="btn">🗺️ Elegir en el mapa</button>
        </div>
        <div id="c-ubicacion" class="ubicacion-elegida ${tiene ? "ok" : ""}">
          ${tiene ? `✓ ${edicion.lat.toFixed(6)}, ${edicion.lng.toFixed(6)} · a ${formatoDist(dist(s, edicion))} de la actual` : "Elige dónde está realmente"}
        </div>
      </div>
      <label class="campo">Referencia (opcional)
        <textarea id="c-nota" rows="2" maxlength="200" placeholder="Ej.: está a la vuelta, puerta azul">${escapar(edicion.nota)}</textarea>
      </label>
      <div class="fila">
        <button id="c-guardar" class="btn primario" ${tiene ? "" : "disabled"}>Guardar para todos</button>
        ${s.c !== "nuevo" && correccionDe(s.n) ? `<button id="c-restaurar" class="btn">Volver a la del plano</button>` : ""}
      </div>
      <p class="nota">${s.c === "nuevo"
        ? "Es un suministro que agregaste a mano: se corrige solo en este celular."
        : "La corrección se guarda en el sistema: el punto se mueve en el mapa, la búsqueda, las rutas y el plano de todos los usuarios."}</p>` : `
      <p class="nota">Busca el suministro que está mal ubicado en el PDF y marca dónde está realmente.
        La corrección vale para todos los usuarios.</p>`}
    <h3 class="subtitulo">Ubicaciones corregidas ${lista.length ? `(${lista.length})` : ""}</h3>
    ${lista.length ? `
      <div class="fila"><button id="c-exportar" class="btn">Descargar lista (CSV)</button></div>
      <ul class="lista">${lista.map(([num, c]) => `
        <li data-n="${num}"><span class="punto ${indice.get(num)?.c ?? ""}"></span><span class="num">${num}</span>
          <span class="info">${pendientes[num] ? "⏳ pendiente de enviar · " : ""}${escapar(c.nota) || "sin referencia"}<br>${c.fecha ? new Date(c.fecha).toLocaleDateString("es-PE") : ""}${c.por ? " · " + escapar(c.por) : ""}</span>
        </li>`).join("")}</ul>` : `<p class="vacio">Todavía no hay ubicaciones corregidas.</p>`}`);

  $("#c-form").onsubmit = (ev) => {
    ev.preventDefault();
    hojaCorregir($("#c-numero").value.replace(/\D/g, ""));
  };
  document.querySelectorAll("#hoja-cuerpo li[data-n]").forEach((li) => { li.onclick = () => hojaCorregir(li.dataset.n); });
  if (lista.length) $("#c-exportar").onclick = exportarCorrecciones;
  if (!s) { if (!edicion.n) setTimeout(() => $("#c-numero")?.focus(), 50); return; }

  const leerNota = () => { edicion.nota = $("#c-nota").value.trim(); };
  $("#c-gps").onclick = async () => {
    leerNota();
    $("#c-ubicacion").textContent = "Obteniendo ubicación…";
    const pos = await obtenerUbicacion().catch(() => null);
    if (!pos) { $("#c-ubicacion").textContent = "No se pudo obtener la ubicación. Revisa el GPS."; return; }
    hojaCorregir(s.n, { ...edicion, lat: pos.lat, lng: pos.lng });
  };
  $("#c-mapa").onclick = () => {
    leerNota();
    elegirEnMapa({
      texto: `Toca dónde está realmente el ${s.n}`,
      centro: tiene ? edicion : s,
      actual: s,
      alElegir: (ll) => hojaCorregir(s.n, { ...edicion, lat: ll.lat, lng: ll.lng }),
      alCancelar: () => hojaCorregir(s.n, edicion),
    });
  };
  $("#c-guardar").onclick = async () => {
    leerNota();
    const c = { lat: +edicion.lat.toFixed(6), lng: +edicion.lng.toFixed(6), nota: edicion.nota, por: usuario, fecha: new Date().toISOString() };
    if (s.c === "nuevo") {
      // los agregados a mano son solo de este celular: se corrigen directamente
      const p = propios.find((x) => x.n === s.n);
      if (p) Object.assign(p, { lat: c.lat, lng: c.lng, nota: c.nota || p.nota });
      guardar(CLAVE_PROPIOS, propios);
      Object.assign(s, { lat: c.lat, lng: c.lng, nota: c.nota || s.nota, _nodoVersion: undefined });
      refrescarTrasMover();
      cerrarHoja();
      activarVista("buscar");
      seleccionar(s.n);
      return;
    }
    pendientes[s.n] = c;
    guardar(CLAVE_CORRECCIONES, pendientes);
    aplicarTodas();
    refrescarTrasMover();
    $("#c-guardar").disabled = true;
    $("#c-guardar").textContent = "Enviando…";
    const problema = await sincronizarPendientes();
    cerrarHoja();
    activarVista("buscar");
    seleccionar(s.n);
    avisar(mensajeEnvio(problema, s.n), !problema);
  };
  if ($("#c-restaurar")) $("#c-restaurar").onclick = async () => {
    if (!confirm(`¿Volver a poner el ${s.n} donde lo indica el plano, para todos los usuarios?`)) return;
    pendientes[s.n] = { borrar: true, fecha: new Date().toISOString() };
    guardar(CLAVE_CORRECCIONES, pendientes);
    aplicarTodas();
    refrescarTrasMover();
    const problema = await sincronizarPendientes();
    hojaCorregir(s.n, null, problema ? mensajeEnvio(problema, s.n) : `✓ El ${s.n} volvió a la ubicación del plano para todos.`);
  };
}

/** Lista de ubicaciones corregidas en CSV (se abre en Excel). */
function exportarCorrecciones() {
  descargarCsv(`ubicaciones-corregidas-${hoyISO()}.csv`,
    ["suministro", "latitud_nueva", "longitud_nueva", "latitud_plano", "longitud_plano", "referencia", "corregido_por", "fecha", "estado"],
    todasLasCorrecciones().map(([n, c]) => {
      const s = indice.get(n);
      return [n, c.lat, c.lng, s?.latPlano ?? "", s?.lngPlano ?? "", c.nota, c.por, c.fecha ? new Date(c.fecha).toLocaleString("es-PE") : "",
        pendientes[n] ? "pendiente de enviar" : "en el sistema"];
    }));
}

function hojaMisPuntos() {
  abrirHoja("Mis suministros agregados", propios.length ? `
    <div class="fila">
      <button id="m-exportar" class="btn primario">Descargar lista (CSV)</button>
    </div>
    <ul class="lista">${propios.map((p) => `
      <li data-n="${p.n}"><span class="punto nuevo"></span><span class="num">${p.n}</span>
        <span class="info">${escapar(p.nota) || "sin referencia"}<br>${new Date(p.fecha).toLocaleDateString("es-PE")}${p.por ? " · " + escapar(p.por) : ""}</span>
        <button class="btn" data-borrar="${p.n}">Borrar</button></li>`).join("")}</ul>`
    : `<p class="vacio">Aún no agregaste suministros.<br>Usa “Agregar suministro nuevo” en el menú.</p>`);

  document.querySelectorAll("#hoja-cuerpo li[data-n]").forEach((li) => {
    li.onclick = (e) => {
      if (e.target.dataset.borrar) return;
      cerrarHoja(); activarVista("buscar"); seleccionar(li.dataset.n);
    };
  });
  document.querySelectorAll("#hoja-cuerpo [data-borrar]").forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.borrar;
      if (!confirm(`¿Borrar el suministro ${n} que agregaste?`)) return;
      propios = propios.filter((p) => p.n !== n);
      guardar(CLAVE_PROPIOS, propios);
      if (indice.get(n)?.c === "nuevo") {
        indice.delete(n);
        datos.suministros = datos.suministros.filter((s) => s.n !== n);
        ruta = ruta.filter((x) => x !== n);
        guardar(CLAVE_RUTA, ruta);
        pintarRuta();
      }
      hojaMisPuntos();
    };
  });
  if (propios.length) $("#m-exportar").onclick = exportarPropios;
}

/** Descarga un CSV (se abre en Excel) para enviar los suministros nuevos a la oficina. */
function exportarPropios() {
  descargarCsv(`suministros-nuevos-${hoyISO()}.csv`, ["suministro", "latitud", "longitud", "referencia", "agregado_por", "fecha"],
    propios.map((p) => [p.n, p.lat, p.lng, p.nota, p.por, new Date(p.fecha).toLocaleString("es-PE")]));
}

function descargarCsv(nombre, cabecera, filas) {
  const csv = [cabecera, ...filas].map((f) => f.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

pintarCabeceraMenu();

if (usuarioActual) alEntrar(); // la sesión se resolvió antes de que cargara este archivo
