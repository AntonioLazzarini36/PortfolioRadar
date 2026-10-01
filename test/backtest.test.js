// Tests del simulador de tramos (src/backtest.js): grid trading autofinanciado
// y asimétrico (umbral de venta distinto del de compra) aplicado a una serie
// de precios histórica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateGrid } from "../src/backtest.js";

test("sin movimiento no hay operaciones, y el valor final coincide con solo mantener", () => {
  const history = [{ date: 1, close: 100 }, { date: 2, close: 100 }, { date: 3, close: 100 }];
  const r = simulateGrid(history, { qty: 10, avg: 90, stepUpPct: 5, stepDownPct: 5, tradePct: 10 });
  assert.deepEqual(r.trades, []);
  assert.equal(r.finalValue, r.holdValue);
  assert.equal(r.strategyGainPct, 0);
});

test("vende una porción al subir el tramo de venta", () => {
  const history = [{ date: 1, close: 100 }, { date: 2, close: 110 }];
  const r = simulateGrid(history, { qty: 10, avg: 100, stepUpPct: 5, stepDownPct: 5, tradePct: 10 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].action, "sell");
  assert.equal(r.trades[0].qty, 1); // 10 * 0.10
  assert.equal(r.shares, 9);
  assert.equal(r.cash, 110);
});

test("recompra con la caja acumulada al bajar el tramo de compra desde la nueva referencia", () => {
  const history = [{ date: 1, close: 100 }, { date: 2, close: 110 }, { date: 3, close: 104 }];
  const r = simulateGrid(history, { qty: 10, avg: 100, stepUpPct: 5, stepDownPct: 5, tradePct: 10 });
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[1].action, "buy");
  const expectedQty = (110 * 0.1) / 104;
  assert.equal(r.trades[1].qty, expectedQty);
  assert.equal(r.shares, 9 + expectedQty);
  assert.equal(r.cash, 110 - 110 * 0.1);
});

test("con umbral de compra más pequeño que el de venta, un retroceso menor ya recompra (pensado para tendencias alcistas)", () => {
  // Subida del 10% (dispara venta con stepUpPct=5), luego solo un 3% de
  // retroceso: con stepDownPct=5 (simétrico) NO debería recomprar todavía;
  // con stepDownPct=2 SÍ debería, porque basta un retroceso menor.
  const history = [{ date: 1, close: 100 }, { date: 2, close: 110 }, { date: 3, close: 106.7 }]; // -3% desde 110
  const symmetric = simulateGrid(history, { qty: 10, avg: 100, stepUpPct: 5, stepDownPct: 5, tradePct: 10 });
  const asymmetric = simulateGrid(history, { qty: 10, avg: 100, stepUpPct: 5, stepDownPct: 2, tradePct: 10 });
  assert.equal(symmetric.trades.length, 1, "con umbral simétrico, un -3% no basta para recomprar tras vender a +10%");
  assert.equal(asymmetric.trades.length, 2, "con umbral de bajada más pequeño, el mismo -3% sí dispara la recompra");
  assert.equal(asymmetric.trades[1].action, "buy");
});

test("no compra si todavía no ha vendido nada (sin caja acumulada)", () => {
  const history = [{ date: 1, close: 100 }, { date: 2, close: 80 }];
  const r = simulateGrid(history, { qty: 10, avg: 100, stepUpPct: 5, stepDownPct: 5, tradePct: 10 });
  assert.deepEqual(r.trades, []);
  assert.equal(r.cash, 0);
  assert.equal(r.shares, 10);
});

test("la referencia de la ventana es el primer cierre, no el precio de compra real", () => {
  // avg muy distinto del precio de la ventana: no debe generar un aluvión de
  // ventas en el primer día solo por la diferencia con avg.
  const history = [{ date: 1, close: 100 }, { date: 2, close: 100 }];
  const r = simulateGrid(history, { qty: 10, avg: 20, stepUpPct: 5, stepDownPct: 5, tradePct: 10 });
  assert.deepEqual(r.trades, []);
  assert.equal(r.startPrice, 100);
});
