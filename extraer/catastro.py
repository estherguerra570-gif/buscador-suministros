"""
Descarga del catastro público de COFOPRI (Geo Llaqta) las manzanas, lotes, calles y nombres de pueblos o
urbanizaciones de la zona que cubre el plano, y los guarda por zonas de ~1 km para que el celular baje solo lo
que muestra en pantalla.

Fuentes (datos públicos del Estado), en este orden de preferencia:
  1. FORMALIZACION_REFERENCIAL_WGS84: pueblos formalizados (Pachacútec, Túpac Amaru...): Mz y Lt de cada lote.
  2. CATASTRO_URBANO: catastro de la ciudad: manzana y lote municipales, nombres de vías y habilitaciones.
Solo se guarda ubicación, manzana, lote y nombres de calles y pueblos. NUNCA se pide el campo del dueño.

Uso:
    python catastro.py

Genera (coordenadas como enteros: (valor - base) * 100000, ~1 m):
    docs/data/catastro/<zona>.json  -> {"h": [[y, x, i]], "m": [[y, x, mz]], "l": [[y, x, lt, mz, i]],
                                        "v": [[y, x, ángulo, nombre]], "n": [nombres de pueblos de la zona]}
                                        (i: posición del pueblo en "n", -1 si no se sabe)
    docs/data/catastro/info.json     -> base, zonas y pueblos [[nombre, y_min, x_min, y_max, x_max]] para buscar
                                        "Mz E Lt 14 Túpac Amaru" bajando solo las zonas de ese pueblo
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

GEO = "https://geoportal.cofopri.gob.pe/giscofopri/rest/services/Cofopri"
FORMAL = f"{GEO}/FORMALIZACION_REFERENCIAL_WGS84/MapServer"
URBANO = f"{GEO}/CATASTRO_URBANO/MapServer"
POR_PEDIDO = 500           # el servidor da como mucho 1000 por consulta y no pagina: se pide por OBJECTID
ZONA_GRADOS = 0.01         # igual que las zonas del plano (indice.json)
ESCALA = 100000            # 1e-5 grados ~ 1,1 m
MISMO_LOTE_M = 6           # dos lotes con el mismo número a menos de esto son el mismo (vienen de las dos fuentes)
MISMA_MZ_M = 30

RAIZ = Path(__file__).resolve().parent.parent
DATOS = RAIZ / "docs" / "data"
SALIDA = DATOS / "catastro"


# ---------- Descarga ----------
def pedir(servicio, capa, params, intentos=5):
    url = f"{servicio}/{capa}/query"
    cuerpo = urllib.parse.urlencode({**params, "f": "json"}).encode()
    for i in range(intentos):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=cuerpo), timeout=180) as r:
                d = json.load(r)
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:  # el servidor del Estado a veces se cae un momento
            if i == intentos - 1:
                raise
            print(f"  reintento ({e})", file=sys.stderr)
            time.sleep(4 * (i + 1))


def descargar(servicio, capa, campos, caja, simplificar):
    oeste, sur, este, norte = caja
    filtro = {"geometry": f"{oeste},{sur},{este},{norte}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
              "spatialRel": "esriSpatialRelIntersects", "where": "1=1"}
    ids = sorted(pedir(servicio, capa, {**filtro, "returnIdsOnly": "true"}).get("objectIds") or [])
    print(f"{servicio.split('/')[-2]} capa {capa}: {len(ids)} elementos", flush=True)
    grupos = [ids[i:i + POR_PEDIDO] for i in range(0, len(ids), POR_PEDIDO)]

    def uno(g):
        return pedir(servicio, capa, {"objectIds": ",".join(map(str, g)), "outFields": campos, "returnGeometry": "true",
                                      "outSR": 4326, "maxAllowableOffset": simplificar})["features"]

    with ThreadPoolExecutor(4) as ex:
        return [f for parte in ex.map(uno, grupos) for f in parte]


# ---------- Geometría ----------
def centro(anillos):
    """Centro de área del anillo más grande."""
    anillo = max(anillos, key=len)
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(anillo, anillo[1:] + anillo[:1]):
        k = x0 * y1 - x1 * y0
        a += k
        cx += (x0 + x1) * k
        cy += (y0 + y1) * k
    if abs(a) < 1e-14:
        xs, ys = zip(*anillo)
        return sum(ys) / len(ys), sum(xs) / len(xs)
    return cy / (3 * a), cx / (3 * a)


def dentro(lat, lng, anillos):
    adentro = False
    for anillo in anillos:
        for (x0, y0), (x1, y1) in zip(anillo, anillo[1:] + anillo[:1]):
            if (y0 > lat) != (y1 > lat) and lng < (x1 - x0) * (lat - y0) / (y1 - y0) + x0:
                adentro = not adentro
    return adentro


def metros(a, b):
    return math.hypot((a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])), (a[0] - b[0]) * 110540)


def tramo_mas_largo(caminos):
    """Punto medio y ángulo del tramo más largo de una calle, para escribir su nombre encima."""
    mejor, largo = None, -1.0
    for c in caminos:
        for (x0, y0), (x1, y1) in zip(c, c[1:]):
            dx, dy = (x1 - x0) * math.cos(math.radians(y0)), y1 - y0
            d = math.hypot(dx, dy)
            if d > largo:
                ang = math.degrees(math.atan2(-dy, dx))  # en pantalla la y crece hacia abajo
                if ang > 90: ang -= 180
                if ang < -90: ang += 180
                mejor, largo = ((y0 + y1) / 2, (x0 + x1) / 2, round(ang)), d
    return mejor


class Rejilla:
    """Busca rápido los polígonos que pueden contener un punto."""
    def __init__(self, paso=0.005):
        self.paso, self.celdas = paso, defaultdict(list)

    def agregar(self, anillos, valor):
        xs = [p[0] for r in anillos for p in r]
        ys = [p[1] for r in anillos for p in r]
        for i in range(int(min(ys) // self.paso), int(max(ys) // self.paso) + 1):
            for j in range(int(min(xs) // self.paso), int(max(xs) // self.paso) + 1):
                self.celdas[(i, j)].append((anillos, valor))

    def buscar(self, lat, lng):
        for anillos, valor in self.celdas.get((int(lat // self.paso), int(lng // self.paso)), []):
            if dentro(lat, lng, anillos):
                return valor
        return None


class Vecinos:
    """Puntos con etiqueta, para no repetir lo mismo que ya trajo la otra fuente."""
    def __init__(self, paso=0.0005):
        self.paso, self.celdas = paso, defaultdict(list)

    def cerca(self, p, etiqueta, max_m):
        i, j = int(p[0] // self.paso), int(p[1] // self.paso)
        return any(e == etiqueta and metros(p, q) < max_m
                   for di in (-1, 0, 1) for dj in (-1, 0, 1) for q, e in self.celdas.get((i + di, j + dj), []))

    def agregar(self, p, etiqueta):
        self.celdas[(int(p[0] // self.paso), int(p[1] // self.paso))].append((p, etiqueta))


MAL_CODIFICADO = str.maketrans({"§": "º", "¥": "Ñ", "¤": "ñ", "�": "º"})  # COFOPRI guarda algunos textos en CP850


def limpiar(texto):
    t = " ".join(str(texto or "").translate(MAL_CODIFICADO).split())
    return "" if t in ("None", "-", "S/N", "0") else t


def zona(lat, lng):
    return f"{math.floor(lat / ZONA_GRADOS)}_{math.floor(lng / ZONA_GRADOS)}"


# ---------- Armado ----------
def main():
    ix = json.loads((DATOS / "indice.json").read_text(encoding="utf-8"))
    p = ix["paginas"]
    caja = (min(x["oeste"] for x in p), min(x["sur"] for x in p), max(x["este"] for x in p), max(x["norte"] for x in p))
    base = (round(caja[1], 2) - 0.01, round(caja[0], 2) - 0.01)
    entero = lambda lat, lng: [round((lat - base[0]) * ESCALA), round((lng - base[1]) * ESCALA)]

    pueblos = descargar(FORMAL, 3, "nom_pueblo", caja, 0.00005)
    habs = descargar(URBANO, 12, "NOM_HAB_UR", caja, 0.00005)
    mz_formal = descargar(FORMAL, 2, "nro_mzna", caja, 0.00002)
    lt_formal = descargar(FORMAL, 1, "nro_mzna,nro_lote", caja, 0.00001)
    mz_urbano = descargar(URBANO, 11, "ID_MZNA", caja, 0.00002)
    lt_urbano = descargar(URBANO, 10, "ID_MZNA,MZNA_MUNI,LOTE_MUNI", caja, 0.00001)
    vias_formal = descargar(FORMAL, 0, "nom_calle", caja, 0.00002)
    vias_urbano = descargar(URBANO, 0, "NOM_VIA", caja, 0.00002)

    # nombres de pueblos y urbanizaciones (los pueblos formalizados primero: son los nombres que usan las hojas)
    nombres, indice_nombre = [], {}
    def id_nombre(n):
        if n not in indice_nombre:
            indice_nombre[n] = len(nombres)
            nombres.append(n)
        return indice_nombre[n]
    rejilla = Rejilla()
    caja_nombre = {}
    zonas = defaultdict(lambda: {"h": [], "m": [], "l": [], "v": []})
    for fuente, campo in ((pueblos, "nom_pueblo"), (habs, "NOM_HAB_UR")):
        for f in fuente:
            n, g = limpiar(f["attributes"].get(campo)), f.get("geometry")
            if not (n and g and g.get("rings")):
                continue
            i = id_nombre(n)
            rejilla.agregar(g["rings"], i)
            ys = [p[1] for r in g["rings"] for p in r]
            xs = [p[0] for r in g["rings"] for p in r]
            c = caja_nombre.get(i, (90, 180, -90, -180))
            caja_nombre[i] = (min(c[0], min(ys)), min(c[1], min(xs)), max(c[2], max(ys)), max(c[3], max(xs)))
            lat, lng = centro(g["rings"])
            zonas[zona(lat, lng)]["h"].append([*entero(lat, lng), i])

    # lotes: Mz y Lt (formalización primero; del catastro urbano solo lo que no esté ya)
    lotes_vistos, direcciones = Vecinos(), 0
    letras_urbano = defaultdict(Counter)
    nonlocal_direcciones = [0]
    def agregar_lote(lat, lng, mz, lt):
        if lotes_vistos.cerca((lat, lng), (mz, lt), MISMO_LOTE_M):
            return
        nonlocal_direcciones[0] += 1 if mz else 0
        lotes_vistos.agregar((lat, lng), (mz, lt))
        nombre = rejilla.buscar(lat, lng)
        zonas[zona(lat, lng)]["l"].append([*entero(lat, lng), lt, mz, -1 if nombre is None else nombre])
    for f in lt_formal:
        a, g = f["attributes"], f.get("geometry")
        mz, lt = limpiar(a.get("nro_mzna")).upper(), limpiar(a.get("nro_lote")).upper()
        if lt and g and g.get("rings"):
            agregar_lote(*centro(g["rings"]), mz, lt)
    for f in lt_urbano:
        a, g = f["attributes"], f.get("geometry")
        mz, lt = limpiar(a.get("MZNA_MUNI")).upper(), limpiar(a.get("LOTE_MUNI")).upper()
        if mz:
            letras_urbano[a.get("ID_MZNA")][mz] += 1
        if lt and g and g.get("rings"):
            agregar_lote(*centro(g["rings"]), mz, lt)

    # manzanas: su letra o número en el centro
    mz_vistas = Vecinos(0.002)
    def agregar_mz(lat, lng, mz):
        if mz_vistas.cerca((lat, lng), mz, MISMA_MZ_M):
            return
        mz_vistas.agregar((lat, lng), mz)
        zonas[zona(lat, lng)]["m"].append([*entero(lat, lng), mz])
    for f in mz_formal:
        mz, g = limpiar(f["attributes"].get("nro_mzna")).upper(), f.get("geometry")
        if mz and g and g.get("rings"):
            agregar_mz(*centro(g["rings"]), mz)
    for f in mz_urbano:
        letra, g = letras_urbano.get(f["attributes"].get("ID_MZNA")), f.get("geometry")
        if letra and g and g.get("rings"):
            agregar_mz(*centro(g["rings"]), letra.most_common(1)[0][0])

    # calles: el nombre sobre su tramo más largo (sin repetir la misma calle de las dos fuentes)
    calles_vistas = Vecinos(0.002)
    for fuente, campo in ((vias_urbano, "NOM_VIA"), (vias_formal, "nom_calle")):
        for f in fuente:
            n, g = limpiar(f["attributes"].get(campo)), f.get("geometry")
            if not (n and g and g.get("paths")):
                continue
            t = tramo_mas_largo(g["paths"])
            if t and not calles_vistas.cerca((t[0], t[1]), n.upper(), 60):
                calles_vistas.agregar((t[0], t[1]), n.upper())
                zonas[zona(t[0], t[1])]["v"].append([*entero(t[0], t[1]), t[2], n])

    # cada zona lleva solo los nombres de pueblos que usa
    SALIDA.mkdir(parents=True, exist_ok=True)
    for viejo in SALIDA.glob("*.json"):
        viejo.unlink()
    for k, z in zonas.items():
        usados = sorted({h[2] for h in z["h"]} | {l[4] for l in z["l"] if l[4] >= 0})
        local = {g: i for i, g in enumerate(usados)}
        z["h"] = [[y, x, local[i]] for y, x, i in z["h"]]
        z["l"] = [[y, x, lt, mz, local.get(i, -1)] for y, x, lt, mz, i in z["l"]]
        z["n"] = [nombres[g] for g in usados]
        (SALIDA / f"{k}.json").write_text(json.dumps(z, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (SALIDA / "info.json").write_text(json.dumps(
        {"fuente": "COFOPRI - Geo Llaqta (Formalización y Catastro Urbano)", "base": list(base), "escala": ESCALA,
         "zona_grados": ZONA_GRADOS, "zonas": sorted(zonas),
         "pueblos": [[n, *entero(c[0], c[1]), *entero(c[2], c[3])] for n, c in
                     ((nombres[i], caja_nombre[i]) for i in range(len(nombres)))]}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    t = lambda c: sum(len(z[c]) for z in zonas.values())
    print(f"{len(zonas)} zonas · {t('m')} manzanas · {t('l')} lotes · {t('v')} calles · {len(nombres)} pueblos · "
          f"{nonlocal_direcciones[0]} lotes con manzana")


if __name__ == "__main__":
    main()
