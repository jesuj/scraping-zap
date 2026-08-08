-- Vista plana: una fila por SKU con todo lo necesario para la web y los reportes.
-- Se recrea en cada arranque (no guarda datos) para que agregar columnas no
-- requiera migrar nada a mano.
DROP VIEW IF EXISTS v_offer;
CREATE VIEW v_offer AS
SELECT
  s.id                AS sku_id,
  st.slug             AS store_slug,
  st.name             AS store_name,
  st.base_url         AS store_url,
  st.currency         AS currency,
  p.id                AS product_id,
  p.name              AS product_name,
  p.brand             AS brand,
  p.gender            AS gender,
  p.sport             AS sport,
  p.category_path     AS category_path,
  p.ref_code          AS ref_code,
  p.match_key         AS match_key,
  p.model_key         AS model_key,
  p.url               AS product_url,
  COALESCE(s.image_url, p.image_url) AS image_url,
  s.size_label        AS size_label,
  s.size_us           AS size_us,
  s.size_cm           AS size_cm,
  s.url               AS sku_url,
  s.ean               AS ean,
  ss.price            AS price,
  ss.list_price       AS list_price,
  ss.available        AS available,
  ss.stock            AS stock,
  ss.stock_is_capped  AS stock_is_capped,
  ss.seller           AS seller,
  ss.prev_price       AS prev_price,
  ss.prev_price_at    AS prev_price_at,
  ss.min_price_ever   AS min_price_ever,
  ss.max_price_ever   AS max_price_ever,
  ss.first_price      AS first_price,
  ss.observation_count AS observation_count,
  ss.observed_at      AS observed_at,
  ss.last_run_id      AS run_id,
  r.started_at        AS run_started_at,
  s.first_seen_at     AS sku_first_seen_at
FROM sku s
JOIN product   p  ON p.id = s.product_id
JOIN store     st ON st.id = p.store_id
JOIN sku_state ss ON ss.sku_id = s.id
JOIN run       r  ON r.id = ss.last_run_id;
