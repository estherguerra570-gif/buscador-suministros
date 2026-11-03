"use strict";
// Inicio de sesión con Google (Supabase). Sirve para saber quién usa la app y quién corrige cada ubicación.
// La URL y la clave "publishable" son públicas: lo que cada uno puede ver o cambiar lo deciden los permisos
// de la base (supabase/migrations). La sesión queda guardada en el celular, así que sin señal la app abre igual.

const SUPABASE_URL = "https://wknalygmlzghpucyvuoi.supabase.co";
const SUPABASE_CLAVE = "sb_publishable_8FAJR9zYDJUCcwItnHO7-A_HDQl8Wvm";
const CORREO_ADMIN = "estherguerra570@gmail.com";
const CLAVE_SESION = "sesion-usuario"; // copia de {id, nombre, email, foto} para abrir sin señal

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_CLAVE, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

let usuarioActual = null; // {id, nombre, email, foto, admin}
let avisarSesionLista;
const sesionLista = new Promise((r) => { avisarSesionLista = r; }); // menu.js espera esto antes de leer correcciones

function datosDeUsuario(u) {
  const m = u.user_metadata ?? {};
  return {
    id: u.id, email: u.email, foto: m.avatar_url ?? m.picture ?? "",
    nombre: m.full_name ?? m.name ?? (u.email ?? "").split("@")[0],
    admin: (u.email ?? "").toLowerCase() === CORREO_ADMIN,
  };
}

function entrar(datos) {
  const primera = !usuarioActual;
  usuarioActual = datos;
  try { localStorage.setItem(CLAVE_SESION, JSON.stringify(datos)); } catch { /* sin almacenamiento */ }
  document.getElementById("entrada").hidden = true;
  if (primera) avisarSesionLista(usuarioActual);
  window.alEntrar?.(); // menu.js (si ya cargó; si no, lo llama él al cargar): nombre, panel de admin, pendientes
}

function mostrarEntrada(error = "") {
  usuarioActual = null;
  try { localStorage.removeItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
  document.getElementById("entrada").hidden = false;
  const e = document.getElementById("entrada-error");
  e.textContent = error;
  e.hidden = !error;
}

document.getElementById("btn-google").onclick = async () => {
  const b = document.getElementById("btn-google");
  b.disabled = true;
  const { error } = await supa.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } },
  });
  if (error) {
    b.disabled = false;
    mostrarEntrada(navigator.onLine ? `No se pudo abrir Google: ${error.message}` : "Necesitas internet para entrar la primera vez.");
  }
};

async function cerrarSesion() {
  await supa.auth.signOut().catch(() => {});
  mostrarEntrada();
}

let accesoRegistrado = false;
/** Una vez por apertura de la app: último acceso y cantidad de veces que entró (para el panel de la admin). */
async function registrarAcceso() {
  if (accesoRegistrado) return;
  const { error } = await supa.rpc("registrar_acceso");
  if (!error) accesoRegistrado = true;
}

(async () => {
  // al volver de Google la dirección trae ?code=…: supabase-js lo canjea por la sesión y se limpia la barra
  const { data } = await supa.auth.getSession();
  if (location.search.includes("code=")) history.replaceState(null, "", location.pathname + location.hash);
  if (data.session) {
    entrar(datosDeUsuario(data.session.user));
    registrarAcceso();
    return;
  }
  // sin señal la sesión no se puede renovar: si ya había entrado en este celular, se sigue usando
  let guardado = null;
  try { guardado = JSON.parse(localStorage.getItem(CLAVE_SESION)); } catch { /* nada */ }
  if (guardado && !navigator.onLine) entrar(guardado);
  else mostrarEntrada();
})();

supa.auth.onAuthStateChange((evento, sesion) => {
  if (evento === "SIGNED_IN" && sesion && usuarioActual?.id !== sesion.user.id) {
    entrar(datosDeUsuario(sesion.user));
    registrarAcceso();
  }
  if (evento === "SIGNED_OUT") mostrarEntrada();
});
