// Radar Cartera — Cloudflare Worker
// - API para la app del móvil (/api/*), protegida con APP_TOKEN
// - Cron cada 5 min: actualiza precios, refresca consenso 1 vez al día y manda alertas por ntfy
//
// Secretos (wrangler secret put ...):
//   APP_TOKEN    contraseña larga que usará la app
//   NTFY_TOPIC   nombre secreto del canal de ntfy (ej. radar-antonio-8f3k2...)
//   FMP_KEY      clave gratuita de financialmodelingprep.com (consenso de analistas)
//   FINNHUB_KEY  (opcional) clave gratuita de finnhub.io (nº de analistas / respaldo de precio)
// Variables opcionales: MOCK = "1" para datos simulados (pruebas)

import { handleApi, runCycle } from "./api.js";
import { json } from "./state.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(req, env, url); }
      catch (e) { return json({ error: e.message || String(e) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env));
  },
};
