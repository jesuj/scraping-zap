# scraping-zap

Scraper de **calzado de hombre** en talla **US 11 / 11.5 / 12** para cinco tiendas
bolivianas, con historial de precios, comparación entre tiendas e interfaz web.

| Tienda | Plataforma | Cómo se obtienen los datos | Stock |
|---|---|---|---|
| [Fair Play](https://www.fairplay.com.bo/) | VTEX | API JSON pública | topado (0/1/10/100) |
| [Yuth](https://www.yuth.com.bo/) | VTEX | API JSON pública | topado (0/1/10/100) |
| [Impulse](https://impulse.bo/) | Magento | GraphQL público | solo sí/no |
| [TAF](https://taf.com.bo/) | WooCommerce | JSON embebido en el HTML | **cantidad exacta** |
| [Marathon](https://www.marathon.store/bo) | SAP Hybris | listado filtrado por faceta | solo sí/no |

Solo se recorre calzado de hombre. Para incluir mujer, agregá su categoría en
`config/config.json`.

## Empezar

```bash
npm install
npm run scrape    # extrae de ambas tiendas (~40s)
npm run serve     # abre http://127.0.0.1:4321
```

## Por qué TypeScript y no Python

La decisión no fue por gusto: **las dos tiendas corren sobre VTEX**, que expone su
catálogo como API JSON pública:

```
GET https://www.fairplay.com.bo/api/catalog_system/pub/products/search?fq=C:/47/54/&_from=0&_to=49
```

Eso cambia el problema por completo. No hay que renderizar HTML ni usar un navegador
headless: el JSON ya trae producto, **cada talla como SKU independiente** con su propio
precio y stock, imágenes y código de fabricante.

La ventaja de Python para scraping (BeautifulSoup, Scrapy, Selenium) es justamente parsear
HTML, y acá no hay HTML que parsear. Lo que queda es consumir JSON y servir una web —
terreno natural de TypeScript, con un solo lenguaje de punta a punta y tipado sobre
la respuesta de la API.

El catálogo completo son **34 peticiones y ~40 segundos**. Con un navegador headless
serían miles de páginas y horas.

### Dependencias: ninguna en runtime

| Necesidad | Solución | Por qué |
|---|---|---|
| HTTP | `fetch` nativo | Incluido en Node |
| Base de datos | `node:sqlite` | Incluido en Node 22.5+, sin compilar nada |
| Web | `node:http` + SPA | Un framework sería peso muerto para este volumen |

Solo hay dos dependencias de desarrollo: `typescript` y `@types/node`.

## Comandos

```bash
npm run scrape           # extrae y guarda el historial
npm run serve            # interfaz web
npm run report           # tabla en consola, lo disponible en tu talla
npm run compare          # mismo modelo y color en ambas tiendas
npm run build && node dist/cli.js compare model   # mismo modelo, cualquier color
npm run build && node dist/cli.js drops 720       # bajadas de las últimas N horas
npm run build && node dist/cli.js runs            # bitácora de extracciones
npm run build && node dist/cli.js export          # vuelca a JSON y CSV
```

### Si el puerto está ocupado

`npm run serve` usa el 4321. Si ya hay una copia corriendo:

```bash
pkill -f "dist/cli.js serve"
```

O levantalo en otro puerto:

```bash
PORT=4322 npm run serve
```

## Dónde se guardan los datos

Todo en un solo archivo SQLite: `data/zapatillas.db`. No hay servidor de base de datos
que instalar ni configurar — es un archivo que podés copiar, respaldar o borrar.

### Copias de seguridad

```bash
npm run build && node dist/cli.js backup
```

Deja una copia con fecha en `backups/`. Usa `VACUUM INTO`, que produce un archivo
consistente y compactado aunque haya escrituras en curso — copiar el `.db` a mano puede
dejar el WAL a medias y corromper la copia.

Para volver atrás:

```bash
cp backups/zapatillas-2026-08-09T01-06-00.db data/zapatillas.db
```

Si querés los datos en archivos planos, `export` genera:

- `export/zapatillas.json` — todo, incluida la procedencia
- `export/zapatillas.csv` — abrible en Excel (lleva BOM para los acentos)

## Cómo funciona el historial de precios

`price_point` recibe una fila **solo cuando algo cambia** (precio, precio de lista,
disponibilidad o stock). Correr el scraper dos veces seguidas sin cambios en origen
escribe cero filas — verificado.

Esto hace que años de corridas diarias ocupen poco, y que "¿qué bajó de precio?" sea
una consulta directa en vez de un diff sobre millones de filas.

La tabla `sku_state` mantiene el estado actual denormalizado (precio anterior, mínimo
y máximo histórico, número de observaciones) para que la web no tenga que recorrer el
historial en cada carga.

**Para que el historial sirva, el scraper tiene que correr periódicamente.** Una entrada
de cron diaria:

```
0 9 * * * cd /home/jesuz/proyect/scraping-zap && npm run scrape >> data/cron.log 2>&1
```

## Comparación entre tiendas

Ambas tiendas publican el `productReference` del fabricante, que es la clave de cruce.
Hay dos modos, y la diferencia importa:

**`exact`** — mismo modelo *y* mismo color (código completo, ej. `396464-01`).
Comparación estricta.

**`model`** — mismo modelo, **cualquier color**. Los proveedores codifican el color como
sufijo (`396464-07` = modelo `396464`, color `07`), así que agrupando por el código base
aparecen casos que la comparación exacta no ve:

```
PUMA PALERMO LTH talla 11
  yuth     Bs 599  (color -07)
  fairplay Bs 1049 (color -01)
  → Bs 450 de diferencia (42.9%) por el mismo modelo en otro color
```

## Sobre el stock

Cada tienda publica un nivel de detalle distinto, y el sistema **no los mezcla como si
fueran lo mismo**. La columna `stock_is_capped` marca cuándo la cifra no es exacta, y la
interfaz muestra `10+ pares` en lugar de inventar un número.

- **TAF** es la única que da la **cantidad real** (`max_qty`). Su `stock: 2` significa dos pares.
- **Fair Play y Yuth** (VTEX) devuelven valores topados: `0`, `1`, `10`, `100`. De 1 a 9 son
  reales — `1` es literalmente el último par — pero `10` y `100` significan "10 o más" y
  "100 o más".
- **Impulse** solo informa `IN_STOCK` / `OUT_OF_STOCK`, sin cantidad.
- **Marathon** no tiene página de variante: que un zapato aparezca bajo la faceta de talla
  significa que está disponible, nada más.

El filtro "solo con stock" es fiable en las cinco. El orden por "menor stock" solo tiene
sentido en TAF, Fair Play y Yuth.

## Sobre las tallas

Las tiendas publican la talla como texto (`"11.5"`) en escala **US hombre**. El sistema la
normaliza a número y la convierte a centímetros con la tabla estándar de Nike/adidas/Puma:

| US | 11 | 11.5 | 12 |
|---|---|---|---|
| cm | 29 | 29.5 | 30 |

**Ojo con esto:** si tu pie mide 30 cm exactos, la equivalencia directa es **US 12**;
US 11 son 29 cm. Las tres tallas configuradas cubren el rango con margen, y la interfaz
muestra los cm de cada una para que decidas. La conversión varía algo entre marcas, así
que se usa para informar, nunca para filtrar — el filtro va siempre contra la etiqueta
real de la tienda.

Para cambiar las tallas, editá `config/config.json`:

```json
"targetSizes": { "system": "US_MEN", "labels": ["11", "11.5", "12"], "footLengthCm": 30 }
```

## Procedencia de los datos

Cada dato es rastreable hasta su origen. La pestaña **Origen de los datos** de la web y el
comando `runs` muestran, por cada extracción: tienda, momento, estado, número de peticiones,
productos encontrados, cuántos en tu talla, cuántos con stock, cambios detectados, duración
y los endpoints exactos consultados.

El panel de detalle de cada zapato muestra su cadena completa: tienda, URL del producto,
URL del SKU, URL de la imagen, código de fabricante, corrida que lo capturó y timestamp.

## Agregar tiendas

**Otra tienda VTEX** — solo configuración, sin tocar código. En `config/config.json`:

```json
{
  "slug": "otra", "name": "Otra Tienda", "enabled": true,
  "platform": "vtex", "baseUrl": "https://www.otra.com.bo", "currency": "BOB",
  "vtex": {
    "sizeSpecificationId": 57, "sizeFieldName": "TALLA",
    "categories": [{ "path": "/47/54/", "label": "HOMBRE / ZAPATILLAS" }]
  }
}
```

Para descubrir el árbol de categorías de una tienda VTEX:

```bash
curl -s 'https://www.LATIENDA.com/api/catalog_system/pub/category/tree/3' | head -c 2000
```

**Otra tienda Magento, WooCommerce o Hybris** — también solo configuración: ya hay conector
para las tres. Mirá los bloques `magento`, `woocommerce` y `hybris` en `config/config.json`.

**Una plataforma nueva** (Shopify, PrestaShop, HTML plano) — implementar la interfaz
`StoreConnector` (`src/domain/types.ts`) en un archivo nuevo bajo `src/connectors/` y
registrarlo en `src/connectors/registry.ts`. El resto del sistema — historial, comparación,
web, exportación — funciona sin cambios, porque todo trabaja contra el modelo de dominio,
no contra la forma de la respuesta de cada tienda.

### Tiendas evaluadas y descartadas

- **[Bata Bolivia](https://www.bata.com.bo/)** — es VTEX, entraría con solo configuración,
  pero su calzado de hombre llega hasta **EU 44** (≈ US 10.5). Todo su catálogo queda por
  debajo de la talla buscada.
- **[Sport Line](https://sportlinebolivia.com/)** y **[Tienda Winner](https://tiendawinner.com/)**
  — API REST cerrada (401) y sin GraphQL. Requerirían parsear HTML sin datos estructurados.

### Fragilidad de cada conector

No todos envejecen igual, y conviene saberlo:

- **VTEX y Magento** leen APIs con contrato. Son estables.
- **TAF (WooCommerce)** y **Marathon (Hybris)** leen marcado HTML. Si esas tiendas rehacen
  su plantilla, sus conectores se rompen. Emiten avisos en `warnings` en vez de fallar en
  silencio, y una tienda caída no tumba la corrida de las demás.

## Estructura

```
config/config.json        tiendas y tallas objetivo
src/
  domain/                 modelo de dominio, tallas, cruce entre tiendas
  connectors/             vtex.ts (genérico) + registro por plataforma
  infra/                  http.ts (reintentos, concurrencia), db.ts (SQLite)
  repo/                   schema.sql, views.sql, escrituras idempotentes
  pipeline/               ingest.ts (orquestador), analytics.ts (consultas)
  web/                    server.ts + public/index.html
  cli.ts
```

## Buen comportamiento con los sitios

- Un solo `User-Agent` identificable — cambialo en `config/config.json` por tu contacto.
- Concurrencia limitada (4) y espaciado mínimo entre peticiones (120 ms).
- Reintentos con backoff exponencial y jitter; respeta `Retry-After` en 429.
- 34 peticiones por corrida completa: menos carga que una persona navegando el sitio.

Se consultan endpoints públicos, los mismos que usa el navegador al visitar la tienda.
No hay autenticación, ni evasión, ni acceso a nada que no sea público. Aun así, es para
uso personal: no republiques los datos ni le subas la frecuencia sin necesidad.
