/**
 * Registro de conectores por plataforma.
 *
 * Para soportar una tienda que NO sea VTEX (Shopify, WooCommerce, HTML plano)
 * se implementa `StoreConnector` en un archivo nuevo y se registra aca.
 * Nada mas del sistema cambia.
 */

import type { ConnectorOptions, StoreConfig, StoreConnector } from '../domain/types.js';
import type { HttpClient } from '../infra/http.js';
import { VtexConnector } from './vtex.js';
import { MagentoConnector } from './magento.js';
import { WooCommerceConnector } from './woocommerce.js';
import { HybrisConnector } from './hybris.js';

type Factory = (store: StoreConfig, http: HttpClient, opts: ConnectorOptions) => StoreConnector;

const REGISTRY: Record<string, Factory> = {
  vtex: (store, http, opts) => new VtexConnector(store, http, opts),
  magento: (store, http, opts) => new MagentoConnector(store, http, opts),
  woocommerce: (store, http, opts) => new WooCommerceConnector(store, http, opts),
  hybris: (store, http, opts) => new HybrisConnector(store, http, opts),
};

export function createConnector(
  store: StoreConfig,
  http: HttpClient,
  opts: ConnectorOptions,
): StoreConnector {
  const factory = REGISTRY[store.platform];
  if (!factory) {
    throw new Error(
      `Plataforma "${store.platform}" desconocida para la tienda "${store.slug}". ` +
        `Disponibles: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return factory(store, http, opts);
}
