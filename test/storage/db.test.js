import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaInfo } from '../../src/storage/db.js';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import { tempDir } from '../helpers.js';

let tmp;
const open = [];
beforeEach(async () => { tmp = await tempDir(); });
afterEach(() => {
  open.splice(0).forEach((db) => db.open && db.close());
  tmp.cleanup();
});
const track = (db) => (open.push(db), db);
const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();

describe('migraciones versionadas', () => {
  it('crea el esquema completo y guarda la versión y el historial', () => {
    const db = track(openDatabase(':memory:'));
    const info = schemaInfo(db);
    expect(info.version).toBe(MIGRATIONS.length);
    expect(info.history.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(info.history.every((m) => m.applied_at)).toBe(true);
    expect(tableNames(db)).toEqual(
      ['backtest_runs', 'backtest_trades', 'balance_snapshots', 'candles', 'events', 'order_fills', 'orders', 'positions', 'risk_state', 'schema_migrations'],
    );
  });

  it('crea la carpeta si no existe y usa WAL', () => {
    const db = track(openDatabase(path.join(tmp.dir, 'sub', 'dir', 'bot.db')));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('migrar de nuevo no aplica nada ni borra datos', () => {
    const file = path.join(tmp.dir, 'bot.db');
    const db = openDatabase(file);
    db.prepare("INSERT INTO events (env, mode, time, type, message) VALUES ('testnet', 'dry-run', 't', 'TEST', 'dato')").run();
    db.close();

    const reopened = track(openDatabase(file));
    expect(migrate(reopened)).toBe(MIGRATIONS.length);
    expect(reopened.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(1);
    expect(schemaInfo(reopened).history).toHaveLength(MIGRATIONS.length);
  });

  it('una migración que falla no deja cambios a medias (transacción)', () => {
    const db = track(new Database(':memory:'));
    const broken = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'rota', sql: 'CREATE TABLE nueva (a); ESTO NO ES SQL;' }];
    expect(() => migrate(db, broken)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(tableNames(db)).not.toContain('nueva');
    expect(schemaInfo(db).history.map((m) => m.name)).not.toContain('rota');
  });

  it('exige migraciones numeradas en orden', () => {
    const db = track(new Database(':memory:'));
    expect(() => migrate(db, [MIGRATIONS[1]])).toThrow(/se esperaba la versión 1/);
  });

  it('se niega a usar una base de datos más nueva que el código', () => {
    const file = path.join(tmp.dir, 'bot.db');
    const raw = new Database(file);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => openDatabase(file)).toThrow(/más nueva que este código/);
  });
});

describe('migración v1 → v2 con datos existentes', () => {
  it('separa el antiguo "mode" en entorno + modo, conserva ids y datos, y extiende la parada', () => {
    // Base de datos tal como la dejaba el código del módulo 3: esquema v1 y
    // user_version = 1, sin tabla schema_migrations.
    const db = track(new Database(path.join(tmp.dir, 'v1.db')));
    db.exec(MIGRATIONS[0].sql);
    db.pragma('user_version = 1');
    const insert = db.prepare(
      `INSERT INTO positions (id, mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time)
         VALUES (?, ?, 'BTC/USDT', 'open', 0.001, 50000, 0.05, 50.05, '2026-09-28T10:00:00.000Z')`,
    );
    insert.run(7, 'dry-run');
    insert.run(8, 'testnet');
    insert.run(9, 'demo');
    db.prepare("UPDATE risk_state SET halted = 1, halt_code = 'KILL_SWITCH', halt_reason = 'viejo', halted_at = 'x'").run();
    db.prepare("INSERT INTO events (time, type, message) VALUES ('t', 'HALT', 'viejo')").run();

    expect(migrate(db)).toBe(MIGRATIONS.length);

    expect(db.prepare('SELECT id, env, mode, entry_cost FROM positions ORDER BY id').all()).toEqual([
      { id: 7, env: 'testnet', mode: 'dry-run', entry_cost: 50.05 },
      { id: 8, env: 'testnet', mode: 'exchange', entry_cost: 50.05 },
      { id: 9, env: 'demo', mode: 'exchange', entry_cost: 50.05 },
    ]);
    // la parada global anterior se conserva en todos los ámbitos
    expect(db.prepare('SELECT env, mode, halted, halt_reason FROM risk_state ORDER BY env, mode').all()).toEqual([
      { env: 'demo', mode: 'dry-run', halted: 1, halt_reason: 'viejo' },
      { env: 'demo', mode: 'exchange', halted: 1, halt_reason: 'viejo' },
      { env: 'testnet', mode: 'dry-run', halted: 1, halt_reason: 'viejo' },
      { env: 'testnet', mode: 'exchange', halted: 1, halt_reason: 'viejo' },
    ]);
    expect(db.prepare('SELECT env, mode, message FROM events').get()).toEqual({ env: 'testnet', mode: 'dry-run', message: 'viejo' });
    // el historial registra la v1 (aplicada antes de existir el historial) y las siguientes
    expect(schemaInfo(db).history.map((m) => [m.version, m.applied_at === null])).toEqual(
      MIGRATIONS.map((m) => [m.version, m.version === 1]),
    );
    // los ids nuevos siguen después de los existentes
    db.prepare(
      `INSERT INTO positions (env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time)
         VALUES ('testnet', 'dry-run', 'BTC/USDT', 'open', 1, 1, 0, 1, 't')`,
    ).run();
    expect(db.prepare('SELECT MAX(id) FROM positions').pluck().get()).toBe(10);
  });
});

describe('restricciones del esquema (la base de datos misma impide mezclar entornos)', () => {
  let db;
  beforeEach(() => { db = track(openDatabase(':memory:')); });

  const insertOrder = (env, mode, clientOrderId = `c-${env}-${mode}`) =>
    db.prepare(
      `INSERT INTO orders (env, mode, client_order_id, symbol, side, type, amount, status, created_at, updated_at)
         VALUES (?, ?, ?, 'BTC/USDT', 'buy', 'market', 0.001, 'pending', 't', 't')`,
    ).run(env, mode, clientOrderId).lastInsertRowid;

  it('risk_state: una fila por entorno × modo, todas habilitadas', () => {
    expect(db.prepare('SELECT env, mode, halted FROM risk_state ORDER BY env, mode').all()).toEqual([
      { env: 'demo', mode: 'dry-run', halted: 0 },
      { env: 'demo', mode: 'exchange', halted: 0 },
      { env: 'testnet', mode: 'dry-run', halted: 0 },
      { env: 'testnet', mode: 'exchange', halted: 0 },
    ]);
  });

  it.each(['production-readonly', 'mainnet', 'live'])('no acepta órdenes del entorno "%s"', (env) => {
    expect(() => insertOrder(env, 'exchange')).toThrow(/CHECK constraint/);
  });

  it('no acepta posiciones ni eventos de producción', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO positions (env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time)
           VALUES ('production-readonly', 'exchange', 'BTC/USDT', 'open', 1, 1, 0, 1, 't')`,
      ).run(),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db.prepare("INSERT INTO events (env, mode, time, type, message) VALUES ('mainnet', 'dry-run', 't', 'X', 'y')").run(),
    ).toThrow(/CHECK constraint/);
  });

  it('una ejecución no puede pertenecer a otro entorno que su orden', () => {
    const orderId = insertOrder('testnet', 'exchange');
    const insertFill = db.prepare(
      `INSERT INTO order_fills (order_id, env, mode, trade_id, qty, price, time) VALUES (?, ?, ?, ?, 0.001, 50000, 't')`,
    );
    expect(() => insertFill.run(orderId, 'demo', 'exchange', '1')).toThrow(/entorno\/modo no coincide/);
    expect(() => insertFill.run(orderId, 'testnet', 'dry-run', '2')).toThrow(/entorno\/modo no coincide/);
    expect(() => insertFill.run(orderId, 'testnet', 'exchange', '3')).not.toThrow();
  });

  it('una posición no puede enlazar órdenes de otro entorno', () => {
    const demoOrder = insertOrder('demo', 'dry-run');
    expect(() =>
      db.prepare(
        `INSERT INTO positions (env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time, entry_order_id)
           VALUES ('testnet', 'dry-run', 'BTC/USDT', 'open', 1, 1, 0, 1, 't', ?)`,
      ).run(demoOrder),
    ).toThrow(/orden de entrada es de otro entorno/);
  });

  it('las velas aceptan los tres entornos de datos, incluido production-readonly', () => {
    const insert = db.prepare(
      `INSERT INTO candles (env, symbol, timeframe, open_time, open, high, low, close, volume)
         VALUES (?, 'BTC/USDT', '1h', 0, 1, 1, 1, 1, 0)`,
    );
    for (const env of ['testnet', 'demo', 'production-readonly']) expect(() => insert.run(env)).not.toThrow();
    expect(() => insert.run('mainnet')).toThrow(/CHECK constraint/);
  });
});
