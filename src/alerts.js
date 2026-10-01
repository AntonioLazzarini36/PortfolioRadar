// Radar Cartera — Motor de reglas de alerta con histéresis (ver spec §6.7)
// Cada regla dispara una sola vez al entrar en la condición y se rearma solo
// cuando el precio sale con margen. Así no llega el mismo aviso cada 5 minutos.

import { fmt, pct } from "./state.js";
import { notify } from "./notify.js";

function rule(s, key, active, rearm) {
  const on = !!s.flags[key];
  if (active && !on) { s.flags[key] = true; return true; }
  if (!active && on && rearm) delete s.flags[key];
  return false;
}

async function evaluateAlerts(env, s, sym) {
  const it = s.items[sym], q = s.market[sym], t = s.targets[sym];
  if (!it || !q || q.price == null) return;
  const p = q.price, cur = q.currency || "";
  const near = s.settings.nearPct / 100;
  const ses = q.session === "post" ? " (after-hours)" : q.session === "pre" ? " (pre-market)" : "";
  const P = `${fmt(p)} ${cur}${ses}`;

  if (t?.mean) {
    const d = (p - t.mean) / t.mean;
    if (rule(s, `${sym}:nearMean`, Math.abs(d) <= near, Math.abs(d) > near * 1.7))
      await notify(env, s, { symbol: sym, title: `${sym} cerca del consenso`, body: `${P} · consenso medio ${fmt(t.mean)} (${d >= 0 ? "+" : ""}${fmt(d * 100, 1)} %)`, tags: "dart" });
    if (rule(s, `${sym}:aboveMean`, p >= t.mean, p < t.mean * (1 - near)))
      await notify(env, s, { symbol: sym, title: `${sym} supera el precio objetivo medio`, body: `${P} ≥ consenso ${fmt(t.mean)}. Revisa si toca recortar.`, tags: "rocket", priority: 4 });
    // Muy alejado del consenso (spec ampliada a petición del usuario): la
    // distancia (en cualquier sentido) llega al umbral `farPct` (50 % por
    // defecto). Se rearma solo si la distancia baja de forma clara (85 % del
    // umbral), para no repetir el aviso con pequeños vaivenes cerca del límite.
    const far = s.settings.farPct / 100;
    if (rule(s, `${sym}:farFromMean`, Math.abs(d) >= far, Math.abs(d) < far * 0.85))
      await notify(env, s, {
        symbol: sym, title: `${sym} muy alejado del consenso`,
        body: `${P} · consenso medio ${fmt(t.mean)} (${d >= 0 ? "+" : ""}${fmt(d * 100, 1)} %) — ${d >= 0 ? "muy por encima" : "muy por debajo"} del consenso`,
        tags: d >= 0 ? "warning" : "eyes", priority: 4,
      });
  }
  if (t?.high && rule(s, `${sym}:aboveHigh`, p >= t.high, p < t.high * 0.97))
    await notify(env, s, { symbol: sym, title: `${sym} por encima del objetivo MÁXIMO`, body: `${P} ≥ objetivo más alto de los analistas (${fmt(t.high)})`, tags: "warning", priority: 4 });
  if (t?.low && rule(s, `${sym}:belowLow`, p <= t.low, p > t.low * 1.03))
    await notify(env, s, { symbol: sym, title: `${sym} por debajo del objetivo MÍNIMO`, body: `${P} ≤ objetivo más bajo de los analistas (${fmt(t.low)})`, tags: "rotating_light", priority: 4 });

  if (it.myTarget) {
    const d = (it.myTarget - p) / it.myTarget;
    if (rule(s, `${sym}:nearMyTarget`, d > 0 && d <= near, d > near * 1.7 || d <= 0))
      await notify(env, s, { symbol: sym, title: `${sym} se acerca a tu objetivo`, body: `${P} · tu objetivo de venta ${fmt(it.myTarget)} (falta ${fmt(d * 100, 1)} %)`, tags: "eyes" });
    if (rule(s, `${sym}:hitMyTarget`, p >= it.myTarget, p < it.myTarget * 0.98))
      await notify(env, s, { symbol: sym, title: `${sym} ha llegado a tu objetivo`, body: `${P} ≥ tu objetivo de venta ${fmt(it.myTarget)}`, tags: "moneybag", priority: 5 });
  }
  if (it.myBuy && rule(s, `${sym}:hitMyBuy`, p <= it.myBuy, p > it.myBuy * 1.02))
    await notify(env, s, { symbol: sym, title: `${sym} en tu precio de compra`, body: `${P} ≤ tu precio de compra ${fmt(it.myBuy)}`, tags: "shopping_cart", priority: 5 });

  if (s.settings.entryAlerts && it.avg) {
    const below = p < it.avg;
    const key = `${sym}:belowEntry`;
    const was = s.flags[key];
    if (was === undefined) { s.flags[key] = below; }
    else if (below !== was && Math.abs(p - it.avg) / it.avg > 0.005) {
      s.flags[key] = below;
      await notify(env, s, { symbol: sym, title: `${sym} ${below ? "baja de" : "recupera"} tu precio de entrada`, body: `${P} · tu precio medio ${fmt(it.avg)} (${fmt(pct(p, it.avg), 1)} %)`, tags: below ? "small_red_triangle_down" : "white_check_mark" });
    }
  }
}

export { rule, evaluateAlerts };
