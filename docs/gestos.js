"use strict";
// Gestos con dos dedos más precisos que los de leaflet-rotate:
// - el mapa gira solo si se tuercen los dedos a propósito (más de UMBRAL_GIRO grados); al pellizcar para
//   acercar o alejar ya no se tuerce sin querer
// - el giro y el zoom se aplican juntos una vez por cuadro de pantalla, en lugar de en cada evento táctil
(function () {
  const UMBRAL_GIRO = 15; // grados
  const G = L.Map.TouchGestures.prototype;
  const inicioOriginal = G._onTouchStart;

  G._onTouchStart = function (e) {
    inicioOriginal.call(this, e);
    if (!this._zooming && !this._rotating) return;
    const m = this._map;
    const v = m.mouseEventToContainerPoint(e.touches[0]).subtract(m.mouseEventToContainerPoint(e.touches[1]));
    this._angulo0 = Math.atan2(v.y, v.x);
    this._rumbo0 = m.getBearing();
    this._giroActivo = false;
  };

  G._onTouchMove = function (e) {
    if (!e.touches || e.touches.length !== 2 || !(this._zooming || this._rotating)) return;
    const map = this._map;
    const p1 = map.mouseEventToContainerPoint(e.touches[0]);
    const p2 = map.mouseEventToContainerPoint(e.touches[1]);
    const v = p1.subtract(p2);
    const scale = p1.distanceTo(p2) / this._startDist;

    let rumbo = null;
    if (this._rotating) {
      let giro = (Math.atan2(v.y, v.x) - this._angulo0) * L.DomUtil.RAD_TO_DEG;
      giro = ((giro + 540) % 360) - 180;
      if (!this._giroActivo && Math.abs(giro) > UMBRAL_GIRO) { this._giroActivo = true; this._giroBase = giro; }
      if (this._giroActivo) rumbo = this._rumbo0 + giro - this._giroBase;
    }

    if (this._zooming) {
      this._zoom = map.getScaleZoom(scale, this._startZoom);
      if (!map.options.bounceAtZoomLimits &&
          ((this._zoom < map.getMinZoom() && scale < 1) || (this._zoom > map.getMaxZoom() && scale > 1))) {
        this._zoom = map._limitZoom(this._zoom);
      }
      const delta = p1.add(p2)._divideBy(2)._subtract(this._centerPoint);
      if (scale === 1 && delta.x === 0 && delta.y === 0 && rumbo === null) return;
      const alfa = -(rumbo ?? map.getBearing()) * L.DomUtil.DEG_TO_RAD;
      this._center = map.unproject(map.project(this._pinchStartLatLng).subtract(delta.rotate(alfa)));
    }

    if (!this._moved) {
      map._moveStart(true, false);
      this._moved = true;
    }

    L.Util.cancelAnimFrame(this._animRequest);
    const centro = this._center, zoom = this._zoom;
    this._animRequest = L.Util.requestAnimFrame(() => {
      if (rumbo !== null) map.setBearing(rumbo);
      if (centro) map._move(centro, zoom, { pinch: true, round: false });
    }, this, true);

    L.DomEvent.preventDefault(e);
  };
})();
