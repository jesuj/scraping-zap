/**
 * Conector generico para tiendas VTEX.
 *
 * Fair Play y Yuth corren sobre VTEX, que expone un catalogo publico en JSON:
 *
 *   GET /api/catalog_system/pub/products/search?fq=C:/47/54/&_from=0&_to=49
 *
 * Esto evita por completo renderizar HTML o usar un navegador headless:
 * el JSON trae producto, cada talla como SKU independiente, precio, precio de
 * lista, stock e imagenes. Es mas rapido, mas estable y mucho menos fragil que
 * parsear el DOM (que cambia con cada rediseno del sitio).
 *
 * Cualquier otra tienda VTEX se agrega solo con configuracion.
 */

import type {
  ScrapeResult,
  ScrapedOffer,
  ScrapedProduct,
  ScrapedSku,
  StoreConfig,
  StoreConnector,
} from '../domain/types.js';
import type { HttpClient } from '../infra/http.js';

/** VTEX limita la ventana de paginacion a 50 elementos por peticion. */
const MAX_PAGE_SIZE = 50;
/** Corte de seguridad: si una categoria devuelve mas que esto, algo anda mal. */
const MAX_PRODUCTS_PER_CATEGORY = 20_000;

/** Valores de AvailableQuantity que VTEX usa como tope, no como stock real. */
const CAPPED_STOCK_VALUES = new Set([10, 100, 1000, 10000, 100000]);

interface VtexItem {
  itemId: string;
  name: string;
  nameComplete?: string;
  ean?: string | null;
  images?: Array<{ imageUrl?: string; imageText?: string }>;
  sellers?: Array<{
    sellerId: string;
    sellerName?: string;
    commertialOffer?: {
      Price?: number;
      ListPrice?: number;
      PriceWithoutDiscount?: number;
      AvailableQuantity?: number;
      IsAvailable?: boolean;
    };
  }>;
  [key: string]: unknown;
}

interface VtexProduct {
  productId: string;
  productName: string;
  brand?: string | null;
  productReference?: string | null;
  productReferenceCode?: string | null;
  link?: string;
  linkText?: string;
  categories?: string[];
  GENERO?: string[];
  DEPORTE?: string[];
  items?: VtexItem[];
}

export class VtexConnector implements StoreConnector {
  readonly store: StoreConfig;
  #http: HttpClient;
  #pageSize: number;
  #endpoints: string[] = [];
  #warnings: string[] = [];

  constructor(store: StoreConfig, http: HttpClient, pageSize: number) {
    if (!store.vtex) throw new Error(`La tienda "${store.slug}" no tiene bloque de config "vtex".`);
    this.store = store;
    this.#http = http;
    this.#pageSize = Math.min(pageSize, MAX_PAGE_SIZE);
  }

  async fetchFootwear(onProgress?: (msg: string) => void): Promise<ScrapeResult> {
    const cfg = this.store.vtex!;
    const byId = new Map<string, ScrapedProduct>();

    for (const category of cfg.categories) {
      let fetched = 0;
      for (let from = 0; from < MAX_PRODUCTS_PER_CATEGORY; from += this.#pageSize) {
        const to = from + this.#pageSize - 1;
        const url =
          `${this.store.baseUrl}/api/catalog_system/pub/products/search` +
          `?fq=C:${category.path}&_from=${from}&_to=${to}`;

        const page = await this.#http.getJson<VtexProduct[]>(url);
        if (this.#endpoints.length < 50) this.#endpoints.push(url);
        if (!Array.isArray(page) || page.length === 0) break;

        for (const raw of page) {
          const product = this.#toProduct(raw, cfg.sizeFieldName);
          // Un producto puede vivir en varias categorias; nos quedamos con una copia.
          if (product && !byId.has(product.externalId)) byId.set(product.externalId, product);
        }
        fetched += page.length;
        onProgress?.(`  ${this.store.slug} · ${category.label}: ${fetched} productos`);

        if (page.length < this.#pageSize) break;
      }
    }

    return {
      products: [...byId.values()],
      endpoints: this.#endpoints,
      requestCount: this.#http.requestCount,
      warnings: this.#warnings,
    };
  }

  #toProduct(raw: VtexProduct, sizeField: string): ScrapedProduct | null {
    if (!raw?.productId || !Array.isArray(raw.items)) return null;

    const url = raw.link ?? (raw.linkText ? `${this.store.baseUrl}/${raw.linkText}/p` : '');
    if (!url) {
      this.#warnings.push(`Producto ${raw.productId} sin URL resoluble`);
      return null;
    }

    const skus: ScrapedSku[] = [];
    for (const item of raw.items) {
      const sku = this.#toSku(item, sizeField, url);
      if (sku) skus.push(sku);
    }
    if (skus.length === 0) return null;

    return {
      externalId: String(raw.productId),
      refCode: raw.productReference ?? raw.productReferenceCode ?? null,
      name: raw.productName ?? '(sin nombre)',
      brand: raw.brand ?? null,
      gender: raw.GENERO?.[0] ?? null,
      sport: raw.DEPORTE?.[0] ?? null,
      categoryPath: raw.categories?.[0] ?? null,
      url,
      imageUrl: skus.find((s) => s.imageUrl)?.imageUrl ?? null,
      skus,
    };
  }

  #toSku(item: VtexItem, sizeField: string, productUrl: string): ScrapedSku | null {
    if (!item?.itemId) return null;

    // La talla viaja como propiedad dinamica del SKU, con el nombre de la
    // especificacion como clave (ej. item.TALLA === ["11.5"]).
    const rawSize = item[sizeField];
    const sizeLabel = Array.isArray(rawSize) ? String(rawSize[0] ?? '') : '';
    if (!sizeLabel) return null;

    // Se elige la mejor oferta disponible: primero las que tienen stock, luego precio menor.
    const offers = (item.sellers ?? [])
      .map((seller) => toOffer(seller))
      .filter((o): o is ScrapedOffer => o !== null);
    if (offers.length === 0) return null;

    offers.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return (a.price ?? Infinity) - (b.price ?? Infinity);
    });

    return {
      externalId: String(item.itemId),
      sizeLabel,
      ean: item.ean || null,
      imageUrl: item.images?.[0]?.imageUrl ?? null,
      url: `${productUrl}?skuId=${item.itemId}`,
      offer: offers[0]!,
    };
  }
}

function toOffer(seller: {
  sellerId: string;
  sellerName?: string;
  commertialOffer?: {
    Price?: number;
    ListPrice?: number;
    AvailableQuantity?: number;
    IsAvailable?: boolean;
  };
}): ScrapedOffer | null {
  const co = seller?.commertialOffer;
  if (!co) return null;

  const stock = Number(co.AvailableQuantity ?? 0);
  const price = numberOrNull(co.Price);
  const listPrice = numberOrNull(co.ListPrice);

  return {
    price,
    // Si no hay descuento, VTEX repite el precio; guardamos el mayor de los dos.
    listPrice: listPrice !== null && price !== null ? Math.max(listPrice, price) : listPrice,
    available: Boolean(co.IsAvailable) && stock > 0,
    stock,
    stockIsCapped: CAPPED_STOCK_VALUES.has(stock),
    seller: seller.sellerName ?? seller.sellerId ?? null,
  };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
