// Tests del motor de alertas (Fase 3, ver spec §6.7 y §13).
// Para cada regla: una secuencia de precios que entra, se mantiene, sale sin
// margen (no rearma), sale con margen (rearma) y vuelve a entrar (segundo aviso).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rule, evaluateAlerts } from "../src/alerts.js";

function baseState(overrides = {}) {
  return {
    items: { NVDA: { symbol: "NVDA", kind: "holding", qty: 10, avg: 200, myTarget: 240, myBuy: 190, ...overrides.item } },
    market: { NVDA: { price: 220, currency: "USD", session: "regular", ...overrides.market } },
    targets: { NVDA: { mean: 230, high: 300, low: 210, ...overrides.targets } },
    flags: {},
    log: [],
    settings: { nearPct: 3, farPct: 50, consensusChangePct: 1, entryAlerts: true, quietNight: false },
  };
}
const noNotifyEnv = { MOCK: "1" }; // notify() con MOCK no llama a ntfy, pero sigue registrando en s.log

function titlesFor(s) { return s.log.map((l) => l.title); }

test("rule(): dispara una sola vez al entrar, no se repite mientras se mantiene activa", () => {
  const s = { flags: {} };
  assert.equal(rule(s, "x", true, false), true);   // entra -> dispara
  assert.equal(rule(s, "x", true, false), false);  // se mantiene -> no repite
  assert.equal(rule(s, "x", true, false), false);
});

test("rule(): sale sin margen no rearma; sale con margen sí rearma", () => {
  const s = { flags: {} };
  rule(s, "x", true, false); // entra
  assert.equal(rule(s, "x", false, false), false); // sale, pero sin margen (rearm=false) -> no se rearma
  assert.ok(s.flags.x, "sigue marcada como disparada");
  assert.equal(rule(s, "x", false, true), false);  // ahora sale con margen suficiente -> se rearma
  assert.ok(!s.flags.x, "se ha rearmado");
});

test("rule(): tras rearmarse, volver a entrar dispara un segundo aviso", () => {
  const s = { flags: {} };
  assert.equal(rule(s, "x", true, false), true);   // 1er aviso
  assert.equal(rule(s, "x", false, true), false);  // rearma
  assert.equal(rule(s, "x", true, false), true);   // 2º aviso
});

test("nearMean: secuencia completa entra/mantiene/sale sin margen/sale con margen/vuelve a entrar", async () => {
  const s = baseState({ targets: { mean: 230 } }); // near = 3% de 230 = 6.9
  const at = async (price) => { s.market.NVDA.price = price; await evaluateAlerts(noNotifyEnv, s, "NVDA"); };

  await at(225);                                   // dentro del 3% -> dispara
  assert.equal(titlesFor(s).filter((t) => t.includes("cerca del consenso")).length, 1);

  await at(224);                                   // se mantiene dentro -> no repite
  assert.equal(titlesFor(s).filter((t) => t.includes("cerca del consenso")).length, 1);

  await at(219);                                   // sale del 3% pero no del margen de rearme (1.7×3% = 5.1%)
  assert.equal(s.flags["NVDA:nearMean"], true, "no se ha rearmado todavía");

  await at(210);                                   // sale con margen suficiente (> 5.1% de 230) -> rearma
  assert.equal(s.flags["NVDA:nearMean"], undefined);

  await at(225);                                    // vuelve a entrar -> segundo aviso
  assert.equal(titlesFor(s).filter((t) => t.includes("cerca del consenso")).length, 2);
});

test("farFromMean: avisa cuando el precio se aleja 50% o más del consenso (en cualquier sentido), y rearma con margen", async () => {
  const s = baseState({ targets: { mean: 230 } }); // far = 50% de 230
  const at = async (price) => { s.market.NVDA.price = price; await evaluateAlerts(noNotifyEnv, s, "NVDA"); };

  await at(100);                                    // |−56,5%| >= 50% -> dispara
  assert.equal(titlesFor(s).filter((t) => t.includes("muy alejado del consenso")).length, 1);

  await at(105);                                    // sigue muy alejado -> no repite
  assert.equal(titlesFor(s).filter((t) => t.includes("muy alejado del consenso")).length, 1);

  await at(125);                                    // vuelve dentro del 50% pero no del margen de rearme (42,5%)
  assert.equal(s.flags["NVDA:farFromMean"], true, "no se ha rearmado todavía");

  await at(135);                                    // por debajo del margen de rearme -> rearma
  assert.equal(s.flags["NVDA:farFromMean"], undefined);

  await at(100);                                     // vuelve a alejarse -> segundo aviso
  assert.equal(titlesFor(s).filter((t) => t.includes("muy alejado del consenso")).length, 2);
});

test("farFromMean: también avisa cuando el precio se dispara muy por encima del consenso", async () => {
  const s = baseState({ targets: { mean: 230 } });
  const at = async (price) => { s.market.NVDA.price = price; await evaluateAlerts(noNotifyEnv, s, "NVDA"); };
  await at(400); // +73,9% >= 50%
  const body = s.log.find((l) => l.title.includes("muy alejado del consenso"))?.body;
  assert.match(body, /muy por encima/);
});

test("hitMyTarget: dispara al llegar al objetivo de venta y rearma solo con margen", async () => {
  const s = baseState({ item: { myTarget: 240 } });
  const at = async (price) => { s.market.NVDA.price = price; await evaluateAlerts(noNotifyEnv, s, "NVDA"); };

  await at(241);
  assert.equal(titlesFor(s).filter((t) => t.includes("ha llegado a tu objetivo")).length, 1);

  await at(242); // se mantiene por encima -> no repite
  assert.equal(titlesFor(s).filter((t) => t.includes("ha llegado a tu objetivo")).length, 1);

  await at(236); // por debajo del objetivo pero dentro del margen de rearme (0.98 * 240 = 235.2) -> no rearma
  assert.equal(s.flags["NVDA:hitMyTarget"], true);

  await at(230); // por debajo del margen -> rearma
  assert.equal(s.flags["NVDA:hitMyTarget"], undefined);

  await at(241); // vuelve a superar el objetivo -> segundo aviso
  assert.equal(titlesFor(s).filter((t) => t.includes("ha llegado a tu objetivo")).length, 2);
});

test("hitMyBuy: dispara al bajar del precio de compra y rearma con margen", async () => {
  const s = baseState({ item: { myBuy: 190 } });
  const at = async (price) => { s.market.NVDA.price = price; await evaluateAlerts(noNotifyEnv, s, "NVDA"); };

  await at(188);
  assert.equal(titlesFor(s).filter((t) => t.includes("en tu precio de compra")).length, 1);

  await at(193); // por encima pero dentro del margen (1.02 * 190 = 193.8) -> no rearma
  assert.equal(s.flags["NVDA:hitMyBuy"], true);

  await at(195); // por encima del margen -> rearma
  assert.equal(s.flags["NVDA:hitMyBuy"], undefined);

  await at(188); // vuelve a bajar -> segundo aviso
  assert.equal(titlesFor(s).filter((t) => t.includes("en tu precio de compra")).length, 2);
});

test("rule() con remindMs: no repite de inmediato, pero sí una vez pasado el intervalo, mientras se mantiene activa", () => {
  const s = { flags: {} };
  const DAY = 24 * 3600 * 1000;
  let t = 1_000_000;
  assert.equal(rule(s, "x", true, false, t, DAY), true);    // entra -> dispara
  assert.equal(rule(s, "x", true, false, t + 1000, DAY), false); // se mantiene, poco después -> no repite
  assert.equal(rule(s, "x", true, false, t + DAY - 1, DAY), false); // justo antes del día -> no repite
  assert.equal(rule(s, "x", true, false, t + DAY, DAY), true);  // pasado el día -> recordatorio
  assert.equal(rule(s, "x", true, false, t + DAY + 10, DAY), false); // de nuevo tras el recordatorio -> calla
});

test("hitMyBuy: además de disparar al entrar, recuerda una vez al día mientras se mantiene por debajo", async () => {
  const s = baseState({ item: { myBuy: 190 } });
  s.market.NVDA.price = 188;
  await evaluateAlerts(noNotifyEnv, s, "NVDA"); // 1er aviso
  assert.equal(titlesFor(s).filter((t) => t.includes("en tu precio de compra")).length, 1);

  await evaluateAlerts(noNotifyEnv, s, "NVDA"); // segundos después, se mantiene -> no repite
  assert.equal(titlesFor(s).filter((t) => t.includes("en tu precio de compra")).length, 1);

  s.flags["NVDA:hitMyBuy:ts"] -= 25 * 3600 * 1000; // simula que ha pasado más de un día
  await evaluateAlerts(noNotifyEnv, s, "NVDA");
  assert.equal(titlesFor(s).filter((t) => t.includes("en tu precio de compra")).length, 2, "recuerda pasado un día aunque siga en el mismo sitio");
});

test("avisos escalonados bajo el precio de compra: dispara al momento al profundizar de tramo (−5%, −10%, −15%…)", async () => {
  // avg se anula a propósito para que el aviso de "precio medio" no se solape con el de "precio de compra"
  const s = baseState({ item: { myBuy: 200, avg: undefined } });
  const at = async (price) => { s.market.NVDA.price = price; await evaluateAlerts(noNotifyEnv, s, "NVDA"); };

  await at(192); // −4 % -> todavía no llega al primer tramo (5 %)
  assert.equal(titlesFor(s).filter((t) => t.includes("ha caído más de un")).length, 0);

  await at(190); // −5 % -> primer tramo
  assert.equal(titlesFor(s).filter((t) => t.includes("ha caído más de un 5 %")).length, 1);

  await at(188); // −6 %, mismo tramo -> no repite de inmediato
  assert.equal(titlesFor(s).filter((t) => t.includes("ha caído más de un 5 %")).length, 1);

  await at(180); // −10 % -> profundiza de tramo, avisa al momento
  assert.equal(titlesFor(s).filter((t) => t.includes("ha caído más de un 10 %")).length, 1);

  await at(195); // recupera por encima del primer tramo -> se limpia el estado
  await at(180); // vuelve a caer un 10 % -> segundo aviso de ese tramo
  assert.equal(titlesFor(s).filter((t) => t.includes("ha caído más de un 10 %")).length, 2);
});

test("belowEntry: avisa al cruzar el precio de entrada en cualquier sentido, con margen de 0.5%", async () => {
  // objetivos/consenso elegidos a propósito para no disparar otras reglas a la vez
  // (mean a un 16 % de distancia: ni "cerca" del 3 % ni "muy alejado" del 50 %)
  const s = baseState({ item: { avg: 200, myTarget: 1000, myBuy: 10 }, market: { price: 210 }, targets: { mean: 250, high: 2000, low: 10 } });
  await evaluateAlerts(noNotifyEnv, s, "NVDA"); // primera evaluación: solo fija el estado, no avisa
  assert.equal(titlesFor(s).length, 0);

  s.market.NVDA.price = 198; // cruza por debajo, más de 0.5% de margen (1 %)
  await evaluateAlerts(noNotifyEnv, s, "NVDA");
  assert.equal(titlesFor(s).filter((t) => t.includes("baja de")).length, 1);

  s.market.NVDA.price = 199.3; // sigue por debajo (mismo lado) -> no repite, sin importar el margen
  await evaluateAlerts(noNotifyEnv, s, "NVDA");
  assert.equal(titlesFor(s).filter((t) => t.includes("baja de")).length, 1);

  s.market.NVDA.price = 205; // recupera por encima con margen -> avisa de nuevo (el otro sentido)
  await evaluateAlerts(noNotifyEnv, s, "NVDA");
  assert.equal(titlesFor(s).filter((t) => t.includes("recupera")).length, 1);
});
