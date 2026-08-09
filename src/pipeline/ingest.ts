/**
 * Orquestador de una corrida de extraccion.
 *
 * Una corrida por tienda. Si una tienda falla, se registra el error en `run`
 * y las demas siguen: un sitio caido no debe tirar abajo la corrida entera.
 */

import type { AppConfig, ScrapeResult } from '../domain/types.js';
import { buildSizeMatcher } from '../domain/sizes.js';
import { createConnector } from '../connectors/registry.js';
import { HttpClient } from '../infra/http.js';
import { Repository, type RunTotals } from '../repo/repositories.js';

export interface StoreRunSummary {
  store: string;
  runId: number;
  status: 'ok' | 'error';
  totals: RunTotals;
  requestCount: number;
  durationMs: number;
  error?: string;
  warnings: string[];
}

export async function runScrape(
  repo: Repository,
  config: AppConfig,
  log: (msg: string) => void = console.log,
): Promise<StoreRunSummary[]> {
  const matchesTargetSize = buildSizeMatcher(config.targetSizes.labels);
  const summaries: StoreRunSummary[] = [];

  for (const storeConfig of config.stores) {
    if (!storeConfig.enabled) {
      log(`· ${storeConfig.slug}: deshabilitada en config, se omite`);
      continue;
    }

    const startedAt = Date.now();
    const storeId = repo.upsertStore(storeConfig);
    const runId = repo.startRun(storeId);
    const http = new HttpClient({
      userAgent: config.scrape.userAgent,
      timeoutMs: config.scrape.requestTimeoutMs,
      maxRetries: config.scrape.maxRetries,
      minDelayMs: config.scrape.minDelayMs,
      concurrency: config.scrape.concurrency,
    });

    const totals: RunTotals = {
      productsFound: 0,
      skusFound: 0,
      skusTargetSize: 0,
      skusInStock: 0,
      priceChanges: 0,
    };

    log(`→ ${storeConfig.name} (${storeConfig.platform}) · corrida #${runId}`);

    try {
      const connector = createConnector(storeConfig, http, {
        pageSize: config.scrape.pageSize,
        targetSizes: config.targetSizes.labels,
      });
      const result: ScrapeResult = await connector.fetchFootwear((msg) => log(msg));
      const observedAt = new Date().toISOString();

      // Todo el guardado en una transaccion: la corrida se ve completa o no se ve.
      repo.transaction(() => {
        for (const product of result.products) {
          totals.productsFound++;
          totals.skusFound += product.skus.length;

          // Se guardan TODOS los SKUs de las tallas objetivo, con y sin stock.
          // Guardar tambien los agotados es lo que permite responder despues
          // "cuando se agoto" y "a que precio estaba antes de agotarse".
          const targetSkus = product.skus.filter((sku) => matchesTargetSize(sku.sizeLabel));
          if (targetSkus.length === 0) continue;

          const productId = repo.upsertProduct(storeId, product, observedAt);
          for (const sku of targetSkus) {
            totals.skusTargetSize++;
            if (sku.offer.available) totals.skusInStock++;
            const skuId = repo.upsertSku(productId, sku, observedAt);
            if (repo.recordOffer(skuId, runId, sku.offer, observedAt)) totals.priceChanges++;
          }
        }
      });

      const durationMs = Date.now() - startedAt;
      repo.finishRun(runId, {
        status: 'ok',
        requestCount: http.requestCount,
        totals,
        endpoints: result.endpoints,
        durationMs,
      });

      log(
        `  ✓ ${storeConfig.slug}: ${totals.productsFound} productos · ` +
          `${totals.skusTargetSize} SKUs en talla objetivo · ` +
          `${totals.skusInStock} con stock · ${totals.priceChanges} cambios · ` +
          `${http.requestCount} peticiones · ${(durationMs / 1000).toFixed(1)}s`,
      );

      summaries.push({
        store: storeConfig.slug,
        runId,
        status: 'ok',
        totals,
        requestCount: http.requestCount,
        durationMs,
        warnings: result.warnings,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      repo.finishRun(runId, {
        status: 'error',
        requestCount: http.requestCount,
        totals,
        endpoints: [],
        errorMessage: message,
        durationMs,
      });
      log(`  ✗ ${storeConfig.slug} fallo: ${message}`);
      summaries.push({
        store: storeConfig.slug,
        runId,
        status: 'error',
        totals,
        requestCount: http.requestCount,
        durationMs,
        error: message,
        warnings: [],
      });
    }
  }

  return summaries;
}
