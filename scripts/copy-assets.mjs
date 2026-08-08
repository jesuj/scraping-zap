/**
 * tsc solo emite JavaScript. Este paso copia los assets no-TS (el esquema SQL y
 * la interfaz web) a dist/ para que el build quede autocontenido y se pueda
 * desplegar copiando solo dist/ + config/.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['src/repo/schema.sql', 'dist/repo/schema.sql'],
  ['src/repo/views.sql', 'dist/repo/views.sql'],
  ['src/web/public', 'dist/web/public'],
];

for (const [from, to] of assets) {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  cpSync(join(root, from), join(root, to), { recursive: true });
}

console.log(`assets copiados (${assets.length})`);
