/**
 * Conexión a SQLite (better-sqlite3) y migraciones versionadas.
 *
 * better-sqlite3 es síncrono: cada escritura queda en disco al retornar. Para
 * un bot es una ventaja: si el proceso muere justo después de registrar una
 * parada, la parada ya está guardada.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

/**
 * Abre (o crea) la base de datos y aplica las migraciones pendientes.
 * @param {string} file ruta del archivo, o ':memory:' para tests
 */
export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // el bot y los scripts (kill/resume/status) pueden usarla a la vez
  db.pragma('busy_timeout = 5000'); // si otro proceso está escribiendo, espera en vez de fallar
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
  } catch (err) {
    db.close(); // no dejar el archivo bloqueado (en Windows impediría borrarlo o reabrirlo)
    throw err;
  }
  return db;
}

/**
 * Aplica las migraciones que falten, cada una en su propia transacción: si una
 * falla, la base de datos queda en la versión anterior, sin cambios a medias.
 * @param {Array<{ version: number, name: string, sql: string }>} [migrations]
 * @returns {number} versión final
 */
export function migrate(db, migrations = MIGRATIONS) {
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new Error(`Migraciones desordenadas: se esperaba la versión ${i + 1} y se encontró ${migration.version}`);
    }
  });

  const current = db.pragma('user_version', { simple: true });
  if (current > migrations.length) {
    throw new Error(
      `La base de datos está en la versión ${current}, más nueva que este código (${migrations.length}).`,
    );
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT                                          -- null: aplicada antes de existir este historial
  )`);
  // Bases creadas antes del historial: registra las versiones que ya tenían.
  const backfill = db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NULL)');
  for (const migration of migrations.slice(0, current)) backfill.run(migration.version, migration.name);

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  );
  for (const migration of migrations.slice(current)) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  return db.pragma('user_version', { simple: true });
}

/** Versión del esquema y su historial (para `npm run status`). */
export function schemaInfo(db) {
  return {
    version: db.pragma('user_version', { simple: true }),
    history: db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all(),
  };
}
