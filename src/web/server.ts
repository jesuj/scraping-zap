/**
 * Servidor web: API JSON + la SPA estatica.
 *
 * Usa solo `node:http`. Para el volumen de este proyecto (unos miles de SKUs)
 * un framework seria peso muerto: cero dependencias significa que esto arranca
 * en cualquier lado sin instalar nada.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../infra/db.js';
import {
  crossStoreComparison,
  facets,
  listRuns,
  queryOffers,
  recentPriceDrops,
  skuDetail,
  skuHistory,
  stats,
  type OfferFilters,
} from '../pipeline/analytics.js';
import type { AppConfig } from '../domain/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function startServer(db: Db, config: AppConfig): void {
  const server = createServer((req, res) => {
    try {
      handle(req, res, db, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  error en ${req.method} ${req.url}: ${message}`);

      // Si la respuesta ya empezo a salir, no se puede cambiar el estado:
      // intentarlo lanza ERR_HTTP_HEADERS_SENT y tumba el proceso entero.
      // Lo unico correcto es cortar la conexion.
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: message });
    }
  });

  // Ultima red de seguridad: una peticion con problemas nunca debe matar
  // el servidor. Sin esto, cualquier error no capturado deja la web caida.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // Sin esto, un puerto ocupado revienta con un stack trace de node:net.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  El puerto ${config.web.port} ya esta en uso.\n\n` +
          `  Suele ser otra copia de este mismo servidor. Para verla y cerrarla:\n` +
          `    ss -lptn 'sport = :${config.web.port}'\n` +
          `    pkill -f "dist/cli.js serve"\n\n` +
          `  O usa otro puerto:\n` +
          `    PORT=4322 npm run serve\n`,
      );
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`\n  Sin permiso para abrir el puerto ${config.web.port}.`);
      console.error(`  Los puertos por debajo de 1024 requieren privilegios: usa uno mas alto.\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(config.web.port, config.web.host, () => {
    console.log(`\n  Interfaz lista en http://${config.web.host}:${config.web.port}\n`);
    console.log('  Ctrl+C para detener.\n');
  });

  // Ctrl+C cierra el servidor y la base de datos de forma ordenada.
  process.on('SIGINT', () => {
    console.log('\n  Cerrando…');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

function handle(req: IncomingMessage, res: ServerResponse, db: Db, config: AppConfig): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/api/offers') {
    return sendJson(res, 200, { offers: queryOffers(db, parseFilters(url)) });
  }

  if (path === '/api/facets') {
    return sendJson(res, 200, facets(db, url.searchParams.get('inStock') !== '0'));
  }

  if (path === '/api/stats') {
    return sendJson(res, 200, { ...stats(db), targetSizes: config.targetSizes });
  }

  if (path === '/api/compare') {
    const mode = url.searchParams.get('mode') === 'model' ? 'model' : 'exact';
    return sendJson(res, 200, {
      mode,
      comparisons: crossStoreComparison(db, url.searchParams.get('inStock') !== '0', mode),
    });
  }

  if (path === '/api/drops') {
    const hours = Number(url.searchParams.get('hours') ?? 168);
    return sendJson(res, 200, { drops: recentPriceDrops(db, Number.isFinite(hours) ? hours : 168) });
  }

  if (path === '/api/runs') {
    return sendJson(res, 200, { runs: listRuns(db, 100) });
  }

  const skuMatch = path.match(/^\/api\/sku\/(\d+)$/);
  if (skuMatch) {
    const skuId = Number(skuMatch[1]);
    const detail = skuDetail(db, skuId);
    if (!detail) return sendJson(res, 404, { error: 'SKU no encontrado' });
    return sendJson(res, 200, { ...detail, history: skuHistory(db, skuId) });
  }

  // Una ruta /api/ desconocida es un error de cliente, no un archivo faltante.
  if (path.startsWith('/api/')) {
    return sendJson(res, 404, { error: `Endpoint desconocido: ${path}` });
  }

  return serveStatic(res, path === '/' ? '/index.html' : path);
}

function parseFilters(url: URL): OfferFilters {
  const q = url.searchParams;
  const num = (key: string): number | undefined => {
    const raw = q.get(key);
    if (raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    inStockOnly: q.get('inStock') !== '0',
    store: q.get('store') || undefined,
    brand: q.get('brand') || undefined,
    sizes: q.get('sizes')?.split(',').filter(Boolean),
    minPrice: num('minPrice'),
    maxPrice: num('maxPrice'),
    onlyDiscounted: q.get('discounted') === '1',
    search: q.get('q') || undefined,
    sort: q.get('sort') || undefined,
    limit: num('limit') ?? 500,
    offset: num('offset') ?? 0,
  };
}

function serveStatic(res: ServerResponse, path: string): void {
  // Solo se sirven archivos del directorio public; se corta cualquier travesia.
  const safe = path.replace(/\.\./g, '').replace(/^\/+/, '');
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Prohibido');
    return;
  }

  // Leer ANTES de escribir la cabecera. Al reves, un archivo inexistente
  // (el /favicon.ico que pide el navegador solo) dejaba la respuesta a medias
  // y el manejo del error ya no podia cambiar el codigo de estado.
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
    return;
  }

  const ext = safe.slice(safe.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Sin esto el navegador cachea el HTML y seguis viendo la version anterior
    // despues de editar la interfaz.
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}
