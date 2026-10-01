// Radar Cartera — Comparador de ordenación (ver spec §6.5)
// Los valores sin dato van siempre al final, sea cual sea la dirección.

// "value" se compara en EUR (valueEur) cuando se puede: con posiciones en
// monedas distintas, comparar los números en su moneda original daría un
// orden sin sentido (p. ej. 900 EUR vs 1000 USD no es "1000 > 900").
function sortVal(m, sortKey) {
  if (sortKey === "alpha") return m.sym;
  if (sortKey === "value") return m.valueEur ?? m.value;
  // "plAbs" (ganancia en dinero, no en %): igual que "value", se compara en
  // EUR cuando se puede — si no, una posición en USD y otra en EUR darían un
  // orden sin sentido comparando números en monedas distintas.
  if (sortKey === "plAbs") return m.plAbsEur ?? m.plAbs;
  // La clave de orden es "earnings" pero metrics() la expone como
  // "earningsDays" (para no chocar con el campo "earnings" que no existe) —
  // sin este caso especial, m["earnings"] siempre da undefined y la lista cae
  // al desempate alfabético por defecto (bug real, hallado 2026-10-01).
  if (sortKey === "earnings") return m.earningsDays;
  return m[sortKey];
}

function compareItems(a, b, sortKey, sortDesc) {
  const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
  if (va == null && vb == null) return a.sym.localeCompare(b.sym);
  if (va == null) return 1;
  if (vb == null) return -1;
  const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
  return sortDesc ? -c : c;
}

export { sortVal, compareItems };
