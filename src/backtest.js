// Radar Cartera — Simulador de "vender un % al subir un tramo, comprar un %
// al bajar OTRO tramo (normalmente más pequeño)" — grid trading asimétrico, a
// petición del usuario para ver qué habría pasado aplicando esa regla en los
// últimos meses sobre una posición real.
//
// Umbrales separados a propósito (2026-09-27, segunda iteración): con un solo
// umbral simétrico (subir X% para vender, bajar esos mismos X% para volver a
// comprar) la estrategia casi nunca recompra en una tendencia alcista sana,
// porque el precio rara vez retrocede tanto — te quedas vendiendo posición
// según sube y sin recuperarla, perdiendo frente a solo mantener. Separando
// "cuánto tiene que subir para vender" (stepUpPct) de "cuánto tiene que bajar
// para volver a comprar" (stepDownPct, normalmente menor) el dinero vuelve a
// entrar en cualquier retroceso pequeño, no solo en una caída tan grande como
// la subida previa — pensado para mercados alcistas, no solo laterales.
//
// Autofinanciado a propósito: solo compra con el dinero que ya sacó vendiendo
// antes (nunca con dinero de fuera), así la comparación contra "solo
// mantener" parte de la misma inversión inicial y es honesta. La referencia
// (`ref`) para medir subidas/bajadas es el precio del primer día del propio
// histórico simulado (no el precio de compra real), porque la pregunta es
// "¿qué habría pasado en esta ventana?", no "desde que compré".
//
// Esto es una simulación histórica, no una recomendación de inversión ni una
// promesa de resultados futuros — el disclaimer se muestra también en la UI.
function simulateGrid(history, { qty, avg, stepUpPct, stepDownPct, tradePct }) {
  const up = Math.max(0.001, stepUpPct / 100);
  const down = Math.max(0.001, stepDownPct / 100);
  const trade = Math.min(0.95, Math.max(0.001, tradePct / 100));
  let shares = qty, cash = 0;
  let ref = history.length ? history[0].close : avg;
  const trades = [];
  for (const { date, close } of history) {
    let guard = 0;
    while (guard++ < 25) {
      if (ref > 0 && shares > 0 && close >= ref * (1 + up)) {
        const q = shares * trade;
        shares -= q; cash += q * close;
        trades.push({ date, action: "sell", price: close, qty: q });
        ref = close;
      } else if (ref > 0 && cash > 0 && close <= ref * (1 - down)) {
        const spend = cash * trade;
        const q = spend / close;
        shares += q; cash -= spend;
        trades.push({ date, action: "buy", price: close, qty: q });
        ref = close;
      } else break;
    }
  }
  const startPrice = history.length ? history[0].close : avg;
  const finalPrice = history.length ? history[history.length - 1].close : avg;
  const finalValue = shares * finalPrice + cash;
  const holdValue = qty * finalPrice;
  const cost = qty * startPrice;
  const strategyGainPct = cost ? (finalValue - cost) / cost * 100 : null;
  const holdGainPct = cost ? (holdValue - cost) / cost * 100 : null;
  return { trades, shares, cash, startPrice, finalPrice, finalValue, holdValue, strategyGainPct, holdGainPct };
}

export { simulateGrid };
