"use strict";
// Menú de la esquina: usuario, suministros agregados a mano y búsquedas del día.
// Todo se guarda en el propio celular (localStorage). Usa las funciones y variables globales de app.js.

const CLAVE_USUARIO = "usuario";
const CLAVE_PROPIOS = "suministros-propios";
const CLAVE_HISTORIAL = "historial-busquedas";
const COLOR_NUEVO = "#7b1fa2";

let usuario = leer(CLAVE_USUARIO, "");
let propios = leer(CLAVE_PROPIOS, []);   // [{n, lat, lng, nota, por, fecha, c: "nuevo"}]

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
  $("#cuenta-historial").textContent = historialDeHoy().length || "";
  $("#saludo").textContent = usuario ? `· ${usuario.split(" ")[0]}` : "";
}

// ---------- Usuario ----------
function hojaUsuario() {
  abrirHoja("Usuario", `
    <label class="campo">Nombre de quien usa la app
      <input id="u-nombre" type="text" autocomplete="name" maxlength="60" value="${escapar(usuario)}" placeholder="Ej.: Celina Guerra">
    </label>
    <p class="nota">Se usa para identificar quién agregó cada suministro nuevo. Se guarda solo en este celular.</p>
    <div class="fila"><button id="u-guardar" class="btn primario">Guardar</button></div>`);
  $("#u-guardar").onclick = () => {
    usuario = $("#u-nombre").value.trim();
    guardar(CLAVE_USUARIO, usuario);
    pintarCabeceraMenu();
    cerrarHoja();
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
      <input id="a-numero" type="text" inputmode="numeric" maxlength="6" value="${escapar(b.n)}" placeholder="3 a 6 cifras">
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
    <p class="nota">Se guarda en este celular${usuario ? ` a nombre de ${escapar(usuario)}` : ""} y aparece en el mapa en morado.</p>`);

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
  $("#a-mapa").onclick = () => { leerFormulario(); elegirEnMapa(); };
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
    dibujarTodos();
    cerrarHoja();
    activarVista("buscar");
    seleccionar(s.n);
  };
}

function validar(b) {
  if (!/^\d{3,6}$/.test(b.n)) return "El número debe tener de 3 a 6 cifras.";
  const existe = indice.get(b.n);
  if (existe) return existe.c === "nuevo"
    ? `El ${b.n} ya lo agregaste antes.`
    : `El ${b.n} ya existe en el plano (página ${existe.p}).`;
  if (b.lat == null) return "Falta la ubicación: usa tu GPS o elige el punto en el mapa.";
  return null;
}

function elegirEnMapa() {
  cerrarHoja();
  activarVista("buscar");
  document.body.classList.add("eligiendo");
  $("#aviso-mapa").hidden = false;
  const terminar = () => {
    document.body.classList.remove("eligiendo");
    $("#aviso-mapa").hidden = true;
    mapa.off("click", alTocar);
  };
  const alTocar = (e) => {
    terminar();
    hojaAgregar({ ...borrador, lat: e.latlng.lat, lng: e.latlng.lng });
  };
  mapa.on("click", alTocar);
  $("#aviso-cancelar").onclick = () => { terminar(); hojaAgregar(borrador); };
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
        dibujarTodos();
        pintarRuta();
      }
      hojaMisPuntos();
    };
  });
  if (propios.length) $("#m-exportar").onclick = exportarPropios;
}

/** Descarga un CSV (se abre en Excel) para enviar los suministros nuevos a la oficina. */
function exportarPropios() {
  const filas = [["suministro", "latitud", "longitud", "referencia", "agregado_por", "fecha"],
    ...propios.map((p) => [p.n, p.lat, p.lng, p.nota, p.por, new Date(p.fecha).toLocaleString("es-PE")])];
  const csv = filas.map((f) => f.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `suministros-nuevos-${hoyISO()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

pintarCabeceraMenu();
