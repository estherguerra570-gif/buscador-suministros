"use strict";
// Subestaciones (SED) del plano: buscar por número, verlas en el mapa y la SED más cercana de cada suministro.
// Datos en data/sed.json (generado con extraer/sed.py desde el plano y la "RELACION SED MODULAR BT").
// Usa las globales de app.js (mapa, controlCapas, $, seleccionActual, marcadorSeleccion, trazarCamino, ...).

(() => {
  const ZOOM_CAPA = 15.5;        // de más lejos los triángulos se amontonan
  const MAX_EN_PANTALLA = 400;
  const SED_LEJOS_M = 600;       // más lejos que esto no se muestra como "SED cercana"

  let modo = "suministro";       // qué busca el buscador: "suministro" o "sed"
  let lista = null;              // [{n, lat, lng, kva, p, px, py, d, m, tipo:"sed"}]
  const porNumero = new Map();

  const cargar = () => (cargar.p ??= fetch("data/sed.json").then((r) => r.json()).then((j) => {
    lista = j.n.map((n, i) => ({
      tipo: "sed", n, lat: +(j.base[0] + j.la[i] / 1e6).toFixed(6), lng: +(j.base[1] + j.lo[i] / 1e6).toFixed(6),
      kva: j.kva[i], p: j.p[i], px: j.px[i], py: j.py[i], d: j.d[i], m: j.m[i],
    }));
    for (const s of lista) porNumero.set(s.n, s);
    dibujar();
    return lista;
  }).catch(() => { cargar.p = null; return null; }));   // se baja recién al usarla (buscar, ficha o capa)

  // ---------- Buscar SED: desde el menú (☰ > Buscar SED); el buscador pasa a buscar SED ----------
  window.modoSed = () => modo === "sed";
  function ponerModo(m, limpiar = false) {
    modo = m;
    $("#modo-sed").hidden = m !== "sed";
    const t = m === "sed" ? "Número de SED…" : "Número de suministro…";
    $("#buscador").placeholder = t;
    $("#buscador").setAttribute("aria-label", t);
    if (!limpiar) return;
    $("#buscador").value = "";
    $("#ficha").hidden = true;
    $("#resultados").innerHTML = "";
    seleccionActual = null;
    detenerNavegacion();
    if (marcadorSeleccion) { marcadorSeleccion.remove(); marcadorSeleccion = null; }
    $("#buscador").focus();
  }
  HOJAS["buscar-sed"] = () => { activarVista("buscar"); ponerModo("sed", true); };
  $("#salir-sed").onclick = () => ponerModo("suministro", true);
  window.salirSed = () => { if (modo === "sed") ponerModo("suministro"); }; // al abrir un suministro desde otro lado

  /** Sugerencias mientras se escribe (en modo SED). */
  window.buscarSed = async (q) => {
    const ul = $("#resultados");
    if (!(await cargar())) {
      ul.innerHTML = `<li><span class="info">No se pudo cargar la lista de SED. Revisa la señal.</span></li>`;
      return [];
    }
    if ($("#buscador").value.replace(/\D/g, "") !== q) return [];
    const exactos = [], empiezan = [], contienen = [];
    for (const s of lista) {
      if (s.n === q) exactos.push(s);
      else if (s.n.startsWith(q)) empiezan.push(s);
      else if (s.n.includes(q)) contienen.push(s);
    }
    const res = [...exactos, ...empiezan, ...contienen];
    ul.innerHTML = res.length ? "" : `<li><span class="info">No se encontró la SED “${q}” en el plano.</span></li>`;
    for (const s of res.slice(0, 30)) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="tri-sed">▲</span><span class="num">SED ${s.n}</span>
        <span class="info">${s.kva ? s.kva + " kVA · " : ""}${escapar(s.d || "Página " + s.p)}</span>`;
      li.onclick = () => abrir(s.n);
      ul.appendChild(li);
    }
    return res;
  };

  /** Botón "Ver ruta" en modo SED: la exacta, o la única parecida. */
  window.ejecutarBusquedaSed = async (q) => {
    await cargar();
    if (porNumero.has(q)) return abrir(q);
    const res = await window.buscarSed(q);
    if (res.length === 1) abrir(res[0].n);
  };

  const icono = (n) => L.divIcon({
    className: "", iconSize: null,
    html: `<div class="marca-sed"><span class="tri-sed">▲</span><b>${escapar(n)}</b></div>`,
  });

  function abrir(n) {
    const s = porNumero.get(n);
    if (!s) return;
    seleccionActual = n;
    $("#buscador").value = n;
    $("#resultados").innerHTML = "";
    if (marcadorSeleccion) marcadorSeleccion.remove();
    marcadorSeleccion = L.marker([s.lat, s.lng]).addTo(mapa)
      .bindTooltip(`SED ${s.n}`, { permanent: true, direction: "top", offset: [-15, -12] });
    plegarPanel(true, `SED ${s.n}`);
    mapa.setView([s.lat, s.lng], 18);
    anotar("buscar", `SED ${s.n}`);
    const f = $("#ficha");
    f.hidden = false;
    f.innerHTML = `
      <h2><span class="tri-sed">▲</span>SED ${escapar(s.n)}</h2>
      <p id="f-recorrido" class="recorrido gris">Calculando recorrido desde tu ubicación…</p>
      <div id="f-rutas" class="opciones-ruta" hidden></div>
      <dl>
        ${s.kva ? `<dt>Potencia</dt><dd>${escapar(s.kva)} kVA</dd>` : ""}
        ${s.d ? `<dt>Dirección</dt><dd>${escapar(s.d)}</dd>` : ""}
        ${s.m ? `<dt>Modular</dt><dd>${escapar(s.m)}</dd>` : ""}
        <dt>Página</dt><dd>${s.p}</dd>
        <dt>GPS</dt><dd>${s.lat}, ${s.lng}</dd>
      </dl>
      <div class="fila"><button class="btn" id="f-plano">Ver en el plano</button></div>
      <div class="fila">
        <a class="btn navegar" style="margin:0" href="${urlIr(s)}" target="_blank" rel="noopener">Ir con Google Maps</a>
      </div>`;
    $("#f-plano").onclick = () => abrirPlano(s);
    trazarCamino(s);
  }

  // ---------- Capa del mapa: triángulos con el número de cada SED ----------
  const capa = L.layerGroup();
  controlCapas.addOverlay(capa, "SED (subestaciones)"); // apagada al iniciar: se prende desde las capas
  const marcas = new Map();
  function dibujar() {
    if (!lista || !mapa.hasLayer(capa)) return;
    if (mapa.getZoom() < ZOOM_CAPA) return capa.clearLayers();
    const b = mapa.getBounds().pad(0.2);
    const visibles = lista.filter((s) => b.contains([s.lat, s.lng]));
    if (visibles.length > MAX_EN_PANTALLA) return capa.clearLayers();
    const quedan = new Set(visibles.map((s) => s.n));
    capa.eachLayer((m) => { if (!quedan.has(m.options.sed)) capa.removeLayer(m); });
    for (const s of visibles) {
      if (!marcas.has(s.n)) {
        marcas.set(s.n, L.marker([s.lat, s.lng], { icon: icono(s.n), sed: s.n, keyboard: false })
          .on("click", () => { activarVista("buscar"); ponerModo("sed"); abrir(s.n); }));
      }
      const m = marcas.get(s.n);
      if (!capa.hasLayer(m)) capa.addLayer(m);
    }
  }
  mapa.on("moveend overlayadd", () => { if (lista) dibujar(); else if (mapa.hasLayer(capa)) cargar(); });

  // ---------- SED más cercana a un punto (ficha del suministro) ----------
  window.sedCercana = async (lat, lng) => {
    if (!(await cargar())) return null;
    let mejor = null, dmin = Infinity;
    for (const s of lista) {
      const d = dist({ lat, lng }, s);
      if (d < dmin) { dmin = d; mejor = s; }
    }
    return mejor && dmin <= SED_LEJOS_M ? { ...mejor, metros: Math.round(dmin) } : null;
  };
})();
