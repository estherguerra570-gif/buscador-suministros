"use strict";
// Subir la jornada: foto (o PDF) de la hoja de cortes o reconexiones -> lista para revisar -> ruta del día.
// La foto se revisa primero en el celular (nitidez, luz, tamaño); si está bien, la lee la IA en el servidor
// (Edge Function "leer-jornada"). Un PDF se lee aquí mismo, sin IA. La ruta anterior se guarda para Deshacer.
// Usa las funciones y variables globales de app.js (ruta, indice, agregarARuta...), menu.js y sesion.js.

(() => {
  const CLAVE_DESHACER = "jornada-anterior";
  const LADO_ANALISIS = 1000;   // la nitidez se mide con la foto a este tamaño
  const LADO_ENVIO = 2000;      // la foto se achica a esto antes de enviarla (los números siguen legibles)
  const MIN_LADO = 800;         // más chica que esto no se leen los números
  const MIN_NITIDEZ = 110;      // varianza del laplaciano. Hoja real: nítida 1764; desenfocada 1 px 284 (se lee),
                                // 1,5 px 79 (cuesta), 2 px 26 (no se lee)
  const MIN_LUZ = 55, MAX_LUZ = 245;
  const LEJOS_KM = 1.5;         // un suministro a más de esto de todos los demás de la lista se marca
  const MAX_FOTOS = 4;
  const NOMBRE_TIPO = { corte: "Cortes", reconexion: "Reconexiones", desconocido: "Jornada" };

  let lectura = null; // {tipo, origen: "foto" | "pdf", filas: [{n, direccion, seguro, coincide, original, marcado}]}

  // ---------- Botones de entrada ----------
  const entrada = document.createElement("input");
  Object.assign(entrada, { type: "file", accept: "image/*,application/pdf", multiple: true, hidden: true, id: "archivo-jornada" });
  document.body.appendChild(entrada);
  const elegir = () => { entrada.value = ""; entrada.click(); };
  entrada.onchange = () => { if (entrada.files.length) procesar([...entrada.files]); };

  HOJAS.jornada = elegir;
  HOJAS["deshacer-jornada"] = deshacer;
  $("#btn-jornada").onclick = elegir;
  pintarMenuDeshacer();

  function pintarMenuDeshacer() {
    const b = $("#menu-deshacer-jornada");
    if (b) b.hidden = !leer(CLAVE_DESHACER, null);
  }

  // ---------- Revisar la foto en el celular ----------
  async function abrirImagen(archivo) {
    try {
      return await createImageBitmap(archivo, { imageOrientation: "from-image" });
    } catch {
      const url = URL.createObjectURL(archivo);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally { URL.revokeObjectURL(url); }
    }
  }

  function lienzoDe(img, lado) {
    const w = img.width, h = img.height, k = Math.min(1, lado / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /** Nitidez (varianza del laplaciano) y luz media de la foto. */
  function medir(img) {
    const c = lienzoDe(img, LADO_ANALISIS);
    const { data, width: w, height: h } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const g = new Float32Array(w * h);
    let luz = 0;
    for (let i = 0; i < w * h; i++) { g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; luz += g[i]; }
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      s += l; s2 += l * l; n++;
    }
    return { nitidez: s2 / n - (s / n) ** 2, luz: luz / (w * h), lado: Math.max(img.width, img.height) };
  }

  function problemaDe(m) {
    if (m.lado < MIN_LADO) return "La foto es muy pequeña: tómala más de cerca o envíala sin comprimir.";
    if (m.luz < MIN_LUZ) return "La foto salió muy oscura: tómala con más luz.";
    if (m.luz > MAX_LUZ) return "La foto salió muy clara o con reflejo: evita el sol directo sobre la hoja.";
    if (m.nitidez < MIN_NITIDEZ) return "La foto salió borrosa, intenta subirla nuevamente.";
    return "";
  }

  async function comprimir(img) {
    const c = lienzoDe(img, LADO_ENVIO);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    const b64 = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(String(f.result).split(",")[1]); f.readAsDataURL(blob); });
    return { datos: b64, tipo: "image/jpeg" };
  }

  // ---------- Flujo ----------
  async function procesar(archivos) {
    cerrarMenu();
    const pdf = archivos.find((a) => a.type === "application/pdf" || /\.pdf$/i.test(a.name));
    if (pdf) return leerPdf(pdf);
    const fotos = archivos.filter((a) => a.type.startsWith("image/")).slice(0, MAX_FOTOS);
    if (!fotos.length) return mostrarError("Ese archivo no es una foto ni un PDF.");

    hojaEsperando("Revisando la foto…");
    const listas = [];
    for (const [i, archivo] of fotos.entries()) {
      let img;
      try { img = await abrirImagen(archivo); } catch { return mostrarError("No se pudo abrir la foto. Prueba con otra."); }
      const problema = problemaDe(medir(img));
      if (problema) {
        anotar("foto_borrosa", problema.slice(0, 80));
        return mostrarError(fotos.length > 1 ? `Foto ${i + 1}: ${problema}` : problema);
      }
      listas.push(await comprimir(img));
      img.close?.();
    }

    if (!navigator.onLine) return mostrarError("Para leer la foto se necesita internet. Intenta cuando tengas señal.");
    hojaEsperando(`Leyendo ${fotos.length > 1 ? `las ${fotos.length} fotos` : "la hoja"}… puede tardar unos 15 segundos.`);
    const { data, error } = await supa.functions.invoke("leer-jornada", { body: { fotos: listas } });
    if (error) {
      let texto = "No se pudo leer la foto. Revisa tu señal e intenta de nuevo.";
      try { texto = (await error.context.json()).error ?? texto; } catch { /* sin detalle */ }
      return mostrarError(texto);
    }
    if (!data.legible || !data.filas.length) {
      anotar("foto_borrosa", (data.motivo || "ilegible").slice(0, 80));
      return mostrarError(`${data.motivo || "La foto salió borrosa"}. Intenta subirla nuevamente.`);
    }
    lectura = { tipo: data.tipo, origen: "foto", quedan: data.quedan, filas: data.filas.map((f) => ({ ...f, original: f.n, marcado: true })) };
    revisar();
  }

  // ---------- PDF: los números salen directo del archivo, sin IA ----------
  async function leerPdf(archivo) {
    hojaEsperando("Leyendo el PDF…");
    try {
      const pdfjs = await import("./lib/pdfjs/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "lib/pdfjs/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: await archivo.arrayBuffer() }).promise;
      const filas = [], vistos = new Set();
      let texto = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const items = (await (await doc.getPage(p)).getTextContent()).items.map((it) => it.str.trim()).filter(Boolean);
        texto += " " + items.join(" ");
        // cada fila: ... OT (8 dígitos, empieza con 26) seguido del CONTRATO
        for (let i = 0; i < items.length - 1; i++) {
          if (/^2\d{7}$/.test(items[i]) && /^\d{1,7}$/.test(items[i + 1]) && !vistos.has(items[i + 1])) {
            vistos.add(items[i + 1]);
            filas.push({ n: items[i + 1], direccion: "", seguro: true, coincide: true, original: items[i + 1], marcado: true });
          }
        }
      }
      if (!filas.length) return mostrarError("No se encontraron contratos en este PDF. Sube una foto de la hoja.");
      const tipo = /reconex/i.test(texto) ? "reconexion" : /\bcortes?\b/i.test(texto) ? "corte" : "desconocido";
      lectura = { tipo, origen: "pdf", filas };
      revisar();
    } catch (e) {
      console.error(e);
      mostrarError("No se pudo abrir el PDF. Sube una foto de la hoja.");
    }
  }

  // ---------- Revisar antes de crear la ruta ----------
  const km = (a, b) => {
    const r = Math.PI / 180;
    return Math.hypot((b.lng - a.lng) * r * Math.cos(a.lat * r), (b.lat - a.lat) * r) * 6371;
  };

  function evaluar() {
    const conPunto = lectura.filas.filter((f) => indice.has(f.n));
    for (const f of lectura.filas) {
      const s = indice.get(f.n);
      f.existe = !!s;
      f.lejos = false;
      if (s && conPunto.length >= 4) {
        const cercano = Math.min(...conPunto.filter((o) => o !== f).map((o) => km(s, indice.get(o.n))));
        f.lejos = cercano > LEJOS_KM;
      }
      f.avisos = [];
      if (!f.existe) f.avisos.push("No está en el mapa");
      if (f.lejos) f.avisos.push("Muy lejos de los demás");
      if (!f.coincide) f.avisos.push("Se leyó distinto en las dos lecturas");
      else if (!f.seguro) f.avisos.push("Un número no se leyó con seguridad");
      if (!f.existe) f.marcado = false;
    }
  }

  function revisar() {
    evaluar();
    const repetidos = new Set(ruta);
    const filas = lectura.filas;
    const listos = filas.filter((f) => f.marcado && f.existe);
    const porRevisar = filas.filter((f) => f.avisos.length).length;
    const nombre = NOMBRE_TIPO[lectura.tipo] ?? "Jornada";
    abrirHoja(`Revisar ${nombre.toLowerCase()}`, `
      <div class="jr-resumen">
        <span class="jr-tipo ${lectura.tipo}">${nombre}</span>
        <span><b>${listos.length}</b> listos${porRevisar ? ` · <b class="jr-alerta">${porRevisar}</b> por revisar` : ""}</span>
        <span class="nota">${lectura.origen === "pdf" ? "Leído del PDF" : "Leído de la foto"} · compáralo con tu hoja</span>
      </div>
      <ul class="jr-lista">${filas.map((f, i) => `
        <li class="jr-fila${f.avisos.length ? (f.existe ? " revisar" : " falta") : ""}">
          <input type="checkbox" data-i="${i}" ${f.marcado ? "checked" : ""} ${f.existe ? "" : "disabled"} aria-label="Incluir ${escapar(f.n)}">
          <div class="jr-info">
            <input class="jr-num" data-i="${i}" value="${escapar(f.n)}" inputmode="numeric" maxlength="7" aria-label="Número de contrato">
            ${f.direccion ? `<span class="jr-dir">${escapar(f.direccion)}</span>` : ""}
            ${f.avisos.length ? `<span class="jr-aviso">⚠️ ${f.avisos.join(" · ")}</span>` : ""}
            ${f.n !== f.original ? `<span class="jr-corregido">Corregido (decía ${escapar(f.original)})</span>` : ""}
            ${repetidos.has(f.n) ? `<span class="jr-dir">Ya está en tu ruta</span>` : ""}
          </div>
          ${f.existe ? `<button class="btn chico jr-ver" data-i="${i}" aria-label="Ver ${escapar(f.n)} en el mapa">📍</button>` : ""}
        </li>`).join("")}
      </ul>
      <div class="jr-botones">
        <button class="btn primario" id="jr-crear" ${listos.length ? "" : "disabled"}>Crear ruta con ${listos.length}</button>
        ${ruta.length ? `<button class="btn" id="jr-agregar" ${listos.length ? "" : "disabled"}>Agregar ${listos.length} a mi ruta actual</button>` : ""}
        <button class="btn" id="jr-otra">📷 Subir otra foto</button>
      </div>
      ${ruta.length ? `<p class="nota">"Crear ruta" reemplaza tu ruta actual de ${plural(ruta.length, "suministro")}. Podrás deshacerlo.</p>` : ""}
      ${lectura.quedan !== undefined ? `<p class="nota">Te quedan ${lectura.quedan} lecturas de foto hoy.</p>` : ""}`);

    const cuerpo = $("#hoja-cuerpo");
    cuerpo.querySelectorAll("input[type=checkbox]").forEach((c) => { c.onchange = () => { filas[c.dataset.i].marcado = c.checked; revisar(); }; });
    cuerpo.querySelectorAll(".jr-num").forEach((inp) => {
      inp.onchange = () => {
        const f = filas[inp.dataset.i];
        f.n = inp.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
        f.marcado = true; f.coincide = true; f.seguro = true; // lo revisó la persona
        revisar();
      };
    });
    cuerpo.querySelectorAll(".jr-ver").forEach((b) => { b.onclick = () => verEnMapa(filas[b.dataset.i].n); });
    $("#jr-crear").onclick = () => aplicar(true);
    if ($("#jr-agregar")) $("#jr-agregar").onclick = () => aplicar(false);
    $("#jr-otra").onclick = elegir;
  }

  // ---------- Ver un punto sin perder la lista ----------
  function verEnMapa(n) {
    const s = indice.get(n);
    $("#hoja").hidden = true;
    mapa.setView([s.lat, s.lng], 18);
    const m = L.circleMarker([s.lat, s.lng], { radius: 14, color: "#d84315", weight: 3, fillOpacity: 0.15 })
      .bindTooltip(n, { permanent: true, direction: "top" }).addTo(mapa);
    const volver = document.createElement("button");
    volver.className = "btn primario jr-volver";
    volver.textContent = "← Volver a la lista";
    volver.onclick = () => { m.remove(); volver.remove(); $("#hoja").hidden = false; };
    document.body.appendChild(volver);
  }

  // ---------- Crear la ruta y deshacer ----------
  function aplicar(reemplazar) {
    const numeros = [...new Set(lectura.filas.filter((f) => f.marcado && f.existe).map((f) => f.n))];
    if (!numeros.length) return;
    guardar(CLAVE_DESHACER, { ruta: [...ruta], visitados: [...visitados], inicio: inicioRuta, tipos: { ...tiposRuta }, fecha: Date.now() });
    if (reemplazar) {
      ruta = []; visitados.clear(); inicioRuta = null;
      guardar(CLAVE_RUTA, ruta); guardar(CLAVE_VISITADOS, []); guardar(CLAVE_INICIO, null);
    }
    if (lectura.tipo === "corte" || lectura.tipo === "reconexion") for (const n of numeros) tiposRuta[n] = lectura.tipo;
    guardar(CLAVE_TIPOS, tiposRuta);
    const corregidos = lectura.filas.filter((f) => f.marcado && f.n !== f.original).length;
    anotar("jornada", `${numeros.length} ${lectura.tipo} · ${lectura.origen}${corregidos ? ` · ${corregidos} corregidos` : ""}`);
    cerrarHoja();
    activarVista("ruta");
    agregarARuta(numeros);
    pintarMenuDeshacer();
    avisoDeshacer(`${reemplazar ? "Ruta creada" : "Agregados"}: ${plural(numeros.length, "suministro")}`);
  }

  function deshacer() {
    const antes = leer(CLAVE_DESHACER, null);
    if (!antes) return avisar("No hay ninguna jornada para deshacer.", false);
    ruta = antes.ruta; visitados = new Set(antes.visitados); inicioRuta = antes.inicio; tiposRuta = antes.tipos ?? {};
    guardar(CLAVE_RUTA, ruta); guardar(CLAVE_VISITADOS, antes.visitados); guardar(CLAVE_INICIO, inicioRuta); guardar(CLAVE_TIPOS, tiposRuta);
    try { localStorage.removeItem(CLAVE_DESHACER); } catch { /* sin almacenamiento */ }
    anotar("deshacer_jornada");
    $(".jr-deshacer")?.remove();
    activarVista("ruta");
    pintarRuta();
    if (ruta.length) encuadrarRuta();
    pintarMenuDeshacer();
    avisar(ruta.length ? `Volviste a tu ruta anterior (${plural(ruta.length, "suministro")}).` : "Se deshizo: la ruta quedó vacía como antes.");
  }

  function avisoDeshacer(texto) {
    $(".jr-deshacer")?.remove();
    const d = document.createElement("div");
    d.className = "jr-deshacer";
    d.setAttribute("role", "status");
    d.innerHTML = `<span>${escapar(texto)}</span><button class="btn">↩︎ Deshacer</button>`;
    d.querySelector("button").onclick = deshacer;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 20000);
  }

  // ---------- Pantallas de espera y error ----------
  function hojaEsperando(texto) {
    abrirHoja("Subir jornada", `<div class="jr-espera"><span class="jr-rueda" aria-hidden="true"></span><p>${escapar(texto)}</p></div>`);
  }
  function mostrarError(texto) {
    abrirHoja("Subir jornada", `
      <div class="jr-error">
        <p class="jr-error-texto">${escapar(texto)}</p>
        <ul class="nota">
          <li>Pon la hoja sobre una superficie plana y con buena luz, sin sol directo.</li>
          <li>Que se vea toda la columna CONTRATO, de arriba a abajo.</li>
          <li>Sostén el celular firme o apóyalo para que no salga movida.</li>
        </ul>
        <button class="btn primario" id="jr-reintentar">📷 Subir otra foto</button>
      </div>`);
    $("#jr-reintentar").onclick = elegir;
  }
})();
