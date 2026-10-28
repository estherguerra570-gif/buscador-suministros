"use strict";
// Menú de la esquina: usuario, suministros agregados a mano y búsquedas del día.
// Se guarda en el propio celular (localStorage), salvo las ubicaciones corregidas, que van al sistema para todos.
// Usa las funciones y variables globales de app.js.

const CLAVE_USUARIO = "usuario";
const CLAVE_PROPIOS = "suministros-propios";
const CLAVE_HISTORIAL = "historial-busquedas";
const CLAVE_CORRECCIONES = "ubicaciones-corregidas"; // pendientes de enviar al sistema
const CLAVE_EQUIPO = "clave-equipo";
const COLOR_NUEVO = "#7b1fa2";

let usuario = leer(CLAVE_USUARIO, "");
let propios = leer(CLAVE_PROPIOS, []);   // [{n, lat, lng, nota, por, fecha, c: "nuevo"}]
let pendientes = leer(CLAVE_CORRECCIONES, {}); // {numero: {lat, lng, nota, por, fecha} | {borrar: true}} sin enviar aún
let claveEquipo = leer(CLAVE_EQUIPO, "");

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
  "mis-puntos": hojaMisPuntos,
  ruta: () => { activarVista("ruta"); setTimeout(() => $("#numero-ruta").focus(), 50); },
};
document.querySelectorAll(".menu-item").forEach((b) => {
  b.onclick = () => { cerrarMenu(); HOJAS[b.dataset.hoja](); };
});

function pintarCabeceraMenu() {
  $("#menu-nombre").textContent = usuario || "Sin nombre";
  $("#menu-avatar").textContent = usuario ? usuario.trim()[0].toUpperCase() : "?";
  $("#menu-fecha").textContent = new Date().toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" });
  $("#cuenta-propios").textContent = propios.length || "";
  const sinEnviar = Object.keys(pendientes).length;
  $("#cuenta-corregidos").textContent = sinEnviar ? `⏳ ${sinEnviar}` : "";
  $("#cuenta-historial").textContent = historialDeHoy().length || "";
  $("#saludo").textContent = usuario ? `· ${usuario.split(" ")[0]}` : "";
}

// ---------- Usuario ----------
function hojaUsuario() {
  abrirHoja("Usuario", `
    <label class="campo">Nombre de quien usa la app
      <input id="u-nombre" type="text" autocomplete="name" maxlength="60" value="${escapar(usuario)}" placeholder="Ej.: Celina Guerra">
    </label>
    <p class="nota">Se usa para identificar quién agregó o corrigió cada suministro.</p>
    <label class="campo">Clave del equipo
      <input id="u-clave" type="password" autocomplete="off" maxlength="60" value="${escapar(claveEquipo)}" placeholder="La entrega la oficina">
    </label>
    <p class="nota">Hace falta para corregir ubicaciones para todos los usuarios.</p>
    <div class="fila"><button id="u-guardar" class="btn primario">Guardar</button></div>`);
  $("#u-guardar").onclick = async () => {
    usuario = $("#u-nombre").value.trim();
    claveEquipo = $("#u-clave").value.trim();
    guardar(CLAVE_USUARIO, usuario);
    guardar(CLAVE_EQUIPO, claveEquipo);
    pintarCabeceraMenu();
    cerrarHoja();
    if (Object.keys(pendientes).length) {
      const problema = await sincronizarPendientes();
      avisar(problema ? `Correcciones sin enviar: ${problema.error}.` : "✓ Correcciones pendientes enviadas a todos.", !problema);
    }
  };
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
// Las correcciones se guardan en el sistema (api/correcciones en Vercel, que las escribe en
// docs/data/correcciones.json del repositorio) y todos los celulares las aplican al abrir la app.
// Sin señal o sin clave quedan "pendientes" en este celular y se envían solas en cuanto se pueda.
const API_CORRECCIONES = location.hostname.endsWith("vercel.app")
  ? "/api/correcciones"
  : "https://buscador-suministros.vercel.app/api/correcciones";

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
  for (const url of [API_CORRECCIONES, "data/correcciones.json"]) {
    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout?.(5000) }); // con mala señal no frena la app
      if (r.ok) { compartidas = await r.json(); return true; }
    } catch { /* se prueba con la siguiente */ }
  }
  return false;
}

/** Al cargar la app (app.js). */
async function aplicarCorrecciones() {
  await descargarCompartidas();
  aplicarTodas();
  sincronizarPendientes();
}

/** Al volver a la app se traen las correcciones que hicieron los demás. */
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !datos) return;
  await sincronizarPendientes();
  if (await descargarCompartidas()) { aplicarTodas(); refrescarTrasMover(); }
});

/** Envía al sistema una corrección (c) o el regreso a la ubicación del plano (c = null). */
async function enviarCorreccion(n, c) {
  try {
    const r = await fetch(API_CORRECCIONES, {
      method: c ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clave: claveEquipo, n, por: usuario, ...(c ? { lat: c.lat, lng: c.lng, nota: c.nota } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, correccion: j.correccion } : { ok: false, codigo: r.status, error: j.error || `Error ${r.status}` };
  } catch {
    return { ok: false, codigo: 0, error: "Sin conexión" };
  }
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
  let problema = null;
  for (const [n, p] of Object.entries(pendientes)) {
    if (!claveEquipo) { problema = { codigo: 401, error: "Falta la clave del equipo" }; break; }
    const r = await enviarCorreccion(n, p.borrar ? null : p);
    if (!r.ok) {
      problema = r;
      if (r.codigo === 400) { delete pendientes[n]; continue; } // dato inválido: no tiene sentido reintentar
      break; // sin señal, clave mala o el sistema no responde: se reintenta más tarde
    }
    if (p.borrar) delete compartidas[n]; else compartidas[n] = r.correccion ?? p;
    delete pendientes[n];
  }
  guardar(CLAVE_CORRECCIONES, pendientes);
  pintarCabeceraMenu();
  return problema;
}

function mensajeEnvio(problema, n) {
  if (!problema) return `✓ Suministro ${n} corregido para todos.`;
  if (problema.codigo === 401) return `Guardado en este celular. ${problema.error}: ponla en el menú → Usuario y se enviará sola.`;
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
