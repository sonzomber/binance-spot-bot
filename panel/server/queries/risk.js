/**
 * Riesgo del día en un ámbito: PnL con comisiones, distancia al límite de
 * pérdida diaria y posiciones abiertas contra el máximo.
 *
 * El PnL se calcula con el MISMO RiskManager.dailyPnl() que usa el bot para
 * decidir la parada (no es un cálculo aparte): si la regla cambia, el panel la
 * sigue. Los límites son los del bot en marcha (guardados en su estado); si el
 * bot nunca corrió en este ámbito, los del .env.
 *
 * Precio para valorar las posiciones abiertas: el más reciente entre el último
 * precio que registró el bot y el cierre de la última vela guardada.
 */
import { unrealizedPnl } from '../../../src/risk/pnl.js';
import { RiskManager } from '../../../src/risk/risk-manager.js';
import { BotStatusStore } from '../../../src/storage/bot-status-store.js';
import { CandleStore } from '../../../src/storage/candle-store.js';
import { RiskStore } from '../../../src/storage/risk-store.js';
import { timeframeToMs } from '../../../src/lib/timeframes.js';

const SILENT = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return SILENT; } };

/** Precio más reciente conocido de un par, con su hora y su origen. */
export function markPrice(db, env, { symbol, timeframe, status }) {
  const candidates = [];
  if (status?.price && status.symbol === symbol && status.priceTime) {
    candidates.push({ price: status.price, time: Date.parse(status.priceTime), source: 'bot' });
  }
  const [candle] = new CandleStore(db, { env }).last(symbol, timeframe, 1);
  if (candle) candidates.push({ price: candle.close, time: candle.time + timeframeToMs(timeframe), source: 'candles' });
  const best = candidates.sort((a, b) => b.time - a.time)[0];
  return best ? { ...best, time: new Date(best.time).toISOString() } : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ env: string, mode: string }} scope
 * @param {{ config: object, now: number }} context
 */
export function riskSummary(db, scope, { config, now }) {
  const status = new BotStatusStore(db, scope).get();
  const settings = status?.settings ?? null;
  const limits = {
    maxTradeUsdt: settings?.maxTradeUsdt ?? config.limits.maxTradeUsdt,
    maxDailyLossUsdt: settings?.maxDailyLossUsdt ?? config.limits.maxDailyLossUsdt,
    maxOpenPositions: settings?.maxOpenPositions ?? config.limits.maxOpenPositions,
  };
  const feeRate = settings?.feeRate ?? config.feeRate;
  const symbol = status?.symbol ?? config.symbol;
  const timeframe = status?.timeframe ?? config.timeframe;

  const store = new RiskStore(db, scope);
  const risk = new RiskManager({ store, limits, feeRate, slippageBps: settings?.slippageBps ?? config.slippageBps, logger: SILENT, now: () => now });
  const mark = markPrice(db, scope.env, { symbol, timeframe, status });
  const markPrices = mark ? { [symbol]: mark.price } : {};
  const daily = risk.dailyPnl(markPrices);

  const positions = store.openPositions().map((p) => {
    const price = markPrices[p.symbol];
    return {
      id: p.id,
      symbol: p.symbol,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryCost: p.entryCost,
      entryTime: p.entryTime,
      markPrice: price ?? null,
      // Sin precio actual, igual que el bot: se valora a precio de entrada (solo cuenta comisiones).
      unrealized: unrealizedPnl(p, price ?? p.entryPrice, feeRate),
    };
  });

  const lossLimit = limits.maxDailyLossUsdt;
  return {
    scope,
    day: daily.day,
    realized: daily.realized,
    realizedFees: daily.realizedFees,
    closedTrades: daily.closedTrades,
    unrealized: daily.unrealized,
    total: daily.total,
    missingPrices: daily.missingPrices,
    lossLimit,
    // Cuánto puede empeorar el PnL del día antes de la parada (se para al llegar a −límite).
    remaining: Math.max(0, daily.total + lossLimit),
    usedPct: Math.min(100, Math.max(0, (-daily.total / lossLimit) * 100)),
    reached: risk.isDailyLossReached(daily),
    limits,
    limitsSource: settings ? 'bot' : 'env',
    feeRate,
    mark,
    positions,
    openPositions: positions.length,
    maxOpenPositions: limits.maxOpenPositions,
    halt: store.getHaltState(),
  };
}
