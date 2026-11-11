// Lee la foto (o fotos) de la hoja de la jornada con Gemini y devuelve los contratos y sus direcciones.
// La clave de Gemini vive solo aquí (secreto GEMINI_API_KEY); el celular nunca la ve.
// Solo la pueden usar usuarios con sesión, no bloqueados y con lecturas disponibles hoy. Las fotos no se guardan.
import { createClient } from "jsr:@supabase/supabase-js@2";

// en orden: si uno está saturado (503) se pasa al siguiente
const MODELOS = (Deno.env.get("GEMINI_MODELOS") ?? "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.8-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
const LIMITE_DIARIO = Number(Deno.env.get("JORNADA_LIMITE_DIARIO") ?? 20);
const MAX_FOTOS = 4;
const MAX_BYTES_FOTO = 4_000_000; // en base64

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, "Content-Type": "application/json" } });

const INSTRUCCIONES = `Te paso la foto de una hoja impresa de órdenes de trabajo de una contratista eléctrica de Arequipa (Perú).
Es una tabla. La foto puede estar girada, inclinada, con sombra o con la hoja doblada.
Columnas habituales: MES o item, RT, OT (8 dígitos, empieza con 26), CONTRATO, ZONA, LIBRO, SED, NIM (6 o 7 dígitos),
NOMBRE, DIRECCION, LECTURA, FECHA PAGO o TIPO. El título dice "cortes ..." o "reconexiones ...".

Orden de las columnas en cada fila (de izquierda a derecha leyendo la hoja derecha):
  MES/RT (ej. R2, C2) | OT (8 dígitos, ej. 26110415) | CONTRATO | ZONA (1 o 2 dígitos) | LIBRO (1 o 2 dígitos) |
  SED (3 o 4 dígitos) | NIM (6 o 7 dígitos) | NOMBRE | DIRECCION | ...
Ejemplo de fila: "R2  26110415  442724  2  15  4965  848749  APELLIDO NOMBRE  ZN CHALLAPAMPA ..." -> contrato = 442724.
El CONTRATO es SIEMPRE el número que va justo después del OT de 8 dígitos. Normalmente tiene de 3 a 6 dígitos.

Tu tarea:
- Copia el número de la columna CONTRATO de cada fila. NO copies el OT, la ZONA, el LIBRO, la SED, el NIM ni otra columna.
- Copia también la DIRECCION de esa fila, tal como está (sin el nombre de la persona).
- Si en algún dígito del contrato dudas, igual escribe tu mejor lectura y pon seguro=false.
- Si una fila está cortada en el borde y no se ve el contrato completo, no la incluyas.
- tipo: "corte" si el título dice cortes, "reconexion" si dice reconexiones, "desconocido" si no se ve.
- legible=false si la foto está tan borrosa, oscura, lejana o cortada que no se pueden leer los contratos; explica en motivo
  con palabras simples (por ejemplo "La foto salió borrosa" o "No se ve la columna CONTRATO").
No inventes filas.`;

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["legible", "motivo", "tipo", "filas"],
  properties: {
    legible: { type: "boolean" },
    motivo: { type: "string" },
    tipo: { type: "string", enum: ["corte", "reconexion", "desconocido"] },
    filas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["contrato", "direccion", "seguro"],
        properties: { contrato: { type: "string" }, direccion: { type: "string" }, seguro: { type: "boolean" } },
      },
    },
  },
};

type Fila = { contrato: string; direccion: string; seguro: boolean };
type Lectura = { legible: boolean; motivo: string; tipo: string; filas: Fila[] };
type Foto = { datos: string; tipo: string };

async function gemini(modelo: string, fotos: Foto[], variante: string, temperatura: number): Promise<Lectura> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseJsonSchema: ESQUEMA,
    temperature: temperatura,
  };
  if (modelo.includes("flash") && !modelo.includes("lite")) generationConfig.thinkingConfig = { thinkingLevel: "low" };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY") ?? "" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCCIONES }] },
      contents: [{
        role: "user",
        parts: [
          { text: variante },
          ...fotos.map((f) => ({ inlineData: { mimeType: f.tipo, data: f.datos } })),
        ],
      }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(75_000),
  });
  if (!r.ok) throw Object.assign(new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`), { estado: r.status });
  const d = await r.json();
  const texto = d.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return JSON.parse(texto);
}

/** Prueba los modelos en orden (y una vuelta más si todos estaban saturados). */
async function leer(fotos: Foto[], variante: string, temperatura: number) {
  const intentos = [...MODELOS, ...MODELOS.slice(0, 2)];
  let ultimo: unknown;
  for (let i = 0; i < intentos.length; i++) {
    try {
      return { lectura: await gemini(intentos[i], fotos, variante, temperatura), modelo: intentos[i] };
    } catch (e) {
      ultimo = e;
      const estado = (e as { estado?: number }).estado;
      if (estado && ![429, 500, 502, 503, 504].includes(estado)) break; // error de la petición: no sirve reintentar
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw ultimo;
}

const soloDigitos = (t: string) => String(t ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responder({ error: "Método no permitido" }, 405);
  if (!Deno.env.get("GEMINI_API_KEY")) return responder({ error: "Falta configurar la clave de la IA." }, 500);

  // quién llama: con su sesión, así los permisos de la base de datos son los suyos
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return responder({ error: "Tu sesión venció. Vuelve a entrar con Google." }, 401);
  const { data: bloqueado } = await supa.rpc("esta_bloqueado");
  if (bloqueado) return responder({ error: "Esta cuenta no tiene acceso a la app." }, 403);
  const { data: cupo, error: errCupo } = await supa.rpc("jornada_cupo", { p_limite: LIMITE_DIARIO });
  if (errCupo) return responder({ error: "No se pudo revisar tu límite de hoy. Intenta de nuevo." }, 500);
  if (cupo <= 0) return responder({ error: `Ya usaste las ${LIMITE_DIARIO} lecturas de hoy. Mañana se renuevan.` }, 429);

  let fotos: Foto[];
  try {
    fotos = ((await req.json()).fotos ?? []).slice(0, MAX_FOTOS)
      .filter((f: Foto) => typeof f?.datos === "string" && f.datos.length < MAX_BYTES_FOTO && /^image\//.test(f.tipo));
  } catch {
    return responder({ error: "No llegó la foto. Intenta de nuevo." }, 400);
  }
  if (!fotos.length) return responder({ error: "No llegó ninguna foto válida." }, 400);

  const inicio = Date.now();
  let a, b;
  try {
    // dos lecturas por separado: si un contrato sale distinto en una de ellas, se marca para revisar
    [a, b] = await Promise.all([
      leer(fotos, "Lee la tabla de arriba hacia abajo.", 0),
      leer(fotos, "Lee la tabla con cuidado, fila por fila, empezando por la última fila.", 0.6).catch(() => null),
    ]);
  } catch (e) {
    console.error(e);
    return responder({ error: "La IA no respondió. Espera un momento e intenta de nuevo." }, 503);
  }

  const principal = a.lectura;
  const otra = new Set((b?.lectura.filas ?? []).map((f) => soloDigitos(f.contrato)));
  const vistos = new Set<string>();
  const filas = [];
  for (const f of principal.filas ?? []) {
    const n = soloDigitos(f.contrato);
    if (!n || n.length > 7 || vistos.has(n)) continue;
    vistos.add(n);
    filas.push({ n, direccion: String(f.direccion ?? "").slice(0, 120), seguro: f.seguro !== false, coincide: !b || otra.has(n) });
  }
  // lo que solo vio la segunda lectura también se muestra, marcado para revisar
  for (const f of b?.lectura.filas ?? []) {
    const n = soloDigitos(f.contrato);
    if (!n || n.length > 7 || vistos.has(n)) continue;
    vistos.add(n);
    filas.push({ n, direccion: String(f.direccion ?? "").slice(0, 120), seguro: false, coincide: false });
  }

  const legible = principal.legible !== false && filas.length > 0;
  const ms = Date.now() - inicio;
  await supa.rpc("jornada_anotar", {
    p_fotos: fotos.length, p_tipo: principal.tipo, p_leidos: filas.length,
    p_dudosos: filas.filter((f) => !f.seguro || !f.coincide).length, p_legible: legible, p_modelo: a.modelo, p_ms: ms,
  });

  return responder({
    legible,
    motivo: legible ? "" : (principal.motivo || "La foto salió borrosa"),
    tipo: principal.tipo,
    filas,
    quedan: Math.max(0, cupo - 1),
    ms,
  });
});
