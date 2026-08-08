/**
 * Cruce de productos entre tiendas.
 *
 * Fair Play y Yuth son cadenas hermanas y publican el mismo `productReference`
 * del fabricante (ej. "39646401", "HQ4484"). Ese codigo es la clave fuerte:
 * identifica el mismo modelo y color exacto, sin depender del nombre comercial.
 *
 * Estrategia en cascada:
 *   1. refCode normalizado          -> match exacto y confiable
 *   2. marca + nombre normalizados  -> respaldo cuando falta el refCode
 */

export type MatchStrength = 'ref' | 'brand_name';

export interface MatchKey {
  key: string;
  strength: MatchStrength;
}

/** Deja solo alfanumericos en mayuscula: "hq4484-001" y "HQ4484 001" colapsan igual. */
export function normalizeRef(ref: string | null | undefined): string {
  return (ref ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normaliza texto libre: sin acentos, sin puntuacion, espacios colapsados. */
export function normalizeText(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Palabras de ruido del catalogo local que no aportan a la identidad del modelo.
 * "ZAP" es el prefijo que ambas tiendas usan para "zapatilla".
 */
const NOISE = new Set(['ZAP', 'ZAPATILLA', 'ZAPATILLAS', 'DE', 'DEL', 'LA', 'EL']);

export function normalizeModelName(brand: string | null, name: string | null): string {
  const brandTokens = new Set(normalizeText(brand).split(' ').filter(Boolean));
  const tokens = normalizeText(name)
    .split(' ')
    .filter((t) => t && !NOISE.has(t) && !brandTokens.has(t));
  return tokens.join(' ');
}

/**
 * Clave de agrupacion de un producto. Se prefiere el refCode; el nombre es respaldo.
 * Un refCode de menos de 4 caracteres se descarta por ser demasiado ambiguo.
 */
export function matchKeyFor(product: {
  refCode: string | null;
  brand: string | null;
  name: string;
}): MatchKey {
  const ref = normalizeRef(product.refCode);
  if (ref.length >= 4) return { key: `ref:${ref}`, strength: 'ref' };
  const brand = normalizeText(product.brand);
  const model = normalizeModelName(product.brand, product.name);
  return { key: `bn:${brand}|${model}`, strength: 'brand_name' };
}

/**
 * Clave de MODELO, ignorando el color.
 *
 * Los proveedores codifican el color como sufijo del codigo: PUMA usa
 * "396464-07" (modelo 396464, color 07) y Under Armour "1381915-001".
 * `matchKeyFor` distingue colores; esta clave los agrupa.
 *
 * Sirve para el caso real de "el mismo zapato en otro color cuesta 450 Bs menos
 * en la otra tienda", que la comparacion por color exacto no ve.
 *
 * Si el codigo no tiene sufijo separable (adidas: "HQ4484"), cae en marca+modelo
 * a partir del nombre, que es lo unico comparable en ese caso.
 */
export function modelKeyFor(product: {
  refCode: string | null;
  brand: string | null;
  name: string;
}): string {
  const raw = (product.refCode ?? '').trim();
  const base = raw.split(/[-_/]/)[0] ?? '';
  const normalized = normalizeRef(base);
  // Solo se usa el codigo si el sufijo existia: si no, no aporta sobre matchKey.
  if (normalized.length >= 4 && normalized !== normalizeRef(raw)) {
    return `model:${normalized}`;
  }
  const brand = normalizeText(product.brand);
  const model = normalizeModelName(product.brand, product.name);
  return model ? `name:${brand}|${model}` : `model:${normalizeRef(raw)}`;
}
