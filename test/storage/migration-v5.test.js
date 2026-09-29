/**
 * Migración v5 (estado del bot y curva de capital, para el panel) y copia de
 * seguridad automática antes de migrar.
 *
 * Condiciones que se verifican:
 *   - la v5 SOLO agrega tablas: las existentes (esquema, índices, triggers) y
 *     todos sus datos quedan idénticos;
 *   - antes de migrar una base con datos se guarda una copia completa, y si la
 *     copia falla no se aplica ninguna migración.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupBeforeMigrating, migrate, openDatabase } from '../../src/storage/db.js';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import { tempDir } from '../helpers.js';

const V5 = MIGRATIONS[4];

let tmp;
const open = [];
beforeEach(async () => { tmp = await tempDir(); });
afterEach(() => {
  open.splice(0).forEach((db) => db.open && db.close());
  tmp.cleanup();
});
const track = (db) => (open.push(db), db);

/** Base en la versión 4 (como la dejaba el módulo 8), con datos en TODAS las tablas. */
function createV4Database(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS.slice(0, 4));
  const t = '2026-09-28T10:00:00.000Z';
  db.exec(`
    UPDATE risk_state SET halted = 1, halt_code = 'DAILY_LOSS', halt_reason = 'pérdida', halted_at = '${t}'
      WHERE env = 'testnet' AND mode = 'dry-run';
    INSERT INTO orders (env, mode, client_order_id, symbol, side, type, amount, price, status, filled_qty,
                        filled_quote, avg_fill_price, fee_quote, created_at, updated_at, signal_key)
      VALUES ('testnet', 'dry-run', 'c-1', 'BTC/USDT', 'buy', 'market', 0.001, 84000, 'filled', 0.001,
              84, 84000, 0.084, '${t}', '${t}', 'sma-cross:BTC/USDT:15m:1:BUY');
    INSERT INTO orders (env, mode, client_order_id, symbol, side, type, amount, status, reject_source,
                        reject_code, reject_reason, created_at, updated_at)
      VALUES ('demo', 'exchange', 'c-2', 'BTC/USDT', 'sell', 'market', 0.002, 'rejected', 'risk',
              'NO_POSITION', 'sin posición', '${t}', '${t}');
    INSERT INTO order_fills (order_id, env, mode, trade_id, qty, price, fee_amount, fee_currency, fee_quote, time)
      VALUES (1, 'testnet', 'dry-run', 't-1', 0.001, 84000, 0.084, 'USDT', 0.084, '${t}');
    INSERT INTO positions (env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time, entry_order_id)
      VALUES ('testnet', 'dry-run', 'BTC/USDT', 'open', 0.001, 84000, 0.084, 84.084, '${t}', 1);
    INSERT INTO events (env, mode, time, type, code, message, data)
      VALUES ('testnet', 'dry-run', '${t}', 'HALT', 'DAILY_LOSS', 'pérdida', '{"x":1}');
    INSERT INTO candles (env, symbol, timeframe, open_time, open, high, low, close, volume)
      VALUES ('testnet', 'BTC/USDT', '15m', 1759053600000, 1, 2, 0.5, 1.5, 10),
             ('production-readonly', 'BTC/USDT', '1h', 1759053600000, 3, 4, 2, 3.5, 20);
    INSERT INTO balance_snapshots (env, mode, asset, amount, time, reason)
      VALUES ('demo', 'exchange', 'USDT', 5000, '${t}', 'referencia inicial');
    INSERT INTO backtest_runs (group_id, segment, created_at, data_env, strategy, params, symbol, timeframe,
                               period_from, period_to, capital, fee_rate, slippage_bps, settings, metrics, csv_path)
      VALUES ('g-1', 'full', '${t}', 'production-readonly', 'sma-cross', '{"fast":9,"slow":21}', 'BTC/USDT', '1h',
              '2025-01-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', 20, 0.001, 5, '{}', '{"netPnl":-1.2}', 'x.csv');
    INSERT INTO backtest_trades (run_id, n, entry_time, entry_price, exit_time, exit_price, qty, fees, pnl, pnl_pct)
      VALUES (1, 1, '${t}', 84000, '${t}', 83000, 0.0002, 0.03, -0.23, -1.4);
  `);
  return db;
}

/** Objetos del esquema (sin los internos de SQLite) y el contenido de cada tabla. */
function snapshot(db) {
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  const data = {};
  for (const { name } of objects.filter((o) => o.type === 'table')) {
    // Orden estable aunque la tabla no tenga rowid (candles es WITHOUT ROWID).
    data[name] = db.prepare(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(row)).sort();
  }
  return { objects, data };
}

describe('migración v5: solo agrega tablas', () => {
  it('el SQL de la v5 no borra, modifica ni renombra nada (solo CREATE TABLE / CREATE INDEX)', () => {
    // Sin comentarios y sin "ON DELETE CASCADE" (es una regla de la clave foránea
    // para el futuro, no un borrado al migrar).
    const sql = V5.sql.replace(/--.*$/gm, '').replace(/ON DELETE CASCADE/g, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|REPLACE|RENAME|ALTER|TRIGGER)\b/i);
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.every((s) => /^CREATE (TABLE|INDEX|UNIQUE INDEX) /i.test(s))).toBe(true);
    expect(V5.version).toBe(5);
  });

  it('en una base v4 con datos: tablas, índices, triggers y datos existentes quedan idénticos', () => {
    const db = track(createV4Database(path.join(tmp.dir, 'bot.db')));
    const before = snapshot(db);
    expect(db.pragma('user_version', { simple: true })).toBe(4);

    expect(migrate(db)).toBe(5);
    const after = snapshot(db);

    // Cada objeto que existía sigue existiendo con la MISMA definición
    for (const object of before.objects) expect(after.objects).toContainEqual(object);
    // Lo único nuevo son las dos tablas de la v5
    const added = after.objects.filter((o) => !before.objects.some((b) => b.name === o.name));
    expect(added.map((o) => `${o.type}:${o.name}`).sort()).toEqual(['table:backtest_equity', 'table:bot_status']);

    // Los datos de cada tabla existente, idénticos (el historial solo suma la fila de la v5)
    for (const [table, rows] of Object.entries(before.data)) {
      if (table === 'schema_migrations') continue;
      expect(after.data[table], table).toEqual(rows);
    }
    const history = after.data.schema_migrations.map((row) => JSON.parse(row));
    expect(history.filter((m) => m.version <= 4).map((row) => JSON.stringify(row)).sort())
      .toEqual(before.data.schema_migrations);
    expect(history.find((m) => m.version === 5)).toMatchObject({ name: V5.name });
    // Las tablas nuevas empiezan vacías
    expect(after.data.bot_status).toEqual([]);
    expect(after.data.backtest_equity).toEqual([]);
  });
});

describe('restricciones de las tablas nuevas', () => {
  let db;
  beforeEach(() => { db = track(openDatabase(':memory:')); });

  const insertStatus = (env, mode, state = 'running') =>
    db.prepare(`INSERT INTO bot_status (env, mode, state, updated_at) VALUES (?, ?, ?, 't')`).run(env, mode, state);

  it('bot_status: solo entornos de trading y modos válidos (nunca producción)', () => {
    expect(() => insertStatus('production-readonly', 'dry-run')).toThrow(/CHECK/);
    expect(() => insertStatus('mainnet', 'exchange')).toThrow(/CHECK/);
    expect(() => insertStatus('testnet', 'real')).toThrow(/CHECK/);
    expect(() => insertStatus('testnet', 'dry-run', 'dancing')).toThrow(/CHECK/);
    expect(() => insertStatus('testnet', 'dry-run')).not.toThrow();
  });

  it('bot_status: una sola fila por ámbito', () => {
    insertStatus('testnet', 'dry-run');
    insertStatus('testnet', 'exchange');
    expect(() => insertStatus('testnet', 'dry-run')).toThrow(/UNIQUE/);
  });

  it('backtest_equity: pertenece a un backtest existente y se borra con él', () => {
    const insertPoint = (runId, n) => db.prepare('INSERT INTO backtest_equity (run_id, n, time, equity) VALUES (?, ?, 0, 20)').run(runId, n);
    expect(() => insertPoint(99, 0)).toThrow(/FOREIGN KEY/);
    db.exec(`INSERT INTO backtest_runs (group_id, segment, created_at, data_env, strategy, params, symbol, timeframe,
               period_from, period_to, capital, fee_rate, slippage_bps, settings, metrics)
             VALUES ('g', 'full', 't', 'production-readonly', 's', '{}', 'BTC/USDT', '1h', 'a', 'b', 20, 0, 0, '{}', '{}')`);
    insertPoint(1, 0);
    insertPoint(1, 1);
    expect(() => insertPoint(1, 1)).toThrow(/UNIQUE|PRIMARY KEY/);
    db.exec('DELETE FROM backtest_runs WHERE id = 1');
    expect(db.prepare('SELECT COUNT(*) FROM backtest_equity').pluck().get()).toBe(0);
  });
});

describe('copia de seguridad antes de migrar', () => {
  const backups = () => {
    const dir = path.join(tmp.dir, 'backups');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('al abrir una base v4 con datos: guarda una copia v4 completa y después migra', () => {
    const file = path.join(tmp.dir, 'bot.db');
    const before = snapshot(track(createV4Database(file))); // queda abierta, como si el bot estuviera usándola
    const logger = { info: vi.fn() };

    const db = track(openDatabase(file, { logger }));
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    const [name] = backups();
    expect(name).toMatch(/^bot\.v4\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/); // sin ":" (Windows)
    const copy = track(new Database(path.join(tmp.dir, 'backups', name), { readonly: true }));
    expect(copy.pragma('user_version', { simple: true })).toBe(4);
    expect(snapshot(copy)).toEqual(before); // copia exacta: mismo esquema y mismos datos
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ backup: expect.stringContaining(name) }), expect.stringMatching(/Copia de seguridad/));
  });

  it('una base nueva o ya al día no genera copias', () => {
    const file = path.join(tmp.dir, 'bot.db');
    openDatabase(file).close(); // nueva: se crea en la versión actual
    openDatabase(file).close(); // al día: no hay nada que migrar
    expect(backups()).toEqual([]);
  });

  it('si la copia falla, NO se aplica ninguna migración y se explica por qué', () => {
    const file = path.join(tmp.dir, 'bot.db');
    createV4Database(file).close();
    fs.writeFileSync(path.join(tmp.dir, 'backups'), 'un archivo donde debería ir la carpeta');

    expect(() => openDatabase(file)).toThrow(/No se pudo crear la copia de seguridad antes de migrar .*No se aplicó ninguna migración/);
    const db = track(new Database(file, { readonly: true }));
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'bot_status'").get()).toBeUndefined();
  });

  it('backupBeforeMigrating usa la versión actual y la fecha en el nombre', () => {
    const file = path.join(tmp.dir, 'datos.sqlite');
    const db = track(createV4Database(file));
    const target = backupBeforeMigrating(db, file, { now: Date.parse('2026-09-29T15:04:05.678Z') });
    expect(target).toBe(path.join(tmp.dir, 'backups', 'datos.v4.2026-09-29T15-04-05-678Z.db'));
    expect(fs.existsSync(target)).toBe(true);
  });
});
