/**
 * Genera el sitio estatico para GitHub Pages.
 *
 * La idea: el scraper corre en tu maquina (cron o a mano), donde vive la base
 * con todo el historial. Este paso publica solo la FOTO VIGENTE — lo que hoy
 * tiene stock — mas el historial de precios de esos SKUs, que es lo unico que
 * el visitante necesita ver.
 *
 * Dos ventajas sobre correr el scraper en GitHub Actions:
 *  - Las tiendas se consultan desde tu conexion en Bolivia, no desde un
 *    datacenter de EE.UU. que podrian bloquear o tratar distinto.
 *  - El historial completo se queda en tu disco: el repositorio no se infla
 *    con una base binaria de 3 MB por cada commit.
 *
 * Todo lo que el servidor calcula con SQL se precalcula aca, asi la pagina
 * estatica solo tiene que filtrar y ordenar una lista corta.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../infra/db.js';
import type { AppConfig } from '../domain/types.js';
import {
  crossStoreComparison,
  facets,
  listRuns,
  queryOffers,
  recentPriceDrops,
  stats,
  type OfferRow,
} from './analytics.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface BuildResult {
  outDir: string;
  offers: number;
  historyPoints: number;
  bytes: number;
}

export function buildStaticSite(db: Db, config: AppConfig, outDir: string): BuildResult {
  mkdirSync(outDir, { recursive: true });

  // Solo lo vigente: lo agotado no le sirve a quien mira la pagina.
  const offers = queryOffers(db, { inStockOnly: true, sort: 'price_asc', limit: 5000 });

  const payload = {
    generatedAt: new Date().toISOString(),
    targetSizes: config.targetSizes,
    stores: config.stores
      .filter((s) => s.enabled)
      .map((s) => ({ slug: s.slug, name: s.name, platform: s.platform, url: s.baseUrl })),
    stats: stats(db),
    facets: facets(db, true),
    offers,
    // Historial de precios, solo de los SKUs publicados.
    history: historyFor(db, offers),
    compare: {
      exact: crossStoreComparison(db, true, 'exact'),
      model: crossStoreComparison(db, true, 'model'),
    },
    drops: recentPriceDrops(db, 24 * 30),
    runs: listRuns(db, 20),
  };

  const json = JSON.stringify(payload);
  writeFileSync(join(outDir, 'data.json'), json);

  // La misma interfaz que usa el servidor local: detecta sola en que modo esta.
  copyFileSync(join(HERE, '..', 'web', 'public', 'index.html'), join(outDir, 'index.html'));

  // Sin este archivo, GitHub Pages procesa el sitio con Jekyll y descarta
  // cualquier carpeta o archivo que empiece con guion bajo.
  writeFileSync(join(outDir, '.nojekyll'), '');

  return {
    outDir,
    offers: offers.length,
    historyPoints: Object.values(payload.history).reduce((n, h) => n + h.length, 0),
    bytes: Buffer.byteLength(json),
  };
}

interface HistoryPoint {
  observed_at: string;
  price: number | null;
  available: number;
  stock: number;
}

/**
 * Historial de los SKUs publicados. Se traen todos los puntos de una vez y se
 * agrupan en memoria: una consulta por SKU serian cientos de consultas.
 */
function historyFor(db: Db, offers: OfferRow[]): Record<string, HistoryPoint[]> {
  const wanted = new Set(offers.map((o) => o.sku_id));
  const rows = db
    .prepare(
      `SELECT sku_id, observed_at, price, available, stock
       FROM price_point ORDER BY observed_at ASC`,
    )
    .all() as unknown as Array<HistoryPoint & { sku_id: number }>;

  const out: Record<string, HistoryPoint[]> = {};
  for (const row of rows) {
    if (!wanted.has(row.sku_id)) continue;
    (out[row.sku_id] ??= []).push({
      observed_at: row.observed_at,
      price: row.price,
      available: row.available,
      stock: row.stock,
    });
  }
  return out;
}
