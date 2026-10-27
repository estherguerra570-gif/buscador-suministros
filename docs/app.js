"use strict";

// ---------- Estado ----------
const MAX_PARADAS_TRAMO = 9; // Google Maps acepta destino + ~8 paradas intermedias por enlace
const CLAVE_RUTA = "ruta-del-dia";
const CLAVE_VISITADOS = "visitados";
const CLAVE_PARTIDA = "partida";       // "gps" o numero de suministro
const CLAVE_DESTINO = "destino";       // "" (libre) o numero de suministro
const CLAVE_INICIO = "inicio-ruta";    // {lat, lng} desde donde se calculo la ruta
const CLAVE_FONDO = "fondo-mapa";
const PENALIDAD_RECTA = 1.4;           // sin calle en el plano: se estima la recta * 1.4
const VELOCIDAD_MOTO_MS = 20 / 3.6;    // velocidad media en moto dentro de la zona (20 km/h)

let datos = null;            // índice de suministros (data/indice.json)
let indice = new Map();      // numero -> suministro
let paginas = new Map();     // pagina -> info del plano
let ruta = leer(CLAVE_RUTA, []);            // numeros en orden de visita
let visitados = new Set(leer(CLAVE_VISITADOS, []));
let miPosicion = null;       // {lat, lng}
let inicioRuta = leer(CLAVE_INICIO, null);
let seleccionActual = null;  // suministro abierto en la vista Buscar
let versionPintado = 0;     // descarta respuestas de OSRM de un trazado anterior
let grafo = null;           // red de calles del plano: {n: [{lat,lng}], ady: [[[vecino, metros]]]}

const $ = (s) => document.querySelector(s);

function leer(clave, defecto) {
  try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; }
}
function guardar(clave, valor) {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin almacenamiento */ }
}

// ---------- Mapa ----------
const mapa = L.map("mapa", { zoomControl: false }).setView([-16.2522, -71.6802], 15);
L.control.zoom({ position: "topleft" }).addTo(mapa);
const lienzo = L.canvas({ padding: 0.5 });
const fondos = {
  "Mapa + calles del plano": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20, maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
  "Solo calles del plano": L.layerGroup(),
};
const capaManzanas = L.layerGroup();
const capaRedBT = L.layerGroup();
mapa.options.maxZoom = 20;
const fondoGuardado = leer(CLAVE_FONDO, "Mapa + calles del plano");
(fondos[fondoGuardado] ?? fondos["Mapa + calles del plano"]).addTo(mapa);
capaManzanas.addTo(mapa);
L.control.layers(fondos, { "Manzanas del plano": capaManzanas, "Red eléctrica (BT)": capaRedBT },
  { position: "topright" }).addTo(mapa);
mapa.on("baselayerchange", (e) => guardar(CLAVE_FONDO, e.name));

const capaTodos = L.layerGroup().addTo(mapa);
const capaRuta = L.layerGroup().addTo(mapa);
const capaCamino = L.layerGroup().addTo(mapa); // recorrido hasta el suministro buscado
let marcadorSeleccion = null;
let marcadorYo = null;

const colorDe = (s) => ({ naranja: "#a87000", nuevo: "#7b1fa2" }[s.c] ?? "#267300");

// ---------- Zonas: el detalle (calles, red, postes) se descarga por zonas de ~1 km, solo las que se usan ----------
const ZOOM_SUMINISTROS = 17;       // desde este zoom se ven los puntos de suministro
const ZOOM_PLANO = 15;             // desde este zoom se ven manzanas y red
let ZONA_GRADOS = 0.01;            // se toma de indice.json
const claveZona = (lat, lng) => `${Math.floor(lat / ZONA_GRADOS)}_${Math.floor(lng / ZONA_GRADOS)}`;
let celdasSuministros = new Map(); // zona -> suministros (para dibujar)
const zonas = new Map();           // zona -> Promise<{m: manzanas, r: tramos de red}>
const zonasListas = new Set();
const capaHojas = L.layerGroup().addTo(mapa); // contorno de cada página del plano (zoom lejano)

function indexarSuministros() {
  celdasSuministros = new Map();
  for (const s of datos.suministros) {
    const k = claveZona(s.lat, s.lng);
    if (!celdasSuministros.has(k)) celdasSuministros.set(k, []);
    celdasSuministros.get(k).push(s);
  }
}

function dibujarHojas() {
  for (const p of datos.paginas) {
    L.rectangle([[p.sur, p.oeste], [p.norte, p.este]], { renderer: lienzo, color: "#1f6f43", weight: 1, fillOpacity: 0.06 })
      .bindTooltip(`Página ${p.p}`).on("click", (e) => mapa.setView(e.latlng, ZOOM_SUMINISTROS)).addTo(capaHojas);
  }
}

/** Descarga (una sola vez) el detalle de una zona y suma su red al grafo de rutas. */
function cargarZona(k) {
  if (!zonas.has(k)) {
    zonas.set(k, fetch(`data/zonas/${k}.json`)
      .then((r) => (r.ok ? r.json() : { s: {}, m: [], r: [] }))
      .then((z) => {
        for (const [n, [poste, px, py, nodo]] of Object.entries(z.s)) {
          const s = indice.get(n);
          if (s) Object.assign(s, { poste, px, py, nodoClave: nodo ? `${nodo[0]},${nodo[1]}` : null });
        }
        const manzanas = z.m.map((m) => { const pts = []; for (let i = 0; i < m.length; i += 2) pts.push([m[i], m[i + 1]]); return pts; });
        const red = z.r.map(([a, b, c, d]) => [[a, b], [c, d]]);
        for (const [[a, b], [c, d]] of red) unirNodos(nodoId(a, b), nodoId(c, d));
        cacheDijkstra.clear();
        zonasListas.add(k);
        return { m: manzanas, r: red };
      })
      .catch(() => {
        // sin señal: se da por vacía y se reintenta en un minuto
        zonasListas.add(k);
        setTimeout(() => { zonas.delete(k); zonasListas.delete(k); }, 60000);
        return { m: [], r: [] };
      }));
  }
  return zonas.get(k);
}

/** Zonas necesarias para unas paradas: la de cada una y sus vecinas; si están cerca, todo el rectángulo que las une. */
function zonasPara(puntos) {
  const ys = puntos.map((p) => Math.floor(p.lat / ZONA_GRADOS)), xs = puntos.map((p) => Math.floor(p.lng / ZONA_GRADOS));
  const claves = new Set();
  const y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1, x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1;
  if ((y1 - y0 + 1) * (x1 - x0 + 1) <= 64) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) claves.add(`${y}_${x}`);
  } else {
    puntos.forEach((_, i) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) claves.add(`${ys[i] + dy}_${xs[i] + dx}`); });
  }
  return [...claves];
}
const zonasCargadas = (puntos) => zonasPara(puntos).every((k) => zonasListas.has(k));
const asegurarZonas = (puntos) => Promise.all(zonasPara(puntos.filter(Boolean)).map(cargarZona));

function zonasEnPantalla() {
  const b = mapa.getBounds();
  const claves = [];
  for (let y = Math.floor(b.getSouth() / ZONA_GRADOS); y <= Math.floor(b.getNorth() / ZONA_GRADOS); y++)
    for (let x = Math.floor(b.getWest() / ZONA_GRADOS); x <= Math.floor(b.getEast() / ZONA_GRADOS); x++) claves.push(`${y}_${x}`);
  return claves;
}

let versionDibujo = 0;
async function dibujarVisible() {
  if (!datos) return;
  const version = ++versionDibujo;
  const z = mapa.getZoom();
  capaHojas[z < ZOOM_PLANO ? "addTo" : "remove"](mapa);
  const claves = z >= ZOOM_PLANO ? zonasEnPantalla() : [];
  const detalle = claves.length <= 30 ? await Promise.all(claves.map(cargarZona)) : [];
  if (version !== versionDibujo) return; // el mapa se movió mientras se descargaba
  capaTodos.clearLayers();
  capaManzanas.clearLayers();
  capaRedBT.clearLayers();
  for (const zd of detalle) {
    for (const pts of zd.m) L.polyline(pts, { renderer: lienzo, color: "#4a4f4c", weight: 1.2, opacity: 0.8, interactive: false }).addTo(capaManzanas);
    if (mapa.hasLayer(capaRedBT)) {
      for (const l of zd.r) L.polyline(l, { renderer: lienzo, color: "#005ce6", weight: 1, opacity: 0.6, interactive: false }).addTo(capaRedBT);
    }
  }
  if (z >= ZOOM_SUMINISTROS) {
    const b = mapa.getBounds().pad(0.2);
    for (const k of claves) {
      for (const s of celdasSuministros.get(k) ?? []) {
        if (!b.contains([s.lat, s.lng])) continue;
        L.circleMarker([s.lat, s.lng], {
          renderer: lienzo, radius: 3, color: "#fff", weight: 0.5, fillColor: colorDe(s), fillOpacity: 0.95,
        }).on("click", () => seleccionar(s.n)).addTo(capaTodos);
      }
    }
  }
}
mapa.on("moveend", dibujarVisible);
mapa.on("overlayadd", dibujarVisible);

/** Vuelve a indexar y pintar los suministros (por ejemplo, tras agregar uno a mano). */
function dibujarTodos() {
  indexarSuministros();
  dibujarVisible();
}

// ---------- Red de calles del plano (rutas): crece a medida que se descargan zonas ----------
grafo = { n: [], ady: [], clave: new Map() };
function nodoId(lat, lng) {
  const k = `${lat},${lng}`;
  let i = grafo.clave.get(k);
  if (i === undefined) {
    i = grafo.n.length;
    grafo.n.push({ lat, lng });
    grafo.ady.push([]);
    grafo.clave.set(k, i);
  }
  return i;
}
function unirNodos(i, j) {
  if (i === j || grafo.ady[i].some(([v]) => v === j)) return;
  const d = dist(grafo.n[i], grafo.n[j]);
  grafo.ady[i].push([j, d]);
  grafo.ady[j].push([i, d]);
}

/** Nodo de acceso a la red: el que trae el plano para cada suministro, o el más cercano. */
function nodoDe(p) {
  if (p.nodoClave && grafo.clave.has(p.nodoClave)) return grafo.clave.get(p.nodoClave);
  if (p._nodoVersion !== grafo.n.length) { p._nodo = nodoCercano(p); p._nodoVersion = grafo.n.length; }
  return p._nodo;
}

const cacheDijkstra = new Map();
/** Distancias mínimas por la red desde un nodo (Dijkstra con montículo binario). */
function dijkstra(origen) {
  if (cacheDijkstra.has(origen)) return cacheDijkstra.get(origen);
  const N = grafo.n.length;
  const d = new Float64Array(N).fill(Infinity);
  const previo = new Int32Array(N).fill(-1);
  const monticulo = [[0, origen]];
  d[origen] = 0;
  while (monticulo.length) {
    const [du, u] = sacar(monticulo);
    if (du > d[u]) continue;
    for (const [v, w] of grafo.ady[u]) {
      if (du + w < d[v]) { d[v] = du + w; previo[v] = u; meter(monticulo, [d[v], v]); }
    }
  }
  const r = { d, previo };
  cacheDijkstra.set(origen, r);
  return r;
}
function meter(h, x) {
  h.push(x);
  for (let i = h.length - 1; i > 0;) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]]; i = p;
  }
}
function sacar(h) {
  const top = h[0], ult = h.pop();
  if (h.length) {
    h[0] = ult;
    for (let i = 0; ;) {
      const a = 2 * i + 1, b = a + 1;
      let m = i;
      if (a < h.length && h[a][0] < h[m][0]) m = a;
      if (b < h.length && h[b][0] < h[m][0]) m = b;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]]; i = m;
    }
  }
  return top;
}

/** Nodo de la red más cercano a un punto (para "Mi ubicación"). */
function nodoCercano(p, maxMetros = 300) {
  if (!grafo) return null;
  let mejor = null, dm = maxMetros;
  grafo.n.forEach((q, i) => { const d = dist(p, q); if (d < dm) { dm = d; mejor = i; } });
  return mejor;
}

/** Tramo entre dos paradas: por la red del plano si hay conexión; si no, en línea recta. */
function tramo(a, b) {
  const na = nodoDe(a), nb = nodoDe(b);
  if (na != null && nb != null) {
    const { d, previo } = dijkstra(na);
    if (Number.isFinite(d[nb])) {
      const camino = [];
      for (let v = nb; v !== -1; v = previo[v]) camino.push(grafo.n[v]);
      camino.reverse();
      const metros = dist(a, grafo.n[na]) + d[nb] + dist(grafo.n[nb], b);
      return { metros, puntos: [a, ...camino, b], porCalle: true };
    }
  }
  return { metros: dist(a, b) * PENALIDAD_RECTA, puntos: [a, b], porCalle: false };
}
const metrosTramo = (a, b) => tramo(a, b).metros;

// ---------- Tramos fuera del plano: calles de OpenStreetMap vía OSRM (gratis, sin registro) ----------
const cacheOsrm = new Map();
function rutaOsrm(a, b) {
  const clave = `${a.lng.toFixed(5)},${a.lat.toFixed(5)};${b.lng.toFixed(5)},${b.lat.toFixed(5)}`;
  if (!cacheOsrm.has(clave)) {
    const url = `https://router.project-osrm.org/route/v1/driving/${clave}?overview=full&geometries=geojson`;
    cacheOsrm.set(clave, fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (j.code !== "Ok" || !j.routes?.length) throw new Error(j.code);
        const r = j.routes[0];
        return { metros: r.distance, segundos: r.duration, puntos: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })) };
      })
      .catch((e) => { cacheOsrm.delete(clave); throw e; }));
  }
  return cacheOsrm.get(clave);
}

// ---------- Carga de datos ----------
async function cargarDatos() {
  $("#estado-datos").textContent = "Cargando suministros…";
  let ix;
  try {
    ix = await (await fetch("data/indice.json")).json();
  } catch (e) {
    $("#estado-datos").textContent = "No se pudieron cargar los datos.";
    return;
  }
  // Índice en columnas (liviano): número, lat/lng en millonésimas sobre una base, color y página.
  ZONA_GRADOS = ix.zona_grados;
  const [baseLat, baseLng] = ix.base;
  const numeros = ix.n.split(",");
  const suministros = numeros.map((n, i) => ({
    n, lat: +(baseLat + ix.la[i] / 1e6).toFixed(6), lng: +(baseLng + ix.lo[i] / 1e6).toFixed(6),
    c: ix.c[i] === "1" ? "naranja" : "verde", p: ix.p[i],
  }));
  datos = { paginas: ix.paginas, suministros };
  for (const s of suministros) indice.set(s.n, s);
  for (const p of datos.paginas) paginas.set(p.p, p);
  $("#estado-datos").textContent =
    `${suministros.length.toLocaleString("es-PE")} suministros cargados (${datos.paginas.length} páginas del plano). ` +
    `Acerca el mapa para ver los puntos.`;
  incorporarPropios(); // suministros agregados a mano (menu.js)
  dibujarHojas();
  indexarSuministros();
  const b = L.latLngBounds(datos.paginas.flatMap((p) => [[p.sur, p.oeste], [p.norte, p.este]]));
  if (b.isValid()) mapa.fitBounds(b, { padding: [20, 20] });
  dibujarVisible();
  ruta = ruta.filter((n) => indice.has(n));
  pintarRuta();
  abrirDesdeEnlace();
}

// Enlace directo a un suministro: .../#338641
function abrirDesdeEnlace() {
  const n = decodeURIComponent(location.hash.slice(1)).replace(/\D/g, "");
  if (!n) return;
  $("#buscador").value = n;
  ejecutarBusqueda();
}
window.addEventListener("hashchange", abrirDesdeEnlace);

// ---------- Búsqueda ----------
function buscar(texto) {
  const q = texto.replace(/\D/g, "");
  const ul = $("#resultados");
  ul.innerHTML = "";
  if (!q) { $("#ficha").hidden = true; return []; }

  const exactos = [], empiezan = [], contienen = [];
  for (const s of datos.suministros) {
    if (s.n === q) exactos.push(s);
    else if (s.n.startsWith(q)) empiezan.push(s);
    else if (s.n.includes(q)) contienen.push(s);
  }
  const lista = [...exactos, ...empiezan, ...contienen];
  if (!lista.length) {
    ul.innerHTML = `<li><span class="info">No se encontró el suministro “${q}”.</span></li>`;
    return lista;
  }
  const titulo = document.createElement("p");
  titulo.className = "resultados-titulo";
  titulo.textContent = `No hay un suministro exacto “${q}”. Parecidos (${lista.length > 30 ? "primeros 30 de " : ""}${lista.length}):`;
  ul.appendChild(titulo);
  for (const s of lista.slice(0, 30)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="punto ${s.c}"></span><span class="num">${s.n}</span>
      <span class="info">Página ${s.p}${s.poste ? " · poste " + s.poste : ""}</span>`;
    li.addEventListener("click", () => { $("#buscador").value = s.n; seleccionar(s.n); });
    ul.appendChild(li);
  }
  return lista;
}

/** Solo al tocar "Buscar": abre el suministro exacto o, si no existe, muestra los parecidos para elegir. */
function ejecutarBusqueda() {
  const q = $("#buscador").value.replace(/\D/g, "");
  if (!datos) return;
  if (!q) { $("#buscador").focus(); return; }
  $("#buscador").blur(); // cierra el teclado del celular
  const btn = $(".btn-buscar");
  btn.classList.add("buscando");
  setTimeout(() => btn.classList.remove("buscando"), 250);
  if (indice.has(q)) return seleccionar(q);
  // sin coincidencia exacta: se limpia el resultado anterior y se listan los parecidos
  seleccionActual = null;
  $("#ficha").hidden = true;
  capaCamino.clearLayers();
  if (marcadorSeleccion) { marcadorSeleccion.remove(); marcadorSeleccion = null; }
  buscar(q);
}

function seleccionar(n) {
  const s = indice.get(n);
  if (!s) return;
  seleccionActual = n;
  $("#buscador").value = n;
  $("#resultados").innerHTML = "";
  if (marcadorSeleccion) marcadorSeleccion.remove();
  marcadorSeleccion = L.marker([s.lat, s.lng]).addTo(mapa).bindTooltip(s.n, { permanent: true, direction: "top", offset: [-15, -12] });
  mapa.setView([s.lat, s.lng], 18);

  registrarBusqueda(n);
  const enRuta = ruta.includes(s.n);
  const propio = s.c === "nuevo";
  const f = $("#ficha");
  f.hidden = false;
  f.innerHTML = `
    <h2><span class="punto ${s.c}"></span>${s.n}</h2>
    <p id="f-recorrido" class="recorrido gris">Calculando recorrido desde tu ubicación…</p>
    <dl>
      ${propio
        ? `<dt>Origen</dt><dd>Agregado${s.por ? " por " + escapar(s.por) : ""} el ${new Date(s.fecha).toLocaleDateString("es-PE")}</dd>
           ${s.nota ? `<dt>Referencia</dt><dd>${escapar(s.nota)}</dd>` : ""}`
        : `<dt>Página</dt><dd>${s.p}</dd>
           <dt>Poste cercano</dt><dd id="f-poste">${s.poste !== undefined ? s.poste ?? "—" : "…"}</dd>`}
      <dt>GPS</dt><dd>${s.lat}, ${s.lng}</dd>
    </dl>
    ${propio ? "" : `<div class="fila"><button class="btn" id="f-plano">Ver en el plano</button></div>`}
    ${enRuta ? `<p class="nota">✓ Está en tu ruta (parada ${ruta.indexOf(s.n) + 1}).</p>` : ""}
    <div class="fila">
      <a class="btn navegar" style="margin:0" href="${urlIr(s)}" target="_blank" rel="noopener">Ir con Google Maps</a>
    </div>`;
  if (!propio) $("#f-plano").onclick = () => abrirPlano(s);
  trazarCamino(s);
  if (!propio && s.poste === undefined) {
    cargarZona(claveZona(s.lat, s.lng)).then(() => {
      if (seleccionActual === s.n && $("#f-poste")) $("#f-poste").textContent = s.poste === undefined ? "sin señal" : s.poste ?? "—";
    });
  }
}

/** Dibuja el recorrido en moto desde mi ubicación hasta el suministro, al estilo de Google Maps. */
async function trazarCamino(s) {
  capaCamino.clearLayers();
  const texto = (t, gris = false) => {
    const p = $("#f-recorrido");
    if (p && seleccionActual === s.n) { p.textContent = t; p.classList.toggle("gris", gris); }
  };
  const yo = await obtenerUbicacion().catch(() => null);
  if (seleccionActual !== s.n) return;
  if (!yo) return texto("Activa el GPS (y el permiso de ubicación) para ver el recorrido.", true);

  const inicio = { ...yo };
  await asegurarZonas([s, dist(yo, s) < 5000 ? yo : null]);
  const t = tramo(inicio, s);
  let { puntos, metros } = t;
  let segundos = metros / VELOCIDAD_MOTO_MS;
  let porCalle = t.porCalle;
  if (!porCalle) {
    try {
      const r = await rutaOsrm(inicio, s);
      ({ puntos, metros, segundos } = r);
      porCalle = true;
    } catch { /* sin internet: queda en línea recta */ }
  }
  if (seleccionActual !== s.n) return;

  const latlngs = puntos.map((p) => [p.lat, p.lng]);
  L.polyline(latlngs, { color: "#1557b0", weight: 9, opacity: 0.9, dashArray: porCalle ? null : "8 8" }).addTo(capaCamino);
  L.polyline(latlngs, { color: "#4285f4", weight: 6, opacity: 1, dashArray: porCalle ? null : "8 8" }).addTo(capaCamino);
  L.circleMarker([yo.lat, yo.lng], { radius: 7, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 })
    .bindTooltip("Tú").addTo(capaCamino);
  mapa.fitBounds(L.latLngBounds(latlngs).extend([s.lat, s.lng]), { padding: [40, 40], maxZoom: 18 });
  texto(`${formatoDist(metros)} · ${formatoTiempo(segundos)} en moto` + (porCalle ? "" : " (línea recta, sin conexión)"));
}

// ---------- Google Maps ----------
function modo() { return "two-wheeler"; } // las visitas se hacen en moto

function urlIr(s) {
  return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=${modo()}`;
}

function urlTramo(paradas) {
  // Sin "origin": Google Maps arranca desde la ubicación actual del celular.
  const destino = paradas.at(-1);
  const intermedias = paradas.slice(0, -1).map((s) => `${s.lat},${s.lng}`).join("|");
  let url = `https://www.google.com/maps/dir/?api=1&destination=${destino.lat},${destino.lng}&travelmode=${modo()}`;
  if (intermedias) url += `&waypoints=${encodeURIComponent(intermedias)}`;
  return url;
}

// ---------- Distancias y optimización ----------
function dist(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function formatoTiempo(seg) {
  const min = Math.max(1, Math.round(seg / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
function plural(n, palabra) { return `${n} ${palabra}${n === 1 ? "" : "s"}`; }
function formatoDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }

/**
 * Ruta abierta: parte de `inicio`, visita todos los `puntos` y, si se indica, termina en `fin`.
 * Distancias por las calles del plano. Vecino más cercano + mejora 2-opt. Corre en el celular, sin internet.
 */
function optimizar(inicio, puntos, fin = null) {
  const todos = [inicio, ...puntos, ...(fin ? [fin] : [])];
  const N = todos.length;
  const M = todos.map((a, i) => todos.map((b, j) => (i === j ? 0 : metrosTramo(a, b))));

  const libres = puntos.map((_, i) => i + 1);
  const orden = [0];
  while (libres.length) {
    const u = orden.at(-1);
    let mejor = 0;
    for (let i = 1; i < libres.length; i++) if (M[u][libres[i]] < M[u][libres[mejor]]) mejor = i;
    orden.push(libres.splice(mejor, 1)[0]);
  }
  if (fin) orden.push(N - 1);

  // 2-opt: invierte sub-tramos mientras acorten el recorrido (la partida y el destino fijo no se mueven)
  const ultimoMovible = fin ? orden.length - 2 : orden.length - 1;
  let mejoro = true;
  while (mejoro) {
    mejoro = false;
    for (let i = 1; i < ultimoMovible; i++) {
      for (let k = i + 1; k <= ultimoMovible; k++) {
        const a = orden[i - 1], b = orden[i], c = orden[k], d = orden[k + 1];
        const antes = M[a][b] + (d !== undefined ? M[c][d] : 0) + costoInterno(M, orden, i, k);
        const despues = M[a][c] + (d !== undefined ? M[b][d] : 0) + costoInterno(M, orden, i, k, true);
        if (despues + 0.5 < antes) {
          orden.splice(i, k - i + 1, ...orden.slice(i, k + 1).reverse());
          mejoro = true;
        }
      }
    }
  }
  return orden.slice(1).map((i) => todos[i]);
}
function costoInterno(M, orden, i, k, invertido = false) {
  let t = 0;
  for (let x = i; x < k; x++) t += invertido ? M[orden[x + 1]][orden[x]] : M[orden[x]][orden[x + 1]];
  return t;
}

// ---------- Crear ruta ----------
/** Agrega suministros a la ruta y la vuelve a optimizar al momento. Devuelve los que no existen. */
function agregarARuta(numeros) {
  const faltan = numeros.filter((n) => !indice.has(n));
  const nuevos = numeros.filter((n) => indice.has(n) && !ruta.includes(n));
  ruta.push(...nuevos);
  guardar(CLAVE_RUTA, ruta);
  pintarRuta();
  if (nuevos.length) optimizarRuta();
  return faltan;
}

function avisoFaltan(faltan, repetidos = []) {
  const aviso = $("#no-encontrados");
  const partes = [];
  if (faltan.length) partes.push(`No encontrado${faltan.length > 1 ? "s" : ""}: ${faltan.join(", ")}`);
  if (repetidos.length) partes.push(`Ya en la ruta: ${repetidos.join(", ")}`);
  aviso.hidden = !partes.length;
  aviso.textContent = partes.join(" · ");
}

/** Punto de partida guardado (ubicación al calcular), con su nodo de acceso a la red. */
function paradaInicio() {
  if (!inicioRuta) return null;
  return { ...inicioRuta };
}

function llenarSelects() {
  const opciones = ruta.filter((n) => !visitados.has(n)).map((n) => `<option value="${n}">${n}</option>`).join("");
  const p = leer(CLAVE_PARTIDA, "gps"), d = leer(CLAVE_DESTINO, "");
  $("#partida").innerHTML = `<option value="gps">Mi ubicación</option>${opciones}`;
  $("#destino").innerHTML = `<option value="">El más conveniente</option>${opciones}`;
  $("#partida").value = [...$("#partida").options].some((o) => o.value === p) ? p : "gps";
  $("#destino").value = [...$("#destino").options].some((o) => o.value === d) ? d : "";
}
$("#partida").onchange = () => guardar(CLAVE_PARTIDA, $("#partida").value);
$("#destino").onchange = () => guardar(CLAVE_DESTINO, $("#destino").value);

function pintarRuta() {
  const cont = $("#contador-ruta");
  const pendientes = ruta.filter((n) => !visitados.has(n));
  cont.hidden = !ruta.length;
  cont.textContent = `${pendientes.length}/${ruta.length}`;
  $("#controles-ruta").hidden = !ruta.length;

  const ol = $("#lista-ruta");
  ol.innerHTML = "";
  capaRuta.clearLayers();
  if (!ruta.length || !datos) return;
  llenarSelects();

  // Trazo: partida -> parada 1 -> ... -> destino, siguiendo las calles del plano
  const inicio = paradaInicio();
  const paradas = [...(inicio ? [inicio] : []), ...ruta.map((n) => indice.get(n))];
  if (!zonasCargadas(paradas)) asegurarZonas(paradas).then(() => pintarRuta());
  const version = ++versionPintado;
  const tramosPendientes = []; // {metros, tipo: "plano" | "osm" | "recta"}
  const actualizarResumen = () => {
    const total = tramosPendientes.reduce((t, x) => t + x.metros, 0);
    const rectas = tramosPendientes.filter((x) => x.tipo === "recta").length;
    $("#resumen-ruta").textContent = `${plural(pendientes.length, "pendiente")} · ${formatoDist(total)} por recorrer en moto` +
      (rectas ? ` · ${plural(rectas, "tramo")} en línea recta` : "");
  };
  for (let i = 1; i < paradas.length; i++) {
    const a = paradas[i - 1], b = paradas[i];
    const t = tramo(a, b);
    const hecho = visitados.has(b.n);
    const linea = L.polyline(t.puntos.map((p) => [p.lat, p.lng]), {
      color: hecho ? "#9aa39e" : t.porCalle ? "#1f6f43" : "#c62828",
      weight: hecho ? 3 : 4, opacity: 0.85, dashArray: t.porCalle ? null : "6 6",
    }).addTo(capaRuta);
    const info = { metros: t.metros, tipo: t.porCalle ? "plano" : "recta" };
    if (!hecho) tramosPendientes.push(info);
    if (!t.porCalle) {
      // fuera del plano: se reemplaza la recta por el camino real de OpenStreetMap
      rutaOsrm(a, b).then((r) => {
        if (version !== versionPintado) return;
        linea.setLatLngs(r.puntos.map((p) => [p.lat, p.lng]));
        linea.setStyle({ color: hecho ? "#9aa39e" : "#1a73e8", dashArray: null });
        Object.assign(info, { metros: r.metros, tipo: "osm" });
        actualizarResumen();
      }).catch(() => { /* sin internet: queda la línea recta */ });
    }
  }
  if (inicio) {
    L.marker([inicio.lat, inicio.lng], {
      icon: L.divIcon({ className: "", html: `<div class="marcador-partida">P</div>`, iconSize: [22, 22] }),
      zIndexOffset: 1000,
    }).bindTooltip("Partida", { permanent: true, direction: "top", offset: [0, -10] }).addTo(capaRuta);
  }

  ruta.forEach((n, i) => {
    const s = indice.get(n);
    const hecho = visitados.has(n);
    const esDestino = i === ruta.length - 1;
    const li = document.createElement("li");
    li.className = hecho ? "visitado" : "";
    li.innerHTML = `<span class="orden">${i + 1}</span>
      <span class="punto ${s.c}"></span>
      <span class="num">${s.n}</span>
      <span class="info">pág. ${s.p}${esDestino ? " · destino" : ""}</span>
      <a class="btn" href="${urlIr(s)}" target="_blank" rel="noopener">Ir</a>
      <input type="checkbox" ${hecho ? "checked" : ""} aria-label="Visitado">`;
    li.querySelector(".num").onclick = () => { activarVista("buscar"); $("#buscador").value = s.n; seleccionar(s.n); };
    li.querySelector("input").onchange = (e) => {
      e.target.checked ? visitados.add(n) : visitados.delete(n);
      guardar(CLAVE_VISITADOS, [...visitados]);
      pintarRuta();
    };
    ol.appendChild(li);

    L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="marcador-ruta ${hecho ? "visitado" : ""} ${esDestino ? "destino" : ""}">${i + 1}</div>`,
        iconSize: esDestino ? [22, 22] : [18, 18],
      }),
      zIndexOffset: esDestino ? 900 : 0,
    }).bindTooltip(esDestino ? `Destino · ${s.n}` : s.n,
      esDestino ? { permanent: true, direction: "top", offset: [0, -10] } : {}).addTo(capaRuta);
  });

  actualizarResumen();
  const proximos = Math.min(MAX_PARADAS_TRAMO, pendientes.length);
  $("#btn-navegar").disabled = !pendientes.length;
  $("#btn-navegar").textContent = !pendientes.length ? "¡Ruta completada!"
    : proximos === 1 ? "Navegar al último pendiente ▸"
    : `Navegar a los próximos ${proximos} pendientes ▸`;
}

function encuadrarRuta() {
  const pts = ruta.map((n) => [indice.get(n).lat, indice.get(n).lng]);
  if (inicioRuta) pts.push([inicioRuta.lat, inicioRuta.lng]);
  if (pts.length) mapa.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
}

$("#form-agregar-ruta").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = $("#numero-ruta").value.replace(/\D/g, "");
  if (!n) return;
  const repetido = ruta.includes(n);
  const faltan = repetido ? [] : agregarARuta([n]);
  avisoFaltan(faltan, repetido ? [n] : []);
  if (!faltan.length) $("#numero-ruta").value = "";
});

$("#btn-cargar").onclick = () => {
  const numeros = [...new Set($("#lista-pegada").value.match(/\d{3,6}/g) ?? [])];
  const faltan = agregarARuta(numeros);
  avisoFaltan(faltan);
  if (!faltan.length) {
    $("#lista-pegada").value = "";
    $("#cargar-lista").open = false;
  }
};

$("#btn-cerrar-ruta").onclick = () => activarVista("buscar");

$("#btn-limpiar").onclick = () => {
  if (!confirm("¿Vaciar la ruta del día y las marcas de visitado?")) return;
  ruta = [];
  visitados.clear();
  inicioRuta = null;
  guardar(CLAVE_RUTA, ruta);
  guardar(CLAVE_VISITADOS, []);
  guardar(CLAVE_INICIO, null);
  pintarRuta();
};

/**
 * Ordena las paradas pendientes por el camino más corto (desde la partida elegida hasta el destino).
 * Se ejecuta sola al agregar puntos; si llega otra petición mientras calcula, se repite al terminar.
 */
let optimizando = false, repetirOptimizacion = false;
async function optimizarRuta({ manual = false } = {}) {
  if (optimizando) { repetirOptimizacion = true; return; }
  const btn = $("#btn-optimizar");
  const pendientes = ruta.filter((n) => !visitados.has(n)).map((n) => indice.get(n));
  if (!pendientes.length) return;
  optimizando = true;
  const hechos = ruta.filter((n) => visitados.has(n));
  const partida = $("#partida").value, destino = $("#destino").value;
  btn.disabled = true;
  btn.textContent = "Descargando calles…";
  await asegurarZonas(pendientes);

  let inicio = null;
  if (partida === "gps") {
    btn.textContent = "Obteniendo ubicación…";
    const pos = await obtenerUbicacion().catch(() => null);
    if (pos) inicio = { ...pos };
    else if (manual) alert("No se pudo obtener tu ubicación: la ruta empieza en el primer suministro de la lista.");
  }
  btn.textContent = "Calculando…";
  await new Promise((r) => setTimeout(r, 30)); // deja que se vea el texto del botón

  const fin = destino && destino !== partida ? pendientes.find((s) => s.n === destino) ?? null : null;
  let primero = null; // cuando la partida es un suministro, ese suministro es la parada 1
  if (!inicio) {
    primero = pendientes.find((s) => s.n === partida) ?? pendientes.find((s) => s !== fin) ?? fin;
    inicio = primero;
  }
  const medio = pendientes.filter((s) => s !== primero && s !== fin);
  // si la única parada es a la vez partida y destino, no hay nada más que ordenar
  const orden = primero && primero === fin ? [] : optimizar(inicio, medio, fin);

  const nuevoOrden = [...hechos, ...(primero ? [primero.n] : []), ...orden.map((s) => s.n)];
  // lo que se agregó o quitó mientras se calculaba no se pierde: se vuelve a optimizar al final
  const agregadosDurante = ruta.filter((n) => !nuevoOrden.includes(n));
  ruta = [...nuevoOrden.filter((n) => ruta.includes(n)), ...agregadosDurante];
  if (agregadosDurante.length) repetirOptimizacion = true;
  inicioRuta = primero ? null : { lat: inicio.lat, lng: inicio.lng };
  guardar(CLAVE_RUTA, ruta);
  guardar(CLAVE_INICIO, inicioRuta);
  pintarRuta();
  encuadrarRuta();
  btn.disabled = false;
  btn.textContent = "↻ Recalcular desde aquí";
  optimizando = false;
  if (repetirOptimizacion) { repetirOptimizacion = false; optimizarRuta(); }
}
$("#btn-optimizar").onclick = () => optimizarRuta({ manual: true });
$("#partida").addEventListener("change", () => optimizarRuta());
$("#destino").addEventListener("change", () => optimizarRuta());

$("#btn-navegar").onclick = () => {
  const proximos = ruta.filter((n) => !visitados.has(n)).slice(0, MAX_PARADAS_TRAMO).map((n) => indice.get(n));
  if (proximos.length) window.open(urlTramo(proximos), "_blank", "noopener");
};


// ---------- Ubicación ----------
function obtenerUbicacion() {
  return new Promise((ok, mal) => {
    if (!navigator.geolocation) return mal(new Error("sin GPS"));
    navigator.geolocation.getCurrentPosition(
      (p) => { ponerMiPosicion(p); ok(miPosicion); },
      mal,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
  });
}

function ponerMiPosicion(p) {
  miPosicion = { lat: p.coords.latitude, lng: p.coords.longitude };
  if (!marcadorYo) {
    marcadorYo = L.circleMarker([miPosicion.lat, miPosicion.lng], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1,
    }).bindTooltip("Tú").addTo(mapa);
  } else {
    marcadorYo.setLatLng([miPosicion.lat, miPosicion.lng]);
  }
}

let seguimiento = null;
$("#btn-ubicacion").onclick = () => {
  const btn = $("#btn-ubicacion");
  if (!navigator.geolocation) return alert("Este navegador no permite obtener la ubicación.");
  if (seguimiento === null) {
    btn.classList.add("activo");
    let primera = true;
    seguimiento = navigator.geolocation.watchPosition(
      (p) => { ponerMiPosicion(p); if (primera) { mapa.setView([miPosicion.lat, miPosicion.lng], 17); primera = false; } },
      () => alert("No se pudo obtener tu ubicación. Revisa que el GPS esté activado y que la página tenga permiso."),
      { enableHighAccuracy: true },
    );
  } else {
    navigator.geolocation.clearWatch(seguimiento);
    seguimiento = null;
    btn.classList.remove("activo");
    if (miPosicion) mapa.setView([miPosicion.lat, miPosicion.lng], 17);
  }
};

// ---------- Visor del plano ----------
let visor = null;
async function abrirPlano(s) {
  const pg = paginas.get(s.p);
  if (s.px === undefined) await cargarZona(claveZona(s.lat, s.lng));
  $("#visor").hidden = false;
  $("#visor-titulo").textContent = `Suministro ${s.n} · página ${s.p}`;
  if (visor) visor.remove();
  visor = L.map("visor-mapa", { crs: L.CRS.Simple, minZoom: -2, maxZoom: 4, zoomSnap: 0.25 });
  const limites = [[0, 0], [pg.alto, pg.ancho]];
  L.imageOverlay(pg.plano, limites).addTo(visor);
  visor.setMaxBounds(L.latLngBounds(limites).pad(0.2));
  const punto = [pg.alto * (1 - s.py), pg.ancho * s.px];
  L.circle(punto, { radius: 12, color: "#e00", weight: 3, fill: false }).addTo(visor);
  visor.setView(punto, 2);
}
$("#visor-cerrar").onclick = () => { $("#visor").hidden = true; };

// ---------- Vistas: "buscar" (inicio) y "ruta" (Crear ruta, desde el menú) ----------
function activarVista(nombre) {
  document.querySelectorAll(".vista").forEach((v) => { v.hidden = v.dataset.vista !== nombre; });
  capaRuta[nombre === "ruta" ? "addTo" : "remove"](mapa);
  capaCamino[nombre === "buscar" ? "addTo" : "remove"](mapa);
  if (marcadorSeleccion) marcadorSeleccion[nombre === "buscar" ? "addTo" : "remove"](mapa);
  if (nombre === "ruta" && ruta.length) encuadrarRuta();
}

// Escribir no hace nada por sí solo: la búsqueda ocurre únicamente al tocar "Buscar".
$("#form-buscar").addEventListener("submit", (e) => {
  e.preventDefault();
  ejecutarBusqueda();
});

// ---------- Inicio ----------
activarVista("buscar");
cargarDatos();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
