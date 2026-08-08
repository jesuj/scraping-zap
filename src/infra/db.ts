/**
 * Acceso a SQLite mediante `node:sqlite`, incluido en Node 22.5+.
 * Cero dependencias nativas que compilar.
 *
 * Todo el SQL vive detras de este modulo y de `repositories.ts`. Migrar a
 * Postgres cuando el volumen lo pida solo toca esos dos archivos.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/**
 * Migracion en tres pasos, y el orden importa:
 *   1. tablas e indices  (idempotente: CREATE TABLE IF NOT EXISTS)
 *   2. columnas nuevas   (ALTER TABLE, porque el paso 1 no toca tablas ya creadas)
 *   3. vistas            (se recrean siempre, y pueden referenciar lo del paso 2)
 */
function migrate(db: DatabaseSync): void {
  const sql = (name: string): string =>
    readFileSync(join(HERE, '..', 'repo', name), 'utf8');

  db.exec(sql('schema.sql'));

  addColumnIfMissing(db, 'product', 'model_key', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_product_model ON product(model_key)');

  db.exec(sql('views.sql'));
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export type Db = DatabaseSync;
