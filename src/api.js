// Radar Cartera — Rutas /api/* y ciclo del cron (ver spec §7 y §8)

import { marketsMaybeOpen, isQuietHour } from "./time.js";
import { getQuote, getTargets, searchSymbols, yahooQuote, finnhubQuote, fmpTargets, analystCount, yahooTargets, fmpPe, fxRate, getWma200, yahoo200wma, getPriceHistory } from "./sources.js";
import { json, num, pct, fmt, loadState, saveState, publicState, cleanItem, parseImportLine } from "./state.js";
import { notify, sendNtfy, retryPending } from "./notify.js";
import { evaluateAlerts } from "./alerts.js";
import { simulateGrid } from "./backtest.js";

const TARGET_MAX_AGE_H = 20;      // refrescar consenso si tiene más de 20 h
const TARGETS_PER_RUN = 4;        // cuántos consensos refrescar por ejecución (límite de subpeticiones)
const MAX_QUOTES_PER_RUN = 35;    // plan gratis de Cloudflare: 50 subpeticiones por ejecución
const FX_MAX_AGE_H = 20;          // refrescar el tipo de cambio EUR/USD si tiene más de 20 h
const WMA_MAX_AGE_H = 24 * 7;     // el 200WMA apenas cambia semana a semana
const WMA_PER_RUN = 1;            // 1 petición extra por ciclo (presupuesto ya ajustado con muchos símbolos)
const MAX_SUBREQUESTS_SAFE = 46;  // margen de seguridad bajo el tope real de 50 de Cloudflare
const YAHOO_TARGET_COST = 3;      // peticiones por símbolo en el respaldo de Yahoo (sin FMP_KEY): cookie + crumb + quoteSummary

// Cuántos símbolos caben de verdad al FORZAR refreshTargets en esta misma
// invocación, sin arriesgarse a pasarse del tope de subpeticiones. Importa
// porque forzar de más no falla "con gracia": el símbolo que se queda sin
// presupuesto a mitad de bucle revienta como si Yahoo hubiera fallado de
// verdad, y eso le pone un `failedAt` que el ciclo automático (sin forzar)
// respeta durante 6 h antes de reintentar — o sea, forzar mal puede dejar
// símbolos peor que si no se hubiera tocado nada. `alreadySpent` es lo que ya
// se ha gastado en peticiones en ESTA misma invocación (p. ej. los precios,
// si se piden en el mismo ciclo que el consenso forzado).
function safeForceTargetsLimit(alreadySpent = 0) {
  return Math.max(TARGETS_PER_RUN, Math.floor((MAX_SUBREQUESTS_SAFE - alreadySpent) / YAHOO_TARGET_COST));
}

// Las posiciones reales (kind === "holding") primero, la watchlist después —
// así, cuando el hueco por ciclo no alcanza para todo (TARGETS_PER_RUN o el
// tope de forzar), lo tuyo se pone al día antes que lo que solo vigilas
// (petición del usuario 2026-09-27). sort() es estable (ES2019+): dentro de
// cada grupo se conserva el orden original, solo se antepone un grupo al otro.
function prioritizeSymbols(s) {
  return Object.keys(s.items).sort((a, b) => {
    const ka = s.items[a].kind === "holding" ? 0 : 1;
    const kb = s.items[b].kind === "holding" ? 0 : 1;
    return ka - kb;
  });
}

async function refreshWma(env, s, symbols, { force = false } = {}) {
  const now = Date.now();
  const stale = symbols
    .filter((sym) => force || !s.targets[sym]?.wma200UpdatedAt || now - s.targets[sym].wma200UpdatedAt > WMA_MAX_AGE_H * 3600e3)
    .filter((sym) => !s.targets[sym]?.wma200FailedAt || now - s.targets[sym].wma200FailedAt > 24 * 3600e3 || force)
    .slice(0, force ? symbols.length : WMA_PER_RUN);
  for (const sym of stale) {
    try {
      const { wma200 } = await getWma200(sym, env);
      s.targets[sym] = { ...(s.targets[sym] || {}), wma200, wma200UpdatedAt: now, wma200FailedAt: null };
    } catch (e) {
      s.targets[sym] = { ...(s.targets[sym] || {}), wma200FailedAt: now };
    }
  }
}

async function refreshFx(env, s, { force = false } = {}) {
  const now = Date.now();
  if (!force && s.fx?.updatedAt && now - s.fx.updatedAt < FX_MAX_AGE_H * 3600e3) return;
  try { s.fx = { ...(await fxRate(env)), updatedAt: now, error: null }; }
  catch (e) { s.fx = { ...(s.fx || {}), error: String(e.message || e) }; }
}

// ───────────────────────── Actualizaciones ─────────────────────────
async function refreshQuotes(env, s, symbols) {
  const list = symbols.slice(0, MAX_QUOTES_PER_RUN);
  const results = await Promise.allSettled(list.map((sym) => getQuote(sym, env)));
  results.forEach((r, i) => {
    const sym = list[i];
    if (r.status === "fulfilled") {
      s.market[sym] = { ...r.value, updatedAt: Date.now(), error: null };
      if (r.value.name && !s.items[sym]?.name) s.items[sym].name = r.value.name;
      if (r.value.currency && !s.items[sym]?.currency) s.items[sym].currency = r.value.currency;
    } else {
      s.market[sym] = { ...(s.market[sym] || {}), error: String(r.reason?.message || r.reason) };
    }
  });
}

async function refreshTargets(env, s, symbols, { force = false, notifyChanges = true, limit = null } = {}) {
  const now = Date.now();
  const stale = symbols
    .filter((sym) => force || !s.targets[sym]?.updatedAt || now - s.targets[sym].updatedAt > TARGET_MAX_AGE_H * 3600e3)
    .filter((sym) => !s.targets[sym]?.failedAt || now - s.targets[sym].failedAt > 6 * 3600e3 || force)
    .slice(0, limit ?? (force ? symbols.length : TARGETS_PER_RUN));
  for (const sym of stale) {
    const old = s.targets[sym];
    try {
      const t = await getTargets(sym, env);
      // Conserva el 200WMA (se refresca por su cuenta, mucho menos a menudo) al
      // reescribir el resto del consenso.
      s.targets[sym] = { wma200: old?.wma200 ?? null, wma200UpdatedAt: old?.wma200UpdatedAt ?? null, wma200FailedAt: old?.wma200FailedAt ?? null, ...t, updatedAt: now, prevMean: old?.mean ?? null, prevAnalysts: old?.analysts ?? null, error: null };
      if (notifyChanges && old?.mean && t.mean) {
        const ch = pct(t.mean, old.mean);
        const nChanged = old.analysts && t.analysts && old.analysts !== t.analysts;
        if (Math.abs(ch) >= s.settings.consensusChangePct || nChanged)
          await notify(env, s, {
            symbol: sym, title: `${sym}: nuevo consenso de analistas`,
            body: `Objetivo medio ${fmt(old.mean)} → ${fmt(t.mean)} (${ch >= 0 ? "+" : ""}${fmt(ch, 1)} %)` +
              (t.analysts ? ` · ${t.analysts} analistas` : "") + (t.low && t.high ? ` · rango ${fmt(t.low)}–${fmt(t.high)}` : ""),
            tags: ch >= 0 ? "arrow_up" : "arrow_down",
          });
      }
    } catch (e) {
      s.targets[sym] = { ...(old || {}), error: String(e.message || e), failedAt: now };
    }
  }
}

async function runCycle(env, { forceQuotes = false, forceTargets = false } = {}) {
  const s = await loadState(env);
  const symbols = prioritizeSymbols(s);
  if (!symbols.length) return s;

  // envía notificaciones aplazadas por la noche
  if (s.pending?.length && !isQuietHour(s.settings)) {
    const p = s.pending; s.pending = [];
    if (p.length > 3) await sendNtfy(env, { title: `${p.length} avisos de la noche`, body: p.map((x) => `• ${x.title}`).join("\n"), tags: "sunrise", priority: 3 });
    else for (const x of p) await sendNtfy(env, x);
  }
  // reintenta los avisos que fallaron al enviarse (p. ej. 429 de ntfy.sh)
  await retryPending(env, s);

  let quotesSpent = 0;
  if (forceQuotes || marketsMaybeOpen() || env.MOCK === "1") {
    // rota la lista si hay más símbolos que el límite por ejecución
    const offset = (s.rot || 0) % symbols.length;
    const ordered = symbols.slice(offset).concat(symbols.slice(0, offset));
    await refreshQuotes(env, s, ordered);
    quotesSpent = Math.min(ordered.length, MAX_QUOTES_PER_RUN);
    s.rot = offset + MAX_QUOTES_PER_RUN;
    for (const sym of ordered.slice(0, MAX_QUOTES_PER_RUN)) await evaluateAlerts(env, s, sym);
  }
  // forceTargets: solo lo pide el botón manual de refrescar (nunca el cron
  // automático). Aun así se limita a lo que quepa con seguridad en ESTA misma
  // invocación (los precios ya han gastado `quotesSpent` peticiones) — nunca
  // "todos, pase lo que pase": ver safeForceTargetsLimit(). El 200WMA NUNCA se
  // fuerza aquí a propósito: apenas cambia semana a semana, así que forzarlo
  // en cada toque solo gastaría presupuesto de peticiones sin ganar nada — se
  // deja siempre con su propio ritmo semanal (WMA_MAX_AGE_H), lo pida el cron
  // o el usuario.
  await refreshTargets(env, s, symbols, { force: forceTargets, limit: forceTargets ? safeForceTargetsLimit(quotesSpent) : null });
  await refreshWma(env, s, symbols);
  await refreshFx(env, s);
  s.lastRun = Date.now();
  await saveState(env, s);
  return s;
}

// ───────────────────────── Rutas /api/* ─────────────────────────
async function handleApi(req, env, url) {
  const auth = req.headers.get("authorization") || "";
  if (!env.APP_TOKEN || auth !== `Bearer ${env.APP_TOKEN}`) return json({ error: "No autorizado" }, 401);
  const path = url.pathname.replace(/^\/api/, "");
  const body = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => ({})) : null;

  if (path === "/state" && req.method === "GET") return json(publicState(await loadState(env)));

  if (path === "/refresh" && req.method === "POST") {
    // `full: true` (el botón de refrescar del encabezado) fuerza también
    // consenso/fundamentales/200WMA de TODOS los símbolos, no solo lo que
    // haya caducado — así un toque manual siempre trae todo al día, en vez de
    // depender de que el cron automático haya llegado a cada símbolo todavía.
    const s = await runCycle(env, { forceQuotes: true, forceTargets: !!body?.full });
    return json(publicState(s));
  }

  if (path === "/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json([]);
    try { return json(await searchSymbols(q, env)); } catch (e) { return json({ error: e.message }, 502); }
  }

  if (path === "/items" && req.method === "POST") {
    const s = await loadState(env);
    const it = cleanItem(body, s.items[String(body.symbol || "").toUpperCase()]);
    if (!it.symbol) return json({ error: "Falta el ticker" }, 400);
    s.items[it.symbol] = it;
    // precio y consenso inmediatos para el nuevo símbolo
    try {
      s.market[it.symbol] = { ...(await getQuote(it.symbol, env)), updatedAt: Date.now(), error: null };
      if (!it.name) it.name = s.market[it.symbol].name;
      if (!it.currency && s.market[it.symbol].currency) it.currency = s.market[it.symbol].currency;
    } catch (e) { s.market[it.symbol] = { error: e.message }; }
    if (!s.targets[it.symbol]?.mean) await refreshTargets(env, s, [it.symbol], { force: true, notifyChanges: false });
    await refreshFx(env, s);
    // no avisar de golpe de condiciones que ya se cumplen al añadir
    const snap = s.log.length; await evaluateAlerts({ ...env, NTFY_TOPIC: "" }, s, it.symbol); s.log.splice(0, s.log.length - snap);
    await saveState(env, s);
    return json(publicState(s));
  }

  if (path === "/import" && req.method === "POST") {
    // líneas: TICKER, cantidad, precio medio[, objetivo venta][, precio compra]
    const s = await loadState(env);
    const lines = String(body.text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const added = [];
    for (const line of lines) {
      const { sym, qty, avg, tgt, buy } = parseImportLine(line);
      if (!sym) continue;
      const it = cleanItem({ symbol: sym, qty, avg, myTarget: tgt, myBuy: buy, kind: body.kind || (qty ? "holding" : "watch") }, s.items[sym.toUpperCase()]);
      s.items[it.symbol] = it; added.push(it.symbol);
    }
    await refreshQuotes(env, s, added);
    for (const sym of added) { const f = s.flags; await evaluateAlerts({ ...env, NTFY_TOPIC: "" }, s, sym); s.flags = f; }
    s.log = s.log.filter((l) => !(added.includes(l.symbol) && Date.now() - l.t < 5000));
    await saveState(env, s);
    return json({ added, state: publicState(s) });
  }

  const m = path.match(/^\/items\/([^/]+)$/);
  if (m && req.method === "DELETE") {
    const s = await loadState(env); const sym = decodeURIComponent(m[1]).toUpperCase();
    delete s.items[sym]; delete s.market[sym]; delete s.targets[sym];
    for (const k of Object.keys(s.flags)) if (k.startsWith(sym + ":")) delete s.flags[k];
    await saveState(env, s);
    return json(publicState(s));
  }

  if (path === "/targets/refresh" && req.method === "POST") {
    const s = await loadState(env);
    // Un símbolo concreto no necesita tope (como mucho son 3 peticiones); al
    // refrescar TODOS de golpe (botón "Actualizar todos los consensos" de
    // Ajustes) sí, para no pasarse del límite de subpeticiones — ver
    // safeForceTargetsLimit(). Aquí no hay precios de por medio (no se llama a
    // refreshQuotes), así que el hueco disponible es el máximo posible.
    const syms = body?.symbol ? [String(body.symbol).toUpperCase()] : prioritizeSymbols(s);
    const limit = body?.symbol ? null : safeForceTargetsLimit(0);
    await refreshTargets(env, s, syms, { force: true, limit });
    await saveState(env, s);
    return json(publicState(s));
  }

  if (path === "/settings" && req.method === "POST") {
    const s = await loadState(env);
    s.settings = { ...s.settings, nearPct: num(body.nearPct) ?? s.settings.nearPct, farPct: num(body.farPct) ?? s.settings.farPct, consensusChangePct: num(body.consensusChangePct) ?? s.settings.consensusChangePct, entryAlerts: body.entryAlerts ?? s.settings.entryAlerts, quietNight: body.quietNight ?? s.settings.quietNight };
    await saveState(env, s);
    return json(publicState(s));
  }

  if (path === "/test-notification" && req.method === "POST") {
    if (!env.NTFY_TOPIC) return json({ ok: false, error: "Falta NTFY_TOPIC" });
    // Devuelve lo que ntfy.sh haya respondido de verdad (antes esto siempre
    // decía ok:true con solo que NTFY_TOPIC existiera, aunque el envío real
    // hubiera fallado — ver sendNtfy en notify.js).
    const r = await sendNtfy(env, { title: "Radar Cartera funciona", body: "Si ves esto, las alertas llegarán a tu móvil.", tags: "white_check_mark", priority: 3 });
    return json(r);
  }

  if (path === "/backtest" && req.method === "GET") {
    const sym = (url.searchParams.get("symbol") || "").toUpperCase();
    const s = await loadState(env);
    const it = s.items[sym];
    if (!it || it.qty == null || it.avg == null) return json({ error: "Esa acción no tiene una posición (cantidad y precio de compra) que simular" }, 400);
    const stepUpPct = Math.min(50, Math.max(0.1, num(url.searchParams.get("stepUpPct")) ?? 5));
    const stepDownPct = Math.min(50, Math.max(0.1, num(url.searchParams.get("stepDownPct")) ?? 2));
    const tradePct = Math.min(95, Math.max(0.1, num(url.searchParams.get("tradePct")) ?? 5));
    const months = Math.min(24, Math.max(1, num(url.searchParams.get("months")) ?? 4));
    try {
      const history = await getPriceHistory(sym, env, months);
      const result = simulateGrid(history, { qty: it.qty, avg: it.avg, stepUpPct, stepDownPct, tradePct });
      return json({ symbol: sym, stepUpPct, stepDownPct, tradePct, months, days: history.length, currency: it.currency || s.market[sym]?.currency || null, ...result });
    } catch (e) { return json({ error: e.message }, 502); }
  }

  if (path === "/diag" && req.method === "GET") {
    const sym = (url.searchParams.get("symbol") || "AAPL").toUpperCase();
    const out = { symbol: sym, keys: { FMP_KEY: !!env.FMP_KEY, FINNHUB_KEY: !!env.FINNHUB_KEY, NTFY_TOPIC: !!env.NTFY_TOPIC } };
    const tryIt = async (name, fn) => { try { out[name] = { ok: true, data: await fn() }; } catch (e) { out[name] = { ok: false, error: e.message }; } };
    await tryIt("yahooQuote", () => yahooQuote(sym));
    await tryIt("finnhubQuote", () => finnhubQuote(sym, env));
    await tryIt("fmpTargets", () => fmpTargets(sym, env));
    await tryIt("analystCount", () => analystCount(sym, env));
    await tryIt("yahooTargets", () => yahooTargets(sym));
    await tryIt("fmpPe", () => fmpPe(sym, env));
    await tryIt("fxRate", () => fxRate(env));
    await tryIt("yahoo200wma", () => yahoo200wma(sym));
    return json(out);
  }

  return json({ error: "Ruta no encontrada" }, 404);
}

export { handleApi, runCycle, refreshQuotes, refreshTargets, refreshFx, refreshWma };
