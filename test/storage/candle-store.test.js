import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { CandleStore, CandleStoreError, formatGapWarning } from '../../src/storage/candle-store.js';

const H = 3_600_000; // 1 hora
const T0 = Date.parse('2026-09-01T00:00:00Z');
const NOW = Date.parse('2026-09-28T12:00:00Z');
const SYMBOL = 'BTC/USDT';

/** Velas de 1h válidas; `hours` son los índices (horas desde T0) a generar. */
const candles = (hours) =>
  hours.map((h) => ({ time: T0 + h * H, open: 100 + h, high: 101 + h, low: 99 + h, close: 100.5 + h, volume: 10 }));
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

let db;
let store;
beforeEach(() => {
  db = openDatabase(':memory:');
  store = new CandleStore(db, { env: 'production-readonly' });
});
afterEach(() => db.close());

const count = () => db.prepare('SELECT COUNT(*) FROM candles').pluck().get();

describe('duplicados', () => {
  it('guardar las mismas velas dos veces no las duplica', () => {
    expect(store.upsert(SYMBOL, '1h', candles(range(0, 10)), { now: NOW })).toEqual({ inserted: 10, duplicates: 0, skippedOpen: 0 });
    expect(store.upsert(SYMBOL, '1h', candles(range(0, 10)), { now: NOW })).toEqual({ inserted: 0, duplicates: 10, skippedOpen: 0 });
    expect(count()).toBe(10);
  });

  it('rangos que se solapan: solo entran las nuevas', () => {
    store.upsert(SYMBOL, '1h', candles(range(0, 10)), { now: NOW });
    expect(store.upsert(SYMBOL, '1h', candles(range(5, 15)), { now: NOW })).toMatchObject({ inserted: 5, duplicates: 5 });
    expect(count()).toBe(15);
  });

  it('duplicados dentro del mismo lote', () => {
    expect(store.upsert(SYMBOL, '1h', candles([0, 1, 1, 2, 2, 2]), { now: NOW })).toMatchObject({ inserted: 3, duplicates: 3 });
  });

  it('la clave incluye par e intervalo: la misma hora en otro par o intervalo no es duplicado', () => {
    store.upsert(SYMBOL, '1h', candles([0]), { now: NOW });
    expect(store.upsert('ETH/USDT', '1h', candles([0]), { now: NOW }).inserted).toBe(1);
    expect(store.upsert(SYMBOL, '1d', candles([0]), { now: NOW }).inserted).toBe(1);
  });

  it('la base de datos misma impide el duplicado (clave primaria)', () => {
    const insert = db.prepare(
      `INSERT INTO candles (env, symbol, timeframe, open_time, open, high, low, close, volume)
         VALUES ('production-readonly', 'BTC/USDT', '1h', ?, 1, 1, 1, 1, 0)`,
    );
    insert.run(T0);
    expect(() => insert.run(T0)).toThrow(/UNIQUE constraint/);
  });
});

describe('validación al guardar', () => {
  it('no guarda la vela en curso (aún no cerrada)', () => {
    const now = T0 + 2 * H + 1; // la vela de las 02:00 sigue abierta
    expect(store.upsert(SYMBOL, '1h', candles([0, 1, 2]), { now })).toEqual({ inserted: 2, duplicates: 0, skippedOpen: 1 });
  });

  it('rechaza velas no alineadas al intervalo', () => {
    const [bad] = candles([0]);
    expect(() => store.upsert(SYMBOL, '1h', [{ ...bad, time: T0 + 60_000 }], { now: NOW })).toThrow(/no está alineada/);
  });

  it('una vela inválida rechaza el lote completo (no guarda nada)', () => {
    const batch = candles(range(0, 5));
    batch[3] = { ...batch[3], close: NaN };
    expect(() => store.upsert(SYMBOL, '1h', batch, { now: NOW })).toThrow(CandleStoreError);
    expect(() => store.upsert(SYMBOL, '1h', batch, { now: NOW })).toThrow(/vela 4\/5 .* close inválido/);
    expect(count()).toBe(0);
  });

  it('timeframe desconocido', () => {
    expect(() => store.upsert(SYMBOL, '7m', candles([0]), { now: NOW })).toThrow(/Timeframe no soportado/);
  });
});

describe('lectura', () => {
  it('get devuelve [from, to) en orden, aunque se hayan guardado desordenadas', () => {
    store.upsert(SYMBOL, '1h', candles([5, 1, 3, 2, 4, 0]), { now: NOW });
    const result = store.get(SYMBOL, '1h', { from: T0 + H, to: T0 + 4 * H });
    expect(result.map((c) => (c.time - T0) / H)).toEqual([1, 2, 3]);
    expect(result[0]).toEqual({ time: T0 + H, open: 101, high: 102, low: 100, close: 101.5, volume: 10 });
  });

  it('bounds: primera y última guardadas', () => {
    store.upsert(SYMBOL, '1h', candles([3, 7, 5]), { now: NOW });
    expect(store.bounds(SYMBOL, '1h')).toEqual({ first: T0 + 3 * H, last: T0 + 7 * H, count: 3 });
  });
});

describe('huecos en los datos', () => {
  const gapsOf = (hours, from = 0, to = 24) => {
    store.upsert(SYMBOL, '1h', candles(hours), { now: NOW });
    return store.findGaps(SYMBOL, '1h', { from: T0 + from * H, to: T0 + to * H });
  };
  const simplify = (report) => report.gaps.map((g) => [(g.from - T0) / H, (g.to - T0) / H, g.count]);

  it('rango completo → sin huecos', () => {
    const report = gapsOf(range(0, 24));
    expect(report).toMatchObject({ expected: 24, present: 24, missing: 0, gaps: [] });
    expect(formatGapWarning(report)).toBeNull();
  });

  it('hueco en el medio', () => {
    const report = gapsOf([...range(0, 10), ...range(13, 24)]);
    expect(report).toMatchObject({ expected: 24, present: 21, missing: 3 });
    expect(simplify(report)).toEqual([[10, 12, 3]]); // faltan las velas de 10:00, 11:00 y 12:00
  });

  it('huecos al inicio, al final y una vela suelta', () => {
    const report = gapsOf([...range(2, 7), ...range(8, 20)]);
    expect(simplify(report)).toEqual([[0, 1, 2], [7, 7, 1], [20, 23, 4]]);
    expect(report.missing).toBe(7);
  });

  it('sin ninguna vela: todo el rango es un hueco', () => {
    const report = gapsOf([]);
    expect(report).toMatchObject({ expected: 24, present: 0, missing: 24 });
    expect(simplify(report)).toEqual([[0, 23, 24]]);
  });

  it('alinea el rango: un inicio a mitad de hora empieza en la hora siguiente', () => {
    store.upsert(SYMBOL, '1h', candles(range(0, 24)), { now: NOW });
    const report = store.findGaps(SYMBOL, '1h', { from: T0 + 30 * 60_000, to: T0 + 5 * H + 1 });
    expect(report).toMatchObject({ from: T0 + H, to: T0 + 5 * H, expected: 4, missing: 0 });
  });

  it('las velas de otro par o intervalo no tapan huecos', () => {
    store.upsert('ETH/USDT', '1h', candles(range(0, 24)), { now: NOW });
    store.upsert(SYMBOL, '1d', candles([0]), { now: NOW });
    expect(gapsOf([]).missing).toBe(24);
  });

  it('formatGapWarning: aviso legible antes del backtest', () => {
    const warning = formatGapWarning(gapsOf([...range(0, 10), ...range(13, 24)]));
    expect(warning).toMatch(/Faltan 3 de 24 velas \(12\.50%\) de BTC\/USDT 1h \[production-readonly\] en 1 hueco/);
    expect(warning).toMatch(/2026-09-01 10:00 → 2026-09-01 12:00 UTC \(3 velas\)/);
    expect(warning).toMatch(/El backtest saltará esos periodos/);
  });

  it('formatGapWarning resume cuando hay muchos huecos', () => {
    const everyOther = range(0, 24).filter((h) => h % 2 === 0);
    const warning = formatGapWarning(gapsOf(everyOther), { maxListed: 3 });
    expect(warning).toMatch(/en 12 hueco\(s\)/);
    expect(warning).toMatch(/… y 9 hueco\(s\) más/);
  });
});
