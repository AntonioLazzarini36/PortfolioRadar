// Tests de src/notify.js. Regresión: sendNtfy() usaba escape()/unescape() para
// codificar el título como RFC 2047, pero esas funciones no están garantizadas
// en el runtime de Cloudflare Workers — si faltan, el fetch() a ntfy.sh lanza
// una excepción que el try/catch silencia, y el aviso nunca sale (aunque la
// ruta /api/test-notification siga devolviendo ok:true). Ver notify.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendNtfy, notify, retryPending } from "../src/notify.js";

test("sendNtfy no usa escape()/unescape() (no garantizados en Workers) para codificar el título", async () => {
  const originalEscape = globalThis.escape, originalUnescape = globalThis.unescape;
  // simulan un runtime (como workerd) donde estas funciones legacy no existen
  delete globalThis.escape; delete globalThis.unescape;
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return { ok: true }; };
  try {
    await sendNtfy({ NTFY_TOPIC: "x" }, { title: "NVDA: nuevo consenso de analistas", body: "cuerpo", tags: "dart", priority: 3 });
    assert.ok(capturedHeaders.Title, "debe generar una cabecera Title sin lanzar");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEscape) globalThis.escape = originalEscape;
    if (originalUnescape) globalThis.unescape = originalUnescape;
  }
});

test("sendNtfy codifica correctamente un título con acentos/eñes como RFC 2047", async () => {
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return { ok: true }; };
  try {
    await sendNtfy({ NTFY_TOPIC: "x" }, { title: "NVDA se acerca a tu objetivo (día)", body: "cuerpo", tags: "eyes", priority: 3 });
    assert.match(capturedHeaders.Title, /^=\?UTF-8\?B\?.+\?=$/);
    const decoded = Buffer.from(capturedHeaders.Title.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64").toString("utf8");
    assert.equal(decoded, "NVDA se acerca a tu objetivo (día)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendNtfy deja el título tal cual si es ASCII imprimible (sin codificar)", async () => {
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return { ok: true }; };
  try {
    await sendNtfy({ NTFY_TOPIC: "x" }, { title: "NVDA en tu precio de compra", body: "cuerpo", tags: "shopping_cart", priority: 5 });
    assert.equal(capturedHeaders.Title, "NVDA en tu precio de compra");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendNtfy incluye el logo de la empresa como Icon cuando se pasa symbol", async () => {
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return { ok: true }; };
  try {
    await sendNtfy({ NTFY_TOPIC: "x" }, { title: "NVDA cerca del consenso", body: "cuerpo", tags: "dart", priority: 3, symbol: "NVDA" });
    assert.equal(capturedHeaders.Icon, "https://images.financialmodelingprep.com/symbol/NVDA.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendNtfy quita el sufijo de bolsa del ticker al construir el Icon", async () => {
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return { ok: true }; };
  try {
    await sendNtfy({ NTFY_TOPIC: "x" }, { title: "AMZ.DE", body: "cuerpo", tags: "dart", priority: 3, symbol: "AMZ.DE" });
    assert.equal(capturedHeaders.Icon, "https://images.financialmodelingprep.com/symbol/AMZ.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendNtfy sin symbol no manda cabecera Icon (aviso agrupado de la noche, por ejemplo)", async () => {
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return { ok: true }; };
  try {
    await sendNtfy({ NTFY_TOPIC: "x" }, { title: "3 avisos de la noche", body: "cuerpo", tags: "sunrise", priority: 3 });
    assert.equal(capturedHeaders.Icon, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Regresión (2026-09-28): antes sendNtfy se tragaba cualquier fallo real de
// ntfy.sh (catch vacío), así que /api/test-notification decía "ok:true" pase
// lo que pase con tal de que NTFY_TOPIC existiera — imposible saber si el
// aviso de verdad había llegado o no. Ahora devuelve {ok,error} honesto.
test("sendNtfy devuelve ok:true si ntfy.sh responde 2xx", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });
  try {
    const r = await sendNtfy({ NTFY_TOPIC: "x" }, { title: "t", body: "b", tags: "dart", priority: 3 });
    assert.deepEqual(r, { ok: true });
  } finally { globalThis.fetch = originalFetch; }
});

test("sendNtfy devuelve ok:false con el código de estado si ntfy.sh responde con error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    const r = await sendNtfy({ NTFY_TOPIC: "x" }, { title: "t", body: "b", tags: "dart", priority: 3 });
    assert.equal(r.ok, false);
    assert.match(r.error, /404/);
  } finally { globalThis.fetch = originalFetch; }
});

test("sendNtfy devuelve ok:false con el mensaje si fetch() lanza (red caída, DNS, etc.)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("red caída"); };
  try {
    const r = await sendNtfy({ NTFY_TOPIC: "x" }, { title: "t", body: "b", tags: "dart", priority: 3 });
    assert.equal(r.ok, false);
    assert.match(r.error, /red caída/);
  } finally { globalThis.fetch = originalFetch; }
});

// Reintentos (2026-09-28): ntfy.sh puede devolver 429 por el límite de IP
// compartida de Cloudflare Workers (ver CLAUDE.md) sin que la app tenga la
// culpa — en vez de perder el aviso con un solo intento, se encola para
// reintentarlo en los siguientes ciclos del cron.
test("notify() encola el aviso en s.retry si sendNtfy falla (p. ej. 429)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  const s = { log: [], settings: { quietNight: false } };
  try {
    await notify({ NTFY_TOPIC: "x" }, s, { title: "NVDA cerca del consenso", body: "cuerpo", tags: "dart", symbol: "NVDA" });
    assert.equal(s.retry.length, 1);
    assert.equal(s.retry[0].attempts, 1);
    assert.equal(s.retry[0].title, "NVDA cerca del consenso");
  } finally { globalThis.fetch = originalFetch; }
});

test("retryPending() reenvía y quita de la cola si esta vez sí funciona", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true }; };
  const s = { settings: { quietNight: false }, retry: [{ title: "t", body: "b", tags: "dart", priority: 3, attempts: 1 }] };
  try {
    await retryPending({ NTFY_TOPIC: "x" }, s);
    assert.equal(calls, 1);
    assert.deepEqual(s.retry, []);
  } finally { globalThis.fetch = originalFetch; }
});

test("retryPending() mantiene el aviso en la cola, con un intento más, si vuelve a fallar", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  const s = { settings: { quietNight: false }, retry: [{ title: "t", body: "b", tags: "dart", priority: 3, attempts: 1 }] };
  try {
    await retryPending({ NTFY_TOPIC: "x" }, s);
    assert.equal(s.retry.length, 1);
    assert.equal(s.retry[0].attempts, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("retryPending() abandona tras agotar los intentos (no se queda reintentando para siempre)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  const s = { settings: { quietNight: false }, retry: [{ title: "t", body: "b", tags: "dart", priority: 3, attempts: 12 }] };
  try {
    await retryPending({ NTFY_TOPIC: "x" }, s);
    assert.deepEqual(s.retry, [], "con el intento nº12 ya agotado, no debe volver a encolarse");
  } finally { globalThis.fetch = originalFetch; }
});
