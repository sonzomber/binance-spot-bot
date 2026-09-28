/**
 * Conexión a SQLite (better-sqlite3) y migraciones.
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

/** Aplica, en una transacción cada una, las migraciones que falten. */
export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current > MIGRATIONS.length) {
    throw new Error(
      `La base de datos está en la versión ${current}, más nueva que este código (${MIGRATIONS.length}).`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  return db.pragma('user_version', { simple: true });
}
