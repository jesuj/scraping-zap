#!/usr/bin/env node
/**
 * Interfaz de linea de comandos.
 *
 *   scrape           extrae de todas las tiendas habilitadas
 *   serve            levanta la web
 *   report           tabla en consola con lo disponible en tu talla
 *   compare          mismo modelo y talla en las dos tiendas
 *   drops            bajadas de precio recientes
 *   runs             bitacora de extracciones (procedencia)
 *   export           vuelca los datos a JSON y CSV
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, DEFAULT_DB_PATH, PROJECT_ROOT } from './config.js';
import { openDatabase } from './infra/db.js';
import { Repository } from './repo/repositories.js';
import { runScrape } from './pipeline/ingest.js';
import { startServer } from './web/server.js';
import {
  crossStoreComparison,
  listRuns,
  queryOffers,
  recentPriceDrops,
  stats,
} from './pipeline/analytics.js';

const command = process.argv[2] ?? 'help';
const config = loadConfig();
const db = openDatabase(process.env.ZAP_DB ?? DEFAULT_DB_PATH);

switch (command) {
  case 'scrape': {
    const repo = new Repository(db);
    const started = Date.now();
    console.log(`\nTallas objetivo: ${config.targetSizes.labels.join(', ')} (US hombre)\n`);
    const summaries = await runScrape(repo, config);
    const failed = summaries.filter((s) => s.status === 'error');

    const s = stats(db);
    console.log(
      `\nListo en ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
        `${s.in_stock} pares con stock en tu talla · ` +
        `${s.matched_groups} modelos presentes en ambas tiendas`,
    );
    console.log(`Base de datos: ${process.env.ZAP_DB ?? DEFAULT_DB_PATH}`);
    if (failed.length) {
      console.error(`\n${failed.length} tienda(s) fallaron: ${failed.map((f) => f.store).join(', ')}`);
      process.exitCode = 1;
    }
    break;
  }

  case 'serve': {
    startServer(db, config);
    break;
  }

  case 'report': {
    // "report 40" limita la salida; sin argumento se listan todos.
    const limit = Number(process.argv[3]) || 2000;
    const offers = queryOffers(db, { inStockOnly: true, sort: 'price_asc', limit });
    if (offers.length === 0) {
      console.log('Nada con stock en tu talla. ¿Corriste "npm run scrape"?');
      break;
    }
    const total = stats(db).in_stock;
    console.log(
      `\n${offers.length}${offers.length < total ? ` de ${total}` : ''} pares con stock ` +
        `en tallas ${config.targetSizes.labels.join('/')}, del más barato al más caro\n`,
    );
    console.log(pad('TIENDA', 10) + pad('MARCA', 15) + pad('MODELO', 40) + pad('T', 6) +
      pad('PRECIO', 10) + pad('ANTES', 10) + pad('STOCK', 12) + 'OTRA TIENDA');
    console.log('─'.repeat(120));
    for (const o of offers) {
      const rival = o.rival_best_price != null ? `${o.rival_store} ${money(o.rival_best_price)}` : '';
      console.log(
        pad(o.store_slug, 10) +
          pad(o.brand ?? '', 15) +
          pad(o.product_name, 40) +
          pad(o.size_label, 6) +
          pad(money(o.price), 10) +
          pad(o.list_price && o.list_price > (o.price ?? 0) ? money(o.list_price) : '', 10) +
          pad(o.stock_is_capped ? `${o.stock}+` : String(o.stock), 12) +
          rival,
      );
    }
    break;
  }

  case 'compare': {
    // "compare model" ignora el color y agrupa por modelo base.
    const mode = process.argv[3] === 'model' ? 'model' : 'exact';
    const rows = crossStoreComparison(db, true, mode).filter((r) => r.saving > 0 || mode === 'exact');
    if (rows.length === 0) {
      console.log('Ningun zapato en tu talla esta con stock en ambas tiendas ahora mismo.');
      break;
    }
    console.log(
      mode === 'model'
        ? `\n${rows.length} modelos en tu talla en ambas tiendas (ignorando el color):\n`
        : `\n${rows.length} zapatos en tu talla, mismo modelo y color, en las dos tiendas:\n`,
    );
    console.log(pad('MARCA', 14) + pad('MODELO', 34) + pad('COD', 12) + pad('T', 6) +
      pad('BARATO', 21) + pad('CARO', 21) + 'AHORRAS');
    console.log('─'.repeat(126));
    for (const r of rows) {
      console.log(
        pad(r.brand ?? '', 14) +
          pad(r.product_name, 34) +
          pad(r.ref_code ?? '', 12) +
          pad(r.size_label, 6) +
          pad(`${r.cheapest_store} ${money(r.cheapest_price)}`, 21) +
          pad(`${r.dearest_store} ${money(r.dearest_price)}`, 21) +
          `${money(r.saving)} (${r.saving_pct}%)`,
      );
    }
    break;
  }

  case 'drops': {
    const rows = recentPriceDrops(db, Number(process.argv[3] ?? 720));
    if (rows.length === 0) {
      console.log('Sin bajadas registradas. Se necesitan al menos dos extracciones para comparar.');
      break;
    }
    console.log(`\n${rows.length} bajadas de precio:\n`);
    for (const r of rows) {
      console.log(
        `  ${pad(r.store_slug, 10)}${pad(r.brand ?? '', 14)}${pad(r.product_name, 38)}` +
          `T${pad(r.size_label, 6)}${money(r.prev_price)} → ${money(r.price)}  (${r.change_pct}%)`,
      );
    }
    break;
  }

  case 'runs': {
    console.log('\nBitacora de extracciones:\n');
    console.log(pad('#', 6) + pad('TIENDA', 12) + pad('INICIO', 22) + pad('ESTADO', 9) +
      pad('PETIC.', 8) + pad('PRODS', 8) + pad('TALLA', 8) + pad('STOCK', 8) + 'CAMBIOS');
    console.log('─'.repeat(100));
    for (const r of listRuns(db, 30)) {
      console.log(
        pad(String(r.id), 6) + pad(r.store_slug, 12) +
          pad(new Date(r.started_at).toLocaleString('es-BO'), 22) +
          pad(r.status, 9) + pad(String(r.request_count), 8) +
          pad(String(r.products_found), 8) + pad(String(r.skus_target_size), 8) +
          pad(String(r.skus_in_stock), 8) + String(r.price_changes),
      );
    }
    break;
  }

  case 'export': {
    // Volcado a archivos planos, por si queres los datos fuera de SQLite.
    const dir = join(PROJECT_ROOT, 'export');
    mkdirSync(dir, { recursive: true });
    const offers = queryOffers(db, { inStockOnly: false, sort: 'price_asc', limit: 2000 });
    const inStock = offers.filter((o) => o.available === 1);

    writeFileSync(
      join(dir, 'zapatillas.json'),
      JSON.stringify(
        {
          generadoEn: new Date().toISOString(),
          tallasObjetivo: config.targetSizes,
          fuentes: config.stores.filter((s) => s.enabled).map((s) => ({
            tienda: s.name, slug: s.slug, plataforma: s.platform, url: s.baseUrl,
          })),
          resumen: stats(db),
          conStock: inStock,
          todos: offers,
          comparacionEntreTiendas: crossStoreComparison(db, true),
          extracciones: listRuns(db, 100),
        },
        null,
        2,
      ),
    );

    const cols = [
      'store_slug', 'brand', 'product_name', 'ref_code', 'size_label', 'size_cm',
      'price', 'list_price', 'discount_pct', 'prev_price', 'change_pct',
      'min_price_ever', 'available', 'stock', 'stock_is_capped',
      'rival_store', 'rival_best_price', 'product_url', 'image_url', 'observed_at', 'run_id',
    ] as const;
    const csv = [
      cols.join(','),
      ...offers.map((o) => cols.map((c) => csvCell(o[c])).join(',')),
    ].join('\n');
    writeFileSync(join(dir, 'zapatillas.csv'), '﻿' + csv); // BOM para que Excel lea los acentos

    console.log(`Exportado a ${dir}/`);
    console.log(`  zapatillas.json  ${offers.length} SKUs (${inStock.length} con stock) + comparaciones + procedencia`);
    console.log(`  zapatillas.csv   ${offers.length} filas, abrible en Excel`);
    break;
  }

  case 'backup': {
    // VACUUM INTO produce una copia consistente y compactada aunque haya
    // escrituras en curso. Copiar el archivo a mano puede dejar el WAL a medias.
    const dir = join(PROJECT_ROOT, 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = join(dir, `zapatillas-${stamp}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.log(`Backup creado: ${dest}`);
    console.log(`Para volver atras: cp "${dest}" data/zapatillas.db`);
    break;
  }

  default:
    console.log(`
  scraping-zap — zapatillas en talla ${config.targetSizes.labels.join('/')} US

  npm run scrape      Extrae de todas las tiendas y guarda el historial
  npm run serve       Abre la interfaz web
  npm run report      Lista en consola lo disponible en tu talla
  npm run compare     Mismo modelo y talla: precio en cada tienda
  npm run build && node dist/cli.js compare model   Mismo modelo, cualquier color
  npm run build && node dist/cli.js drops [horas]
  npm run build && node dist/cli.js runs
  npm run build && node dist/cli.js export          A JSON y CSV
  npm run build && node dist/cli.js backup          Copia de seguridad

  Tiendas: ${config.stores.filter((s) => s.enabled).map((s) => s.slug).join(', ')}
  Datos en: ${DEFAULT_DB_PATH}
`);
}

if (command !== 'serve') db.close();

function pad(value: string, width: number): string {
  const s = String(value ?? '');
  return (s.length > width - 1 ? s.slice(0, width - 2) + '…' : s).padEnd(width);
}

function money(n: number | null | undefined): string {
  return n == null ? '—' : `Bs ${Math.round(n)}`;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
