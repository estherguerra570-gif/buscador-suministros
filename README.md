# Buscador de Suministros

App web para celular: busca un suministro por número, muestra su ubicación GPS, dibuja el recorrido en moto
y arma la ruta del día optimizada.

**App:** https://buscador-suministros.vercel.app/ (también en https://estherguerra570-gif.github.io/buscador-suministros/)

## Cómo se obtiene el GPS
El PDF "MODULAR BT + SUMINISTROS AREQUIPA" es un GeoPDF: cada página trae las coordenadas GPS de sus
4 esquinas. El script lee la posición de cada número dentro de la página y la convierte a lat/lng por
interpolación entre esas esquinas.

Leyenda usada para filtrar:
- Suministro: número verde (`#267300`) o anaranjado (`#a87000`)
- Poste: número rojo (`#a83800`)
- Subestación: triángulo (se ignora)

Se toman números de 1 a 6 cifras.

## Ubicaciones corregidas
Desde el menú (“Corregir ubicación”) se busca un suministro y se marca dónde está realmente (GPS o tocando
el mapa). Se guarda en el celular y se puede descargar como CSV. Para que una corrección valga para todos,
se agrega a `docs/data/correcciones.json` con la forma `{"123456": {"lat": -16.39, "lng": -71.53, "nota": ""}}`.

## Rutas
- Dentro de la zona del plano: se sigue la red de baja tensión del PDF (líneas azules poste a poste, que van
  por las calles); los tramos sueltos se unen solo si no atraviesan una manzana (`extraer/red.py`).
- Fuera del plano: calles de OpenStreetMap vía OSRM (servicio público gratuito).
- Orden de visita: vecino más cercano + 2-opt, calculado en el celular.

## Estructura
- `extraer/extraer.py`: genera `docs/data/indice.json` (para buscar), `docs/data/zonas/*.json` (detalle por zonas
  de ~1 km: calles, red y postes) y las imágenes `docs/data/planos/pNNN.jpg`
- `extraer/red.py`: red de calles y contornos de manzanas
- `extraer/icono.py`: genera los íconos de la app
- `docs/`: la app (HTML + JS, sin servidor), publicada tal cual por GitHub Pages. Mapa con Leaflet + OpenStreetMap (giro con leaflet-rotate).

## Regenerar los datos
```
python extraer/extraer.py "C:\Users\USER\Downloads\MODULAR BT + SUMINISTROS AREQUIPA.pdf"
```
Para probar con pocas páginas: `--desde 1 --hasta 5`. Después, subir `VERSION` en `docs/sw.js`.

## Probar en local
```
cd docs
python -m http.server 8765 --bind 0.0.0.0
```
Abrir `http://localhost:8765` (o `http://IP-DE-LA-PC:8765` desde el celular en la misma wifi).
La ubicación del celular solo funciona con HTTPS (en GitHub Pages).
