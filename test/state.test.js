// Tests de src/state.js (Fase 1): forma de los items e importación.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanItem, parseImportLine } from "../src/state.js";

test("cleanItem normaliza símbolo, tipo y números", () => {
  const it = cleanItem({ symbol: "nvda", kind: "holding", qty: "16", avg: "204.55", myTarget: "240" });
  assert.equal(it.symbol, "NVDA");
  assert.equal(it.kind, "holding");
  assert.equal(it.qty, 16);
  assert.equal(it.avg, 204.55);
  assert.equal(it.myTarget, 240);
  assert.equal(it.myBuy, null);
});

test("cleanItem conserva los campos previos si no vienen en el body", () => {
  const prev = cleanItem({ symbol: "MSFT", kind: "watch", note: "vigilar" });
  const updated = cleanItem({ symbol: "MSFT", kind: "holding", qty: 2 }, prev);
  assert.equal(updated.note, "vigilar");
  assert.equal(updated.kind, "holding");
  assert.equal(updated.qty, 2);
});

test("cleanItem: sin moneda explícita, conserva la ya detectada del mercado", () => {
  const prev = cleanItem({ symbol: "AMZN" });
  prev.currency = "USD"; // simula lo que pone /api/items al recibir la cotización
  const updated = cleanItem({ symbol: "AMZN", qty: 2 }, prev);
  assert.equal(updated.currency, "USD");
});

test("cleanItem: una moneda explícita en el body manda sobre la ya guardada", () => {
  const prev = cleanItem({ symbol: "AMZN" });
  prev.currency = "USD";
  const updated = cleanItem({ symbol: "AMZN", currency: "EUR" }, prev);
  assert.equal(updated.currency, "EUR");
});

test("cleanItem: costEur (euros reales gastados) se normaliza y se conserva si no viene en el body", () => {
  const prev = cleanItem({ symbol: "INTU", qty: "2", avg: "600", costEur: "1050.30" });
  assert.equal(prev.costEur, 1050.30);
  const updated = cleanItem({ symbol: "INTU", qty: 2 }, prev);
  assert.equal(updated.costEur, 1050.30);
});

test("parseImportLine acepta coma, punto y coma y tabulador como separador", () => {
  assert.deepEqual(parseImportLine("NVDA, 16, 204.55, 240"), { sym: "NVDA", qty: "16", avg: "204.55", tgt: "240", buy: undefined });
  assert.deepEqual(parseImportLine("MSFT;1.5;386.59"), { sym: "MSFT", qty: "1.5", avg: "386.59", tgt: undefined, buy: undefined });
  assert.deepEqual(parseImportLine("ADBE"), { sym: "ADBE", qty: undefined, avg: undefined, tgt: undefined, buy: undefined });
});

test("parseImportLine acepta la coma como separador decimal (con punto y coma como separador de campos)", () => {
  const r = parseImportLine("NVDA;16;204,55;240");
  assert.equal(r.avg, "204.55");
});
