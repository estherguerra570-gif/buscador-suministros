// Ubicaciones corregidas, compartidas por todos los usuarios.
// Se guardan en el propio repositorio (docs/data/correcciones.json): cada corrección es un commit,
// así queda el historial de quién corrigió qué y cuándo, y el archivo publicado sirve de respaldo sin señal.
//
// Variables de entorno en Vercel:
//   GITHUB_TOKEN  token "fine-grained" con permiso Contents: Read and write solo sobre este repositorio
//   CLAVE_EQUIPO  clave que cada usuario pone en el menú "Usuario" para poder corregir
//
// GET                         -> {numero: {lat, lng, nota, por, fecha}}
// POST   {clave, n, lat, lng, nota, por} -> guarda o reemplaza la corrección de n
// DELETE {clave, n}                      -> la borra (vuelve la ubicación del plano)

const REPO = "estherguerra570-gif/buscador-suministros";
const RUTA = "docs/data/correcciones.json";
const RAMA = "main";
const ORIGENES = ["https://buscador-suministros.vercel.app", "https://estherguerra570-gif.github.io"];
// zona del plano (Arequipa) con margen: lo que caiga fuera es un error de GPS o de toque
const LIMITES = { latMin: -17.2, latMax: -15.6, lngMin: -72.6, lngMax: -70.8 };

async function github(metodo, cuerpo) {
  const url = `https://api.github.com/repos/${REPO}/contents/${RUTA}` + (metodo === "GET" ? `?ref=${RAMA}` : "");
  const r = await fetch(url, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "buscador-suministros",
      ...(cuerpo ? { "Content-Type": "application/json" } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return r;
}

async function leerArchivo() {
  const r = await github("GET");
  if (r.status === 404) return { datos: {}, sha: undefined };
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
  const j = await r.json();
  return { datos: JSON.parse(Buffer.from(j.content, "base64").toString("utf-8") || "{}"), sha: j.sha };
}

/** Lee, cambia y guarda; si otro usuario guardó al mismo tiempo (409/422), lo reintenta sobre lo nuevo. */
async function modificar(cambiar, mensaje) {
  for (let intento = 0; intento < 4; intento++) {
    const { datos, sha } = await leerArchivo();
    cambiar(datos);
    const ordenado = Object.fromEntries(Object.entries(datos).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
    const contenido = Buffer.from(JSON.stringify(ordenado, null, 1) + "\n", "utf-8").toString("base64");
    const r = await github("PUT", { message: mensaje, content: contenido, sha, branch: RAMA });
    if (r.ok) return ordenado;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub respondió ${r.status}`);
  }
  throw new Error("Demasiados cambios al mismo tiempo, intenta de nuevo");
}

const texto = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

module.exports = async (req, res) => {
  const origen = req.headers.origin;
  if (origen && (ORIGENES.includes(origen) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen))) {
    res.setHeader("Access-Control-Allow-Origin", origen);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!process.env.GITHUB_TOKEN || !process.env.CLAVE_EQUIPO) {
    return res.status(503).json({ error: "Falta configurar GITHUB_TOKEN y CLAVE_EQUIPO en Vercel" });
  }

  try {
    if (req.method === "GET") {
      const { datos } = await leerArchivo();
      res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
      return res.status(200).json(datos);
    }

    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
    if (b.clave !== process.env.CLAVE_EQUIPO) return res.status(401).json({ error: "Clave del equipo incorrecta" });
    const n = String(b.n ?? "");
    if (!/^\d{1,6}$/.test(n)) return res.status(400).json({ error: "Número de suministro inválido" });

    if (req.method === "POST") {
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!(lat >= LIMITES.latMin && lat <= LIMITES.latMax && lng >= LIMITES.lngMin && lng <= LIMITES.lngMax)) {
        return res.status(400).json({ error: "La ubicación está fuera de la zona del plano" });
      }
      const c = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), nota: texto(b.nota, 200), por: texto(b.por, 60), fecha: new Date().toISOString() };
      const datos = await modificar((d) => { d[n] = c; }, `Corregir ubicación del suministro ${n}${c.por ? ` (por ${c.por})` : ""}`);
      return res.status(200).json({ ok: true, correccion: c, total: Object.keys(datos).length });
    }

    if (req.method === "DELETE") {
      const por = texto(b.por, 60);
      await modificar((d) => { delete d[n]; }, `Volver a la ubicación del plano: suministro ${n}${por ? ` (por ${por})` : ""}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
