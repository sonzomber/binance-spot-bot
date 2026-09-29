/**
 * Acceso del panel a SQLite: SOLO LECTURA.
 *
 *   - La conexión se abre con `readonly: true`: SQLite mismo rechaza cualquier
 *     escritura (SQLITE_READONLY). Además `query_only` lo refuerza.
 *   - Con WAL (el modo que usa el bot), leer no bloquea al bot: sus escrituras
 *     nunca esperan al panel.
 *   - El panel NUNCA migra. Si la base no existe o está en otra versión, lo
 *     informa (y lo reintenta en cada consulta: el bot puede crearla o migrarla
 *     mientras el panel está abierto).
 *   - Cada consulta corre dentro de una transacción de lectura: ve una foto
 *     consistente aunque el bot esté escribiendo.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import { displayPath } from './config.js';

export const EXPECTED_VERSION = MIGRATIONS.length;

/** La base de datos no se puede consultar (no existe, otra versión, error). */
export class DatabaseUnavailableError extends Error {
  constructor(status) {
    super(status.message);
    this.name = 'DatabaseUnavailableError';
    this.status = status;
  }
}

export class PanelDatabase {
  /** @param {string} file ruta de la base del bot */
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  /**
   * Estado actual de la base (abre la conexión si hace falta).
   * @returns {{ state: 'ok'|'missing'|'outdated'|'newer'|'error', version: number|null,
   *             expectedVersion: number, path: string, message: string|null }}
   */
  status() {
    const base = { expectedVersion: EXPECTED_VERSION, path: displayPath(this.file) };
    if (!this.db) {
      if (!fs.existsSync(this.file)) {
        return {
          ...base, state: 'missing', version: null,
          message: `Todavía no existe la base de datos (${base.path}): arranca el bot o corre un backtest para crearla.`,
        };
      }
      try {
        this.db = new Database(this.file, { readonly: true, fileMustExist: true });
        this.db.pragma('busy_timeout = 2000');
        this.db.pragma('query_only = ON');
      } catch (err) {
        this.db = null;
        return { ...base, state: 'error', version: null, message: `No se pudo abrir la base de datos: ${err.message}` };
      }
    }
    let version;
    try {
      version = this.db.pragma('user_version', { simple: true });
    } catch (err) {
      return { ...base, state: 'error', version: null, message: `No se pudo leer la base de datos: ${err.message}` };
    }
    if (version < EXPECTED_VERSION) {
      return {
        ...base, state: 'outdated', version,
        message: `La base está en la versión ${version} y el panel necesita la ${EXPECTED_VERSION}. `
          + 'Arranca el bot (o cualquier comando, p. ej. npm run status) una vez para migrarla: antes se hace una copia de seguridad automática.',
      };
    }
    if (version > EXPECTED_VERSION) {
      return {
        ...base, state: 'newer', version,
        message: `La base está en la versión ${version}, más nueva que este panel (${EXPECTED_VERSION}): actualiza el código del panel.`,
      };
    }
    return { ...base, state: 'ok', version, message: null };
  }

  /**
   * Ejecuta consultas en una transacción de lectura (foto consistente).
   * @template T
   * @param {(db: import('better-sqlite3').Database) => T} fn
   * @returns {T}
   * @throws {DatabaseUnavailableError} si la base no se puede consultar
   */
  read(fn) {
    const status = this.status();
    if (status.state !== 'ok') throw new DatabaseUnavailableError(status);
    return this.db.transaction(() => fn(this.db))();
  }

  /**
   * Cambia cada vez que OTRA conexión (el bot, un script) guarda algo.
   * Como esta conexión es de solo lectura, todo cambio viene de afuera.
   * @returns {number|null} null si la base no está disponible
   */
  dataVersion() {
    if (this.status().state !== 'ok') return null;
    return this.db.pragma('data_version', { simple: true });
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
