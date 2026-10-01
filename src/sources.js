// Radar Cartera — Fuentes de datos (ver spec §4)
// Precio en vivo, búsqueda de tickers y consenso de analistas, cada una con
// su respaldo. Con env.MOCK === "1" se devuelven datos simulados y deterministas
// (útil para pruebas y para desarrollar sin gastar cuota de las APIs gratuitas).

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36";

// ───────────────────────── §4.1 Precio en vivo ─────────────────────────
// Principal — Yahoo chart (sin clave). Incluye pre-market y after-hours:
// el precio actual es el último `close` no nulo de la serie de 5 minutos.
async function yahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`;
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error(d?.chart?.error?.description || "Yahoo sin datos");
  const m = res.meta;
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  let last = null, lastT = null;
  for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { last = closes[i]; lastT = ts[i]; break; }
  const price = last ?? m.regularMarketPrice;
  const t = lastT ?? m.regularMarketTime;
  const tp = m.currentTradingPeriod || {};
  let session = "closed";
  if (tp.regular && t >= tp.regular.start && t < tp.regular.end) session = "regular";
  else if (tp.pre && t >= tp.pre.start && t < tp.pre.end) session = "pre";
  else if (tp.post && t >= tp.post.start && t < tp.post.end) session = "post";
  return {
    price,
    regularPrice: m.regularMarketPrice,
    prevClose: m.chartPreviousClose ?? m.previousClose,
    currency: m.currency,
    name: m.longName || m.shortName || null,
    exchange: m.fullExchangeName || m.exchangeName,
    session,
    time: t ? t * 1000 : Date.now(),
  };
}

// Respaldo — Finnhub (clave gratuita). Solo sesión regular.
async function finnhubQuote(symbol, env) {
  if (!env.FINNHUB_KEY) throw new Error("sin FINNHUB_KEY");
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_KEY}`);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const d = await r.json();
  if (!d || !d.c) throw new Error("Finnhub sin datos");
  return { price: d.c, regularPrice: d.c, prevClose: d.pc, session: "regular", time: (d.t || Date.now() / 1000) * 1000 };
}

async function getQuote(symbol, env) {
  if (env.MOCK === "1") return mockQuote(symbol);
  try { return await yahooQuote(symbol); }
  catch (e) {
    try { return await finnhubQuote(symbol, env); }
    catch { throw e; }
  }
}

// ───────────────────────── §4.2 Búsqueda de tickers ─────────────────────────
// Principal — Yahoo search (sin clave). Respaldo — Finnhub search.
async function searchSymbols(q, env) {
  if (env.MOCK === "1") return [{ symbol: q.toUpperCase(), name: `${q.toUpperCase()} Inc (simulado)`, exchange: "NASDAQ", type: "EQUITY" }];
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { headers: { "user-agent": UA } });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const d = await r.json();
    return (d.quotes || []).filter((x) => x.symbol && ["EQUITY", "ETF"].includes(x.quoteType))
      .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange, type: x.quoteType }));
  } catch (e) {
    if (!env.FINNHUB_KEY) throw e;
    const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${env.FINNHUB_KEY}`);
    const d = await r.json();
    return (d.result || []).slice(0, 8).map((x) => ({ symbol: x.symbol, name: x.description, exchange: "", type: x.type }));
  }
}

// ───────────────────────── §4.3 Consenso de analistas ─────────────────────────
// Principal — Financial Modeling Prep (clave gratuita): medio, mediana, máx., mín.
async function fmpTargets(symbol, env) {
  if (!env.FMP_KEY) throw new Error("sin FMP_KEY");
  const r = await fetch(`https://financialmodelingprep.com/stable/price-target-consensus?symbol=${encodeURIComponent(symbol)}&apikey=${env.FMP_KEY}`);
  if (!r.ok) throw new Error(`FMP ${r.status}`);
  const d = await r.json();
  const x = Array.isArray(d) ? d[0] : d;
  if (!x || x.targetConsensus == null) throw new Error(x?.["Error Message"] || "FMP sin consenso");
  return { mean: x.targetConsensus, median: x.targetMedian ?? null, high: x.targetHigh ?? null, low: x.targetLow ?? null, source: "FMP" };
}

// Número de analistas y recomendación: FMP grades-consensus, si no Finnhub recommendation.
async function analystCount(symbol, env) {
  if (env.FMP_KEY) {
    try {
      const r = await fetch(`https://financialmodelingprep.com/stable/grades-consensus?symbol=${encodeURIComponent(symbol)}&apikey=${env.FMP_KEY}`);
      if (r.ok) {
        const d = await r.json(); const x = Array.isArray(d) ? d[0] : d;
        if (x && x.consensus) {
          const n = (x.strongBuy || 0) + (x.buy || 0) + (x.hold || 0) + (x.sell || 0) + (x.strongSell || 0);
          return { analysts: n || null, rating: x.consensus };
        }
      }
    } catch {}
  }
  if (env.FINNHUB_KEY) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_KEY}`);
      if (r.ok) {
        const d = await r.json(); const x = d?.[0];
        if (x) {
          const n = x.strongBuy + x.buy + x.hold + x.sell + x.strongSell;
          const score = (x.strongBuy * 1 + x.buy * 2 + x.hold * 3 + x.sell * 4 + x.strongSell * 5) / (n || 1);
          const rating = score <= 1.5 ? "Strong Buy" : score <= 2.5 ? "Buy" : score <= 3.5 ? "Hold" : score <= 4.5 ? "Sell" : "Strong Sell";
          return { analysts: n || null, rating };
        }
      }
    } catch {}
  }
  return { analysts: null, rating: null };
}

// Respaldo 2 — Yahoo quoteSummary (financialData + summaryDetail + defaultKeyStatistics).
// Requiere cookie + crumb. Se piden los tres módulos en la misma llamada (sin
// coste extra de peticiones) para sacar también el P/E y el forward P/E gratis
// — importante porque, sin FMP_KEY, ESTA es la fuente que se usa para todos
// los símbolos (ver spec §4: verificar condiciones de los planes gratuitos).
async function yahooTargets(symbol) {
  const c = await fetch("https://fc.yahoo.com", { headers: { "user-agent": UA }, redirect: "manual" });
  const cookie = (c.headers.get("set-cookie") || "").split(";")[0];
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "user-agent": UA, cookie } });
  const crumb = await cr.text();
  if (!crumb || crumb.length > 30) throw new Error("Yahoo sin crumb");
  const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,summaryDetail,defaultKeyStatistics,assetProfile,calendarEvents&crumb=${encodeURIComponent(crumb)}`, { headers: { "user-agent": UA, cookie } });
  if (!r.ok) throw new Error(`Yahoo summary ${r.status}`);
  const res = (await r.json())?.quoteSummary?.result?.[0];
  const f = res?.financialData;
  const ks = res?.defaultKeyStatistics;
  const v = (o) => o?.raw ?? null;
  if (!f || v(f.targetMeanPrice) == null) throw new Error("Yahoo sin consenso");
  // Fundamentales: vienen gratis en el mismo módulo "financialData" que el
  // consenso, así que se sacan de aquí sin coste extra de peticiones. El capex
  // no viene como tal — se estima como flujo de caja operativo menos flujo de
  // caja libre (FCF = OCF − Capex), que es razonablemente fiable para empresas
  // con contabilidad "normal" pero es una aproximación, no el dato exacto.
  const ocf = v(f.operatingCashflow), fcf = v(f.freeCashflow);
  return {
    mean: v(f.targetMeanPrice), median: v(f.targetMedianPrice), high: v(f.targetHighPrice), low: v(f.targetLowPrice),
    analysts: v(f.numberOfAnalystOpinions), rating: f.recommendationKey ? f.recommendationKey.replace("_", " ") : null, source: "Yahoo",
    pe: v(res?.summaryDetail?.trailingPE), forwardPe: v(ks?.forwardPE),
    debtToEquity: v(f.debtToEquity), totalDebt: v(f.totalDebt), totalCash: v(f.totalCash),
    returnOnEquity: v(f.returnOnEquity), revenueGrowth: v(f.revenueGrowth),
    grossMargins: v(f.grossMargins), operatingMargins: v(f.operatingMargins), profitMargins: v(f.profitMargins),
    freeCashflow: fcf, operatingCashflow: ocf,
    capex: (ocf != null && fcf != null) ? ocf - fcf : null,
    // Añadidos baratos (2026-09-27): mismos módulos ya pedidos, cero peticiones
    // extra. pegRatio y las dos participaciones (insiders/corto) vienen de
    // defaultKeyStatistics; dividendYield de summaryDetail; currentRatio del
    // mismo financialData que el resto; la descripción de la empresa es el
    // único campo de otro módulo (assetProfile), añadido a la misma llamada.
    pegRatio: v(ks?.pegRatio), dividendYield: v(res?.summaryDetail?.dividendYield),
    currentRatio: v(f.currentRatio), heldPercentInsiders: v(ks?.heldPercentInsiders),
    shortPercentOfFloat: v(ks?.shortPercentOfFloat),
    description: res?.assetProfile?.longBusinessSummary || null,
    // Sector/industria (2026-09-29): mismo módulo assetProfile ya pedido para
    // la descripción, cero peticiones extra. "industry" es la categoría
    // concreta ("Semiconductors", "Biotechnology"...), "sector" la agrupación
    // amplia ("Technology", "Healthcare"...) — se usan tal cual las da Yahoo,
    // sin traducir (igual que el rating "Buy"/"Strong Buy").
    sector: res?.assetProfile?.sector || null, industry: res?.assetProfile?.industry || null,
    // Próximos resultados (2026-10-01): módulo "calendarEvents", añadido a la
    // misma llamada de quoteSummary de siempre — cero peticiones extra, mismo
    // patrón que sector/industry. Yahoo suele dar un rango de dos fechas
    // posibles (earnings aún sin fecha confirmada) — se coge la primera
    // (earningsDate[0]), que es la que usa la propia Yahoo Finance como "fecha
    // prevista". earningsAverage es el EPS medio estimado por los analistas
    // para ese informe — dato secundario, mejor-posible (puede venir null).
    nextEarningsDate: v(res?.calendarEvents?.earnings?.earningsDate?.[0]) ? v(res.calendarEvents.earnings.earningsDate[0]) * 1000 : null,
    nextEarningsEpsEstimate: v(res?.calendarEvents?.earnings?.earningsAverage),
  };
}

// P/E (trailing) vía FMP: respaldo alternativo cuando SÍ hay FMP_KEY (en ese
// caso el consenso viene de fmpTargets, que no trae P/E, así que se pide aparte).
async function fmpPe(symbol, env) {
  if (!env.FMP_KEY) throw new Error("sin FMP_KEY");
  const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${env.FMP_KEY}`);
  if (!r.ok) throw new Error(`FMP ${r.status}`);
  const d = await r.json();
  const x = Array.isArray(d) ? d[0] : d;
  if (!x || x.pe == null) throw new Error(x?.["Error Message"] || "FMP sin P/E");
  return { pe: x.pe };
}

async function getTargets(symbol, env) {
  if (env.MOCK === "1") return mockTargets(symbol);
  let t = null, err = null;
  try {
    t = await fmpTargets(symbol, env);
    Object.assign(t, await analystCount(symbol, env));
  } catch (e) { err = e; }
  if (!t) {
    try { t = await yahooTargets(symbol); }
    catch (e2) { throw new Error(`${err?.message || ""} / ${e2.message}`); }
  }
  // Campos que solo trae yahooTargets (fmpTargets no los da): se dejan en null
  // si vinimos por FMP, para que la forma del objeto sea siempre la misma.
  for (const k of ["pe", "forwardPe", "debtToEquity", "totalDebt", "totalCash", "returnOnEquity", "revenueGrowth", "grossMargins", "operatingMargins", "profitMargins", "freeCashflow", "operatingCashflow", "capex", "pegRatio", "dividendYield", "currentRatio", "heldPercentInsiders", "shortPercentOfFloat", "description", "sector", "industry", "nextEarningsDate", "nextEarningsEpsEstimate"]) {
    if (t[k] === undefined) t[k] = null;
  }
  try { Object.assign(t, await fmpPe(symbol, env)); } catch {}
  return t;
}

// ───────────────────────── 200WMA (media móvil de 200 semanas) ─────────────────────────
// Señal clásica de "zona de compra" en empresas de calidad: si el precio cae
// por debajo de su media de las últimas 200 semanas (~4 años), históricamente
// ha sido una zona atractiva. No viene en financialData -> llamada aparte
// (misma fuente gratuita que yahooQuote, solo que en velas semanales). Cambia
// muy poco semana a semana, así que se refresca con mucha menos frecuencia
// que el precio o el consenso (ver WMA_MAX_AGE_H en api.js).
async function yahoo200wma(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=5y`;
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  if (closes.length < 50) throw new Error("Yahoo sin histórico suficiente para el 200WMA");
  const last200 = closes.slice(-200);
  const wma200 = last200.reduce((a, b) => a + b, 0) / last200.length;
  return { wma200, weeksUsed: last200.length };
}
function mockWma200(sym) { return { wma200: +(mockBase(sym) * 0.82).toFixed(2), weeksUsed: 200 }; }
async function getWma200(symbol, env) {
  if (env.MOCK === "1") return mockWma200(symbol);
  return await yahoo200wma(symbol);
}

// ───────────────────────── Histórico diario (para el simulador de tramos) ─────────────────────────
// Mismo endpoint gratuito que yahooQuote/yahoo200wma, en velas diarias. Yahoo
// solo acepta rangos "redondos" (1mo/3mo/6mo/1y/2y), así que se pide el más
// pequeño que cubra los meses pedidos y luego se recorta por fecha.
async function yahooDailyHistory(symbol, months = 4) {
  const days = Math.max(20, Math.round(months * 30));
  const rangeParam = months <= 1 ? "1mo" : months <= 3 ? "3mo" : months <= 6 ? "6mo" : months <= 12 ? "1y" : "2y";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${rangeParam}`;
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const closes = res?.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < closes.length; i++) if (closes[i] != null) out.push({ date: ts[i] * 1000, close: closes[i] });
  if (out.length < 10) throw new Error("Yahoo sin histórico suficiente");
  const cutoff = Date.now() - days * 86400e3;
  return out.filter((p) => p.date >= cutoff);
}
// Simulado: una onda con periodo de ~18 días naturales para que el simulador
// de tramos tenga varios cruces reales que enseñar en modo desarrollo/test.
function mockDailyHistory(sym, months = 4) {
  const base = mockBase(sym), h = hash(sym), days = Math.max(20, Math.round(months * 30));
  const now = Date.now(), out = [];
  for (let i = days; i >= 0; i--) {
    const wave = Math.sin((days - i) / 9 + (h % 7)) * base * 0.15;
    out.push({ date: now - i * 86400e3, close: +(base + wave).toFixed(2) });
  }
  return out;
}
async function getPriceHistory(symbol, env, months = 4) {
  if (env.MOCK === "1") return mockDailyHistory(symbol, months);
  return await yahooDailyHistory(symbol, months);
}

// ───────────────────────── Conversión a EUR ─────────────────────────
// El usuario invierte en USD (y a veces EUR) pero piensa en euros (Trading 212).
// usdPerEur = cuántos USD vale 1 EUR (así EUR = USD / usdPerEur). Yahoo "EURUSD=X"
// da justo eso en regularMarketPrice. Se refresca ~1 vez al día, como el consenso.
async function fxRate(env) {
  if (env.MOCK === "1") return mockFx();
  const q = await yahooQuote("EURUSD=X");
  if (!q.price) throw new Error("Yahoo sin tipo de cambio EUR/USD");
  return { usdPerEur: q.price };
}
function mockFx() { return { usdPerEur: 1.08 }; }

// ───────────────────────── Datos simulados (MOCK=1) ─────────────────────────
// Deterministas por ticker (mismo símbolo → misma base), con una pequeña
// oscilación en el tiempo para que las alertas tengan algo que evaluar.
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function mockBase(sym) { return 20 + (hash(sym) % 500); }
// Sectores/industrias reales de la clasificación de Yahoo (no traducidos, para
// que el modo simulado se comporte igual que los datos reales) — solo para
// tener variedad determinista en pruebas/desarrollo, no una lista exhaustiva.
const MOCK_SECTORS = ["Technology", "Healthcare", "Financial Services", "Consumer Cyclical", "Industrials", "Energy", "Communication Services", "Consumer Defensive"];
const MOCK_INDUSTRIES = ["Semiconductors", "Software—Infrastructure", "Biotechnology", "Internet Content & Information", "Auto Manufacturers", "Banks—Diversified", "Drug Manufacturers—General", "Internet Retail", "Oil & Gas Integrated", "Telecom Services"];
function mockQuote(sym) {
  const base = mockBase(sym), wobble = Math.sin(Date.now() / 6e5 + hash(sym)) * base * 0.04;
  return { price: +(base + wobble).toFixed(2), regularPrice: base, prevClose: +(base * 0.99).toFixed(2), currency: "USD", name: `${sym} (simulado)`, session: "regular", time: Date.now() };
}
function mockTargets(sym) {
  const b = mockBase(sym), h = hash(sym);
  const pe = +(10 + (h % 30)).toFixed(1);
  const ocf = b * 8e6, capex = b * 2e6; // cifras simuladas, no reales
  return {
    mean: +(b * 1.15).toFixed(2), median: +(b * 1.13).toFixed(2), high: +(b * 1.5).toFixed(2), low: +(b * 0.8).toFixed(2),
    analysts: 10 + (h % 50), rating: "Buy", source: "Simulado", pe, forwardPe: +(pe * 0.9).toFixed(1),
    debtToEquity: +(20 + (h % 150)).toFixed(1), totalDebt: b * 5e7, totalCash: b * 3e7,
    returnOnEquity: +(0.05 + (h % 30) / 100).toFixed(3), revenueGrowth: +(-0.05 + (h % 40) / 100).toFixed(3),
    grossMargins: +(0.2 + (h % 60) / 100).toFixed(3), operatingMargins: +(0.05 + (h % 35) / 100).toFixed(3), profitMargins: +(0.02 + (h % 30) / 100).toFixed(3),
    freeCashflow: ocf - capex, operatingCashflow: ocf, capex,
    pegRatio: +(0.6 + (h % 250) / 100).toFixed(2), dividendYield: +((h % 30) / 1000).toFixed(4),
    currentRatio: +(0.7 + (h % 250) / 100).toFixed(2), heldPercentInsiders: +((h % 250) / 1000).toFixed(3),
    shortPercentOfFloat: +((h % 150) / 1000).toFixed(3),
    description: `${sym} es una empresa simulada para pruebas — este texto sustituye a la descripción real que vendría de Yahoo (assetProfile.longBusinessSummary).`,
    sector: MOCK_SECTORS[h % MOCK_SECTORS.length], industry: MOCK_INDUSTRIES[h % MOCK_INDUSTRIES.length],
    // Determinista: entre 1 y 90 días desde "ahora", como las fechas reales de
    // Yahoo (siempre una fecha futura, nunca pasada, hasta el próximo refresco).
    nextEarningsDate: Date.now() + (1 + (h % 90)) * 86400e3,
    nextEarningsEpsEstimate: +(0.3 + (h % 400) / 100).toFixed(2),
  };
}

export {
  UA,
  yahooQuote, finnhubQuote, getQuote,
  searchSymbols,
  fmpTargets, analystCount, yahooTargets, getTargets, fmpPe,
  fxRate,
  yahoo200wma, getWma200,
  yahooDailyHistory, getPriceHistory,
  mockQuote, mockTargets,
};
