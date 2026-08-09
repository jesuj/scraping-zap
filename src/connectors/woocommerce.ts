/**
 * Conector para WooCommerce (TAF Bolivia).
 *
 * La API REST de esta tienda esta cerrada (401), pero no hace falta: WooCommerce
 * embebe las variantes de cada producto variable en el propio HTML del listado,
 * dentro del atributo `data-product_variations` como JSON.
 *
 * Ese JSON es la mejor fuente de las cuatro tiendas: trae `max_qty`, la
 * CANTIDAD EXACTA de stock, que ni VTEX ni Magento publican.
 *
 * Punto fragil, y hay que ser honesto: esto depende del marcado de la tienda,
 * no de un contrato de API. Si TAF rehace su plantilla, este conector se rompe.
 * Por eso se emiten avisos en vez de fallar en silencio.
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
import { decodeEntities } from '../domain/html.js';

interface WooVariation {
  variation_id?: number;
  sku?: string;
  attributes?: Record<string, string>;
  display_price?: number;
  display_regular_price?: number;
  is_in_stock?: boolean;
  max_qty?: number | '';
  image?: { url?: string; src?: string };
}

export class WooCommerceConnector implements StoreConnector {
  readonly store: StoreConfig;
  #http: HttpClient;
  #opts: ConnectorOptions;
  #endpoints: string[] = [];
  #warnings: string[] = [];

  constructor(store: StoreConfig, http: HttpClient, opts: ConnectorOptions) {
    if (!store.woocommerce) {
      throw new Error(`La tienda "${store.slug}" no tiene bloque "woocommerce".`);
    }
    this.store = store;
    this.#http = http;
    this.#opts = opts;
  }

  async fetchFootwear(onProgress?: (msg: string) => void): Promise<ScrapeResult> {
    const cfg = this.store.woocommerce!;
    const byId = new Map<string, ScrapedProduct>();

    // Primero el mapa de marcas: la tarjeta del listado no la incluye, pero la
    // tienda tiene un archivo por marca del que se puede deducir.
    const brandByUrl = await this.#buildBrandMap(onProgress);

    for (const category of cfg.categories) {
      let fetched = 0;
      for (let page = 1; page <= cfg.maxPages; page++) {
        const url =
          page === 1
            ? `${this.store.baseUrl}${category.path}`
            : `${this.store.baseUrl}${category.path}page/${page}/`;

        let html: string;
        try {
          html = await this.#http.getText(url);
        } catch {
          break; // La ultima pagina + 1 devuelve 404: es la senal de fin.
        }
        if (this.#endpoints.length < 50) this.#endpoints.push(url);

        const products = this.#parsePage(html, cfg.sizeAttribute);
        if (products.length === 0) break;

        for (const p of products) {
          if (byId.has(p.externalId)) continue;
          p.brand = brandByUrl.get(normalizeUrl(p.url)) ?? null;
          byId.set(p.externalId, p);
        }
        fetched += products.length;
        onProgress?.(`  ${this.store.slug} · ${category.label}: ${fetched} productos`);
      }
    }

    return {
      products: [...byId.values()],
      endpoints: this.#endpoints,
      requestCount: this.#http.requestCount,
      warnings: this.#warnings,
    };
  }

  /**
   * Recorre los archivos de marca quedandose solo con las URLs de producto.
   * Es barato: no hace falta parsear variantes, solo enlaces.
   */
  async #buildBrandMap(onProgress?: (msg: string) => void): Promise<Map<string, string>> {
    const cfg = this.store.woocommerce!;
    const map = new Map<string, string>();
    if (!cfg.brandArchives?.length) return map;

    for (const archive of cfg.brandArchives) {
      for (let page = 1; page <= cfg.maxPages; page++) {
        const url =
          page === 1
            ? `${this.store.baseUrl}${archive.path}`
            : `${this.store.baseUrl}${archive.path}page/${page}/`;

        let html: string;
        try {
          html = await this.#http.getText(url);
        } catch {
          break;
        }

        const links = [
          ...new Set(
            [...html.matchAll(/href="(https:\/\/[^"]*\/tienda\/[^"?#]+)"/g)].map((m) => m[1]!),
          ),
        ];
        if (links.length === 0) break;

        const before = map.size;
        for (const link of links) map.set(normalizeUrl(link), archive.brand);
        onProgress?.(`  ${this.store.slug} · marcas: ${map.size} productos mapeados`);

        // Si la pagina no aporta URLs nuevas, la paginacion ya se repite.
        if (map.size === before) break;
      }
    }
    return map;
  }

  /** Recorre las tarjetas del listado extrayendo el JSON de variantes de cada una. */
  #parsePage(html: string, sizeAttribute: string): ScrapedProduct[] {
    const out: ScrapedProduct[] = [];
    const blocks = [...html.matchAll(/data-product_variations="([^"]*)"/g)];

    for (const block of blocks) {
      const json = decodeEntities(block[1] ?? '');
      let variations: unknown;
      try {
        variations = JSON.parse(json);
      } catch {
        continue;
      }
      // WooCommerce pone `false` cuando hay demasiadas variantes para embeberlas.
      if (!Array.isArray(variations)) {
        this.#warnings.push('Un producto no trae sus variantes embebidas (demasiadas)');
        continue;
      }

      const context = html.slice(Math.max(0, (block.index ?? 0) - 6000), block.index ?? 0);
      const product = this.#toProduct(variations as WooVariation[], context, sizeAttribute);
      if (product) out.push(product);
    }
    return out;
  }

  #toProduct(
    variations: WooVariation[],
    context: string,
    sizeAttribute: string,
  ): ScrapedProduct | null {
    if (variations.length === 0) return null;

    // El enlace y el titulo del producto estan justo antes del bloque de variantes.
    const links = [...context.matchAll(/href="(https:\/\/[^"]*\/producto\/[^"]+)"/g)];
    const url = links.at(-1)?.[1] ?? lastMatch(context, /href="(https:\/\/taf\.com\.bo\/[^"?#]+)"/g);
    const name =
      lastMatch(context, /<h2[^>]*>([^<]{3,120})<\/h2>/g) ??
      lastMatch(context, /aria-label="([^"]{3,120})"/g) ??
      lastMatch(context, /alt="([^"]{3,120})"/g);

    if (!url || !name) {
      this.#warnings.push('Tarjeta sin nombre o URL reconocible');
      return null;
    }

    // WooCommerce convierte el color del fabricante en slug: "396463-23".
    const colorCode = variations[0]?.attributes?.['attribute_pa_color'] ?? null;
    const externalId = colorCode ?? String(variations[0]?.variation_id ?? url);

    const skus: ScrapedSku[] = [];
    for (const v of variations) {
      const raw = v.attributes?.[sizeAttribute];
      if (!raw) continue;

      // "11-5" es como WooCommerce escribe "11.5" al convertirlo en slug.
      const sizeLabel = String(raw).replace('-', '.').trim();
      const available = v.is_in_stock === true;
      const qty = typeof v.max_qty === 'number' ? v.max_qty : 0;

      skus.push({
        externalId: String(v.variation_id ?? `${externalId}-${sizeLabel}`),
        sizeLabel,
        ean: v.sku ?? null,
        imageUrl: v.image?.url ?? v.image?.src ?? null,
        url,
        offer: {
          price: positive(v.display_price),
          listPrice: positive(v.display_regular_price),
          available,
          stock: available ? Math.max(qty, 1) : 0,
          // `max_qty` es la cantidad real: no hay tope que declarar.
          stockIsCapped: false,
          seller: this.store.name,
        },
      });
    }

    if (skus.length === 0) return null;

    return {
      externalId,
      refCode: colorCode,
      name: decodeEntities(name).trim(),
      brand: null,
      gender: null,
      sport: null,
      categoryPath: null,
      url,
      imageUrl: skus.find((s) => s.imageUrl)?.imageUrl ?? null,
      skus,
    };
  }
}

function positive(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function lastMatch(text: string, re: RegExp): string | null {
  const all = [...text.matchAll(re)];
  return all.at(-1)?.[1] ?? null;
}

/** Iguala URLs que solo difieren en la barra final o el protocolo. */
function normalizeUrl(url: string): string {
  return url.replace(/^https?:/, '').replace(/\/+$/, '').toLowerCase();
}

