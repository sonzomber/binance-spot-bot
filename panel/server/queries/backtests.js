/**
 * Resultados de backtests guardados: lista (agrupada por corrida) y detalle con
 * métricas, parámetros, período, operaciones, curva de capital y la curva de
 * "comprar y mantener" para comparar.
 *
 * Curvas (un punto por vela, en la hora en que vale ese capital):
 *   - capital de la estrategia: la guardada por el backtest (tabla
 *     backtest_equity). Los backtests guardados antes de la v5 no la tienen: se
 *     usa una curva por operación (capital inicial + PnL de cada operación
 *     cerrada) y se indica en `equitySource`.
 *   - comprar y mantener: la MISMA función buyAndHold() del backtest (metrics.js),
 *     valorando al cierre de cada vela guardada en el caché. Su último punto es
 *     el "comprar y mantener" del reporte.
 */
import { buyAndHold } from '../../../src/backtest/metrics.js';
import { timeframeToMs } from '../../../src/lib/timeframes.js';
import { CandleStore } from '../../../src/storage/candle-store.js';

export const MAX_CURVE_POINTS = 2000;

const parse = (json) => (json ? JSON.parse(json) : null);

/** Resumen de las métricas para la lista. */
function summary(metrics) {
  return {
    netPnl: metrics.netPnl,
    netPnlPct: metrics.netPnlPct,
    trades: metrics.trades,
    winRatePct: metrics.winRatePct,
    profitFactor: metrics.profitFactor,
    maxDrawdownPct: metrics.maxDrawdownPct,
    buyAndHoldPnl: metrics.buyAndHold?.possible ? metrics.buyAndHold.pnl : null,
    vsBuyAndHold: metrics.vsBuyAndHold,
  };
}

/** Corridas guardadas, agrupadas (ajuste + validación comparten grupo), la más reciente primero. */
export function listBacktests(db, { limit = 50 } = {}) {
  const rows = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM backtest_equity e WHERE e.run_id = r.id) AS equity_points
       FROM backtest_runs r
      WHERE r.group_id IN (SELECT group_id FROM backtest_runs GROUP BY group_id ORDER BY MAX(id) DESC LIMIT @limit)
      ORDER BY r.id DESC`,
  ).all({ limit });
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group_id)) {
      groups.set(row.group_id, {
        groupId: row.group_id, createdAt: row.created_at, strategy: row.strategy, symbol: row.symbol,
        timeframe: row.timeframe, dataEnv: row.data_env, runs: [],
      });
    }
    groups.get(row.group_id).runs.unshift({
      id: row.id,
      segment: row.segment,
      params: parse(row.params),
      periodFrom: row.period_from,
      periodTo: row.period_to,
      capital: row.capital,
      hasEquity: row.equity_points > 0,
      ...summary(parse(row.metrics)),
    });
  }
  return { groups: [...groups.values()] };
}

/** Reduce una curva a como máximo `max` puntos (conserva el primero y el último). */
export function downsample(points, max = MAX_CURVE_POINTS) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/**
 * Detalle de una corrida.
 * @returns {object|null} null si no existe
 */
export function backtestDetail(db, id) {
  const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  if (!row) return null;
  const metrics = parse(row.metrics);
  const settings = parse(row.settings);
  const stepMs = timeframeToMs(row.timeframe);
  const from = Date.parse(row.period_from);
  const to = Date.parse(row.period_to);

  // Curva de la estrategia: n = 0 es el capital inicial (inicio del período);
  // n ≥ 1 vale al CIERRE de la vela que empieza en `time`.
  let equitySource = 'candles';
  let equity = db.prepare('SELECT n, time, equity FROM backtest_equity WHERE run_id = ? ORDER BY n').all(id)
    .map((p) => ({ time: p.n === 0 ? p.time : p.time + stepMs, value: p.equity }));
  const trades = db.prepare(
    'SELECT n, entry_time, entry_price, exit_time, exit_price, qty, fees, pnl, pnl_pct FROM backtest_trades WHERE run_id = ? ORDER BY n',
  ).all(id).map((t) => ({
    n: t.n, entryTime: t.entry_time, entryPrice: t.entry_price, exitTime: t.exit_time, exitPrice: t.exit_price,
    qty: t.qty, fees: t.fees, pnl: t.pnl, pnlPct: t.pnl_pct,
  }));
  if (equity.length === 0) {
    // Guardado antes de la v5: curva por operación cerrada.
    equitySource = 'trades';
    let capital = row.capital;
    equity = [{ time: from, value: capital }, ...trades.map((t) => ({ time: Date.parse(t.exitTime), value: (capital += t.pnl) }))];
  }

  // Comprar y mantener, vela a vela, con la misma función del reporte.
  const candles = new CandleStore(db, { env: row.data_env }).get(row.symbol, row.timeframe, { from, to });
  const expected = Math.round((to - from) / stepMs);
  let buyHold = null;
  let buyHoldNote = null;
  if (!settings?.market) {
    buyHoldNote = 'faltan los filtros del par en el resultado guardado';
  } else if (candles.length === 0 || candles[0].time !== from) {
    buyHoldNote = 'las velas del período ya no están en el caché';
  } else {
    const base = { firstOpen: candles[0].open, capital: row.capital, feeRate: row.fee_rate, slippageBps: row.slippage_bps, market: settings.market };
    const first = buyAndHold({ ...base, lastClose: candles[0].close });
    if (!first.possible) {
      buyHoldNote = first.reason;
    } else {
      buyHold = [{ time: from, value: row.capital }, ...candles.map((c) => ({ time: c.time + stepMs, value: buyAndHold({ ...base, lastClose: c.close }).finalEquity }))];
      if (candles.length < expected) buyHoldNote = `faltan ${expected - candles.length} velas del período en el caché`;
    }
  }

  const group = db.prepare('SELECT id, segment FROM backtest_runs WHERE group_id = ? ORDER BY id').all(row.group_id);
  return {
    id: row.id,
    groupId: row.group_id,
    group,
    segment: row.segment,
    createdAt: row.created_at,
    dataEnv: row.data_env,
    strategy: row.strategy,
    params: parse(row.params),
    symbol: row.symbol,
    timeframe: row.timeframe,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    capital: row.capital,
    feeRate: row.fee_rate,
    slippageBps: row.slippage_bps,
    settings: { limits: settings?.limits ?? null, grid: settings?.grid ?? null },
    metrics,
    trades,
    equitySource,
    equity: downsample(equity),
    equityPoints: equity.length,
    buyHold: buyHold && downsample(buyHold),
    buyHoldNote,
  };
}
