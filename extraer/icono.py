"""Genera los iconos de la app (pin verde con rayo) en docs/."""
from pathlib import Path
import pymupdf

web = Path(__file__).resolve().parent.parent / "docs"
for lado in (192, 512):
    doc = pymupdf.open()
    pg = doc.new_page(width=100, height=100)
    pg.draw_rect(pg.rect, color=None, fill=(0.122, 0.435, 0.263))
    pg.draw_circle((50, 42), 24, color=None, fill=(1, 1, 1))
    pg.draw_polyline([(30, 52), (50, 82), (70, 52)], color=None, fill=(1, 1, 1), closePath=True)
    pg.draw_polyline([(54, 26), (40, 46), (50, 46), (44, 60), (60, 38), (50, 38)], color=None,
                     fill=(0.149, 0.451, 0), closePath=True)
    pg.get_pixmap(matrix=pymupdf.Matrix(lado / 100, lado / 100)).save(web / f"icono-{lado}.png")
