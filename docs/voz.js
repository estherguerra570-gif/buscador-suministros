"use strict";
// Dictar el número (de suministro o de SED) con el micrófono: botón 🎤 al lado del buscador.
// Usa el reconocimiento de voz del propio celular (gratis, sin claves). Si el navegador no lo tiene, el botón no aparece.
// Usa las globales de app.js ($, ejecutarBusqueda).

(() => {
  const Reconocer = window.SpeechRecognition || window.webkitSpeechRecognition;
  const boton = $("#btn-voz");
  if (!Reconocer || !boton) return;
  boton.hidden = false;

  const UNIDADES = { cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
    diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
    diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
    veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29 };
  const DECENAS = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
  const CENTENAS = { cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500,
    seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900 };
  const ORDEN = (v) => (v >= 100 ? 3 : v >= 20 ? 2 : 1);

  /** "cuatrocientos setenta y uno nueve dos siete" o "471 927" -> "471927" */
  function aDigitos(texto) {
    const palabras = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/(\d)[.,\s](?=\d)/g, "$1").split(/[^a-z0-9]+/).filter(Boolean);
    let salida = "", mil = 0, actual = 0, hay = false, ultimo = 9;
    const cerrar = () => { if (hay) salida += String(mil + actual); mil = 0; actual = 0; hay = false; ultimo = 9; };
    for (const p of palabras) {
      if (/^\d+$/.test(p)) { cerrar(); salida += p; continue; }
      if (p === "y") continue;
      if (p === "mil") { mil = (mil + (actual || 1)) * 1000; actual = 0; hay = true; ultimo = 4; continue; }
      const v = UNIDADES[p] ?? DECENAS[p] ?? CENTENAS[p];
      if (v === undefined) continue;                     // palabras sueltas ("suministro", "número"...)
      const o = ORDEN(v);
      if (o >= ultimo && o < 4) cerrar();                // "cuatro siete" = 47, no 11
      actual += v; hay = true; ultimo = o;
    }
    cerrar();
    return salida;
  }

  let oyendo = null;
  function parar() {
    oyendo?.abort();
    oyendo = null;
    boton.classList.remove("oyendo");
    boton.setAttribute("aria-label", "Dictar el número");
    $("#buscador").placeholder = window.modoSed?.() ? "Número de SED…" : "Número de suministro…";
  }

  boton.onclick = () => {
    if (oyendo) return parar();
    const r = new Reconocer();
    r.lang = "es-PE";
    r.interimResults = true;
    r.maxAlternatives = 3;
    oyendo = r;
    boton.classList.add("oyendo");
    boton.setAttribute("aria-label", "Escuchando… toca para parar");
    const input = $("#buscador");
    input.value = "";
    input.placeholder = "Escuchando… di el número";

    r.onresult = (e) => {
      let texto = "";
      for (const res of e.results) texto += " " + res[0].transcript;
      const n = aDigitos(texto);
      input.value = n;
      input.dispatchEvent(new Event("input"));
      if (e.results[e.results.length - 1].isFinal && n) {
        parar();
        ejecutarBusqueda();
      }
    };
    r.onerror = (e) => {
      parar();
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        alert("Para dictar, permite el uso del micrófono a la app (en el candado de la barra de direcciones o en los ajustes del celular).");
      } else if (e.error === "network") {
        alert("Para dictar se necesita señal de internet.");
      }
    };
    r.onend = () => { if (oyendo === r) parar(); };
    try { r.start(); } catch { parar(); }
  };
})();
