// Tests de public/sort.js (Fase 2, ver spec §6.5 y §13):
// los valores sin dato van siempre al final, sea cual sea la dirección.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareItems } from "../public/sort.js";

function order(list, sortKey, sortDesc) {
  return [...list].sort((a, b) => compareItems(a, b, sortKey, sortDesc)).map((m) => m.sym);
}

test("valores nulos al final ordenando descendente", () => {
  const list = [{ sym: "A", upMean: 5 }, { sym: "B", upMean: null }, { sym: "C", upMean: 10 }];
  assert.deepEqual(order(list, "upMean", true), ["C", "A", "B"]);
});

test("valores nulos al final ordenando ascendente también", () => {
  const list = [{ sym: "A", upMean: 5 }, { sym: "B", upMean: null }, { sym: "C", upMean: 10 }];
  assert.deepEqual(order(list, "upMean", false), ["A", "C", "B"]);
});

test("varios valores nulos se desempatan alfabéticamente entre ellos", () => {
  const list = [{ sym: "Z", upMean: null }, { sym: "A", upMean: 1 }, { sym: "M", upMean: null }];
  assert.deepEqual(order(list, "upMean", true), ["A", "M", "Z"]);
});

test("orden alfabético (alpha) usa el símbolo directamente", () => {
  const list = [{ sym: "MSFT" }, { sym: "AAPL" }, { sym: "NVDA" }];
  assert.deepEqual(order(list, "alpha", false), ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(order(list, "alpha", true), ["NVDA", "MSFT", "AAPL"]);
});

test("\"value\" se ordena por valueEur (en EUR), no por el número en su moneda original", () => {
  // 900 EUR vale más que 1000 USD (con este cambio), aunque 1000 > 900 en crudo.
  const list = [
    { sym: "USD_POS", value: 1000, valueEur: 877 },
    { sym: "EUR_POS", value: 900, valueEur: 900 },
  ];
  assert.deepEqual(order(list, "value", true), ["EUR_POS", "USD_POS"]);
});

test("\"value\" recurre al valor en moneda original si no hay valueEur (p. ej. GBP sin tipo de cambio)", () => {
  const list = [{ sym: "A", value: 500, valueEur: null }, { sym: "B", value: 200, valueEur: null }];
  assert.deepEqual(order(list, "value", true), ["A", "B"]);
});

test("\"plAbs\" (ganancia en dinero) se ordena por plAbsEur, no por el número en la moneda original", () => {
  const list = [
    { sym: "USD_POS", plAbs: 1000, plAbsEur: 877 },
    { sym: "EUR_POS", plAbs: 900, plAbsEur: 900 },
  ];
  assert.deepEqual(order(list, "plAbs", true), ["EUR_POS", "USD_POS"]);
});

test("\"plAbs\" recurre a plAbs en moneda original si no hay plAbsEur", () => {
  const list = [{ sym: "A", plAbs: 500, plAbsEur: null }, { sym: "B", plAbs: 200, plAbsEur: null }];
  assert.deepEqual(order(list, "plAbs", true), ["A", "B"]);
});

test("\"earnings\" se ordena por earningsDays (la clave de orden no coincide con el nombre del campo)", () => {
  const list = [{ sym: "FAR", earningsDays: 40 }, { sym: "SOON", earningsDays: 2 }, { sym: "MID", earningsDays: 15 }];
  assert.deepEqual(order(list, "earnings", false), ["SOON", "MID", "FAR"]);
});
