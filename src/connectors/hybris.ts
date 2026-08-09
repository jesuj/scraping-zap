/**
 * Conector para SAP Hybris (Marathon Bolivia).
 *
 * Marathon es el caso mas particular de los cuatro. Su ficha de producto NO
 * publica las tallas en el HTML: el selector se arma por JavaScript, asi que
 * leer cada producto no sirve de nada sin un navegador.
 *
 * La salida es darlo vuelta: el listado acepta facetas y una de ellas es la
 * talla, con el genero incluido en el valor:
 *
 *   /bo/productos/c/marathonProducts?device=DESKTOP&q=:relevance:sizeFootwear:H|11
 *
 * "H|11" = hombre, talla 11 US. Es decir, la tienda filtra por talla y por
 * genero del lado del servidor, y todo lo que devuelve ya esta disponible en
 * esa talla. Se consulta una vez por talla objetivo en lugar de recorrer el
 * catalogo entero, lo que ademas es mucho mas liviano para la tienda.
 *
 * Limitacion honesta: al no haber pagina de variante, no hay cantidad de stock.
 * Aparecer bajo la faceta significa "disponible", nada mas. Se refleja con
 * `stockIsCapped`.
 *
 * El parametro `device=DESKTOP` es obligatorio: sin el, la tienda responde con
 * un redirect por JavaScript en vez del contenido.
 */

import type {
  ConnectorOptions,
  ScrapeResult,
  ScrapedProduct,
  StoreConfig,
  StoreConnector,
} from '../domain/types.js';
import type { HttpClient } from '../infra/http.js';
import { decodeEntities } from '../domain/html.js';

interface CardInfo {
  name?: string;
  id?: string;
  price?: string;
  brand?: string;
  category?: string;
  variant?: string;
}

export class HybrisConnector implements StoreConnector {
  readonly store: StoreConfig;
  #http: HttpClient;
  #opts: ConnectorOptions;
  #endpoints: string[] = [];
  #warnings: string[] = [];

  constructor(store: StoreConfig, http: HttpClient, opts: ConnectorOptions) {
    if (!store.hybris) throw new Error(`La tienda "${store.slug}" no tiene bloque "hybris".`);
    this.store = store;
    this.#http = http;
    this.#opts = opts;
  }

  async fetchFootwear(onProgress?: (msg: string) => void): Promise<ScrapeResult> {
    const cfg = this.store.hybris!;
    // Clave: producto + talla, porque el mismo producto aparece en varias tallas.
    const byId = new Map<string, ScrapedProduct>();

    for (const size of this.#opts.targetSizes) {
      let found = 0;
      for (let page = 0; page < cfg.maxPages; page++) {
        const facet = `:relevance:${cfg.sizeFacet}:${cfg.genderPrefix}|${size}`;
        const url =
          `${this.store.baseUrl}${cfg.listPath}` +
          `?device=DESKTOP&q=${encodeURIComponent(facet)}&page=${page}`;

        let html: string;
        try {
          html = await this.#http.getText(url);
        } catch {
          break;
        }
        if (this.#endpoints.length < 50) this.#endpoints.push(url);

        const cards = this.#parseCards(html, size);
        if (cards.length === 0) break;

        let nuevos = 0;
        for (const p of cards) {
          const existing = byId.get(p.externalId);
          if (!existing) {
            byId.set(p.externalId, p);
            nuevos++;
            continue;
          }
          // El mismo producto reaparece en cada talla donde hay stock. Hay que
          // sumarle el SKU nuevo, no descartarlo: si no, un zapato disponible
          // en 11 y en 12 quedaria registrado en una sola talla.
          for (const sku of p.skus) {
            if (!existing.skus.some((s) => s.externalId === sku.externalId)) {
              existing.skus.push(sku);
              nuevos++;
            }
          }
        }
        found += cards.length;
        onProgress?.(`  ${this.store.slug} · talla ${size}: ${found} resultados`);

        // Si una pagina entera no aporta nada nuevo, la paginacion se repite.
        if (nuevos === 0) break;
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
   * Cada tarjeta del listado lleva sus datos en `data-product-info`, un JSON
   * entre comillas SIMPLES (por eso no se puede reusar el patron de otros sitios).
   */
  #parseCards(html: string, sizeLabel: string): ScrapedProduct[] {
    const out: ScrapedProduct[] = [];
    const seen = new Set<string>();

    for (const m of html.matchAll(/data-product-info='(\{[^']*\})'/g)) {
      let info: CardInfo;
      try {
        info = JSON.parse(m[1] ?? '') as CardInfo;
      } catch {
        continue;
      }
      if (!info.id || !info.name) continue;
      // El mismo producto aparece dos veces por tarjeta (imagen y detalle).
      if (seen.has(info.id)) continue;
      seen.add(info.id);

      const context = html.slice(m.index ?? 0, (m.index ?? 0) + 2500);
      const path = /href="(\/bo\/productos\/[^"]*\/p\/[A-Za-z0-9_]+)"/.exec(context)?.[1]
        ?? /href="(\/bo\/productos\/[^"]*\/p\/[A-Za-z0-9_]+)"/.exec(
             html.slice(Math.max(0, (m.index ?? 0) - 1200), m.index ?? 0),
           )?.[1];
      const image = /data-src="(\/\/media\.marathon\.store\/[^"]+)"/.exec(context)?.[1]
        ?? /src="(\/\/media\.marathon\.store\/[^"]+)"/.exec(context)?.[1];

      if (!path) {
        this.#warnings.push(`Tarjeta ${info.id} sin URL de producto`);
        continue;
      }

      const url = `${this.store.baseUrl}${path}`;
      const price = Number(info.price);
      const imageUrl = image ? `https:${image}` : null;

      out.push({
        externalId: info.id,
        // Hybris no expone el codigo del fabricante en el listado; su codigo
        // interno no sirve para cruzar con otras tiendas, asi que el cruce de
        // Marathon cae en marca + nombre (ver domain/matching.ts).
        refCode: null,
        name: decodeEntities(info.name),
        brand: info.brand ?? null,
        gender: 'HOMBRE',
        sport: info.category ?? null,
        categoryPath: info.category ?? null,
        url,
        imageUrl,
        skus: [
          {
            // La talla forma parte de la identidad: el listado se consulta una
            // vez por talla y el producto aparece en cada una donde hay stock.
            externalId: `${info.id}-${sizeLabel}`,
            sizeLabel,
            ean: null,
            imageUrl,
            url,
            offer: {
              price: Number.isFinite(price) && price > 0 ? price : null,
              // El listado no muestra precio tachado: no se inventa un descuento.
              listPrice: null,
              available: true,
              stock: 1,
              // Aparecer bajo la faceta significa "hay", no "hay uno".
              stockIsCapped: true,
              seller: this.store.name,
            },
          },
        ],
      });
    }
    return out;
  }
}
