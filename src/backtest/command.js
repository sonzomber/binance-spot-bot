/**
 * El comando de backtest, como función (lo usa scripts/backtest.js y las pruebas).
 *
 *   1. Descarga (o toma del caché) las velas del período, más las previas
 *      necesarias para calentar los indicadores, desde producción en SOLO LECTURA.
 *   2. Si faltan velas (huecos), avisa y NO corre, salvo con allowGaps.
 *   3. Corre el período completo, o bien:
 *      - split: un período para AJUSTAR parámetros y otro, separado y posterior,
 *        para VALIDAR. Con grid, prueba cada combinación en el de ajuste, elige la
 *        mejor y solo esa se valida. Cada período se reporta por separado.
 *   4. Guarda cada resultado en SQLite y exporta sus operaciones a CSV.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { timeframeToMs } from '../lib/timeframes.js';
import { CandleStore, formatGapWarning } from '../storage/candle-store.js';
import { createStrategy } from '../strategy/registry.js';
import { BacktestError, runBacktest } from './engine.js';
import { BacktestStore, writeTradesCsv } from './results.js';

export const DATA_ENV = 'production-readonly';

/**
 * @param {object} options
 * @param {string} options.symbol
 * @param {string} options.timeframe
 * @param {number} options.from ms UTC (inclusive)
 * @param {number} options.to ms UTC (exclusivo)
 * @param {string} options.strategyId
 * @param {object} options.params parámetros de la estrategia
 * @param {number} options.capital
 * @param {number} options.feeRate
 * @param {number} options.slippageBps
 * @param {object} options.limits límites de riesgo de la config
 * @param {number} [options.split] ms UTC: inicio del período de validación
 * @param {Record<string, number[]>} [options.grid] valores a probar en el período de ajuste
 * @param {boolean} [options.allowGaps]
 * @param {boolean} [options.save]
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {import('./market-data-client.js').MarketDataClient} deps.client
 * @param {string} deps.csvDir
 * @param {() => number} [deps.now]
 * @param {import('pino').Logger} [deps.logger]
 */
export async function backtestCommand(options, { db, client, csvDir, now = Date.now, logger }) {
  const { symbol, timeframe, from, to, split, grid, allowGaps = false, save = true } = options;
  if (!(from < to)) throw new BacktestError('el inicio del período debe ser anterior al fin');
  if (to > now()) throw new BacktestError('el fin del período no puede estar en el futuro');
  if (split !== undefined && !(from < split && split < to)) {
    throw new BacktestError('la fecha de división debe estar dentro del período');
  }

  // Estrategias a probar (valida los parámetros antes de descargar nada)
  const candidates = await buildCandidates(options.strategyId, options.params, grid);
  const lookback = Math.max(...candidates.map((s) => Math.max(s.lookback, s.warmup)));

  // 1. Datos: período + velas previas para calentar indicadores
  const stepMs = timeframeToMs(timeframe);
  const dataFrom = from - lookback * stepMs;
  const store = new CandleStore(db, { env: DATA_ENV });
  const market = await client.fetchMarket(symbol);
  const report = store.findGaps(symbol, timeframe, { from: dataFrom, to });
  for (const gap of report.gaps) {
    const candles = await client.fetchCandles(symbol, timeframe, { from: gap.from, to: gap.to + stepMs, now: now() });
    const { inserted } = store.upsert(symbol, timeframe, candles, { now: now() });
    logger?.info({ from: new Date(gap.from).toISOString(), inserted }, `Descargadas ${inserted} velas`);
  }

  // 2. Huecos: sin permiso explícito, no se corre
  const gaps = store.findGaps(symbol, timeframe, { from: dataFrom, to });
  const warning = formatGapWarning(gaps);
  if (warning && !allowGaps) {
    return { ok: false, reason: 'gaps', warning, gaps };
  }
  if (warning) logger?.warn(warning);
  const candles = store.get(symbol, timeframe, { from: dataFrom, to });

  // 3. Corridas
  const base = {
    candles, market, timeframe, capital: options.capital, feeRate: options.feeRate,
    slippageBps: options.slippageBps, limits: options.limits,
  };
  const groupId = randomUUID();
  const segments = [];
  let gridResults = null;
  if (split === undefined) {
    segments.push({ segment: 'full', strategy: candidates[0], report: await runBacktest({ ...base, strategy: candidates[0], from, to }) });
  } else {
    // Ajuste: cada candidato en el período de ajuste; se elige el mejor.
    const trained = [];
    for (const strategy of candidates) {
      trained.push({ strategy, report: await runBacktest({ ...base, strategy, from, to: split }) });
    }
    trained.sort(compareResults);
    const best = trained[0];
    gridResults = candidates.length > 1
      ? trained.map((t) => ({ params: t.strategy.params, netPnl: t.report.netPnl, trades: t.report.trades, profitFactor: t.report.profitFactor }))
      : null;
    segments.push({ segment: 'train', strategy: best.strategy, report: best.report });
    // Validación: SOLO la mejor, en datos que no se usaron para elegirla.
    segments.push({ segment: 'validation', strategy: best.strategy, report: await runBacktest({ ...base, strategy: best.strategy, from: split, to }) });
  }

  // 4. Guardar
  const results = new BacktestStore(db);
  const saved = [];
  for (const { segment, strategy, report: result } of segments) {
    let runId = null;
    let csvPath = null;
    if (save) {
      runId = results.saveRun({
        groupId, segment, createdAt: now(), dataEnv: DATA_ENV, strategy: strategy.id, params: strategy.params,
        symbol, timeframe, report: result, capital: options.capital, feeRate: options.feeRate, slippageBps: options.slippageBps,
        settings: { limits: options.limits, market: { precision: market.precision, limits: market.limits }, grid: segment === 'train' ? gridResults : undefined },
      });
      csvPath = writeTradesCsv(path.join(csvDir, `backtest-${runId}-${segment}.csv`), result.tradesList);
      results.setCsvPath(runId, csvPath);
    }
    saved.push({ segment, runId, csvPath, params: strategy.params, report: result });
  }
  return { ok: true, groupId, market, gapsWarning: warning, grid: gridResults, segments: saved };
}

/** Mejor resultado primero: mayor PnL neto; a igualdad, mayor profit factor y menor drawdown. */
function compareResults(a, b) {
  return (b.report.netPnl - a.report.netPnl)
    || ((b.report.profitFactor ?? 0) - (a.report.profitFactor ?? 0))
    || (a.report.maxDrawdown - b.report.maxDrawdown);
}

/** Una estrategia por combinación del grid (las inválidas, p. ej. fast ≥ slow, se descartan). */
async function buildCandidates(strategyId, params, grid) {
  if (!grid) return [await createStrategy(strategyId, params)];
  const keys = Object.keys(grid);
  let combos = [{ ...params }];
  for (const key of keys) {
    if (!Array.isArray(grid[key]) || grid[key].length === 0) throw new BacktestError(`grid.${key} debe ser una lista de valores`);
    combos = combos.flatMap((combo) => grid[key].map((value) => ({ ...combo, [key]: value })));
  }
  const strategies = [];
  for (const combo of combos) {
    try {
      strategies.push(await createStrategy(strategyId, combo));
    } catch {
      // combinación inválida para la estrategia: se omite
    }
  }
  if (strategies.length === 0) throw new BacktestError('ninguna combinación del grid es válida para la estrategia');
  return strategies;
}
