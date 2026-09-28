import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/storage/db.js';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import { tempDir } from '../helpers.js';

describe('openDatabase / migraciones', () => {
  let tmp;
  beforeEach(async () => { tmp = await tempDir(); });
  afterEach(() => tmp.cleanup());

  it('crea el esquema y registra la versión', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
    expect(tables).toEqual(expect.arrayContaining(['risk_state', 'positions', 'events']));
    db.close();
  });

  it('crea la carpeta si no existe y usa WAL', () => {
    const file = path.join(tmp.dir, 'sub', 'dir', 'bot.db');
    const db = openDatabase(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('migrar dos veces no aplica nada nuevo ni borra datos', () => {
    const file = path.join(tmp.dir, 'bot.db');
    const db = openDatabase(file);
    db.prepare("INSERT INTO events (time, type, message) VALUES ('t', 'TEST', 'dato')").run();
    db.close();

    const reopened = openDatabase(file);
    expect(migrate(reopened)).toBe(MIGRATIONS.length);
    expect(reopened.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(1);
    reopened.close();
  });

  it('se niega a usar una base de datos más nueva que el código', () => {
    const file = path.join(tmp.dir, 'bot.db');
    const raw = new Database(file);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => openDatabase(file)).toThrow(/más nueva que este código/);
  });

  it('risk_state tiene exactamente una fila, que empieza habilitada', () => {
    const db = openDatabase(':memory:');
    expect(db.prepare('SELECT id, halted FROM risk_state').all()).toEqual([{ id: 1, halted: 0 }]);
    expect(() => db.prepare("INSERT INTO risk_state (id, updated_at) VALUES (2, 'x')").run()).toThrow(/CHECK/);
    db.close();
  });
});
