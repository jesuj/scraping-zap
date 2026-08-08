/**
 * Cliente HTTP para scraping: reintentos con backoff exponencial + jitter,
 * limite de concurrencia y espaciado minimo entre peticiones.
 *
 * Se separa del conector a proposito: cualquier tienda nueva hereda el mismo
 * comportamiento de red sin reimplementarlo.
 */

export interface HttpOptions {
  userAgent: string;
  timeoutMs: number;
  maxRetries: number;
  minDelayMs: number;
  concurrency: number;
}

export class HttpClient {
  #opts: HttpOptions;
  #inFlight = 0;
  #queue: Array<() => void> = [];
  #lastRequestAt = 0;
  requestCount = 0;

  constructor(opts: HttpOptions) {
    this.#opts = opts;
  }

  async getJson<T>(url: string): Promise<T> {
    return this.#withSlot(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.#opts.maxRetries; attempt++) {
        if (attempt > 0) await sleep(backoffMs(attempt));
        await this.#respectRateLimit();
        try {
          const res = await this.#fetchOnce(url);
          // 429/5xx son transitorios: reintentar. 4xx restantes son definitivos.
          if (res.status === 429 || res.status >= 500) {
            lastError = new Error(`HTTP ${res.status} en ${url}`);
            const retryAfter = Number(res.headers.get('retry-after'));
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              await sleep(Math.min(retryAfter * 1000, 30_000));
            }
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
          return (await res.json()) as T;
        } catch (err) {
          lastError = err;
          if (err instanceof Error && err.name === 'AbortError') continue;
          if (attempt === this.#opts.maxRetries) break;
        }
      }
      throw new Error(
        `Fallo tras ${this.#opts.maxRetries + 1} intentos: ${url} (${describeError(lastError)})`,
      );
    });
  }

  async #fetchOnce(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#opts.timeoutMs);
    try {
      this.requestCount++;
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': this.#opts.userAgent,
          accept: 'application/json',
          'accept-language': 'es-BO,es;q=0.9',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Espaciado minimo global entre peticiones, para no golpear la tienda. */
  async #respectRateLimit(): Promise<void> {
    const wait = this.#lastRequestAt + this.#opts.minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastRequestAt = Date.now();
  }

  /** Semaforo de concurrencia. */
  async #withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.#opts.concurrency) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#inFlight++;
    try {
      return await fn();
    } finally {
      this.#inFlight--;
      this.#queue.shift()?.();
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return base + Math.random() * 400; // jitter para no sincronizar reintentos
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
