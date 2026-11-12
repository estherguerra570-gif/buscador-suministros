// Guarda la app y los datos en el celular para que la búsqueda funcione sin señal.
// Subir VERSION cada vez que cambie el código. Subir CACHE_DATOS solo cuando se regeneren los datos del PDF
// (así una actualización del código no obliga a bajar de nuevo los 4 MB del índice).
const VERSION = "v33";
const CACHE_DATOS = "datos-2026-10-28"; // índice y zonas: se usan desde el celular, sin esperar a internet
const CACHE_PLANOS = "planos-v1"; // imágenes de páginas del plano: se guardan a medida que se abren
const CACHE_CATASTRO = "catastro-2026-11-11"; // manzanas y lotes de COFOPRI: subir al regenerarlos
const ARCHIVOS = [
  "./", "index.html", "styles.css", "app.js", "menu.js", "gestos.js", "sesion.js", "catastro.js", "jornada.js", "sed.js", "voz.js", "lib/supabase.js", "manifest.json",
  "lib/leaflet.js", "lib/leaflet-rotate.js", "lib/leaflet.css",
  "icono-192.png", "icono-512.png",
];
const ESPERA_RED = 3000; // con señal lenta, pasado este tiempo se abre lo guardado

self.addEventListener("install", (e) => {
  e.waitUntil(Promise.all([
    caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)),
    caches.open(CACHE_DATOS).then(async (c) => {
      if (await c.match("data/indice.json")) return;
      const anterior = await caches.match("data/indice.json"); // el de la versión anterior: no se baja otra vez
      if (anterior) await c.put("data/indice.json", anterior);
      else await c.add("data/indice.json");
    }),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => ![VERSION, CACHE_DATOS, CACHE_PLANOS, CACHE_CATASTRO].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // mapas de OSM: siempre por red

  // Datos del PDF y planos (casi no cambian): primero lo guardado; si no está, se descarga y se guarda.
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      caches.open(url.pathname.includes("/data/planos/") ? CACHE_PLANOS : url.pathname.includes("/data/catastro/") ? CACHE_CATASTRO : CACHE_DATOS).then(async (c) => {
        const guardado = await c.match(e.request);
        if (guardado) return guardado;
        const r = await fetch(e.request);
        if (r.ok) c.put(e.request, r.clone());
        return r;
      }),
    );
    return;
  }

  // Código: primero la red (para tener lo último); si no hay señal o tarda más de 3 s, lo guardado.
  const red = fetch(e.request).then((r) => {
    if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copia)); }
    return r;
  });
  e.respondWith(new Promise((listo) => {
    let hecho = false;
    const usar = (r) => { if (!hecho && r) { hecho = true; listo(r); } };
    const guardado = () => caches.match(e.request);
    setTimeout(() => guardado().then(usar), ESPERA_RED);
    red.then(usar, () => guardado().then((r) => (r ? usar(r) : red.catch(() => Response.error()).then(usar))));
  }));
});
