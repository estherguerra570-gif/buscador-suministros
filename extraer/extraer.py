"""
Extrae los suministros del GeoPDF "MODULAR BT + SUMINISTROS AREQUIPA" y calcula su GPS.

Uso:
    python extraer.py "ruta/al.pdf" --desde 1 --hasta 5

Genera:
    docs/data/indice.json        -> numero, pagina, lat, lng y color de cada suministro (para buscar)
    docs/data/zonas/<zona>.json  -> detalle por zonas de ~1 km: poste, red de calles y manzanas
    docs/data/planos/pNNN.jpg    -> imagen de cada pagina para el visor de planos

Leyenda del plano:
    verde (#267300) y anaranjado (#a87000), fuente Verdana -> suministro
    rojo (#a83800)                                          -> poste
    triangulo                                               -> subestacion (se ignora)
"""
import argparse
import json
import math
import re
from datetime import datetime
from pathlib import Path

import pymupdf

from red import Red

COLORES_SUMINISTRO = {0x267300: "verde", 0xA87000: "naranja"}
COLOR_POSTE = 0xA83800
COLOR_RED_BT = (0.0, 0.36, 0.9)   # lineas azules poste a poste (red de baja tension)
DPI_PLANO = 200
RADIO_POSTE_PT = 45  # distancia maxima (puntos PDF, ~1 m c/u) para asociar un poste cercano
MARGEN_BORDE_PT = 4  # etiquetas a menos de esto del borde de la hoja se descartan (salen cortadas)
ZONA_GRADOS = 0.01   # los datos de detalle se parten en zonas de ~1.1 km para que el celular baje solo lo que usa

RAIZ = Path(__file__).resolve().parent.parent
SALIDA_DATOS = RAIZ / "docs" / "data"


def leer_viewports(doc, page):
    """Devuelve los viewports georreferenciados de la pagina: BBox + esquinas GPS."""
    tipo, valor = doc.xref_get_key(page.xref, "VP")
    if tipo == "null":
        return []
    viewports = []
    for vp in re.findall(r"<<(.*?)>>", valor, re.S):
        bbox = re.search(r"/BBox\s*\[([^\]]*)\]", vp)
        meas = re.search(r"/Measure\s+(\d+)\s+0\s+R", vp)
        if not (bbox and meas):
            continue
        m = doc.xref_object(int(meas.group(1)), compressed=True)
        gpts = [float(x) for x in re.search(r"/GPTS\s*\[([^\]]*)\]", m).group(1).split()]
        lpts = [float(x) for x in re.search(r"/LPTS\s*\[([^\]]*)\]", m).group(1).split()]
        esquinas = {}
        for i in range(0, 8, 2):
            esquinas[(round(lpts[i]), round(lpts[i + 1]))] = (gpts[i], gpts[i + 1])
        viewports.append({"bbox": [float(x) for x in bbox.group(1).split()], "esquinas": esquinas})
    return viewports


def a_gps(vp, x, y, alto_pagina):
    """Convierte un punto de PyMuPDF (origen arriba-izquierda) a (lat, lng) por interpolacion bilineal."""
    bx0, by0, bx1, by1 = vp["bbox"]
    u = (x - bx0) / (bx1 - bx0)
    v = ((alto_pagina - y) - by0) / (by1 - by0)
    e = vp["esquinas"]
    g00, g01, g11, g10 = e[(0, 0)], e[(0, 1)], e[(1, 1)], e[(1, 0)]
    lat = (1 - u) * (1 - v) * g00[0] + (1 - u) * v * g01[0] + u * v * g11[0] + u * (1 - v) * g10[0]
    lng = (1 - u) * (1 - v) * g00[1] + (1 - u) * v * g01[1] + u * v * g11[1] + u * (1 - v) * g10[1]
    return lat, lng


def contiene(vp, x, y, alto_pagina):
    bx0, by0, bx1, by1 = vp["bbox"]
    py = alto_pagina - y
    return min(bx0, bx1) <= x <= max(bx0, bx1) and min(by0, by1) <= py <= max(by0, by1)


def textos(page):
    """Cada span de texto con su color y el centro de su caja."""
    for bloque in page.get_text("rawdict")["blocks"]:
        for linea in bloque.get("lines", []):
            for span in linea["spans"]:
                t = "".join(c["c"] for c in span["chars"]).strip()
                if not t:
                    continue
                x0, y0, x1, y1 = span["bbox"]
                yield {"t": t, "color": span["color"], "font": span["font"], "bbox": (x0, y0, x1, y1),
                       "x": (x0 + x1) / 2, "y": (y0 + y1) / 2}


def marco(vps, alto_pagina):
    """Rectangulo del mapa en coordenadas PyMuPDF (lo que queda fuera se recorta en el plano)."""
    xs = [x for v in vps for x in (v["bbox"][0], v["bbox"][2])]
    ys = [alto_pagina - y for v in vps for y in (v["bbox"][1], v["bbox"][3])]
    return min(xs), min(ys), max(xs), max(ys)


def toca_borde(bbox, rect, margen=MARGEN_BORDE_PT):
    """Las etiquetas que tocan el borde de la hoja salen cortadas ("447" en vez de "447132");
    la etiqueta completa aparece en la hoja vecina, porque las hojas se superponen."""
    x0, y0, x1, y1 = bbox
    rx0, ry0, rx1, ry1 = rect
    return x0 < rx0 + margen or y0 < ry0 + margen or x1 > rx1 - margen or y1 > ry1 - margen


def _mismo_color(a, b):
    return a is not None and all(abs(x - y) < 0.02 for x, y in zip(a, b))


def lineas(page, vps, red):
    """Agrega a la red los tramos azules (poste a poste) y los contornos de manzanas de la pagina."""
    alto = page.mediabox.height

    def gps(punto):
        vp = next((v for v in vps if contiene(v, punto.x, punto.y, alto)), vps[0])
        return a_gps(vp, punto.x, punto.y, alto)

    for d in page.get_drawings():
        if d["type"] != "s" or any(it[0] != "l" for it in d["items"]):
            continue
        if _mismo_color(d.get("color"), COLOR_RED_BT):
            for _, a, b in d["items"]:
                red.agregar_tramo(gps(a), gps(b))
        elif _mismo_color(d.get("color"), (0, 0, 0)) and (d.get("width") or 0) < 0.1:
            # contorno de manzana (linea negra fina de varios tramos)
            red.agregar_manzana([gps(d["items"][0][1])] + [gps(it[2]) for it in d["items"]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--desde", type=int, default=1)
    ap.add_argument("--hasta", type=int, default=None)
    ap.add_argument("--sin-planos", action="store_true", help="no generar imagenes de paginas")
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    hasta = min(args.hasta or doc.page_count, doc.page_count)
    (SALIDA_DATOS / "planos").mkdir(parents=True, exist_ok=True)

    suministros, paginas, repetidos, colores_raros = {}, [], [], {}
    cortados = 0
    red = Red()

    for pno in range(args.desde - 1, hasta):
        page = doc[pno]
        alto = page.mediabox.height
        vps = leer_viewports(doc, page)
        if not vps:
            print(f"pagina {pno + 1}: sin georreferencia, se omite")
            continue

        lineas(page, vps, red)
        items = list(textos(page))
        rect = marco(vps, alto)
        postes = [i for i in items if i["color"] == COLOR_POSTE and i["t"].isdigit()]
        cuenta = 0
        for it in items:
            if not re.fullmatch(r"\d{3,6}", it["t"]):
                continue
            if toca_borde(it["bbox"], rect):
                cortados += 1
                continue
            color = COLORES_SUMINISTRO.get(it["color"])
            if color is None:
                if it["font"].startswith("Verdana"):
                    colores_raros.setdefault("#%06x" % it["color"], []).append(it["t"])
                continue
            vp = next((v for v in vps if contiene(v, it["x"], it["y"], alto)), vps[0])
            lat, lng = a_gps(vp, it["x"], it["y"], alto)
            cercano = min(postes, key=lambda p: math.dist((p["x"], p["y"]), (it["x"], it["y"])), default=None)
            poste = None
            if cercano and math.dist((cercano["x"], cercano["y"]), (it["x"], it["y"])) <= RADIO_POSTE_PT:
                poste = cercano["t"]
            registro = {"n": it["t"], "p": pno + 1, "lat": round(lat, 6), "lng": round(lng, 6),
                        "c": color, "poste": poste,
                        # posicion relativa dentro de la imagen del plano (0..1)
                        "px": round(it["x"] / page.rect.width, 5), "py": round(it["y"] / page.rect.height, 5)}
            if it["t"] in suministros:
                repetidos.append((it["t"], suministros[it["t"]]["p"], pno + 1))
                continue
            suministros[it["t"]] = registro
            cuenta += 1

        archivo = f"p{pno + 1:03d}.jpg"
        if not args.sin_planos:
            page.get_pixmap(dpi=DPI_PLANO).save(SALIDA_DATOS / "planos" / archivo, jpg_quality=70)
        e = vps[0]["esquinas"]
        paginas.append({"p": pno + 1, "plano": f"data/planos/{archivo}",
                        "ancho": page.rect.width, "alto": page.rect.height,
                        "sur": min(c[0] for c in e.values()), "norte": max(c[0] for c in e.values()),
                        "oeste": min(c[1] for c in e.values()), "este": max(c[1] for c in e.values())})
        print(f"pagina {pno + 1}: {cuenta} suministros")

    unidas, componentes = red.unir_tramos_sueltos()
    sin_acceso = 0
    for s in suministros.values():
        s["nodo"] = red.nodo_de_acceso(s["lat"], s["lng"])
        sin_acceso += s["nodo"] is None

    zonas = exportar(suministros, paginas, red, Path(args.pdf).name)

    print(f"\nTotal: {len(suministros)} suministros en {len(paginas)} paginas, {zonas} zonas")
    print(f"Etiquetas descartadas por estar cortadas en el borde: {cortados}")
    print(f"Red: {len(red.nodos)} nodos, {len(red.aristas)} tramos ({unidas} uniones agregadas), "
          f"{componentes} zonas sin conexion entre si; {len(red.manzanas)} manzanas")
    print(f"Suministros sin calle cercana: {sin_acceso}")
    if repetidos:
        print(f"Repetidos (se conserva la primera aparicion): {len(repetidos)}")
        for n, p1, p2 in repetidos[:20]:
            print(f"  {n}: pag {p1} y pag {p2}")
    if colores_raros:
        print("Numeros Verdana con color no reconocido (revisar):")
        for c, ns in colores_raros.items():
            print(f"  {c}: {len(ns)} -> {ns[:10]}")


def zona(lat, lng):
    return f"{math.floor(lat / ZONA_GRADOS)}_{math.floor(lng / ZONA_GRADOS)}"


def escribir_json(ruta, datos):
    ruta.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def exportar(suministros, paginas, red, origen):
    """
    data/indice.json        -> lo necesario para buscar y ubicar (se descarga al abrir la app):
                               numeros, lat/lng en enteros (1e-6 grados sobre una base), color y pagina.
    data/zonas/<zona>.json  -> detalle de cada zona de ~1 km (se descarga al usarla):
                               suministros (poste, posicion en el plano, nodo de acceso), manzanas y red.
    """
    lista = sorted(suministros.values(), key=lambda s: s["n"])
    base_lat = min(s["lat"] for s in lista)
    base_lng = min(s["lng"] for s in lista)
    indice = {
        "generado": datetime.now().isoformat(timespec="seconds"), "origen": origen,
        "zona_grados": ZONA_GRADOS, "base": [base_lat, base_lng], "paginas": paginas,
        "n": ",".join(s["n"] for s in lista),
        "la": [round((s["lat"] - base_lat) * 1e6) for s in lista],
        "lo": [round((s["lng"] - base_lng) * 1e6) for s in lista],
        "c": "".join("1" if s["c"] == "naranja" else "0" for s in lista),
        "p": [s["p"] for s in lista],
    }
    escribir_json(SALIDA_DATOS / "indice.json", indice)

    def nodo(i):
        return [round(v, 6) for v in red.nodos[i]] if i is not None else None

    detalle = {}
    def de(z):
        return detalle.setdefault(z, {"s": {}, "m": [], "r": []})

    for s in lista:
        de(zona(s["lat"], s["lng"]))["s"][s["n"]] = [s["poste"], s["px"], s["py"], nodo(s["nodo"])]
    for m in red.manzanas:
        de(zona(*m[0]))["m"].append([round(v, 6) for p in m for v in p])
    for i, j in red.aristas:
        a, b = red.nodos[i], red.nodos[j]
        de(zona(*a))["r"].append([round(a[0], 6), round(a[1], 6), round(b[0], 6), round(b[1], 6)])

    carpeta = SALIDA_DATOS / "zonas"
    carpeta.mkdir(parents=True, exist_ok=True)
    for viejo in carpeta.glob("*.json"):
        viejo.unlink()
    for z, d in detalle.items():
        escribir_json(carpeta / f"{z}.json", d)
    viejo = SALIDA_DATOS / "suministros.json"
    if viejo.exists():
        viejo.unlink()
    return len(detalle)


if __name__ == "__main__":
    main()
