// Radar Cartera — Motor de reglas de alerta con histéresis (ver spec §6.7)
// Cada regla dispara una sola vez al entrar en la condición y se rearma solo
// cuando el precio sale con margen. Así no llega el mismo aviso cada 5 minutos.
//
// Excepción: las reglas ligadas a decisiones de cartera que el propio usuario
// fijó (precio de compra/venta objetivo, precio medio de la posición) además
// se repiten como recordatorio cada REMINDER_MS mientras la condición se
// mantenga activa — petición explícita del usuario (2026-10-05): si Uber
// lleva días por debajo de su precio de compra quiere que se lo sigan
// recordando, no solo el primer día ("a veces me olvido"). `rule()` acepta un
// `remindMs` opcional para esto; sin él se comporta exactamente igual que
// antes (dispara una vez, calla hasta rearmar).

import { fmt, pct } from "./state.js";
import { notify } from "./notify.js";

const REMINDER_MS = 24 * 3600 * 1000; // recordatorio mínimo para alertas de cartera
const DROP_STEP_PCT = 5; // tramo de caída para los avisos escalonados bajo el precio de referencia

function rule(s, key, active, rearm, now = Date.now(), remindMs) {
  const on = !!s.flags[key];
  if (active && !on) {
    s.flags[key] = true;
    if (remindMs) s.flags[`${key}:ts`] = now;
    return true;
  }
  if (active && on && remindMs) {
    const last = s.flags[`${key}:ts`] || 0;
    if (now - last >= remindMs) { s.flags[`${key}:ts`] = now; return true; }
    return false;
  }
  if (!active && on && rearm) { delete s.flags[key]; delete s.flags[`${key}:ts`]; }
  return false;
}

// Avisos escalonados de caída bajo un precio de referencia (precio de compra
// objetivo o precio medio de la posición): además del aviso de "lo ha
// tocado", recuerda cada tramo adicional de DROP_STEP_PCT% que caiga por
// debajo (−5 %, −10 %, −15 %…), disparando al momento si profundiza de tramo
// y repitiendo el mismo tramo una vez al día si se mantiene — así una caída
// sostenida no se olvida ni se machaca con un aviso nuevo cada 5 minutos.
function dropSteps(s, key, dropPct, now) {
  if (dropPct < DROP_STEP_PCT) { delete s.flags[key]; return null; }
  const level = Math.floor(dropPct / DROP_STEP_PCT) * DROP_STEP_PCT;
  const stored = s.flags[key];
  if (!stored || level > stored.level || now - stored.ts >= REMINDER_MS) {
    s.flags[key] = { level, ts: now };
    return level;
  }
  return null;
}

async function evaluateAlerts(env, s, sym) {
  const it = s.items[sym], q = s.market[sym], t = s.targets[sym];
  if (!it || !q || q.price == null) return;
  const p = q.price, cur = q.currency || "";
  const near = s.settings.nearPct / 100;
  const now = Date.now();
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
    if (rule(s, `${sym}:nearMyTarget`, d > 0 && d <= near, d > near * 1.7 || d <= 0, now, REMINDER_MS))
      await notify(env, s, { symbol: sym, title: `${sym} se acerca a tu objetivo`, body: `${P} · tu objetivo de venta ${fmt(it.myTarget)} (falta ${fmt(d * 100, 1)} %)`, tags: "eyes" });
    if (rule(s, `${sym}:hitMyTarget`, p >= it.myTarget, p < it.myTarget * 0.98, now, REMINDER_MS))
      await notify(env, s, { symbol: sym, title: `${sym} ha llegado a tu objetivo`, body: `${P} ≥ tu objetivo de venta ${fmt(it.myTarget)}`, tags: "moneybag", priority: 5 });
  }

  if (it.myBuy) {
    const d = (p - it.myBuy) / it.myBuy; // positivo = todavía por encima, acercándose; negativo = ya por debajo
    if (rule(s, `${sym}:nearMyBuy`, d > 0 && d <= near, d > near * 1.7 || d <= 0, now, REMINDER_MS))
      await notify(env, s, { symbol: sym, title: `${sym} se acerca a tu precio de compra`, body: `${P} · tu precio de compra ${fmt(it.myBuy)} (falta ${fmt(d * 100, 1)} %)`, tags: "eyes" });
    if (rule(s, `${sym}:hitMyBuy`, p <= it.myBuy, p > it.myBuy * 1.02, now, REMINDER_MS))
      await notify(env, s, { symbol: sym, title: `${sym} en tu precio de compra`, body: `${P} ≤ tu precio de compra ${fmt(it.myBuy)} (${fmt(-d * 100, 1)} %)`, tags: "shopping_cart", priority: 5 });

    const buyDropLevel = dropSteps(s, `${sym}:myBuyDropStep`, -d * 100, now);
    if (buyDropLevel)
      await notify(env, s, { symbol: sym, title: `${sym} ha caído más de un ${buyDropLevel} % bajo tu precio de compra`, body: `${P} · tu precio de compra ${fmt(it.myBuy)} (${fmt(d * 100, 1)} %)`, tags: "chart_with_downwards_trend", priority: 4 });
  }

  if (s.settings.entryAlerts && it.avg) {
    const below = p < it.avg;
    const key = `${sym}:belowEntry`;
    const was = s.flags[key];
    if (was === undefined) {
      s.flags[key] = below;
      s.flags[`${key}:ts`] = now;
    } else if (below !== was && Math.abs(p - it.avg) / it.avg > 0.005) {
      s.flags[key] = below;
      s.flags[`${key}:ts`] = now;
      await notify(env, s, { symbol: sym, title: `${sym} ${below ? "baja de" : "recupera"} tu precio de entrada`, body: `${P} · tu precio medio ${fmt(it.avg)} (${fmt(pct(p, it.avg), 1)} %)`, tags: below ? "small_red_triangle_down" : "white_check_mark" });
    } else if (below && was && now - (s.flags[`${key}:ts`] || 0) >= REMINDER_MS) {
      s.flags[`${key}:ts`] = now;
      await notify(env, s, { symbol: sym, title: `${sym} sigue bajo tu precio de entrada`, body: `${P} · tu precio medio ${fmt(it.avg)} (${fmt(pct(p, it.avg), 1)} %)`, tags: "small_red_triangle_down" });
    }

    const avgDropLevel = dropSteps(s, `${sym}:avgDropStep`, ((it.avg - p) / it.avg) * 100, now);
    if (avgDropLevel)
      await notify(env, s, { symbol: sym, title: `${sym} ha caído más de un ${avgDropLevel} % bajo tu precio medio`, body: `${P} · tu precio medio ${fmt(it.avg)} (${fmt(pct(p, it.avg), 1)} %)`, tags: "chart_with_downwards_trend", priority: 4 });
  }
}

export { rule, evaluateAlerts };
