/**
 * Escrituras del pipeline. Todas idempotentes: correr el scraper dos veces
 * seguidas no duplica nada ni ensucia el historial.
 */

import type { Db } from '../infra/db.js';
import type { ScrapedOffer, ScrapedProduct, ScrapedSku, StoreConfig } from '../domain/types.js';
import { matchKeyFor, modelKeyFor, normalizeRef } from '../domain/matching.js';
import { normalizeSize } from '../domain/sizes.js';

export interface RunTotals {
  productsFound: number;
  skusFound: number;
  skusTargetSize: number;
  skusInStock: number;
  priceChanges: number;
}

export class Repository {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get db(): Db {
    return this.#db;
  }

  upsertStore(store: StoreConfig): number {
    this.#db
      .prepare(
        `INSERT INTO store (slug, name, platform, base_url, currency)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           platform = excluded.platform,
           base_url = excluded.base_url,
           currency = excluded.currency`,
      )
      .run(store.slug, store.name, store.platform, store.baseUrl, store.currency);

    const row = this.#db.prepare('SELECT id FROM store WHERE slug = ?').get(store.slug) as
      | { id: number }
      | undefined;
    if (!row) throw new Error(`No se pudo registrar la tienda ${store.slug}`);
    return row.id;
  }

  startRun(storeId: number): number {
    const now = new Date().toISOString();
    this.#db
      .prepare(`INSERT INTO run (store_id, started_at, status) VALUES (?, ?, 'running')`)
      .run(storeId, now);
    const row = this.#db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    return row.id;
  }

  finishRun(
    runId: number,
    outcome: {
      status: 'ok' | 'error';
      requestCount: number;
      totals: RunTotals;
      endpoints: string[];
      errorMessage?: string | null;
      durationMs: number;
    },
  ): void {
    this.#db
      .prepare(
        `UPDATE run SET
           finished_at = ?, status = ?, request_count = ?,
           products_found = ?, skus_found = ?, skus_target_size = ?,
           skus_in_stock = ?, price_changes = ?, endpoints = ?,
           error_message = ?, duration_ms = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        outcome.status,
        outcome.requestCount,
        outcome.totals.productsFound,
        outcome.totals.skusFound,
        outcome.totals.skusTargetSize,
        outcome.totals.skusInStock,
        outcome.totals.priceChanges,
        JSON.stringify(outcome.endpoints.slice(0, 50)),
        outcome.errorMessage ?? null,
        outcome.durationMs,
        runId,
      );
  }

  upsertProduct(storeId: number, product: ScrapedProduct, observedAt: string): number {
    const match = matchKeyFor(product);
    this.#db
      .prepare(
        `INSERT INTO product (
           store_id, external_id, ref_code, ref_norm, match_key, match_strength, model_key,
           name, brand, gender, sport, category_path, url, image_url,
           first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(store_id, external_id) DO UPDATE SET
           ref_code = excluded.ref_code,
           ref_norm = excluded.ref_norm,
           match_key = excluded.match_key,
           match_strength = excluded.match_strength,
           model_key = excluded.model_key,
           name = excluded.name,
           brand = excluded.brand,
           gender = excluded.gender,
           sport = excluded.sport,
           category_path = excluded.category_path,
           url = excluded.url,
           image_url = COALESCE(excluded.image_url, product.image_url),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        storeId,
        product.externalId,
        product.refCode,
        normalizeRef(product.refCode) || null,
        match.key,
        match.strength,
        modelKeyFor(product),
        product.name,
        product.brand,
        product.gender,
        product.sport,
        product.categoryPath,
        product.url,
        product.imageUrl,
        observedAt,
        observedAt,
      );

    const row = this.#db
      .prepare('SELECT id FROM product WHERE store_id = ? AND external_id = ?')
      .get(storeId, product.externalId) as { id: number } | undefined;
    if (!row) throw new Error(`No se pudo registrar el producto ${product.externalId}`);
    return row.id;
  }

  upsertSku(productId: number, sku: ScrapedSku, observedAt: string): number {
    const size = normalizeSize(sku.sizeLabel);
    this.#db
      .prepare(
        `INSERT INTO sku (
           product_id, external_id, size_label, size_us, size_cm, ean, url, image_url,
           first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id, external_id) DO UPDATE SET
           size_label = excluded.size_label,
           size_us = excluded.size_us,
           size_cm = excluded.size_cm,
           ean = COALESCE(excluded.ean, sku.ean),
           url = excluded.url,
           image_url = COALESCE(excluded.image_url, sku.image_url),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        productId,
        sku.externalId,
        size.label,
        size.us,
        size.cm,
        sku.ean,
        sku.url,
        sku.imageUrl,
        observedAt,
        observedAt,
      );

    const row = this.#db
      .prepare('SELECT id FROM sku WHERE product_id = ? AND external_id = ?')
      .get(productId, sku.externalId) as { id: number } | undefined;
    if (!row) throw new Error(`No se pudo registrar el SKU ${sku.externalId}`);
    return row.id;
  }

  /**
   * Registra la oferta observada.
   *
   * Solo escribe en `price_point` si algo cambio respecto de la ultima
   * observacion (precio, precio de lista, disponibilidad o stock). Esa es la
   * clave para que el historial siga siendo chico despues de anos de corridas
   * diarias, y para que "ultimo cambio de precio" sea una consulta trivial.
   *
   * @returns true si se registro un cambio.
   */
  recordOffer(skuId: number, runId: number, offer: ScrapedOffer, observedAt: string): boolean {
    const state = this.#db.prepare('SELECT * FROM sku_state WHERE sku_id = ?').get(skuId) as
      | {
          price: number | null;
          list_price: number | null;
          available: number;
          stock: number;
          min_price_ever: number | null;
          max_price_ever: number | null;
          first_price: number | null;
          observation_count: number;
        }
      | undefined;

    const availableInt = offer.available ? 1 : 0;
    const changed =
      !state ||
      !sameNumber(state.price, offer.price) ||
      !sameNumber(state.list_price, offer.listPrice) ||
      state.available !== availableInt ||
      state.stock !== offer.stock;

    if (changed) {
      this.#db
        .prepare(
          `INSERT INTO price_point (
             sku_id, run_id, observed_at, price, list_price, available, stock,
             stock_is_capped, seller
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          skuId,
          runId,
          observedAt,
          offer.price,
          offer.listPrice,
          availableInt,
          offer.stock,
          offer.stockIsCapped ? 1 : 0,
          offer.seller,
        );
    }

    // `prev_price` solo avanza cuando el precio realmente cambio de valor:
    // asi "antes costaba X" nunca muestra el mismo numero que el precio actual.
    const priceMoved = state ? !sameNumber(state.price, offer.price) : false;
    const prevPrice = priceMoved ? state!.price : null;

    this.#db
      .prepare(
        `INSERT INTO sku_state (
           sku_id, last_run_id, observed_at, price, list_price, available, stock,
           stock_is_capped, seller, prev_price, prev_price_at,
           min_price_ever, max_price_ever, first_price, observation_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1)
         ON CONFLICT(sku_id) DO UPDATE SET
           last_run_id = excluded.last_run_id,
           observed_at = excluded.observed_at,
           price = excluded.price,
           list_price = excluded.list_price,
           available = excluded.available,
           stock = excluded.stock,
           stock_is_capped = excluded.stock_is_capped,
           seller = excluded.seller,
           prev_price = CASE WHEN ? = 1 THEN ? ELSE sku_state.prev_price END,
           prev_price_at = CASE WHEN ? = 1 THEN sku_state.observed_at ELSE sku_state.prev_price_at END,
           min_price_ever = CASE
             WHEN excluded.price IS NULL THEN sku_state.min_price_ever
             WHEN sku_state.min_price_ever IS NULL THEN excluded.price
             ELSE MIN(sku_state.min_price_ever, excluded.price) END,
           max_price_ever = CASE
             WHEN excluded.price IS NULL THEN sku_state.max_price_ever
             WHEN sku_state.max_price_ever IS NULL THEN excluded.price
             ELSE MAX(sku_state.max_price_ever, excluded.price) END,
           observation_count = sku_state.observation_count + 1`,
      )
      .run(
        skuId,
        runId,
        observedAt,
        offer.price,
        offer.listPrice,
        availableInt,
        offer.stock,
        offer.stockIsCapped ? 1 : 0,
        offer.seller,
        offer.price,
        offer.price,
        offer.price,
        priceMoved ? 1 : 0,
        prevPrice,
        priceMoved ? 1 : 0,
      );

    return changed;
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Compara precios tolerando el ruido de coma flotante. */
function sameNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Math.abs(a - b) < 0.005;
}
