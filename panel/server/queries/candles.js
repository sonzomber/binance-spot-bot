/**
 * Datos del gráfico de un ámbito: velas cerradas del caché, los indicadores
 * de la estrategia y las marcas de compra/venta.
 *
 * Indicadores: no se recalculan aparte. Para cada vela se llama a
 * strategy.evaluate() con la MISMA ventana que le pasa el bot (las últimas
 * `lookback` velas) y se toman los indicadores que la estrategia reporta (en
 * sma-cross: smaFast y smaSlow). Así el gráfico muestra exactamente lo que la
 * estrategia "vio" al decidir. Para que las primeras velas visibles también
 * tengan valores, se leen `lookback` velas extra hacia atrás.
 *
 * Marcas: órdenes del ámbito con algo ejecutado, en la vela de su primera ejecución.
 */
import { alignDown, timeframeToMs } from '../../../src/lib/timeframes.js';
import { BotStatusStore } from '../../../src/storage/bot-status-store.js';
import { CandleStore } from '../../../src/storage/candle-store.js';
import { createStrategy } from '../../../src/strategy/registry.js';

export const MAX_CANDLES = 1000;

/** Estrategias ya creadas (crearlas lee el directorio de estrategias). */
const strategies = new Map();
async function getStrategy(id, params) {
  const key = `${id}:${JSON.stringify(params ?? {})}`;
  if (!strategies.has(key)) strategies.set(key, await createStrategy(id, params ?? {}));
  return strategies.get(key);
}

/**
 * Qué graficar: lo que usa el bot en marcha (su estado); si nunca corrió, el .env.
 * Síncrono: se llama dentro de la transacción de lectura.
 */
export function chartTarget(db, scope, { config }) {
  const status = new BotStatusStore(db, scope).get();
  return {
    symbol: status?.symbol ?? config.symbol,
    timeframe: status?.timeframe ?? config.timeframe,
    strategy: { id: status?.strategy ?? config.strategy.id, params: status?.params ?? config.strategy.params },
    source: status ? 'bot' : 'env',
  };
}

/** La estrategia (o el motivo por el que no se pudo crear), fuera de la transacción. */
export async function loadStrategy({ id, params }) {
  if (!id) return { strategy: null, error: 'no hay estrategia configurada (STRATEGY) ni estado del bot' };
  try {
    return { strategy: await getStrategy(id, params), error: null };
  } catch (err) {
    return { strategy: null, error: err.message };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ env: string, mode: string }} scope
 * @param {{ target: ReturnType<typeof chartTarget>, strategy: object|null, strategyError: string|null, limit: number }} args
 */
export function candleChart(db, scope, { target, strategy, strategyError, limit }) {
  const { symbol, timeframe } = target;
  const stepMs = timeframeToMs(timeframe);
  const extra = strategy ? Math.max(strategy.lookback, strategy.warmup) : 0;
  const candles = new CandleStore(db, { env: scope.env }).last(symbol, timeframe, limit + extra);
  const firstShown = Math.max(0, candles.length - limit);
  const shown = candles.slice(firstShown);

  // Indicadores: lo que reporta la estrategia vela a vela, con la ventana del bot.
  const series = new Map();
  if (strategy) {
    for (let i = firstShown; i < candles.length; i++) {
      const window = candles.slice(Math.max(0, i + 1 - strategy.lookback), i + 1);
      let indicators;
      try {
        indicators = strategy.evaluate(window, { position: null }).indicators;
      } catch {
        indicators = null; // una ventana inválida no rompe el gráfico
      }
      for (const [key, value] of Object.entries(indicators ?? {})) {
        if (!Number.isFinite(value)) continue;
        if (!series.has(key)) series.set(key, []);
        series.get(key).push({ time: candles[i].time, value });
      }
    }
  }

  // Marcas: órdenes con algo ejecutado, en la vela de su primera ejecución.
  const from = shown[0]?.time ?? 0;
  const to = (shown.at(-1)?.time ?? 0) + stepMs;
  const markers = db.prepare(
    `SELECT o.client_order_id AS clientOrderId, o.side, o.status, o.filled_qty AS qty, o.avg_fill_price AS price,
            COALESCE(MIN(f.time), o.accepted_at, o.created_at) AS executedAt
       FROM orders o LEFT JOIN order_fills f ON f.order_id = o.id
      WHERE o.env = @env AND o.mode = @mode AND o.symbol = @symbol AND o.filled_qty > 0
      GROUP BY o.id
      ORDER BY executedAt`,
  ).all({ ...scope, symbol })
    .map((m) => ({ ...m, candleTime: alignDown(Date.parse(m.executedAt), stepMs) }))
    .filter((m) => m.candleTime >= from && m.candleTime < to);

  return {
    scope,
    symbol,
    timeframe,
    stepMs,
    source: target.source,
    strategy: { ...target.strategy, error: strategyError },
    candles: shown,
    series: [...series].map(([key, points]) => ({ key, points })),
    markers,
  };
}
