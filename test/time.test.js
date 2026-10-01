// Tests de src/time.js (horario de mercado, ver spec §6.3 y §13).
// Nota: Madrid va 5-6 h por delante de Nueva York, así que en cualquier día
// laborable normal, cuando en Nueva York son las 03:59-04:00 la bolsa europea
// ya lleva un buen rato abierta (~09:59-10:00) — por eso esos límites se
// comprueban sobre partsIn() (la conversión de huso horario) en vez de sobre
// marketsMaybeOpen(), que da "abierto" en ambos casos por el solapamiento.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partsIn, marketsMaybeOpen, isQuietHour } from "../src/time.js";

test("partsIn: límite de apertura de Nueva York, 03:59 vs 04:00 (invierno, EST)", () => {
  const before = partsIn("America/New_York", new Date("2026-01-14T08:59:00Z"));
  const at = partsIn("America/New_York", new Date("2026-01-14T09:00:00Z"));
  assert.deepEqual(before, { wd: "Wed", h: 3, m: 59 });
  assert.deepEqual(at, { wd: "Wed", h: 4, m: 0 });
});

test("partsIn: mismo límite de Nueva York en verano (EDT) cae en la misma hora local gracias al horario de verano", () => {
  const before = partsIn("America/New_York", new Date("2026-07-15T07:59:00Z"));
  const at = partsIn("America/New_York", new Date("2026-07-15T08:00:00Z"));
  assert.deepEqual(before, { wd: "Wed", h: 3, m: 59 });
  assert.deepEqual(at, { wd: "Wed", h: 4, m: 0 });
});

test("partsIn: límite de cierre de Madrid, 17:40 vs 17:41", () => {
  const at = partsIn("Europe/Madrid", new Date("2026-01-14T16:40:00Z"));
  const after = partsIn("Europe/Madrid", new Date("2026-01-14T16:41:00Z"));
  assert.deepEqual(at, { wd: "Wed", h: 17, m: 40 });
  assert.deepEqual(after, { wd: "Wed", h: 17, m: 41 });
});

test("marketsMaybeOpen: en día laborable normal, con cualquier bolsa en horario, da abierto", () => {
  assert.equal(marketsMaybeOpen(new Date("2026-01-14T09:00:00Z")), true);   // NY 04:00 (Madrid ya abierta)
  assert.equal(marketsMaybeOpen(new Date("2026-01-14T16:40:00Z")), true);   // Madrid 17:40 (NY en sesión regular)
});

test("marketsMaybeOpen: de madrugada UTC entre semana, con las dos bolsas cerradas, da cerrado", () => {
  assert.equal(marketsMaybeOpen(new Date("2026-01-14T03:00:00Z")), false); // NY martes 22:00, Madrid miércoles 04:00
});

test("marketsMaybeOpen: fin de semana (sábado y domingo) siempre cerrado", () => {
  assert.equal(marketsMaybeOpen(new Date("2026-01-17T15:00:00Z")), false); // sábado
  assert.equal(marketsMaybeOpen(new Date("2026-01-18T15:00:00Z")), false); // domingo
});

test("marketsMaybeOpen: el día de la semana se comprueba por zona, no por UTC (viernes en NY / sábado ya en Madrid)", () => {
  // A esta hora Madrid ya es sábado (cerrado por fin de semana) pero en Nueva York
  // sigue siendo viernes dentro del horario de after-hours -> abierto por EE. UU.
  const d = new Date("2026-01-16T23:00:00Z");
  assert.deepEqual(partsIn("America/New_York", d).wd, "Fri");
  assert.deepEqual(partsIn("Europe/Madrid", d).wd, "Sat");
  assert.equal(marketsMaybeOpen(d), true);
});

test("isQuietHour: activo antes de las 07:00 (Madrid) si quietNight está activado", () => {
  const settings = { quietNight: true };
  assert.equal(isQuietHour(settings, new Date("2026-01-14T05:30:00Z")), true);  // Madrid 06:30
  assert.equal(isQuietHour(settings, new Date("2026-01-14T06:30:00Z")), false); // Madrid 07:30
});

test("isQuietHour: siempre falso si quietNight está desactivado", () => {
  assert.equal(isQuietHour({ quietNight: false }, new Date("2026-01-14T05:30:00Z")), false);
});
