/**
 * Backtest con velas históricas de PRODUCCIÓN (solo lectura, data-api.binance.vision).
 *
 *   npm run backtest -- --from 2025-01-01 --to 2025-07-01
 *   npm run backtest -- --from 2025-01-01 --to 2025-07-01 --split 2025-05-01
 *   npm run backtest -- --from 2025-01-01 --to 2025-07-01 --split 2025-05-01 --grid '{"fast":[5,9,12],"slow":[21,30]}'
 *
 * Opciones (por defecto, los valores del .env):
 *   --symbol BTC/USDT   --timeframe 1h   --strategy sma-cross   --params '{"fast":9,"slow":21}'
 *   --capital 20        --fee 0.001      --slippage-bps 5
 *   --split FECHA       período de ajuste [from, split) y de validación [split, to)
 *   --grid JSON         valores a probar en el período de ajuste (requiere --split)
 *   --allow-gaps        correr aunque falten velas (por defecto no corre y avisa)
 *   --no-save           no guardar en SQLite ni exportar CSV
 *
 * Fechas en UTC (AAAA-MM-DD o ISO completo). Los límites de riesgo son los del .env.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { backtestCommand } from '../src/backtest/command.js';
import { BacktestError } from '../src/backtest/engine.js';
import { MarketDataClient } from '../src/backtest/market-data-client.js';
import { formatGrid, formatReport } from '../src/backtest/report.js';
import { ConfigError, TIMEFRAMES, loadConfig, loadEnvFile } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { openDatabase } from '../src/storage/db.js';
import { StrategyError } from '../src/strategy/base-strategy.js';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' }, to: { type: 'string' }, split: { type: 'string' },
    symbol: { type: 'string' }, timeframe: { type: 'string' }, strategy: { type: 'string' }, params: { type: 'string' },
    capital: { type: 'string' }, fee: { type: 'string' }, 'slippage-bps': { type: 'string' },
    grid: { type: 'string' }, 'allow-gaps': { type: 'boolean' }, 'no-save': { type: 'boolean' },
  },
});

const fail = (message) => {
  console.error(`Backtest: ${message}`);
  process.exitCode = 1;
};
const date = (value, name) => {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) throw new BacktestError(`--${name} inválida: "${value}" (usa AAAA-MM-DD, en UTC)`);
  return ms;
};
const number = (value, name, fallback) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new BacktestError(`--${name} debe ser un número ≥ 0`);
  return n;
};
const json = (value, name) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new BacktestError(`--${name} debe ser JSON válido, p. ej. '{"fast":9,"slow":21}'`);
  }
};

loadEnvFile();
let db;
try {
  const config = loadConfig();
  if (!args.from || !args.to) throw new BacktestError('faltan --from y --to (p. ej. --from 2025-01-01 --to 2025-07-01)');
  if (args.grid && !args.split) throw new BacktestError('--grid necesita --split: se ajusta en un período y se valida en otro');
  const timeframe = args.timeframe ?? config.timeframe;
  if (!TIMEFRAMES.includes(timeframe)) throw new BacktestError(`--timeframe debe ser uno de: ${TIMEFRAMES.join(', ')}`);

  const logger = createLogger({ ...config.log, level: 'warn' });
  db = openDatabase(config.storage.dbPath);
  const result = await backtestCommand(
    {
      symbol: (args.symbol ?? config.symbol).toUpperCase(),
      timeframe,
      from: date(args.from, 'from'),
      to: date(args.to, 'to'),
      split: args.split ? date(args.split, 'split') : undefined,
      strategyId: args.strategy ?? config.strategy.id,
      params: args.params ? json(args.params, 'params') : config.strategy.params,
      grid: args.grid ? json(args.grid, 'grid') : undefined,
      capital: number(args.capital, 'capital', config.backtest.capital),
      feeRate: number(args.fee, 'fee', config.execution.feeRate),
      slippageBps: number(args['slippage-bps'], 'slippage-bps', config.execution.slippageBps),
      limits: {
        maxTradeUsdt: config.risk.maxTradeUsdt,
        maxDailyLossUsdt: config.risk.maxDailyLossUsdt,
        maxOpenPositions: config.risk.maxOpenPositions,
      },
      allowGaps: Boolean(args['allow-gaps']),
      save: !args['no-save'],
    },
    { db, client: new MarketDataClient({ logger }), csvDir: path.join(path.dirname(config.storage.dbPath), 'backtests'), logger },
  );

  if (!result.ok) {
    console.error(result.warning);
    fail('no se corrió por los huecos en los datos. Para correrlo igual: --allow-gaps');
  } else {
    console.log(`Backtest ${result.segments[0].report.period.from.slice(0, 10)} · ${args.symbol ?? config.symbol} ${timeframe} · datos de producción (solo lectura)\n`);
    if (result.gapsWarning) console.log(`⚠ ${result.gapsWarning}\n`);
    const grid = formatGrid(result.grid);
    if (grid) console.log(`${grid}\n`);
    for (const segment of result.segments) console.log(`${formatReport(segment)}\n`);
  }
} catch (err) {
  if (!(err instanceof ConfigError || err instanceof BacktestError || err instanceof StrategyError)) throw err;
  fail(err.message);
} finally {
  db?.close();
}
