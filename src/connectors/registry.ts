/**
 * Registro de conectores por plataforma.
 *
 * Para soportar una tienda que NO sea VTEX (Shopify, WooCommerce, HTML plano)
 * se implementa `StoreConnector` en un archivo nuevo y se registra aca.
 * Nada mas del sistema cambia.
 */

import type { StoreConfig, StoreConnector } from '../domain/types.js';
import type { HttpClient } from '../infra/http.js';
import { VtexConnector } from './vtex.js';

type Factory = (store: StoreConfig, http: HttpClient, pageSize: number) => StoreConnector;

const REGISTRY: Record<string, Factory> = {
  vtex: (store, http, pageSize) => new VtexConnector(store, http, pageSize),
};

export function createConnector(
  store: StoreConfig,
  http: HttpClient,
  pageSize: number,
): StoreConnector {
  const factory = REGISTRY[store.platform];
  if (!factory) {
    throw new Error(
      `Plataforma "${store.platform}" desconocida para la tienda "${store.slug}". ` +
        `Disponibles: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return factory(store, http, pageSize);
}
