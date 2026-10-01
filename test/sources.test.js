// Tests de src/sources.js (Fase 0): modo MOCK, determinismo y respaldos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getQuote, getTargets, searchSymbols, mockQuote, mockTargets, fxRate, yahooTargets, yahoo200wma, getWma200, getPriceHistory, yahooDailyHistory } from "../src/sources.js";

const MOCK_ENV = { MOCK: "1" };

test("getQuote en modo MOCK devuelve un precio y no llama a la red", async () => {
  const q = await getQuote("NVDA", MOCK_ENV);
  assert.equal(typeof q.price, "number");
  assert.equal(q.currency, "USD");
  assert.equal(q.session, "regular");
});

test("mockQuote es determinista por ticker (misma base salvo la oscilación)", () => {
  const a = mockQuote("AAPL");
  const b = mockQuote("AAPL");
  assert.equal(a.regularPrice, b.regularPrice);
  assert.equal(a.prevClose, b.prevClose);
});

test("mockQuote da bases distintas para tickers distintos", () => {
  const a = mockQuote("AAPL");
  const b = mockQuote("MSFT");
  assert.notEqual(a.regularPrice, b.regularPrice);
});

test("getTargets en modo MOCK devuelve medio/mediana/máx/mín/analistas coherentes", async () => {
  const t = await getTargets("NVDA", MOCK_ENV);
  assert.equal(typeof t.mean, "number");
  assert.ok(t.high > t.mean);
  assert.ok(t.mean > t.low);
  assert.ok(t.analysts > 0);
  assert.equal(t.source, "Simulado");
});

test("mockTargets es determinista por ticker", () => {
  assert.deepEqual(mockTargets("TSLA"), mockTargets("TSLA"));
});

test("mockTargets incluye fundamentales coherentes (capex = flujo operativo − flujo libre)", () => {
  const t = mockTargets("TSLA");
  assert.equal(typeof t.debtToEquity, "number");
  assert.equal(typeof t.returnOnEquity, "number");
  assert.equal(t.operatingCashflow - t.freeCashflow, t.capex);
});

test("mockTargets incluye los fundamentales baratos nuevos (PEG, dividendo, liquidez, insiders, corto) y una descripción", () => {
  const t = mockTargets("TSLA");
  assert.equal(typeof t.pegRatio, "number");
  assert.equal(typeof t.dividendYield, "number");
  assert.equal(typeof t.currentRatio, "number");
  assert.equal(typeof t.heldPercentInsiders, "number");
  assert.equal(typeof t.shortPercentOfFloat, "number");
  assert.equal(typeof t.description, "string");
  assert.ok(t.description.includes("TSLA"));
});

test("mockTargets incluye sector e industria deterministas", () => {
  const a = mockTargets("NVDA"), b = mockTargets("NVDA");
  assert.equal(typeof a.sector, "string");
  assert.equal(typeof a.industry, "string");
  assert.equal(a.sector, b.sector);
  assert.equal(a.industry, b.industry);
});

test("mockTargets incluye una fecha de próximos resultados futura y determinista", () => {
  const a = mockTargets("NVDA"), b = mockTargets("NVDA");
  assert.equal(a.nextEarningsDate, b.nextEarningsDate);
  assert.ok(a.nextEarningsDate > Date.now(), "siempre una fecha futura, como las reales de Yahoo hasta el próximo refresco");
  assert.equal(typeof a.nextEarningsEpsEstimate, "number");
});

test("searchSymbols en modo MOCK devuelve el ticker introducido en mayúsculas", async () => {
  const r = await searchSymbols("nvda", MOCK_ENV);
  assert.equal(r.length, 1);
  assert.equal(r[0].symbol, "NVDA");
});

test("getWma200 en modo MOCK devuelve un número determinista", async () => {
  const a = await getWma200("NVDA", MOCK_ENV);
  const b = await getWma200("NVDA", MOCK_ENV);
  assert.equal(typeof a.wma200, "number");
  assert.equal(a.wma200, b.wma200);
});

test("yahoo200wma calcula la media de los últimos 200 cierres semanales", async () => {
  const originalFetch = globalThis.fetch;
  const closes = Array.from({ length: 260 }, (_, i) => 100 + i); // 260 semanas, 100..359
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: closes }] } }] } }),
  });
  try {
    const { wma200, weeksUsed } = await yahoo200wma("NVDA");
    assert.equal(weeksUsed, 200);
    // media de los últimos 200 valores (160..359) = (160+359)/2 = 259.5
    assert.equal(wma200, 259.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("yahoo200wma falla si no hay histórico suficiente", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [100, 101, 102] }] } }] } }),
  });
  try {
    await assert.rejects(() => yahoo200wma("NVDA"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fxRate en modo MOCK devuelve un usdPerEur numérico y determinista", async () => {
  const a = await fxRate(MOCK_ENV);
  const b = await fxRate(MOCK_ENV);
  assert.equal(typeof a.usdPerEur, "number");
  assert.equal(a.usdPerEur, b.usdPerEur);
});

test("yahooTargets saca también el P/E y el forward P/E, en la misma llamada (sin FMP_KEY)", async () => {
  const originalFetch = globalThis.fetch;
  let quoteSummaryUrl = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("fc.yahoo.com")) return { headers: { get: () => "B=abc123; path=/" } };
    if (u.includes("getcrumb")) return { text: async () => "crumb123" };
    if (u.includes("quoteSummary")) {
      quoteSummaryUrl = u;
      return {
        ok: true,
        json: async () => ({
          quoteSummary: { result: [{
            financialData: {
              targetMeanPrice: { raw: 250 }, targetMedianPrice: { raw: 245 }, targetHighPrice: { raw: 300 }, targetLowPrice: { raw: 200 }, numberOfAnalystOpinions: { raw: 40 }, recommendationKey: "strong_buy",
              debtToEquity: { raw: 45.2 }, totalDebt: { raw: 5e9 }, totalCash: { raw: 2e9 },
              returnOnEquity: { raw: 0.28 }, revenueGrowth: { raw: 0.12 },
              grossMargins: { raw: 0.45 }, operatingMargins: { raw: 0.3 }, profitMargins: { raw: 0.22 },
              operatingCashflow: { raw: 8e9 }, freeCashflow: { raw: 6e9 }, currentRatio: { raw: 1.8 },
            },
            summaryDetail: { trailingPE: { raw: 24.5 }, dividendYield: { raw: 0.006 } },
            defaultKeyStatistics: { forwardPE: { raw: 21.3 }, pegRatio: { raw: 1.7 }, heldPercentInsiders: { raw: 0.12 }, shortPercentOfFloat: { raw: 0.015 } },
            assetProfile: { longBusinessSummary: "Amazon vende cosas por internet (resumen de prueba).", sector: "Consumer Cyclical", industry: "Internet Retail" },
            calendarEvents: { earnings: { earningsDate: [{ raw: 1893456000 }, { raw: 1893542400 }], earningsAverage: { raw: 1.25 } } },
          }] },
        }),
      };
    }
    throw new Error("URL inesperada: " + u);
  };
  try {
    const t = await yahooTargets("AMZN");
    assert.equal(t.mean, 250);
    assert.equal(t.pe, 24.5);
    assert.equal(t.forwardPe, 21.3);
    assert.equal(t.debtToEquity, 45.2);
    assert.equal(t.returnOnEquity, 0.28);
    assert.equal(t.operatingCashflow, 8e9);
    assert.equal(t.freeCashflow, 6e9);
    assert.equal(t.capex, 2e9, "capex estimado = flujo operativo − flujo libre");
    assert.equal(t.pegRatio, 1.7);
    assert.equal(t.dividendYield, 0.006);
    assert.equal(t.currentRatio, 1.8);
    assert.equal(t.heldPercentInsiders, 0.12);
    assert.equal(t.shortPercentOfFloat, 0.015);
    assert.match(t.description, /Amazon vende cosas/);
    assert.equal(t.sector, "Consumer Cyclical");
    assert.equal(t.industry, "Internet Retail");
    assert.equal(t.nextEarningsDate, 1893456000 * 1000, "se queda con la primera fecha del rango, no la segunda");
    assert.equal(t.nextEarningsEpsEstimate, 1.25);
    assert.match(quoteSummaryUrl, /modules=financialData,summaryDetail,defaultKeyStatistics,assetProfile,calendarEvents/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPriceHistory en modo MOCK devuelve un histórico determinista con cierres numéricos", async () => {
  const a = await getPriceHistory("NVDA", MOCK_ENV, 4);
  const b = await getPriceHistory("NVDA", MOCK_ENV, 4);
  assert.ok(a.length > 60, "4 meses deberían dar bastantes más de 60 días de histórico simulado");
  // Determinista en los cierres (los `date` pueden variar unos ms entre llamadas
  // porque se calculan a partir de Date.now() en cada una).
  assert.deepEqual(a.map((p) => p.close), b.map((p) => p.close));
  assert.equal(typeof a[0].close, "number");
  assert.equal(typeof a[0].date, "number");
});

test("yahooDailyHistory descarta cierres nulos y recorta por fecha de corte", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const days = 40;
  const timestamp = Array.from({ length: days }, (_, i) => Math.round((now - (days - i) * 86400e3) / 1000));
  const closes = Array.from({ length: days }, (_, i) => (i === 5 ? null : 100 + i));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ chart: { result: [{ timestamp, indicators: { quote: [{ close: closes }] } }] } }),
  });
  try {
    const hist = await yahooDailyHistory("NVDA", 1); // pide ~30 días de corte
    assert.ok(hist.every((p) => p.close != null));
    assert.ok(hist.length < days, "debe recortar por la fecha de corte de 1 mes");
    assert.ok(hist.every((p) => p.date >= now - 30 * 86400e3 - 1000));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getQuote sin MOCK y con las fuentes reales rotas usa Finnhub como respaldo de Yahoo", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("finance.yahoo.com")) throw new Error("red caída");
    if (String(url).includes("finnhub.io")) {
      return { ok: true, json: async () => ({ c: 123.45, pc: 120, t: 1758000000 }) };
    }
    throw new Error("URL inesperada: " + url);
  };
  try {
    const q = await getQuote("NVDA", { FINNHUB_KEY: "fake" });
    assert.equal(q.price, 123.45);
    assert.equal(q.session, "regular");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
