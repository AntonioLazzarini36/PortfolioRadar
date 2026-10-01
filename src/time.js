// Radar Cartera — Horarios de mercado (ver spec §6.3)
// Se comprueban EE. UU. (América/Nueva York) y Europa (Europa/Madrid) en hora local,
// para saber si merece la pena pedir precios en el ciclo del cron.

function partsIn(tz, date = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { wd: g("weekday"), h: +g("hour") % 24, m: +g("minute") };
}

function marketsMaybeOpen(date = new Date()) {
  const ny = partsIn("America/New_York", date);
  const eu = partsIn("Europe/Madrid", date);
  const weekday = (w) => !["Sat", "Sun"].includes(w);
  const nyMin = ny.h * 60 + ny.m, euMin = eu.h * 60 + eu.m;
  const usOpen = weekday(ny.wd) && nyMin >= 4 * 60 && nyMin <= 20 * 60 + 5;     // pre, normal y after-hours
  const euOpen = weekday(eu.wd) && euMin >= 8 * 60 && euMin <= 17 * 60 + 40;    // bolsas europeas
  return usOpen || euOpen;
}

function isQuietHour(settings, date = new Date()) {
  if (!settings.quietNight) return false;
  const h = partsIn("Europe/Madrid", date).h;
  return h < 7;
}

export { partsIn, marketsMaybeOpen, isQuietHour };
