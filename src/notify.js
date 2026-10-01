// Radar Cartera — Notificaciones ntfy y silencio nocturno (ver spec §6.7/§6.8)

import { isQuietHour } from "./time.js";

// Logo de la empresa (gratis, sin clave — mismo servicio que usa la lista en
// el frontend). Se quita el sufijo de bolsa porque el logo es de la empresa,
// no de la cotización concreta.
const logoUrl = (sym) => `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(sym.split(".")[0])}.png`;

// Cuántas veces se reintenta un aviso que falló al enviarse (p. ej. ntfy.sh
// devolvió 429 por el límite de IP compartida de Cloudflare Workers — ver
// CLAUDE.md) antes de rendirse. Se reintenta una vez por ciclo del cron
// (~cada 5 min), así que 12 intentos son ~1 hora de margen.
const MAX_NTFY_RETRIES = 12;

async function notify(env, s, { title, body, tags = "chart_with_upwards_trend", priority = 3, symbol }) {
  s.log.unshift({ t: Date.now(), symbol: symbol || null, title, body });
  if (!env.NTFY_TOPIC || env.MOCK === "1") return;
  if (isQuietHour(s.settings) && priority < 5) { s.pending ??= []; s.pending.push({ title, body, tags, priority, symbol }); return; }
  const r = await sendNtfy(env, { title, body, tags, priority, symbol });
  // Si ntfy.sh lo rechaza (429 y similares), no se pierde: se apunta para
  // reintentarlo en el siguiente ciclo (petición del usuario 2026-09-28 — "que
  // vaya reenviando la noti si no funciona al momento"), en vez de darlo por
  // perdido con solo un intento.
  if (!r.ok) { s.retry ??= []; s.retry.push({ title, body, tags, priority, symbol, attempts: 1 }); }
}

// Reintenta los avisos que fallaron al enviarse la primera vez. Respeta el
// silencio nocturno igual que el envío normal (si un reintento cae dentro de
// esa franja, simplemente espera al siguiente ciclo sin gastar el intento).
// Tras MAX_NTFY_RETRIES intentos sin éxito se abandona — el aviso ya quedó en
// el log de la app (se pierde solo el empujón al móvil, no el aviso en sí).
async function retryPending(env, s) {
  if (!s.retry?.length) return;
  const items = s.retry; s.retry = [];
  for (const item of items) {
    if (isQuietHour(s.settings) && item.priority < 5) { s.retry.push(item); continue; }
    const r = await sendNtfy(env, item);
    if (!r.ok && item.attempts < MAX_NTFY_RETRIES) s.retry.push({ ...item, attempts: item.attempts + 1 });
  }
}

// Los títulos con caracteres fuera de ASCII imprimible se codifican como
// "encoded-word" (RFC 2047) para que sean una cabecera HTTP válida.
// Nota: no se usa escape()/unescape() (no están garantizados en el runtime
// de Cloudflare Workers) — se codifica a UTF-8 con TextEncoder en su lugar.
function encodeTitle(title) {
  if (/^[\x20-\x7E]*$/.test(title)) return title;
  const bytes = new TextEncoder().encode(title);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

// Devuelve { ok, error? } en vez de tragarse el fallo en silencio (como hacía
// antes con un catch vacío) — así /api/test-notification puede decir la
// verdad sobre si ntfy.sh aceptó el aviso o no, en vez de un {ok:true} que no
// significaba nada. Los sitios que llaman a esto desde el motor de alertas
// (notify() más abajo, y el vaciado de `pending` en runCycle) siguen sin
// comprobar el resultado a propósito: un aviso que falla no debe frenar la
// evaluación de los demás — pero ahora, si hace falta depurarlo, el dato está.
async function sendNtfy(env, { title, body, tags, priority, symbol }) {
  const server = env.NTFY_SERVER || "https://ntfy.sh";
  try {
    const r = await fetch(`${server}/${env.NTFY_TOPIC}`, {
      method: "POST",
      body,
      headers: {
        Title: encodeTitle(title), Tags: tags, Priority: String(priority),
        ...(env.APP_URL ? { Click: env.APP_URL } : {}),
        ...(symbol ? { Icon: logoUrl(symbol) } : {}),
      },
    });
    if (!r.ok) return { ok: false, error: `ntfy respondió ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export { notify, sendNtfy, retryPending };
