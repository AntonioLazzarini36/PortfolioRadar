// Radar Cartera — Estado (KV) y forma de los datos (ver spec §5)
// Todo el estado vive en un único documento JSON en KV bajo la clave "state".

import { marketsMaybeOpen } from "./time.js";

const STATE_KEY = "state";

const DEFAULT_SETTINGS = {
  nearPct: 3,            // aviso cuando el precio está a menos de X % del consenso o de tu objetivo
  farPct: 50,            // aviso cuando el precio se aleja X % o más del consenso (en cualquier sentido)
  consensusChangePct: 1,  // aviso si el consenso cambia más de X %
  entryAlerts: true,     // aviso al cruzar tu precio de entrada
  quietNight: true,      // sin notificaciones de 00:00 a 07:00 (hora de Madrid)
};

// ───────────────────────── Utilidades ─────────────────────────
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const num = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? null : +v);
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d }));

// ───────────────────────── Carga / guardado ─────────────────────────
async function loadState(env) {
  const s = (await env.KV.get(STATE_KEY, "json")) || {};
  s.items ??= {}; s.market ??= {}; s.targets ??= {}; s.flags ??= {}; s.log ??= []; s.pending ??= []; s.retry ??= [];
  s.fx ??= null; // { usdPerEur, updatedAt } — conversión a EUR (spec ampliada, ver CLAUDE.md)
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  return s;
}
async function saveState(env, s) {
  s.log = s.log.slice(0, 80);
  await env.KV.put(STATE_KEY, JSON.stringify(s));
}

function publicState(s) {
  return { items: s.items, market: s.market, targets: s.targets, fx: s.fx || null, log: s.log.slice(0, 50), settings: s.settings, lastRun: s.lastRun || null, marketsOpen: marketsMaybeOpen() };
}

// ───────────────────────── Valores (items) ─────────────────────────
function cleanItem(b, prev = {}) {
  return {
    symbol: String(b.symbol || prev.symbol).toUpperCase().trim(),
    name: b.name ?? prev.name ?? null,
    kind: b.kind === "watch" ? "watch" : b.kind === "holding" ? "holding" : prev.kind || "watch",
    qty: num(b.qty ?? prev.qty),
    avg: num(b.avg ?? prev.avg),
    myTarget: num(b.myTarget ?? prev.myTarget),
    myBuy: num(b.myBuy ?? prev.myBuy),
    // Euros reales gastados al comprar (dato exacto de tu bróker, p. ej. Trading212),
    // para una ganancia en EUR real en vez de la aproximación con la tasa de hoy — ver CLAUDE.md.
    costEur: num(b.costEur ?? prev.costEur),
    note: (b.note ?? prev.note ?? "").toString().slice(0, 300),
    // "" o ausente = automático (el servidor lo rellena con la moneda que reporte
    // la cotización); un valor explícito (p. ej. el usuario cambió el selector de
    // moneda en el formulario) manda y ya no se sobrescribe con el detectado.
    currency: b.currency || prev.currency || null,
    addedAt: prev.addedAt || Date.now(),
  };
}

// ───────────────────────── Importación masiva (spec §6.2) ─────────────────────────
// Una línea por valor: TICKER, cantidad, precio medio, objetivo venta, precio compra
// Separadores: coma, punto y coma, tabulador. Decimales con punto o coma.
// La coma no puede ser a la vez separador de campos y decimal en la misma línea:
// si hay punto y coma, tabulador o varios espacios, esos marcan los campos y una
// coma que quede dentro de un campo se trata como decimal; si no, la coma separa
// los campos (como en el ejemplo de la spec) y los decimales deben llevar punto.
function parseImportLine(line) {
  const fieldSep = /[;\t]| {2,}/;
  const parts = fieldSep.test(line) ? line.split(fieldSep) : line.split(",");
  const [sym, qty, avg, tgt, buy] = parts.map((x) => x && x.trim().replace(",", "."));
  return { sym, qty, avg, tgt, buy };
}

export { STATE_KEY, DEFAULT_SETTINGS, json, num, pct, fmt, loadState, saveState, publicState, cleanItem, parseImportLine };
