// Guarda la app y los datos en el celular para que la búsqueda funcione sin señal.
// Subir VERSION cada vez que se actualicen los datos o el código.
const VERSION = "v14";
const CACHE_PLANOS = "planos-v1"; // imágenes de páginas del plano: se guardan a medida que se abren
const ARCHIVOS = [
  "./", "index.html", "styles.css", "app.js", "menu.js", "manifest.json",
  "lib/leaflet.js", "lib/leaflet-rotate.js", "lib/leaflet.css", "data/indice.json", "data/correcciones.json",
  "icono-192.png", "icono-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== VERSION && k !== CACHE_PLANOS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // mapas de OSM: siempre por red

  // Planos (son muchos y casi no cambian): primero lo guardado; si no está, se descarga y se guarda.
  if (url.pathname.includes("/data/planos/")) {
    e.respondWith(
      caches.open(CACHE_PLANOS).then(async (c) => {
        const guardado = await c.match(e.request);
        if (guardado) return guardado;
        const r = await fetch(e.request);
        if (r.ok) c.put(e.request, r.clone());
        return r;
      }),
    );
    return;
  }

  // Resto: primero la red (datos frescos); si no hay señal, lo guardado.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
