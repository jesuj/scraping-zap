/**
 * Normalizacion de tallas.
 *
 * Las dos tiendas publican la talla como texto libre en el SKU ("11", "11.5", "43").
 * Aca la convertimos a un numero comparable y a centimetros, que es lo unico
 * que de verdad importa cuando lo que conoces es el largo de tu pie.
 *
 * Tabla US hombre -> cm (longitud de horma), que es la que usan Nike/adidas/Puma
 * en su guia oficial. Es aproximada por marca: se usa para informar, no para filtrar.
 */

const US_MEN_TO_CM: Record<string, number> = {
  '6': 24,
  '6.5': 24.5,
  '7': 25,
  '7.5': 25.5,
  '8': 26,
  '8.5': 26.5,
  '9': 27,
  '9.5': 27.5,
  '10': 28,
  '10.5': 28.5,
  '11': 29,
  '11.5': 29.5,
  '12': 30,
  '12.5': 30.5,
  '13': 31,
  '14': 32,
};

export interface NormalizedSize {
  /** Etiqueta tal cual la publica la tienda. Es la fuente de verdad. */
  label: string;
  /** Talla numerica normalizada (11.5). null si no es parseable (ej. "TU", "OSFA"). */
  us: number | null;
  /** Equivalencia en cm segun tabla US hombre. null si no hay equivalencia. */
  cm: number | null;
}

/** Convierte "TALLA 11.5", " 11,5 " o "11.5" en una talla normalizada. */
export function normalizeSize(raw: string | null | undefined): NormalizedSize {
  const label = (raw ?? '').trim();
  if (!label) return { label: '', us: null, cm: null };

  // Acepta coma decimal y descarta prefijos tipo "TALLA".
  const cleaned = label.replace(/talla/i, '').replace(',', '.').trim();
  const match = cleaned.match(/^(\d{1,2}(?:\.\d)?)$/);
  if (!match) return { label, us: null, cm: null };

  const us = Number(match[1]);
  if (!Number.isFinite(us)) return { label, us: null, cm: null };

  const key = Number.isInteger(us) ? String(us) : us.toFixed(1);
  return { label, us, cm: US_MEN_TO_CM[key] ?? null };
}

/**
 * Compara la talla de un SKU contra la lista objetivo.
 * Compara por valor numerico, no por texto, para que "11.0" y "11" sean la misma.
 */
export function buildSizeMatcher(targetLabels: string[]): (raw: string) => boolean {
  const targets = new Set<number>();
  const rawTargets = new Set<string>();
  for (const label of targetLabels) {
    const norm = normalizeSize(label);
    if (norm.us !== null) targets.add(norm.us);
    rawTargets.add(label.trim().toLowerCase());
  }
  return (raw: string) => {
    const norm = normalizeSize(raw);
    if (norm.us !== null && targets.has(norm.us)) return true;
    return rawTargets.has((raw ?? '').trim().toLowerCase());
  };
}

export function cmForLabel(label: string): number | null {
  return normalizeSize(label).cm;
}
