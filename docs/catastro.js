"use strict";
// Manzanas, lotes, calles y pueblos del catastro público de COFOPRI sobre el mapa (datos en data/catastro,
// generados con extraer/catastro.py). Se bajan por zonas de ~1 km, solo las que se ven, y quedan guardadas
// para usarlas sin señal. También: buscar por dirección (pueblo + Mz + Lt) y la Mz/Lt de un suministro.
// Usa las globales de app.js (mapa, controlCapas, $...) y menu.js (abrirHoja, HOJAS, escapar).

(() => {
  // de lejos solo los pueblos; al acercarse, manzanas; más cerca, calles y lotes (si no, los textos se tapan)
  const ZOOM_PUEBLOS = 15, ZOOM_SIN_PUEBLOS = 16.5, ZOOM_MANZANAS = 16.5, ZOOM_CALLES = 17.8, ZOOM_LOTES = 18.5;
  const MAX_ZONAS = 16;          // más que esto en pantalla: demasiados textos, no se dibuja
  const RADIO_LOTE_M = 25;       // la Mz/Lt de un suministro: lote a menos de esto

  let info = null;               // data/catastro/info.json
  const zonas = new Map();       // clave -> Promise<zona | null>
  const capa = L.layerGroup();
  const capas = new Map();       // `${tipo}:${zona}` -> L.LayerGroup
  controlCapas.addOverlay(capa, "Mz, lotes y calles (COFOPRI)");
  capa.addTo(mapa);

  const cargarInfo = () => (info ??= fetch("data/catastro/info.json").then((r) => r.json()).catch(() => { info = null; return null; }));

  function zona(k) {
    if (!zonas.has(k)) {
      zonas.set(k, cargarInfo().then((i) => (i && i.zonas.includes(k)
        ? fetch(`data/catastro/${k}.json`).then((r) => (r.ok ? r.json() : null)).then((z) => z && desplegar(z, i))
        : null)).catch(() => { setTimeout(() => zonas.delete(k), 60000); return null; }));
    }
    return zonas.get(k);
  }
  // de enteros (~1 m) a grados
  function desplegar(z, i) {
    const p = (y, x) => [i.base[0] + y / i.escala, i.base[1] + x / i.escala];
    return {
      h: z.h.map(([y, x, n]) => [p(y, x), z.n[n]]),
      m: z.m.map(([y, x, mz]) => [p(y, x), mz]),
      l: z.l.map(([y, x, lt, mz, n]) => [p(y, x), lt, mz, n >= 0 ? z.n[n] : ""]),
      v: z.v.map(([y, x, ang, nombre]) => [p(y, x), ang, nombre]),
    };
  }

  const etiqueta = (pos, html, clase, giro = 0) => L.marker(pos, {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: "", iconSize: null, html: `<div class="cat ${clase}" style="${giro ? `--giro:${giro}deg` : ""}">${html}</div>` }),
  });

  function capaDe(tipo, k, z) {
    const clave = `${tipo}:${k}`;
    if (!capas.has(clave)) {
      const g = L.layerGroup();
      if (tipo === "h") for (const [pos, n] of z.h) etiqueta(pos, escapar(n), "cat-pueblo").addTo(g);
      if (tipo === "m") for (const [pos, mz] of z.m) etiqueta(pos, `Mz ${escapar(mz)}`, "cat-mz").addTo(g);
      if (tipo === "l") for (const [pos, lt] of z.l) etiqueta(pos, escapar(lt), "cat-lt").addTo(g);
      if (tipo === "v") for (const [pos, ang, n] of z.v) etiqueta(pos, escapar(n), "cat-calle", ang).addTo(g);
      capas.set(clave, g);
    }
    return capas.get(clave);
  }

  let version = 0;
  async function dibujar() {
    const v = ++version;
    const z = mapa.getZoom();
    if (!mapa.hasLayer(capa) || z < ZOOM_PUEBLOS) return sincronizar(capa, []);
    const claves = zonasEnPantalla();
    if (claves.length > MAX_ZONAS) return sincronizar(capa, []);
    const datos = await Promise.all(claves.map(zona));
    if (v !== version) return;
    const grupos = [];
    claves.forEach((k, i) => {
      const d = datos[i];
      if (!d) return;
      if (z < ZOOM_SIN_PUEBLOS) grupos.push(capaDe("h", k, d));
      if (z >= ZOOM_CALLES) grupos.push(capaDe("v", k, d));
      if (z >= ZOOM_MANZANAS) grupos.push(capaDe("m", k, d));
      if (z >= ZOOM_LOTES) grupos.push(capaDe("l", k, d));
    });
    sincronizar(capa, grupos);
  }
  // los nombres de calle giran con el mapa para seguir la calle
  const girar = () => document.documentElement.style.setProperty("--rumbo", `${mapa.getBearing?.() ?? 0}deg`);
  mapa.on("moveend overlayadd", dibujar);
  mapa.on("rotate", girar);
  girar();
  dibujar();

  // ---------- Mz y lote de un suministro ----------
  const metros = (a, b) => Math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
  window.direccionCercana = async (lat, lng) => {
    const i = await cargarInfo();
    if (!i) return null;
    const y = Math.floor(lat / i.zona_grados), x = Math.floor(lng / i.zona_grados);
    const vecinas = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) vecinas.push(`${y + dy}_${x + dx}`);
    let mejor = null, dist = RADIO_LOTE_M;
    for (const z of await Promise.all(vecinas.map(zona))) {
      for (const [pos, lt, mz, pueblo] of z?.l ?? []) {
        const d = metros(pos, [lat, lng]);
        if (d < dist) { dist = d; mejor = { lt, mz, pueblo }; }
      }
    }
    return mejor;
  };

  // ---------- Buscar por dirección ----------
  const normal = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/\b(MZ|MZA|LT|LOTE|MANZANA|URB|AAHH|AA\.HH|PJV|CP|ASOC|PBL|TRAD|SECT|SECTOR|N[°º]?)\b\.?/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const limpiarCodigo = (t) => String(t ?? "").toUpperCase().replace(/^(MZ|MZA|LT|LOTE)\.?\s*/, "").replace(/\s+/g, "").replace(/^0+(?=\d)/, "");

  async function hojaDireccion() {
    abrirHoja("Buscar por dirección", `
      <p class="nota">Escribe el pueblo o urbanización y la manzana y el lote, como en la hoja. Datos del catastro de COFOPRI.</p>
      <label class="campo">Pueblo o urbanización
        <input id="dir-pueblo" list="dir-pueblos" autocomplete="off" placeholder="Ej.: Túpac Amaru, Pachacútec zona H…">
      </label>
      <datalist id="dir-pueblos"></datalist>
      <div class="fila">
        <label class="campo">Manzana <input id="dir-mz" autocomplete="off" placeholder="Ej.: E" maxlength="6"></label>
        <label class="campo">Lote <input id="dir-lt" autocomplete="off" inputmode="numeric" placeholder="Ej.: 14" maxlength="6"></label>
      </div>
      <button class="btn primario" id="dir-buscar">Buscar</button>
      <div id="dir-resultados"></div>`);
    const i = await cargarInfo();
    if (!i) { $("#dir-resultados").innerHTML = `<p class="vacio">Sin señal: no se pudo bajar el catastro.</p>`; return; }
    $("#dir-pueblos").innerHTML = i.pueblos.slice(0, 2000).map((p) => `<option value="${escapar(p[0])}">`).join("");
    const buscarYa = () => buscarDireccion($("#dir-pueblo").value, $("#dir-mz").value, $("#dir-lt").value);
    $("#dir-buscar").onclick = buscarYa;
    ["#dir-pueblo", "#dir-mz", "#dir-lt"].forEach((s) => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") buscarYa(); }));
    $("#dir-pueblo").focus();
  }

  async function buscarDireccion(textoPueblo, mzTexto, ltTexto) {
    const salida = $("#dir-resultados");
    const mz = limpiarCodigo(mzTexto), lt = limpiarCodigo(ltTexto);
    if (!mz && !lt) { salida.innerHTML = `<p class="nota alerta">Escribe al menos la manzana o el lote.</p>`; return; }
    salida.innerHTML = `<p class="vacio">Buscando…</p>`;
    const i = await cargarInfo();
    const palabras = normal(textoPueblo).split(" ").filter(Boolean);
    const coinciden = (nombre) => palabras.every((p) => normal(nombre).split(" ").some((w) => w.startsWith(p)));

    // zonas donde buscar: las de los pueblos que coinciden, o las que se ven en pantalla si no escribió pueblo
    const claves = new Set();
    const pueblos = palabras.length ? i.pueblos.filter((p) => coinciden(p[0])) : [];
    if (palabras.length && !pueblos.length) {
      salida.innerHTML = `<p class="vacio">No hay ningún pueblo o urbanización con “${escapar(textoPueblo)}”. Prueba con menos palabras.</p>`;
      return;
    }
    if (pueblos.length > 40) {
      salida.innerHTML = `<p class="vacio">Hay ${pueblos.length} pueblos con ese nombre. Escribe algo más (por ejemplo la zona o el sector).</p>`;
      return;
    }
    for (const [, y0, x0, y1, x1] of pueblos) {
      const a = (v, b) => Math.floor((b + v / i.escala) / i.zona_grados);
      for (let y = a(y0, i.base[0]); y <= a(y1, i.base[0]); y++)
        for (let x = a(x0, i.base[1]); x <= a(x1, i.base[1]); x++) claves.add(`${y}_${x}`);
    }
    if (!palabras.length) zonasEnPantalla().forEach((k) => claves.add(k));
    if (claves.size > 60) { salida.innerHTML = `<p class="vacio">Escribe el nombre del pueblo para buscar.</p>`; return; }

    const hallados = [];
    for (const z of await Promise.all([...claves].map(zona))) {
      for (const [pos, l, m, pueblo] of z?.l ?? []) {
        if ((mz && limpiarCodigo(m) !== mz) || (lt && limpiarCodigo(l) !== lt)) continue;
        if (palabras.length && !coinciden(pueblo)) continue;
        hallados.push({ pos, lt: l, mz: m, pueblo });
      }
    }
    if (!hallados.length) {
      salida.innerHTML = `<p class="vacio">No se encontró${mz ? ` la Mz ${escapar(mz)}` : ""}${lt ? ` lote ${escapar(lt)}` : ""}${palabras.length ? " en ese pueblo" : " en lo que se ve del mapa"}.</p>`;
      return;
    }
    salida.innerHTML = `<ul class="lista">${hallados.slice(0, 30).map((h, k) => `
      <li><button class="btn ancho dir-ir" data-k="${k}"><b>Mz ${escapar(h.mz || "?")} Lt ${escapar(h.lt)}</b><br><span class="nota">${escapar(h.pueblo || "Pueblo sin nombre")}</span></button></li>`).join("")}</ul>
      ${hallados.length > 30 ? `<p class="nota">Y ${hallados.length - 30} más. Escribe el pueblo para acotar.</p>` : ""}`;
    salida.querySelectorAll(".dir-ir").forEach((b) => {
      b.onclick = () => {
        const h = hallados[b.dataset.k];
        cerrarHoja();
        activarVista("buscar");
        mapa.setView(h.pos, 19);
        L.circleMarker(h.pos, { radius: 16, color: "#7b1fa2", weight: 3, fillOpacity: 0.12 })
          .bindTooltip(`Mz ${h.mz} Lt ${h.lt}`, { permanent: true, direction: "top" }).addTo(mapa);
      };
    });
  }

  HOJAS.direccion = hojaDireccion;
})();
