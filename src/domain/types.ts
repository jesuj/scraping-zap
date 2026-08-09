/** Modelo de dominio, independiente de la plataforma de cada tienda. */

export interface StoreConfig {
  slug: string;
  name: string;
  enabled: boolean;
  platform: string;
  baseUrl: string;
  currency: string;

  /** Fair Play, Yuth. Catalogo JSON publico. */
  vtex?: {
    sizeFieldName: string;
    categories: Array<{ path: string; label: string }>;
  };

  /** Impulse. GraphQL de Magento. */
  magento?: {
    graphqlPath: string;
    sizeAttribute: string;
    categories: Array<{ id: string; label: string }>;
  };

  /** TAF. WooCommerce, con las variantes embebidas en el HTML. */
  woocommerce?: {
    sizeAttribute: string;
    categories: Array<{ path: string; label: string }>;
    /**
     * Archivos de marca. La tarjeta del listado no dice la marca, asi que se
     * recorren estas paginas primero para construir un mapa URL -> marca.
     */
    brandArchives?: Array<{ path: string; brand: string }>;
    maxPages: number;
  };

  /**
   * Marathon. SAP Hybris. Filtra por talla y genero del lado del servidor
   * mediante facetas, asi que el conector necesita las tallas objetivo.
   */
  hybris?: {
    listPath: string;
    sizeFacet: string;
    /** Prefijo de genero en el valor de la faceta: "H|11" = hombre, talla 11. */
    genderPrefix: string;
    maxPages: number;
  };
}

/** Lo que el orquestador entrega a cada conector. */
export interface ConnectorOptions {
  pageSize: number;
  /** Etiquetas de talla buscadas. Los conectores que filtran del lado del
   *  servidor las usan; los demas devuelven todo y filtra el pipeline. */
  targetSizes: string[];
}

export interface AppConfig {
  targetSizes: { system: string; labels: string[]; footLengthCm: number };
  scrape: {
    pageSize: number;
    concurrency: number;
    minDelayMs: number;
    requestTimeoutMs: number;
    maxRetries: number;
    userAgent: string;
  };
  stores: StoreConfig[];
  web: { port: number; host: string };
}

/** Un producto tal como lo entrega un conector, ya normalizado. */
export interface ScrapedProduct {
  externalId: string;
  /** Codigo de fabricante (ej. "HQ4484"). Es la clave que permite cruzar tiendas. */
  refCode: string | null;
  name: string;
  brand: string | null;
  gender: string | null;
  sport: string | null;
  categoryPath: string | null;
  url: string;
  imageUrl: string | null;
  skus: ScrapedSku[];
}

/** Un SKU = una talla concreta, con su propio precio y stock. */
export interface ScrapedSku {
  externalId: string;
  sizeLabel: string;
  ean: string | null;
  imageUrl: string | null;
  url: string;
  offer: ScrapedOffer;
}

export interface ScrapedOffer {
  /** Precio de venta actual. */
  price: number | null;
  /** Precio de lista / tachado. */
  listPrice: number | null;
  available: boolean;
  /**
   * Stock informado. VTEX lo devuelve topado: 1..9 son reales, 10 y 100 son topes.
   * Ver `stockIsCapped`.
   */
  stock: number;
  stockIsCapped: boolean;
  seller: string | null;
}

/** Lo que devuelve un conector tras recorrer una tienda. */
export interface ScrapeResult {
  products: ScrapedProduct[];
  /** Trazabilidad: endpoints exactos que se consultaron. */
  endpoints: string[];
  requestCount: number;
  warnings: string[];
}

export interface StoreConnector {
  readonly store: StoreConfig;
  /** Recorre el catalogo de calzado de la tienda. */
  fetchFootwear(onProgress?: (msg: string) => void): Promise<ScrapeResult>;
}
