/**
 * Métricas del backtest: funciones puras sobre las operaciones y la curva de capital.
 *
 *   Profit factor = ganancias brutas / pérdidas brutas. > 1 gana más de lo que pierde.
 *   Máximo drawdown = la mayor caída del capital desde un máximo hasta un mínimo
 *   posterior: "cuánto dolor" hubo que aguantar en el peor momento.
 */
import { roundDownToStep } from '../risk/market-filters.js';

/**
 * @param {Array<{ pnl: number }>} trades operaciones cerradas (PnL neto de comisiones)
 */
export function tradeStats(trades) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = -losses.reduce((sum, t) => sum + t.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    grossProfit,
    grossLoss,
    // Sin operaciones perdedoras el cociente no está definido (sería infinito): se deja null.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}

/**
 * Máximo drawdown de una curva de capital.
 * @param {number[]} values capital en cada punto (el primero, el capital inicial)
 * @returns {{ maxDrawdown: number, maxDrawdownPct: number, peak: number, trough: number }}
 */
export function maxDrawdown(values) {
  let peak = -Infinity;
  let result = { maxDrawdown: 0, maxDrawdownPct: 0, peak: values[0] ?? 0, trough: values[0] ?? 0 };
  for (const value of values) {
    peak = Math.max(peak, value);
    const drawdown = peak - value;
    if (drawdown > result.maxDrawdown) {
      result = { maxDrawdown: drawdown, maxDrawdownPct: (drawdown / peak) * 100, peak, trough: value };
    }
  }
  return result;
}

/**
 * Comprar y mantener en el mismo período, con las mismas reglas: compra con todo
 * el capital a la apertura de la primera vela (más slippage y comisión, cantidad
 * redondeada al paso del par) y valoración a la venta al cierre de la última.
 * @returns {{ possible: boolean, reason?: string, qty?, entryPrice?, exitPrice?, finalEquity?, pnl?, pnlPct? }}
 */
export function buyAndHold({ firstOpen, lastClose, capital, feeRate, slippageBps, market }) {
  const slippage = slippageBps / 10_000;
  const entryPrice = firstOpen * (1 + slippage);
  const qty = roundDownToStep(capital / (entryPrice * (1 + feeRate)), market.precision?.amount);
  const minCost = market.limits?.cost?.min ?? 0;
  if (!(qty > 0) || qty < (market.limits?.amount?.min ?? 0) || qty * entryPrice < minCost) {
    return { possible: false, reason: `con ${capital} USDT no se alcanza el mínimo del par` };
  }
  const cost = qty * entryPrice * (1 + feeRate);
  const exitPrice = lastClose * (1 - slippage);
  const finalEquity = capital - cost + qty * exitPrice * (1 - feeRate);
  const pnl = finalEquity - capital;
  return { possible: true, qty, entryPrice, exitPrice, finalEquity, pnl, pnlPct: (pnl / capital) * 100 };
}
