/**
 * Consultas de lectura: catalogo filtrado, historial de precios,
 * comparacion entre tiendas y procedencia de los datos.
 */

import type { Db } from '../infra/db.js';

export interface OfferFilters {
  inStockOnly?: boolean;
  store?: string;
  brand?: string;
  sizes?: string[];
  minPrice?: number;
  maxPrice?: number;
  onlyDiscounted?: boolean;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface OfferRow {
  sku_id: number;
  store_slug: string;
  store_name: string;
  product_name: string;
  brand: string | null;
  gender: string | null;
  sport: string | null;
  ref_code: string | null;
  match_key: string;
  product_url: string;
  sku_url: string;
  image_url: string | null;
  size_label: string;
  size_us: number | null;
  size_cm: number | null;
  price: number | null;
  list_price: number | null;
  available: number;
  stock: number;
  stock_is_capped: number;
  prev_price: number | null;
  prev_price_at: string | null;
  min_price_ever: number | null;
  max_price_ever: number | null;
  observation_count: number;
  observed_at: string;
  run_id: number;
  currency: string;
  /** Calculados en SQL, no en JS, para que ordenar por ellos sea barato. */
  discount_pct: number | null;
  change_pct: number | null;
  vs_min_pct: number | null;
  is_all_time_low: number;
  rival_best_price: number | null;
  rival_store: string | null;
}

/** Precio mas barato del MISMO modelo y talla en OTRA tienda. */
const RIVAL_JOIN = `
  LEFT JOIN (
    SELECT match_key, size_us, store_slug, price,
           ROW_NUMBER() OVER (PARTITION BY match_key, size_us ORDER BY price ASC) AS rn
    FROM v_offer
    WHERE available = 1 AND price IS NOT NULL
  ) rival
    ON rival.match_key = o.match_key
   AND rival.size_us IS o.size_us
   AND rival.store_slug <> o.store_slug
   AND rival.rn = 1
`;

const SELECT_OFFERS = `
  SELECT o.*,
    CASE WHEN o.list_price > o.price
         THEN ROUND((o.list_price - o.price) * 100.0 / o.list_price, 1) END AS discount_pct,
    CASE WHEN o.prev_price IS NOT NULL AND o.prev_price > 0
         THEN ROUND((o.price - o.prev_price) * 100.0 / o.prev_price, 1) END AS change_pct,
    CASE WHEN o.min_price_ever IS NOT NULL AND o.min_price_ever > 0
         THEN ROUND((o.price - o.min_price_ever) * 100.0 / o.min_price_ever, 1) END AS vs_min_pct,
    CASE WHEN o.price IS NOT NULL AND o.price <= o.min_price_ever THEN 1 ELSE 0 END AS is_all_time_low,
    rival.price AS rival_best_price,
    rival.store_slug AS rival_store
  FROM v_offer o
  ${RIVAL_JOIN}
`;

const SORTS: Record<string, string> = {
  price_asc: 'o.price ASC NULLS LAST',
  price_desc: 'o.price DESC',
  discount: 'discount_pct DESC NULLS LAST',
  drop: 'change_pct ASC NULLS LAST',
  stock: 'o.stock ASC',
  brand: 'o.brand ASC, o.product_name ASC',
  name: 'o.product_name ASC',
  recent: 'o.sku_first_seen_at DESC',
};

export function queryOffers(db: Db, filters: OfferFilters = {}): OfferRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filters.inStockOnly !== false) where.push('o.available = 1');
  if (filters.store) {
    where.push('o.store_slug = ?');
    params.push(filters.store);
  }
  if (filters.brand) {
    where.push('o.brand = ?');
    params.push(filters.brand);
  }
  if (filters.sizes?.length) {
    where.push(`o.size_label IN (${filters.sizes.map(() => '?').join(',')})`);
    params.push(...filters.sizes);
  }
  if (typeof filters.minPrice === 'number') {
    where.push('o.price >= ?');
    params.push(filters.minPrice);
  }
  if (typeof filters.maxPrice === 'number') {
    where.push('o.price <= ?');
    params.push(filters.maxPrice);
  }
  if (filters.onlyDiscounted) where.push('o.list_price > o.price');
  if (filters.search) {
    where.push('(o.product_name LIKE ? OR o.brand LIKE ? OR o.ref_code LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }

  const sql =
    SELECT_OFFERS +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${SORTS[filters.sort ?? 'price_asc'] ?? SORTS.price_asc}` +
    ` LIMIT ? OFFSET ?`;

  params.push(Math.min(filters.limit ?? 500, 2000), filters.offset ?? 0);
  return db.prepare(sql).all(...params) as unknown as OfferRow[];
}

export interface HistoryPoint {
  observed_at: string;
  price: number | null;
  list_price: number | null;
  available: number;
  stock: number;
  stock_is_capped: number;
  run_id: number;
}

/** Historial completo de un SKU: una fila por cambio observado. */
export function skuHistory(db: Db, skuId: number): HistoryPoint[] {
  return db
    .prepare(
      `SELECT observed_at, price, list_price, available, stock, stock_is_capped, run_id
       FROM price_point WHERE sku_id = ? ORDER BY observed_at ASC`,
    )
    .all(skuId) as unknown as HistoryPoint[];
}

/** Detalle de un SKU con su procedencia: de que tienda, que URL, que corrida. */
export function skuDetail(db: Db, skuId: number): (OfferRow & { endpoints: string[] }) | null {
  const row = db
    .prepare(`${SELECT_OFFERS} WHERE o.sku_id = ?`)
    .get(skuId) as unknown as OfferRow | undefined;
  if (!row) return null;

  const run = db.prepare('SELECT endpoints FROM run WHERE id = ?').get(row.run_id) as
    | { endpoints: string | null }
    | undefined;

  let endpoints: string[] = [];
  try {
    endpoints = run?.endpoints ? (JSON.parse(run.endpoints) as string[]) : [];
  } catch {
    endpoints = [];
  }
  return { ...row, endpoints };
}

export interface ComparisonRow {
  match_key: string;
  ref_code: string | null;
  brand: string | null;
  product_name: string;
  size_label: string;
  size_cm: number | null;
  stores: number;
  cheapest_store: string;
  cheapest_price: number;
  dearest_store: string;
  dearest_price: number;
  /** Nombre y codigo del lado caro: en modo `model` puede ser otro color. */
  dearest_name: string;
  dearest_ref: string | null;
  saving: number;
  saving_pct: number;
  image_url: string | null;
  cheapest_url: string;
  dearest_url: string;
  cheapest_stock: number;
  dearest_stock: number;
}

/**
 * Modo de agrupacion para comparar entre tiendas.
 *
 *  - `exact`: mismo modelo Y mismo color (codigo de fabricante completo).
 *    Es una comparacion "manzanas con manzanas".
 *  - `model`: mismo modelo, cualquier color. Encuentra casos reales como
 *    "el mismo Palermo LTH en otro color cuesta 450 Bs menos en la otra tienda",
 *    que la comparacion exacta no ve.
 */
export type CompareMode = 'exact' | 'model';

/** Mismo zapato + misma talla, disponible en mas de una tienda. */
export function crossStoreComparison(
  db: Db,
  inStockOnly = true,
  mode: CompareMode = 'exact',
): ComparisonRow[] {
  const availability = inStockOnly ? 'AND available = 1' : '';
  // Solo puede tomar los dos valores del tipo: nunca llega texto del usuario al SQL.
  const key = mode === 'model' ? 'model_key' : 'match_key';

  return db
    .prepare(
      `WITH base AS (
         SELECT * FROM v_offer WHERE price IS NOT NULL AND ${key} IS NOT NULL ${availability}
       ),
       -- Mejor precio de cada tienda para ese zapato y talla (una fila por tienda).
       per_store AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY ${key}, size_us, store_slug ORDER BY price ASC
         ) AS store_rn
         FROM base
       ),
       best AS (SELECT * FROM per_store WHERE store_rn = 1),
       -- Solo interesan los que aparecen en mas de una tienda.
       groups AS (
         SELECT ${key} AS gkey, size_us, COUNT(*) AS store_count
         FROM best GROUP BY ${key}, size_us HAVING COUNT(*) > 1
       ),
       ranked AS (
         SELECT b.*, g.store_count,
           ROW_NUMBER() OVER (
             PARTITION BY b.${key}, b.size_us ORDER BY b.price ASC, b.store_slug ASC
           ) AS cheap_rn,
           ROW_NUMBER() OVER (
             PARTITION BY b.${key}, b.size_us ORDER BY b.price DESC, b.store_slug DESC
           ) AS dear_rn
         FROM best b
         JOIN groups g ON g.gkey = b.${key} AND g.size_us IS b.size_us
       )
       SELECT
         c.${key} AS match_key, c.ref_code, c.brand, c.product_name,
         c.size_label, c.size_cm, c.store_count AS stores,
         c.store_slug AS cheapest_store, c.price AS cheapest_price,
         d.store_slug AS dearest_store,  d.price AS dearest_price,
         d.product_name AS dearest_name, d.ref_code AS dearest_ref,
         ROUND(d.price - c.price, 2) AS saving,
         ROUND((d.price - c.price) * 100.0 / d.price, 1) AS saving_pct,
         c.image_url, c.sku_url AS cheapest_url, d.sku_url AS dearest_url,
         c.stock AS cheapest_stock, d.stock AS dearest_stock
       FROM ranked c
       JOIN ranked d
         ON d.${key} = c.${key} AND d.size_us IS c.size_us AND d.dear_rn = 1
       WHERE c.cheap_rn = 1 AND d.store_slug <> c.store_slug
       ORDER BY saving DESC`,
    )
    .all() as unknown as ComparisonRow[];
}

export interface RunRow {
  id: number;
  store_slug: string;
  store_name: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  request_count: number;
  products_found: number;
  skus_target_size: number;
  skus_in_stock: number;
  price_changes: number;
  duration_ms: number | null;
  error_message: string | null;
  endpoints: string | null;
}

/** Bitacora de corridas: el "de donde salio esto" a nivel de sistema. */
export function listRuns(db: Db, limit = 50): RunRow[] {
  return db
    .prepare(
      `SELECT r.id, s.slug AS store_slug, s.name AS store_name, r.started_at, r.finished_at,
              r.status, r.request_count, r.products_found, r.skus_target_size,
              r.skus_in_stock, r.price_changes, r.duration_ms, r.error_message, r.endpoints
       FROM run r JOIN store s ON s.id = r.store_id
       ORDER BY r.started_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as RunRow[];
}

/** Bajadas de precio detectadas en las ultimas N horas. */
export function recentPriceDrops(db: Db, hours = 168): OfferRow[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  return db
    .prepare(
      `${SELECT_OFFERS}
       WHERE o.available = 1
         AND o.prev_price IS NOT NULL
         AND o.price < o.prev_price
         AND o.observed_at >= ?
       ORDER BY change_pct ASC`,
    )
    .all(since) as unknown as OfferRow[];
}

export interface Facets {
  brands: Array<{ value: string; count: number }>;
  stores: Array<{ value: string; label: string; count: number }>;
  sizes: Array<{ value: string; count: number }>;
}

export function facets(db: Db, inStockOnly = true): Facets {
  const cond = inStockOnly ? 'WHERE available = 1' : '';
  return {
    brands: db
      .prepare(
        `SELECT brand AS value, COUNT(*) AS count FROM v_offer ${cond}
         ${cond ? 'AND' : 'WHERE'} brand IS NOT NULL
         GROUP BY brand ORDER BY count DESC`,
      )
      .all() as unknown as Array<{ value: string; count: number }>,
    stores: db
      .prepare(
        `SELECT store_slug AS value, store_name AS label, COUNT(*) AS count
         FROM v_offer ${cond} GROUP BY store_slug, store_name ORDER BY count DESC`,
      )
      .all() as unknown as Array<{ value: string; label: string; count: number }>,
    sizes: db
      .prepare(
        `SELECT size_label AS value, COUNT(*) AS count FROM v_offer ${cond}
         GROUP BY size_label ORDER BY size_us ASC`,
      )
      .all() as unknown as Array<{ value: string; count: number }>,
  };
}

export interface Stats {
  total_skus: number;
  in_stock: number;
  products: number;
  stores: number;
  last_run: string | null;
  cheapest: number | null;
  matched_groups: number;
}

export function stats(db: Db): Stats {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM v_offer)                                  AS total_skus,
         (SELECT COUNT(*) FROM v_offer WHERE available = 1)              AS in_stock,
         (SELECT COUNT(DISTINCT product_id) FROM v_offer)                AS products,
         (SELECT COUNT(*) FROM store)                                    AS stores,
         (SELECT MAX(started_at) FROM run WHERE status = 'ok')           AS last_run,
         (SELECT MIN(price) FROM v_offer WHERE available = 1)            AS cheapest`,
    )
    .get() as unknown as Omit<Stats, 'matched_groups'>;

  const matched = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT match_key, size_us FROM v_offer WHERE available = 1
         GROUP BY match_key, size_us HAVING COUNT(DISTINCT store_slug) > 1)`,
    )
    .get() as unknown as { n: number };

  return { ...row, matched_groups: matched.n };
}
