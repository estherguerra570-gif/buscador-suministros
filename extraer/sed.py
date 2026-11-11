"""
Extrae las subestaciones (SED) del GeoPDF "MODULAR BT + SUMINISTROS AREQUIPA" y les calcula el GPS.

En el plano cada SED es un triangulo con dos numeros negros en negrita (Arial-Bold) debajo:
arriba el numero de la SED (ej. 4568) y abajo la potencia en kVA (ej. 100).
Con la "RELACION SED MODULAR BT.xlsx" (columna B = SED) se descartan numeros que no son SED y se agrega
la direccion y el modular de cada una.

Uso:
    python extraer/sed.py "ruta/al.pdf" "ruta/RELACION SED MODULAR BT.xlsx"
Genera docs/data/sed.json
"""
import argparse
import json
import re
from datetime import datetime

import pymupdf

from extraer import SALIDA_DATOS, a_gps, contiene, leer_viewports, marco, toca_borde


def relacion(xlsx):
    """SED -> (direccion, modular) desde el Excel (columna B = SED)."""
    import openpyxl
    hoja = openpyxl.load_workbook(xlsx, read_only=True, data_only=True).worksheets[0]
    datos = {}
    for fila in hoja.iter_rows(values_only=True):
        if len(fila) < 4 or fila[1] is None:
            continue
        sed = str(fila[1]).strip().removesuffix(".0")
        if sed.isdigit():
            datos[str(int(sed))] = (str(fila[2] or "").strip(), str(fila[3] or "").strip().removesuffix(".0"))
    return datos


def etiquetas(page):
    """Numeros negros en negrita. La SED (4 o 5 cifras, desde 1000) va con su potencia en kVA (menos de 1000)
    justo debajo, a veces encima o en la misma linea ("1228 200", "1120 - 160")."""
    nums = []
    for b in page.get_text("rawdict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                t = "".join(c["c"] for c in s["chars"]).strip()
                m = re.fullmatch(r"(P?)\s*(\d{1,6})(?:\s*-?\s*(\d{1,4}))?", t)
                if s["color"] == 0 and "Bold" in s["font"] and m:
                    x0, y0, x1, y1 = s["bbox"]
                    nums.append({"t": m.group(2), "p": bool(m.group(1)), "kva": m.group(3), "bbox": s["bbox"],
                                 "x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "alto": y1 - y0})
    potencias = [b for b in nums if int(b["t"]) < 1000]
    for a in nums:
        if int(a["t"]) < 1000:
            continue
        junto = [b for b in potencias if abs(b["y"] - a["y"]) < 0.9 * a["alto"] and abs(b["x"] - a["x"]) < a["alto"]]
        kva = a["kva"] or (min(junto, key=lambda b: abs(b["y"] - a["y"]))["t"] if junto else "")
        yield a, kva


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("xlsx")
    args = ap.parse_args()
    lista = relacion(args.xlsx)
    doc = pymupdf.open(args.pdf)

    seds, en_borde, fuera_de_lista, cortadas, particulares, usadas_borde = {}, {}, {}, 0, {}, 0
    for pno in range(doc.page_count):
        page = doc[pno]
        alto = page.mediabox.height
        vps = leer_viewports(doc, page)
        if not vps:
            continue
        rect = marco(vps, alto)
        for it, kva in etiquetas(page):
            n = str(int(it["t"]))
            borde = toca_borde(it["bbox"], rect)   # puede salir cortada: solo si no aparece entera en otra hoja
            if it["p"]:
                particulares[n] = particulares.get(n, 0) + 1
            vp = next((v for v in vps if contiene(v, it["x"], it["y"], alto)), vps[0])
            lat, lng = a_gps(vp, it["x"], it["y"], alto)
            if n not in lista:
                fuera_de_lista.setdefault(n, (pno + 1, kva))
                continue
            dato = {"n": n, "lat": round(lat, 6), "lng": round(lng, 6), "kva": kva, "p": pno + 1,
                    "px": round(it["x"] / page.rect.width, 5), "py": round(it["y"] / page.rect.height, 5)}
            if borde:
                cortadas += 1
                en_borde.setdefault(n, dato)
            else:
                seds.setdefault(n, dato)
    for n, dato in en_borde.items():
        if n not in seds:
            seds[n] = dato
            usadas_borde += 1

    orden = sorted(seds.values(), key=lambda s: int(s["n"]))
    base = [min(s["lat"] for s in orden), min(s["lng"] for s in orden)]
    salida = {
        "generado": datetime.now().isoformat(timespec="seconds"), "base": base,
        "n": [s["n"] for s in orden],
        "la": [round((s["lat"] - base[0]) * 1e6) for s in orden],
        "lo": [round((s["lng"] - base[1]) * 1e6) for s in orden],
        "kva": [s["kva"] for s in orden],
        "p": [s["p"] for s in orden],
        "px": [s["px"] for s in orden],
        "py": [s["py"] for s in orden],
        "d": [lista[s["n"]][0] for s in orden],
        "m": [lista[s["n"]][1] for s in orden],
    }
    (SALIDA_DATOS / "sed.json").write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")),
                                           encoding="utf-8")
    faltan = sorted(set(lista) - set(seds), key=int)
    print(f"SED ubicadas: {len(seds)} de {len(lista)} del Excel")
    print(f"En el borde de la hoja: {cortadas}; usadas porque no estaban enteras en otra hoja: {usadas_borde}")
    print(f"Numeros negros que no estan en el Excel: {len(fuera_de_lista)} -> {list(fuera_de_lista.items())[:15]}")
    print(f"Con P adelante (P4232): {len(particulares)}, de ellas en el Excel: {sum(n in lista for n in particulares)}")
    print(f"Del Excel sin ubicar en el plano: {len(faltan)} -> {faltan[:40]}")


if __name__ == "__main__":
    main()
