// Tests de src/api.js (Fase 1): rutas /api/* de extremo a extremo con KV simulado
// y MOCK=1 (sin red). Cubre el criterio de aceptación de la Fase 1: al añadir un
// ticker aparecen precio, sesión y consenso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi, refreshFx, refreshTargets, refreshWma, runCycle, appendConsensusHistoryPoint, matchHoldings, matchPositions } from "../src/api.js";

class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key, type) {
    const v = this.store.get(key);
    if (v == null) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key, value) { this.store.set(key, value); }
}

function makeEnv() {
  return { KV: new FakeKV(), APP_TOKEN: "test-token", MOCK: "1" };
}

async function call(env, method, path, body) {
  const url = new URL("http://local" + path);
  const req = new Request(url, {
    method,
    headers: { authorization: "Bearer " + env.APP_TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleApi(req, env, url);
  return { status: res.status, data: await res.json() };
}

test("/api/state sin token responde 401", async () => {
  const env = makeEnv();
  const res = await handleApi(new Request("http://local/api/state"), env, new URL("http://local/api/state"));
  assert.equal(res.status, 401);
});

test("añadir un ticker por /api/items devuelve precio, sesión y consenso", async () => {
  const env = makeEnv();
  const { status, data } = await call(env, "POST", "/api/items", { symbol: "nvda", kind: "holding", qty: 16, avg: 204.55 });
  assert.equal(status, 200);
  assert.equal(data.items.NVDA.qty, 16);
  assert.equal(typeof data.market.NVDA.price, "number");
  assert.equal(data.market.NVDA.session, "regular");
  assert.equal(typeof data.targets.NVDA.mean, "number");
});

test("/api/import acepta varias líneas con distintos separadores", async () => {
  const env = makeEnv();
  const text = "NVDA, 16, 204.55, 240\nMSFT;1.5;386.59\nADBE";
  const { status, data } = await call(env, "POST", "/api/import", { text });
  assert.equal(status, 200);
  assert.deepEqual(data.added.sort(), ["ADBE", "MSFT", "NVDA"]);
  assert.equal(data.state.items.MSFT.kind, "holding");
  assert.equal(data.state.items.ADBE.kind, "watch");
});

test("/api/items DELETE elimina el valor y sus datos asociados", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "NVDA" });
  const { status, data } = await call(env, "DELETE", "/api/items/NVDA");
  assert.equal(status, 200);
  assert.equal(data.items.NVDA, undefined);
  assert.equal(data.market.NVDA, undefined);
});

test("/api/search en modo MOCK responde con el ticker buscado", async () => {
  const env = makeEnv();
  const { data } = await call(env, "GET", "/api/search?q=nvda");
  assert.equal(data[0].symbol, "NVDA");
});

test("añadir un ticker también rellena el tipo de cambio EUR/USD si faltaba", async () => {
  const env = makeEnv();
  const { data } = await call(env, "POST", "/api/items", { symbol: "NVDA" });
  assert.equal(typeof data.fx.usdPerEur, "number");
});

test("refreshFx no vuelve a pedir el tipo de cambio si todavía no está caducado", async () => {
  const s = { fx: { usdPerEur: 1.23, updatedAt: Date.now() } };
  await refreshFx({ MOCK: "1" }, s);
  assert.equal(s.fx.usdPerEur, 1.23); // no lo ha tocado
});

test("refreshFx lo refresca si está caducado (más de 20 h)", async () => {
  const s = { fx: { usdPerEur: 1.23, updatedAt: Date.now() - 21 * 3600e3 } };
  await refreshFx({ MOCK: "1" }, s);
  assert.notEqual(s.fx.updatedAt, Date.now() - 21 * 3600e3);
});

test("refreshWma rellena el 200WMA de un símbolo sin él todavía", async () => {
  const s = { targets: { NVDA: { mean: 300 } }, settings: { consensusChangePct: 1 }, log: [] };
  await refreshWma({ MOCK: "1" }, s, ["NVDA"]);
  assert.equal(typeof s.targets.NVDA.wma200, "number");
  assert.ok(s.targets.NVDA.wma200UpdatedAt);
});

test("refreshWma no repite la petición si todavía no ha caducado (dura semanas)", async () => {
  const s = { targets: { NVDA: { mean: 300, wma200: 111, wma200UpdatedAt: Date.now() - 3600e3 } }, settings: {}, log: [] };
  await refreshWma({ MOCK: "1" }, s, ["NVDA"]);
  assert.equal(s.targets.NVDA.wma200, 111);
});

test("refreshTargets conserva el 200WMA ya guardado al refrescar el resto del consenso", async () => {
  const s = { targets: { NVDA: { mean: 300, wma200: 111, wma200UpdatedAt: 12345 } }, settings: { consensusChangePct: 1 }, log: [] };
  await refreshTargets({ MOCK: "1" }, s, ["NVDA"], { force: true, notifyChanges: false });
  assert.equal(s.targets.NVDA.wma200, 111, "el 200WMA no debe perderse al refrescar el consenso");
  assert.equal(s.targets.NVDA.wma200UpdatedAt, 12345);
});

test("refreshTargets va guardando un punto diario de histórico del consenso", async () => {
  const s = { targets: {}, settings: { consensusChangePct: 1 }, log: [] };
  await refreshTargets({ MOCK: "1" }, s, ["NVDA"], { force: true, notifyChanges: false });
  assert.equal(s.targets.NVDA.history.length, 1);
  assert.equal(s.targets.NVDA.history[0].mean, s.targets.NVDA.mean);
});

test("appendConsensusHistoryPoint: un segundo refresco el mismo día sustituye el punto, no lo duplica", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const h1 = appendConsensusHistoryPoint(undefined, { mean: 300, high: 350, low: 250, analysts: 10 }, now);
  const laterSameDay = now + 3600e3;
  const h2 = appendConsensusHistoryPoint(h1, { mean: 310, high: 360, low: 260, analysts: 11 }, laterSameDay);
  assert.equal(h2.length, 1);
  assert.equal(h2[0].mean, 310);
});

test("appendConsensusHistoryPoint: un refresco al día siguiente añade un punto nuevo", () => {
  const day1 = Date.parse("2026-10-21T10:00:00Z");
  const day2 = Date.parse("2026-10-22T10:00:00Z");
  const h1 = appendConsensusHistoryPoint(undefined, { mean: 300 }, day1);
  const h2 = appendConsensusHistoryPoint(h1, { mean: 305 }, day2);
  assert.equal(h2.length, 2);
  assert.equal(h2[0].mean, 300);
  assert.equal(h2[1].mean, 305);
});

test("appendConsensusHistoryPoint: recorta al máximo de puntos", () => {
  let history;
  let now = Date.parse("2020-01-01T00:00:00Z");
  for (let i = 0; i < 410; i++) {
    history = appendConsensusHistoryPoint(history, { mean: 100 + i }, now);
    now += 24 * 3600e3;
  }
  assert.equal(history.length, 400);
  assert.equal(history[history.length - 1].mean, 100 + 409);
});

test("matchHoldings: empareja por ISIN ya guardado y propone la nueva cantidad", () => {
  const items = { NVDA: { symbol: "NVDA", name: "NVIDIA Corp", qty: 10, isin: "US67066G1040" } };
  const { matched, unmatched } = matchHoldings(items, [{ isin: "US67066G1040", name: "NVIDIA Corp", qty: 12, currency: "USD" }]);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(matched, [{ symbol: "NVDA", isin: "US67066G1040", name: "NVIDIA Corp", oldQty: 10, newQty: 12 }]);
});

test("matchHoldings: sin ISIN guardado, empareja por nombre normalizado (primer import)", () => {
  const items = { ORCL: { symbol: "ORCL", name: "Oracle Corp", qty: 1, isin: null } };
  const { matched } = matchHoldings(items, [{ isin: "US68389X1054", name: "Oracle Corp", qty: 1, currency: "USD" }]);
  assert.equal(matched[0].symbol, "ORCL");
});

test("matchHoldings: el nombre tolera variantes de sufijo corporativo (Corp/Corporation, NV/N.V.)", () => {
  const items = {
    MSFT: { symbol: "MSFT", name: "Microsoft Corporation", qty: 1, isin: null },
    ASML: { symbol: "ASML", name: "ASML Holding N.V.", qty: 1, isin: null },
  };
  const { matched, unmatched } = matchHoldings(items, [
    { isin: "US5949181045", name: "Microsoft Corp", qty: 1.5, currency: "USD" },
    { isin: "NL0010273215", name: "ASML Holding NV", qty: 0.3, currency: "EUR" },
  ]);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(matched.map((m) => m.symbol).sort(), ["ASML", "MSFT"]);
});

test("matchHoldings: lo que no encuentra pareja (ticker nuevo) va a unmatched, no se crea solo", () => {
  const { matched, unmatched } = matchHoldings({}, [{ isin: "US4612021034", name: "Intuit Inc", qty: 5, currency: "USD" }]);
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].isin, "US4612021034");
});

test("matchHoldings: mismo ISIN repetido con distinta divisa (lotes Trading212) suma las cantidades", () => {
  const items = { AMZN: { symbol: "AMZN", name: "Amazon.com Inc", qty: 1, isin: "US0231351067" } };
  const { matched } = matchHoldings(items, [
    { isin: "US0231351067", name: "Amazon.com Inc", qty: 4, currency: "USD" },
    { isin: "US0231351067", name: "Amazon.com Inc", qty: 3, currency: "EUR" },
  ]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].newQty, 7);
});

test("/api/import-holdings en modo dry-run no toca el estado; con apply sí actualiza qty y guarda el isin", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "NVDA", name: "NVIDIA Corp", kind: "holding", qty: 10, avg: 200 });
  const dry = await call(env, "POST", "/api/import-holdings", { holdings: [{ isin: "US67066G1040", name: "NVIDIA Corp", qty: 16, currency: "USD" }] });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.matched[0].symbol, "NVDA");
  assert.equal(dry.data.applied, false);
  const stillOld = await call(env, "GET", "/api/state");
  assert.equal(stillOld.data.items.NVDA.qty, 10, "dry-run no debe escribir nada");

  const apply = await call(env, "POST", "/api/import-holdings", { holdings: [{ isin: "US67066G1040", name: "NVIDIA Corp", qty: 16, currency: "USD" }], apply: true });
  assert.equal(apply.data.applied, true);
  const after = await call(env, "GET", "/api/state");
  assert.equal(after.data.items.NVDA.qty, 16);
  assert.equal(after.data.items.NVDA.isin, "US67066G1040");
  assert.equal(after.data.items.NVDA.avg, 200, "el precio medio no lo toca este import");
});

test("/api/import-holdings: aplicar pasa el kind de watch a holding (si el extracto dice que la tienes, es una posición real)", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "NVDA", name: "NVIDIA Corp", kind: "watch" });
  await call(env, "POST", "/api/import-holdings", { holdings: [{ isin: "US67066G1040", name: "NVIDIA Corp", qty: 16, currency: "USD" }], apply: true });
  const after = await call(env, "GET", "/api/state");
  assert.equal(after.data.items.NVDA.kind, "holding");
});

test("matchPositions: empareja por ticker exacto cuando aún no hay ISIN guardado, y propone qty+avg+costEur", () => {
  const items = { NVDA: { symbol: "NVDA", name: "NVIDIA Corp", qty: 10, avg: 180, costEur: 1500, isin: null, currency: "USD" } };
  const { matched, unmatched } = matchPositions(items, [
    { ticker: "NVDA", isin: "US67066G1040", qty: 12, avg: 200.59, avgCurrency: "USD", costEur: 2234.44 },
  ]);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(matched[0], {
    symbol: "NVDA", isin: "US67066G1040", ticker: "NVDA",
    oldQty: 10, newQty: 12,
    oldAvg: 180, newAvg: 200.59,
    oldCostEur: 1500, newCostEur: 2234.44,
    skippedAvg: null,
  });
});

test("matchPositions: ISIN repetido en varias divisas (mismo valor, dos lotes) suma cantidad y coste real, pero no toca el precio medio", () => {
  const items = { AMZN: { symbol: "AMZN", qty: 1, avg: 200, costEur: 180, isin: "US0231351067", currency: "USD" } };
  const { matched } = matchPositions(items, [
    { ticker: "AMZN", isin: "US0231351067", qty: 4, avg: 263.37, avgCurrency: "USD", costEur: 843.28 },
    { ticker: "AMZ", isin: "US0231351067", qty: 3, avg: 234.5, avgCurrency: "EUR", costEur: 615.71 },
  ]);
  assert.equal(matched[0].newQty, 7);
  assert.equal(matched[0].newAvg, null, "no se puede combinar un precio medio en USD con uno en EUR sin convertir");
  assert.equal(matched[0].newCostEur, 1458.99, "el coste real en euros sí se puede sumar entre lotes aunque sean de divisas distintas");
  assert.equal(matched[0].skippedAvg, "varias divisas en el mismo ISIN");
});

test("matchPositions: si la divisa del precio medio leído no coincide con la ya guardada, actualiza qty pero no avg", () => {
  const items = { ASML: { symbol: "ASML", qty: 1, avg: 1400, isin: null, currency: "EUR" } };
  const { matched } = matchPositions(items, [{ ticker: "ASML", isin: "NL0010273215", qty: 0.3, avg: 1455.4, avgCurrency: "USD", costEur: 436.67 }]);
  assert.equal(matched[0].newQty, 0.3);
  assert.equal(matched[0].newAvg, null);
  assert.equal(matched[0].skippedAvg, "divisa distinta a la ya guardada");
});

test("/api/import-positions aplica qty, avg y costEur, pasa a holding, y conserva el resto del ítem", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "NVDA", kind: "watch", myTarget: 300 });
  const apply = await call(env, "POST", "/api/import-positions", {
    positions: [{ ticker: "NVDA", isin: "US67066G1040", qty: 12, avg: 200.59, avgCurrency: "USD", costEur: 2234.44 }],
    apply: true,
  });
  assert.equal(apply.data.applied, true);
  const after = await call(env, "GET", "/api/state");
  assert.equal(after.data.items.NVDA.qty, 12);
  assert.equal(after.data.items.NVDA.avg, 200.59);
  assert.equal(after.data.items.NVDA.costEur, 2234.44);
  assert.equal(after.data.items.NVDA.isin, "US67066G1040");
  assert.equal(after.data.items.NVDA.kind, "holding");
  assert.equal(after.data.items.NVDA.myTarget, 300, "no debe tocar campos que este import no gestiona");
});

test("/api/backtest simula la estrategia de tramos sobre una posición existente", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "NVDA", kind: "holding", qty: 16, avg: 204.55 });
  const { status, data } = await call(env, "GET", "/api/backtest?symbol=NVDA&stepUpPct=5&stepDownPct=2&tradePct=10&months=4");
  assert.equal(status, 200);
  assert.equal(data.symbol, "NVDA");
  assert.ok(Array.isArray(data.trades));
  assert.equal(typeof data.finalValue, "number");
  assert.equal(typeof data.holdValue, "number");
});

test("/api/backtest devuelve 400 si el símbolo no tiene posición (cantidad y precio de compra)", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "ADBE" }); // sin qty/avg -> watchlist
  const { status, data } = await call(env, "GET", "/api/backtest?symbol=ADBE");
  assert.equal(status, 400);
  assert.ok(data.error);
});

test("runCycle: sin forceTargets no toca un consenso ya fresco, pero con forceTargets sí lo refresca", async () => {
  const env = makeEnv();
  const seeded = {
    items: { NVDA: { symbol: "NVDA", kind: "holding", qty: 1, avg: 10, name: null, currency: "USD", myTarget: null, myBuy: null, note: "" } },
    market: {}, targets: { NVDA: { mean: 300, updatedAt: Date.now() - 1000 } }, flags: {}, log: [], pending: [], fx: null, settings: {},
  };
  await env.KV.put("state", JSON.stringify(seeded));
  const before = seeded.targets.NVDA.updatedAt;

  const s1 = await runCycle(env, { forceQuotes: true, forceTargets: false });
  assert.equal(s1.targets.NVDA.updatedAt, before, "sin forceTargets, un consenso ya fresco no debería tocarse");

  const s2 = await runCycle(env, { forceQuotes: true, forceTargets: true });
  assert.notEqual(s2.targets.NVDA.updatedAt, before, "con forceTargets, debe refrescarse aunque ya estuviera fresco");
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("/api/targets/refresh (todos) prioriza las posiciones reales y respeta un tope seguro de subpeticiones", async () => {
  const env = makeEnv();
  // 3 posiciones reales + 20 en watchlist = 23 símbolos: más de los que caben
  // con seguridad forzando todos de golpe (safeForceTargetsLimit(0) = 15 con
  // MAX_SUBREQUESTS_SAFE=46 y coste de 3 peticiones/símbolo sin FMP_KEY).
  for (let i = 1; i <= 3; i++) await call(env, "POST", "/api/items", { symbol: `HOLD${i}`, kind: "holding", qty: 1, avg: 10 });
  for (let i = 1; i <= 20; i++) await call(env, "POST", "/api/items", { symbol: `WATCH${i}` });
  const before = (await call(env, "GET", "/api/state")).data;
  await sleep(5);

  const { data } = await call(env, "POST", "/api/targets/refresh", {});
  const holdRefreshed = [1, 2, 3].filter((i) => data.targets[`HOLD${i}`].updatedAt !== before.targets[`HOLD${i}`].updatedAt).length;
  const watchRefreshed = Array.from({ length: 20 }, (_, i) => i + 1).filter((i) => data.targets[`WATCH${i}`].updatedAt !== before.targets[`WATCH${i}`].updatedAt).length;

  assert.equal(holdRefreshed, 3, "las 3 posiciones reales deben refrescarse siempre, aunque haya que topar la watchlist");
  assert.ok(holdRefreshed + watchRefreshed <= 15, "nunca se intentan más símbolos de los que caben con seguridad en una sola invocación");
  assert.ok(watchRefreshed < 20, "con el tope, no le da tiempo a toda la watchlist en una sola llamada");
});

test("runCycle refresca antes las posiciones reales (holding) que la watchlist, sin importar el orden en que se añadieron", async () => {
  const env = makeEnv();
  // 5 watchlist añadidos ANTES que la única posición real: sin priorizar,
  // TARGETS_PER_RUN=4 se los comería todos a ellos y HOLD1 se quedaría fuera.
  const items = {};
  for (let i = 1; i <= 5; i++) items[`WATCH${i}`] = { symbol: `WATCH${i}`, kind: "watch" };
  items.HOLD1 = { symbol: "HOLD1", kind: "holding", qty: 1, avg: 10 };
  const seeded = { items, market: {}, targets: {}, flags: {}, log: [], pending: [], fx: null, settings: {} };
  await env.KV.put("state", JSON.stringify(seeded));

  const s = await runCycle(env, {});
  assert.ok(s.targets.HOLD1?.updatedAt, "la posición real debe refrescarse en el primer ciclo aunque se añadiera la última");
  const watchRefreshed = Object.keys(items).filter((k) => k.startsWith("WATCH") && s.targets[k]?.updatedAt).length;
  assert.equal(watchRefreshed, 3, "con HOLD1 ocupando una plaza, solo caben 3 de los 5 de la watchlist en este ciclo (TARGETS_PER_RUN=4)");
});

test("/api/refresh con full:true fuerza el refresco de consenso aunque no esté caducado", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/items", { symbol: "NVDA", kind: "holding", qty: 16, avg: 204.55 });
  const before = (await call(env, "GET", "/api/state")).data.targets.NVDA.updatedAt;

  const withoutFull = await call(env, "POST", "/api/refresh", {});
  assert.equal(withoutFull.data.targets.NVDA.updatedAt, before, "sin full, un consenso recién puesto no debería volver a tocarse");

  const withFull = await call(env, "POST", "/api/refresh", { full: true });
  assert.notEqual(withFull.data.targets.NVDA.updatedAt, before, "con full:true, debe forzar el refresco de todos los símbolos");
});
