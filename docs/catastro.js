"use strict";
// Manzanas, lotes, calles y pueblos del catastro público de COFOPRI sobre el mapa (datos en data/catastro,
// generados con extraer/catastro.py). Se bajan por zonas de ~1 km, solo las que se ven, y quedan guardadas
// para usarlas sin señal. También da la Mz/Lt aproximada de un suministro (ficha).
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
  controlCapas.addOverlay(capa, "Mz, lotes y calles (COFOPRI)"); // apagada al iniciar: se prende desde las capas

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

})();
