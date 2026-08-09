/**
 * Conector para tiendas Magento 2 con GraphQL publico (Impulse Bolivia).
 *
 *   POST /graphql  {"query":"{products(filter:{category_id:{eq:\"59\"}}){...}}"}
 *
 * Magento modela el calzado como "producto configurable" con una variante por
 * talla, igual que VTEX modela un SKU por talla. Cada variante trae su precio y
 * su estado de stock.
 *
 * Diferencia importante frente a VTEX: Magento expone `stock_status`
 * (IN_STOCK / OUT_OF_STOCK) pero no la cantidad. `only_x_left_in_stock` viene
 * vacio en esta tienda. Se reporta stock 1 como minimo positivo y se marca
 * `stockIsCapped`, para no inventar una cifra que la tienda no publica.
 */

import type {
  ConnectorOptions,
  ScrapeResult,
  ScrapedProduct,
  ScrapedSku,
  StoreConfig,
  StoreConnector,
} from '../domain/types.js';
import type { HttpClient } from '../infra/http.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 60;

const QUERY = `query Catalogo($cat: String!, $page: Int!, $size: Int!) {
  products(filter: { category_id: { eq: $cat } }, pageSize: $size, currentPage: $page) {
    total_count
    items {
      name sku url_key
      image { url }
      price_range { minimum_price { final_price { value } regular_price { value } } }
      ... on ConfigurableProduct {
        variants {
          attributes { code label }
          product {
            sku stock_status only_x_left_in_stock
            price_range { minimum_price { final_price { value } regular_price { value } } }
          }
        }
      }
    }
  }
}`;

interface GqlVariant {
  attributes?: Array<{ code: string; label: string }>;
  product?: {
    sku?: string;
    stock_status?: string;
    only_x_left_in_stock?: number | null;
    price_range?: PriceRange;
  };
}

interface PriceRange {
  minimum_price?: {
    final_price?: { value?: number | null };
    regular_price?: { value?: number | null };
  };
}

interface GqlProduct {
  name?: string;
  sku?: string;
  url_key?: string;
  image?: { url?: string };
  price_range?: PriceRange;
  variants?: GqlVariant[];
}

interface GqlResponse {
  data?: { products?: { total_count?: number; items?: GqlProduct[] } };
  errors?: Array<{ message?: string }>;
}

export class MagentoConnector implements StoreConnector {
  readonly store: StoreConfig;
  #http: HttpClient;
  #opts: ConnectorOptions;
  #endpoints: string[] = [];
  #warnings: string[] = [];

  constructor(store: StoreConfig, http: HttpClient, opts: ConnectorOptions) {
    if (!store.magento) throw new Error(`La tienda "${store.slug}" no tiene bloque "magento".`);
    this.store = store;
    this.#http = http;
    this.#opts = opts;
  }

  async fetchFootwear(onProgress?: (msg: string) => void): Promise<ScrapeResult> {
    const cfg = this.store.magento!;
    const url = `${this.store.baseUrl}${cfg.graphqlPath}`;
    const bySku = new Map<string, ScrapedProduct>();

    for (const category of cfg.categories) {
      let fetched = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await this.#post(url, {
          query: QUERY,
          variables: { cat: category.id, page, size: PAGE_SIZE },
        });

        if (body.errors?.length) {
          this.#warnings.push(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
          break;
        }
        const items = body.data?.products?.items ?? [];
        if (items.length === 0) break;

        if (this.#endpoints.length < 50) {
          this.#endpoints.push(`${url} [category_id=${category.id} page=${page}]`);
        }

        for (const raw of items) {
          const product = this.#toProduct(raw, cfg.sizeAttribute);
          if (product && !bySku.has(product.externalId)) bySku.set(product.externalId, product);
        }
        fetched += items.length;
        onProgress?.(`  ${this.store.slug} · ${category.label}: ${fetched} productos`);

        if (items.length < PAGE_SIZE) break;
      }
    }

    return {
      products: [...bySku.values()],
      endpoints: this.#endpoints,
      requestCount: this.#http.requestCount,
      warnings: this.#warnings,
    };
  }

  async #post(url: string, payload: unknown): Promise<GqlResponse> {
    return this.#http.postJson<GqlResponse>(url, payload);
  }

  #toProduct(raw: GqlProduct, sizeAttribute: string): ScrapedProduct | null {
    if (!raw?.sku || !raw.name) return null;

    const url = raw.url_key
      ? `${this.store.baseUrl}/${raw.url_key}.html`
      : `${this.store.baseUrl}/catalogsearch/result/?q=${encodeURIComponent(raw.sku)}`;

    const skus: ScrapedSku[] = [];
    for (const variant of raw.variants ?? []) {
      const sizeLabel = variant.attributes?.find((a) => a.code === sizeAttribute)?.label ?? '';
      const child = variant.product;
      if (!sizeLabel || !child?.sku) continue;

      const available = child.stock_status === 'IN_STOCK';
      // La tienda no publica cantidades: se usa 1 como "hay al menos uno".
      const stock = available ? (child.only_x_left_in_stock ?? 1) : 0;

      skus.push({
        externalId: child.sku,
        sizeLabel: String(sizeLabel).trim(),
        ean: null,
        imageUrl: raw.image?.url ?? null,
        url,
        offer: {
          price: price(child.price_range) ?? price(raw.price_range),
          listPrice: listPrice(child.price_range) ?? listPrice(raw.price_range),
          available,
          stock,
          // Sin cantidad real: se marca topado para no mostrar un numero falso.
          stockIsCapped: available && child.only_x_left_in_stock == null,
          seller: this.store.name,
        },
      });
    }

    if (skus.length === 0) return null;

    return {
      externalId: raw.sku,
      // En Magento el SKU del padre suele ser el codigo del fabricante,
      // que es justo la clave que permite cruzar contra las otras tiendas.
      refCode: raw.sku,
      name: raw.name,
      brand: brandFromName(raw.name),
      gender: null,
      sport: null,
      categoryPath: null,
      url,
      imageUrl: raw.image?.url ?? null,
      skus,
    };
  }
}

function price(range?: PriceRange): number | null {
  const v = range?.minimum_price?.final_price?.value;
  return typeof v === 'number' && v > 0 ? v : null;
}

function listPrice(range?: PriceRange): number | null {
  const v = range?.minimum_price?.regular_price?.value;
  return typeof v === 'number' && v > 0 ? v : null;
}

/**
 * Magento no expone la marca como atributo en esta tienda, pero los nombres
 * empiezan por ella ("SKECHERS Zapatilla Owen Hombre"). Se reconocen las marcas
 * conocidas del catalogo; si no hay coincidencia se deja null antes que adivinar.
 */
const BRANDS = [
  'SKECHERS', 'NIKE', 'ADIDAS', 'PUMA', 'NEW BALANCE', 'CONVERSE', 'REEBOK',
  'CAT', 'CATERPILLAR', 'TIMBERLAND', 'COLUMBIA', 'LEVIS', "LEVI'S", 'DKNY',
  'JORDAN', 'EVERLAST', 'VANS', 'FILA', 'UNDER ARMOUR', 'ON',
];

function brandFromName(name: string): string | null {
  const upper = name.toUpperCase();
  // Se prueba primero la coincidencia mas larga ("NEW BALANCE" antes que "NEW").
  const found = [...BRANDS]
    .sort((a, b) => b.length - a.length)
    .find((b) => upper.includes(b));
  return found ?? null;
}
