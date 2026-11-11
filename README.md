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
- Subestación (SED): triángulo con dos números negros en negrita: la SED arriba y los kVA abajo (`extraer/sed.py`)

Se toman números de 1 a 6 cifras.

## Ubicaciones corregidas
Desde el menú (“Corregir ubicación”) se busca un suministro y se marca dónde está realmente (GPS o tocando
el mapa). La corrección vale para todos los usuarios:
- Se guarda en Supabase (tabla `correcciones`); cada cambio queda en `historial_correcciones` con quién y cuándo.
- Todos los celulares la aplican al abrir la app y al instante mientras está abierta (tiempo real). Sin señal
  queda pendiente en el celular y se envía sola después.
- En “Ver en el plano” se dibuja la ubicación corregida sobre la hoja del PDF (`geo` de cada página en
  `indice.json`: transformación lat/lng → posición en la imagen).

## Inicio de sesión (Supabase + Google)
- Proyecto de Supabase `buscador-suministros` (ref `wknalygmlzghpucyvuoi`, São Paulo, plan gratis).
- Se entra con Google (`docs/sesion.js`). La administradora (`estherguerra570@gmail.com`) ve en el menú
  “Usuarios y actividad”: quién usa la app, su último acceso y el historial de correcciones.
- Tablas y permisos: `supabase/migrations/`. Configuración de acceso: `supabase/config.toml`
  (`npx supabase config push`). Las claves secretas van en `supabase/.env`, que no se sube.
- Supabase gratis pausa el proyecto tras 7 días sin uso; se reactiva desde su panel.
- Panel de la administradora: `docs/admin.html` (Resumen, Usuarios, En vivo). La app anota acciones en `actividad`
  y el tiempo de uso en `tramos_uso` (latido cada minuto mientras está a la vista, `docs/sesion.js`). Solo la
  administradora puede leerlos; `perfiles.bloqueado` deja a un usuario sin acceso. No se guarda el GPS.

## Rutas
- Hasta un suministro buscado: en vivo con el GPS. Compiten las calles de OpenStreetMap (OSRM con alternativas)
  y la red del plano (tiene calles que OSM no conoce); gana la más corta. Se recalcula al avanzar 40 m o al
  salirse 35 m del camino.
- Dentro de la zona del plano: se sigue la red de baja tensión del PDF (líneas azules poste a poste, que van
  por las calles); los tramos sueltos se unen solo si no atraviesan una manzana (`extraer/red.py`).
- Fuera del plano: calles de OpenStreetMap vía OSRM (servicio público gratuito).
- Orden de visita: vecino más cercano + 2-opt, calculado en el celular.

## Subir la jornada (foto o PDF de la hoja)
- `docs/jornada.js`: el trabajador elige cómo subir la hoja de cortes o reconexiones: tomar foto con la cámara,
  elegir fotos de la galería o subir el archivo (PDF).
- Foto: primero se revisa en el celular (tamaño, luz y nitidez = varianza del laplaciano; la hoja real nítida da ~1760,
  ilegible < 110). Si está bien se achica a 2000 px y la lee la Edge Function `supabase/functions/leer-jornada`
  (Gemini, dos lecturas por separado; si un modelo está saturado pasa al siguiente: `GEMINI_MODELOS`). La clave `GEMINI_API_KEY` es un secreto de Supabase, nunca va al celular.
  Límite: 20 lecturas por persona al día (tabla `lecturas_jornada`). Las fotos no se guardan.
- PDF: se lee en el celular con pdf.js (`docs/lib/pdfjs`), sin IA: cada fila es OT (8 dígitos) seguido del CONTRATO.
- Antes de crear la ruta se revisa la lista: no está en el mapa, muy lejos de los demás (> 1,5 km del más cercano),
  leído distinto en las dos lecturas o con dudas. Se puede corregir el número. "Deshacer" vuelve a la ruta anterior.

## Manzanas, lotes y calles (COFOPRI)
- `extraer/catastro.py` descarga del Geo Llaqta de COFOPRI (datos públicos) las capas de Formalización (pueblos:
  Mz y Lt) y del Catastro Urbano (Mz/Lt municipales, vías, habilitaciones) y genera `docs/data/catastro/*.json` por
  zonas de ~1 km más `info.json`. Nunca se descarga el dueño del lote.
- `docs/catastro.js`: capa "Mz, lotes y calles (COFOPRI)" y la Mz/Lt aproximada en la ficha de cada suministro. Cubre ~56 % de los suministros; los nombres de COFOPRI pueden no coincidir con los
  de la hoja (por ejemplo "PJV Túpac Amaru" frente a "Urb. Túpac Amaru").
- Regenerar: `python extraer/catastro.py` y subir `CACHE_CATASTRO` en `docs/sw.js`.

## SED (subestaciones)
- `extraer/sed.py` lee del plano los números negros en negrita de cada SED (con su potencia en kVA) y los cruza con la
  "RELACION SED MODULAR BT.xlsx" (columna B = SED; también trae dirección y modular). Ubica 4551 de 4562.
  Las que tocan el borde de una hoja solo se usan si no aparecen enteras en otra. Genera `docs/data/sed.json`.
- `docs/sed.js`: menú ☰ > "Buscar SED" pone el buscador a buscar SED (con "Volver a suministros"); la ficha de la SED (kVA, dirección, modular, ver en el plano,
  recorrido); capa "SED (subestaciones)" en el mapa; y en la ficha de cada suministro "SED cercana" (la más cercana a
  menos de 600 m, por distancia: no es la red eléctrica).
- Regenerar: `python extraer/sed.py "...MODULAR BT + SUMINISTROS AREQUIPA.pdf" "...RELACION SED MODULAR BT.xlsx"`.

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
Para probar con pocas páginas: `--desde 1 --hasta 5`. Después, subir `VERSION` y `CACHE_DATOS` en `docs/sw.js` (si solo cambia el código, basta `VERSION`).

## Probar en local
```
cd docs
python -m http.server 8765 --bind 0.0.0.0
```
Abrir `http://localhost:8765` (o `http://IP-DE-LA-PC:8765` desde el celular en la misma wifi).
La ubicación del celular solo funciona con HTTPS (en GitHub Pages).
