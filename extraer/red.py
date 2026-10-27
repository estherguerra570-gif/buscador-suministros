"""
Red de calles a partir del plano: se usa la red de baja tensión (líneas azules poste a poste),
que corre por las calles, y los contornos de manzanas para no "atravesar" casas.

Todo se calcula en metros sobre una proyección local simple (suficiente para distancias < 50 km).
"""
import math
from collections import defaultdict

TOL_NODO_M = 2.5     # extremos de líneas a menos de esto se consideran el mismo poste
MAX_UNION_M = 45     # distancia máxima para unir tramos de red sueltos
CELDA_M = 50         # tamaño de celda del índice espacial

LAT0 = -16.3
K_LAT = 110574.0
K_LNG = 111320.0 * math.cos(math.radians(LAT0))


def a_metros(lat, lng):
    return lng * K_LNG, lat * K_LAT


def _cruza(p1, p2, p3, p4):
    """True si los segmentos p1-p2 y p3-p4 se cruzan (sin contar tocarse en un extremo)."""
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2 = orient(p3, p4, p1), orient(p3, p4, p2)
    d3, d4 = orient(p1, p2, p3), orient(p1, p2, p4)
    return d1 * d2 < 0 and d3 * d4 < 0


class Red:
    def __init__(self):
        self.nodos = []            # [(lat, lng)]
        self.xy = []               # [(x, y)] en metros
        self.aristas = set()       # {(i, j)} con i < j
        self.indice_nodos = defaultdict(list)
        self.manzanas = []         # [[(lat, lng), ...]]
        self.indice_muros = defaultdict(list)  # celda -> [(xy_a, xy_b)]

    @staticmethod
    def _celda(x, y):
        return int(x // CELDA_M), int(y // CELDA_M)

    def _vecinos(self, x, y, indice):
        cx, cy = self._celda(x, y)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                yield from indice[(cx + dx, cy + dy)]

    def nodo(self, lat, lng):
        x, y = a_metros(lat, lng)
        for i in self._vecinos(x, y, self.indice_nodos):
            if math.dist(self.xy[i], (x, y)) <= TOL_NODO_M:
                return i
        i = len(self.nodos)
        self.nodos.append((lat, lng))
        self.xy.append((x, y))
        self.indice_nodos[self._celda(x, y)].append(i)
        return i

    def agregar_tramo(self, a, b):
        i, j = self.nodo(*a), self.nodo(*b)
        if i != j:
            self.aristas.add((min(i, j), max(i, j)))

    def agregar_manzana(self, puntos):
        self.manzanas.append(puntos)
        xy = [a_metros(*p) for p in puntos]
        for a, b in zip(xy, xy[1:]):
            # se registra el muro en todas las celdas que toca su caja
            (cx0, cy0), (cx1, cy1) = self._celda(*a), self._celda(*b)
            for cx in range(min(cx0, cx1), max(cx0, cx1) + 1):
                for cy in range(min(cy0, cy1), max(cy0, cy1) + 1):
                    self.indice_muros[(cx, cy)].append((a, b))

    def atraviesa_manzana(self, a, b):
        """a, b en metros. True si el segmento cruza algún contorno de manzana."""
        (cx0, cy0), (cx1, cy1) = self._celda(*a), self._celda(*b)
        vistos = set()
        for cx in range(min(cx0, cx1), max(cx0, cx1) + 1):
            for cy in range(min(cy0, cy1), max(cy0, cy1) + 1):
                for muro in self.indice_muros[(cx, cy)]:
                    if id(muro) in vistos:
                        continue
                    vistos.add(id(muro))
                    if _cruza(a, b, *muro):
                        return True
        return False

    def unir_tramos_sueltos(self):
        """Une componentes separadas de la red con el enlace más corto que no cruce manzanas."""
        padre = list(range(len(self.nodos)))

        def raiz(i):
            while padre[i] != i:
                padre[i] = padre[padre[i]]
                i = padre[i]
            return i

        for i, j in self.aristas:
            padre[raiz(i)] = raiz(j)

        candidatos = []
        for i, (x, y) in enumerate(self.xy):
            for j in self._vecinos(x, y, self.indice_nodos):
                if j > i and raiz(i) != raiz(j):
                    d = math.dist(self.xy[i], self.xy[j])
                    if d <= MAX_UNION_M:
                        candidatos.append((d, i, j))
        unidas = 0
        for d, i, j in sorted(candidatos):
            if raiz(i) != raiz(j) and not self.atraviesa_manzana(self.xy[i], self.xy[j]):
                padre[raiz(i)] = raiz(j)
                self.aristas.add((i, j))
                unidas += 1
        componentes = len({raiz(i) for i in range(len(self.nodos))})
        return unidas, componentes

    def nodo_de_acceso(self, lat, lng, max_m=80):
        """Nodo de la red más cercano a un punto, prefiriendo uno al que se llegue sin cruzar manzanas."""
        x, y = a_metros(lat, lng)
        cercanos = sorted(
            (math.dist(self.xy[i], (x, y)), i)
            for i in self._vecinos(x, y, self.indice_nodos)
        )
        cercanos = [(d, i) for d, i in cercanos if d <= max_m]
        if not cercanos:
            return None
        for d, i in cercanos[:8]:
            if not self.atraviesa_manzana((x, y), self.xy[i]):
                return i
        return cercanos[0][1]

    def exportar(self):
        return {
            "n": [[round(a, 6), round(b, 6)] for a, b in self.nodos],
            "a": sorted([i, j] for i, j in self.aristas),
        }

    def exportar_manzanas(self):
        # cada manzana como lista plana [lat, lng, lat, lng, ...] para ahorrar espacio
        return [[round(v, 6) for p in m for v in p] for m in self.manzanas]
