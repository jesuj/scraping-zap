-- Esquema del almacen de datos.
--
-- Dos decisiones centrales:
--
-- 1) HISTORIAL POR CAMBIO, no por corrida. `price_point` solo recibe una fila
--    cuando el precio, la disponibilidad o el stock cambian respecto de la
--    ultima observacion. Asi el historial de anos ocupa poco y las consultas
--    "que cambio" son directas.
--
-- 2) TRAZABILIDAD COMPLETA. Cada fila de precio apunta a la corrida (`run`) que
--    la produjo, y cada corrida guarda la tienda, los endpoints exactos
--    consultados y la marca de tiempo. Siempre se puede responder
--    "de donde salio este dato".

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS store (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  platform   TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'BOB'
);

-- Una corrida de extraccion. Es el registro de procedencia.
CREATE TABLE IF NOT EXISTS run (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id          INTEGER NOT NULL REFERENCES store(id),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,              -- running | ok | error
  request_count     INTEGER NOT NULL DEFAULT 0,
  products_found    INTEGER NOT NULL DEFAULT 0, -- productos de calzado vistos
  skus_found        INTEGER NOT NULL DEFAULT 0, -- SKUs totales vistos
  skus_target_size  INTEGER NOT NULL DEFAULT 0, -- SKUs en las tallas objetivo
  skus_in_stock     INTEGER NOT NULL DEFAULT 0, -- de esos, con stock
  price_changes     INTEGER NOT NULL DEFAULT 0, -- filas nuevas en price_point
  endpoints         TEXT,                       -- JSON: endpoints consultados
  error_message     TEXT,
  duration_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_store_started ON run(store_id, started_at DESC);

CREATE TABLE IF NOT EXISTS product (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES store(id),
  external_id   TEXT NOT NULL,
  ref_code      TEXT,
  ref_norm      TEXT,          -- refCode normalizado: clave de cruce entre tiendas
  match_key     TEXT NOT NULL, -- clave exacta: mismo modelo Y mismo color
  match_strength TEXT NOT NULL,
  model_key     TEXT,          -- clave laxa: mismo modelo, cualquier color
  name          TEXT NOT NULL,
  brand         TEXT,
  gender        TEXT,
  sport         TEXT,
  category_path TEXT,
  url           TEXT NOT NULL,
  image_url     TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE(store_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_product_match ON product(match_key);
CREATE INDEX IF NOT EXISTS idx_product_brand ON product(brand);
-- El indice de model_key se crea en la migracion, junto a su columna
-- (ver infra/db.ts): aca fallaria en bases creadas antes de esa columna.

-- Un SKU = una talla concreta de un producto.
CREATE TABLE IF NOT EXISTS sku (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  size_label    TEXT NOT NULL,
  size_us       REAL,
  size_cm       REAL,
  ean           TEXT,
  url           TEXT NOT NULL,
  image_url     TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE(product_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_sku_size ON sku(size_us);

-- Historial: una fila por CAMBIO observado.
CREATE TABLE IF NOT EXISTS price_point (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id          INTEGER NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  run_id          INTEGER NOT NULL REFERENCES run(id),
  observed_at     TEXT NOT NULL,
  price           REAL,
  list_price      REAL,
  available       INTEGER NOT NULL,
  stock           INTEGER NOT NULL,
  stock_is_capped INTEGER NOT NULL DEFAULT 0,
  seller          TEXT
);
CREATE INDEX IF NOT EXISTS idx_pp_sku_time ON price_point(sku_id, observed_at DESC);

-- Estado actual de cada SKU: evita recorrer el historial para pintar la web.
CREATE TABLE IF NOT EXISTS sku_state (
  sku_id            INTEGER PRIMARY KEY REFERENCES sku(id) ON DELETE CASCADE,
  last_run_id       INTEGER NOT NULL REFERENCES run(id),
  observed_at       TEXT NOT NULL,
  price             REAL,
  list_price        REAL,
  available         INTEGER NOT NULL,
  stock             INTEGER NOT NULL,
  stock_is_capped   INTEGER NOT NULL DEFAULT 0,
  seller            TEXT,
  -- Denormalizado desde el historial para ordenar y filtrar rapido.
  prev_price        REAL,
  prev_price_at     TEXT,
  min_price_ever    REAL,
  max_price_ever    REAL,
  first_price       REAL,
  observation_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_state_avail ON sku_state(available, price);
