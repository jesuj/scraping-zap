import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './domain/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..');

export const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, 'config', 'config.json');
export const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data', 'zapatillas.db');

export function loadConfig(path = DEFAULT_CONFIG_PATH): AppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  validate(raw, path);
  applyEnvOverrides(raw);
  return raw;
}

/** Permite cambiar puerto y host sin editar el archivo de config. */
function applyEnvOverrides(cfg: AppConfig): void {
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0 && port < 65536) cfg.web.port = port;
  if (process.env.HOST) cfg.web.host = process.env.HOST;
}

function validate(cfg: AppConfig, path: string): void {
  const fail = (msg: string): never => {
    throw new Error(`Configuracion invalida en ${path}: ${msg}`);
  };

  if (!cfg.targetSizes?.labels?.length) fail('targetSizes.labels esta vacio');
  if (!Array.isArray(cfg.stores) || cfg.stores.length === 0) fail('no hay tiendas definidas');

  const seen = new Set<string>();
  for (const store of cfg.stores) {
    if (!store.slug) fail('una tienda no tiene "slug"');
    if (seen.has(store.slug)) fail(`slug duplicado: "${store.slug}"`);
    seen.add(store.slug);
    if (!store.baseUrl?.startsWith('http')) fail(`baseUrl invalida en "${store.slug}"`);
    if (store.platform === 'vtex' && !store.vtex?.categories?.length) {
      fail(`la tienda VTEX "${store.slug}" no tiene categorias configuradas`);
    }
  }

  if (cfg.scrape.concurrency < 1) fail('scrape.concurrency debe ser >= 1');
  if (cfg.scrape.pageSize < 1) fail('scrape.pageSize debe ser >= 1');
}
