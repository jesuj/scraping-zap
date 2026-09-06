/**
 * Comprueba que lo publicado en docs/ sea coherente antes de que llegue a
 * GitHub Pages. Corre en CI y tambien se puede ejecutar a mano.
 *
 * No valida "que se vea bien" — valida lo que romperia la pagina en silencio:
 * que existan los archivos, que el JSON tenga las claves que la interfaz lee,
 * y que los datos no esten obviamente mal.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const problemas = [];
const avisos = [];

function fallar(msg) {
  problemas.push(msg);
}

// El sitio puede no existir todavia en un clon recien hecho: eso no es un error.
if (!existsSync(join(docs, 'data.json'))) {
  console.log('docs/ aun no tiene datos publicados; nada que validar.');
  console.log('Genera el sitio con: npm run publish');
  process.exit(0);
}

for (const archivo of ['index.html', 'data.json', '.nojekyll']) {
  if (!existsSync(join(docs, archivo))) fallar(`falta docs/${archivo}`);
}
if (problemas.length) {
  for (const p of problemas) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(join(docs, 'data.json'), 'utf8'));

// Claves que la interfaz consume directamente.
for (const clave of ['generatedAt', 'targetSizes', 'stats', 'facets', 'offers', 'history', 'compare', 'runs']) {
  if (!(clave in data)) fallar(`data.json no tiene la clave "${clave}"`);
}
if (!Array.isArray(data.offers) || data.offers.length === 0) {
  fallar('data.json no trae ofertas');
}
if (!data.compare?.exact || !data.compare?.model) {
  fallar('data.json no trae las dos modalidades de comparacion');
}

// Campos que cada tarjeta necesita para pintarse.
const requeridos = ['sku_id', 'store_slug', 'product_name', 'size_label', 'price', 'sku_url'];
const incompletas = (data.offers ?? []).filter((o) => requeridos.some((c) => o[c] == null));
if (incompletas.length) fallar(`${incompletas.length} ofertas sin campos obligatorios`);

// Coherencia: solo se publica lo vigente.
const agotadas = (data.offers ?? []).filter((o) => o.available !== 1);
if (agotadas.length) fallar(`${agotadas.length} ofertas publicadas sin stock`);

// Tallas: nada fuera de lo configurado.
const objetivo = new Set(data.targetSizes?.labels ?? []);
const fueraDeTalla = (data.offers ?? []).filter((o) => !objetivo.has(o.size_label));
if (fueraDeTalla.length) fallar(`${fueraDeTalla.length} ofertas fuera de las tallas objetivo`);

// El HTML tiene que poder funcionar sin API detras.
const html = readFileSync(join(docs, 'index.html'), 'utf8');
if (!html.includes("fetch('data.json'")) fallar('index.html no sabe cargar data.json');
if (!html.includes('no-referrer')) {
  avisos.push('index.html sin meta no-referrer: las imagenes de Marathon daran 403');
}

// Frescura: publicar una foto vieja no rompe nada, pero conviene saberlo.
const dias = (Date.now() - Date.parse(data.generatedAt)) / 86_400_000;
if (Number.isFinite(dias) && dias > 7) {
  avisos.push(`los datos publicados tienen ${dias.toFixed(0)} dias; corre "npm run scrape" y "npm run publish"`);
}

const kb = (statSync(join(docs, 'data.json')).size / 1024).toFixed(0);

for (const a of avisos) console.warn(`  ! ${a}`);
if (problemas.length) {
  for (const p of problemas) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`Sitio valido: ${data.offers.length} ofertas · ${Object.keys(data.history).length} con historial · data.json ${kb} KB`);
