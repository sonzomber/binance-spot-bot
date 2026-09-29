/**
 * El comando completo de backtest: datos (con caché), huecos, ajuste/validación,
 * grid, guardado en SQLite y exportación a CSV. Datos de producción simulados.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backtestCommand } from '../../src/backtest/command.js';
import { BacktestStore } from '../../src/backtest/results.js';
import { openDatabase } from '../../src/storage/db.js';
import { tempDir } from '../helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2025-01-01T00:00:00Z');
const NOW = Date.parse('2025-06-01T00:00:00Z');
const MARKET = {
  symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', precision: { amount: 0.00001, price: 0.01 },
  limits: { amount: { min: 0.00001, max: 9000 }, price: { min: 0.01, max: 1e6 }, cost: { min: 5, max: 9e6 }, market: { max: 100 } },
};

/** Serie oscilante determinista (cruza las medias varias veces). */
const priceAt = (t) => 84_000 + 3000 * Math.sin((t - T0) / (37 * H)) + 800 * Math.sin((t - T0) / (5 * H));
const candleAt = (t) => {
  const open = priceAt(t - H);
  const close = priceAt(t);
  return { time: t, open, close, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, volume: 1 };
};

/** Cliente falso de producción (misma interfaz que MarketDataClient). */
function fakeClient({ missing = new Set() } = {}) {
  return {
    fetchMarket: vi.fn(async () => MARKET),
    fetchCandles: vi.fn(async (_symbol, _tf, { from, to }) => {
      const out = [];
      for (let t = from; t < to; t += H) if (!missing.has(t)) out.push(candleAt(t));
      return out;
    }),
  };
}

let db;
let tmp;
beforeEach(async () => {
  db = openDatabase(':memory:');
  tmp = await tempDir();
});
afterEach(() => {
  db.close();
  tmp.cleanup();
});

const options = (extra = {}) => ({
  symbol: 'BTC/USDT', timeframe: '1h', from: T0 + 50 * H, to: T0 + 50 * H + 60 * 24 * H,
  strategyId: 'sma-cross', params: { fast: 9, slow: 21 },
  capital: 20, feeRate: 0.001, slippageBps: 5,
  limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 },
  ...extra,
});
const run = (extra, client = fakeClient()) => backtestCommand(options(extra), { db, client, csvDir: tmp.dir, now: () => NOW });

describe('datos y huecos', () => {
  it('descarga el período más las velas previas para calentar indicadores, y después usa el caché', async () => {
    const client = fakeClient();
    await run({}, client);
    const [, , { from }] = client.fetchCandles.mock.calls[0];
    expect(from).toBe(T0 + 50 * H - 42 * H); // lookback de sma-cross 9/21 = 42 velas
    await run({}, client);
    expect(client.fetchCandles).toHaveBeenCalledTimes(1); // la 2ª vez no descarga nada
  });

  it('con huecos avisa y NO corre', async () => {
    const hole = T0 + 100 * H;
    const result = await run({}, fakeClient({ missing: new Set([hole, hole + H]) }));
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/Faltan 2 de .* velas .* en 1 hueco/);
    expect(new BacktestStore(db).listRuns()).toHaveLength(0);
  });

  it('con huecos y allowGaps corre, pero deja el aviso', async () => {
    const result = await run({ allowGaps: true }, fakeClient({ missing: new Set([T0 + 100 * H]) }));
    expect(result.ok).toBe(true);
    expect(result.gapsWarning).toMatch(/Faltan 1 de/);
  });
});

describe('guardado en SQLite y exportación a CSV', () => {
  it('guarda parámetros, período y fecha; y exporta las operaciones', async () => {
    const result = await run();
    const [segment] = result.segments;
    expect(segment.segment).toBe('full');
    expect(segment.report.trades).toBeGreaterThan(3);

    const saved = new BacktestStore(db).getRun(segment.runId);
    expect(saved).toMatchObject({
      segment: 'full', data_env: 'production-readonly', strategy: 'sma-cross', params: { fast: 9, slow: 21 },
      symbol: 'BTC/USDT', timeframe: '1h', capital: 20, fee_rate: 0.001, slippage_bps: 5,
      period_from: new Date(T0 + 50 * H).toISOString(), created_at: new Date(NOW).toISOString(),
    });
    expect(saved.metrics).toMatchObject({ trades: segment.report.trades, netPnl: segment.report.netPnl, maxDrawdown: segment.report.maxDrawdown });
    expect(saved.settings.limits).toEqual({ maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 });
    expect(saved.trades).toHaveLength(segment.report.trades);

    const csv = fs.readFileSync(saved.csv_path, 'utf8').trim().split('\n');
    expect(path.basename(saved.csv_path)).toBe(`backtest-${segment.runId}-full.csv`);
    expect(csv[0]).toBe('n,entry_time,entry_price,exit_time,exit_price,qty,fees,pnl,pnl_pct');
    expect(csv).toHaveLength(segment.report.trades + 1);
    const first = csv[1].split(',');
    expect(Number(first[7])).toBeCloseTo(saved.trades[0].pnl, 6);
  });

  it('--no-save no guarda nada', async () => {
    await run({ save: false });
    expect(new BacktestStore(db).listRuns()).toHaveLength(0);
    expect(fs.readdirSync(tmp.dir)).toEqual([]);
  });
});

describe('período de ajuste y de validación', () => {
  const split = T0 + 50 * H + 40 * 24 * H;

  it('reporta y guarda cada período por separado, enlazados por grupo', async () => {
    const result = await run({ split });
    expect(result.segments.map((s) => s.segment)).toEqual(['train', 'validation']);
    const [train, validation] = result.segments;
    expect(train.report.period).toMatchObject({ from: new Date(T0 + 50 * H).toISOString(), to: new Date(split).toISOString() });
    expect(validation.report.period.from).toBe(new Date(split).toISOString());
    // cada período arranca con su propio capital
    expect(train.report.capital).toBe(20);
    expect(validation.report.capital).toBe(20);
    const group = new BacktestStore(db).getGroup(result.groupId);
    expect(group.map((r) => r.segment)).toEqual(['train', 'validation']);
  });

  it('grid: elige los mejores parámetros SOLO con el período de ajuste y valida solo esos', async () => {
    const result = await run({ split, grid: { fast: [5, 9, 30], slow: [21, 30] } });
    // fast=30 con slow 21 o 30 es inválido (fast debe ser menor): quedan 4 combinaciones
    expect(result.grid).toHaveLength(4);
    const netPnls = result.grid.map((g) => g.netPnl);
    expect(netPnls).toEqual([...netPnls].sort((a, b) => b - a)); // ordenadas de mejor a peor
    const [train, validation] = result.segments;
    expect(train.params).toEqual(result.grid[0].params);
    expect(validation.params).toEqual(result.grid[0].params);
    expect(new BacktestStore(db).getRun(train.runId).settings.grid).toHaveLength(4);
  });

  it('validaciones de fechas', async () => {
    await expect(run({ from: T0 + 10 * H, to: T0 + 10 * H })).rejects.toThrow(/inicio del período debe ser anterior/);
    await expect(run({ to: NOW + H })).rejects.toThrow(/no puede estar en el futuro/);
    await expect(run({ split: T0 })).rejects.toThrow(/dentro del período/);
    await expect(run({ params: { fast: 30, slow: 10 } })).rejects.toThrow(/fast: debe ser menor que slow/);
  });
});

describe('reproducible de punta a punta', () => {
  it('mismo período y parámetros → mismo resultado (salvo id y fecha de guardado)', async () => {
    const a = await run({ split: T0 + 50 * H + 40 * 24 * H });
    const b = await run({ split: T0 + 50 * H + 40 * 24 * H });
    const strip = (r) => r.segments.map((s) => s.report);
    expect(strip(b)).toEqual(strip(a));
  });
});
