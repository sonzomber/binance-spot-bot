/**
 * Motor de backtest.
 *
 * Usa EXACTAMENTE los mismos módulos que el bot en vivo: la misma clase de
 * estrategia, el mismo RiskManager (límites, filtros del par, PnL con
 * comisiones, pérdida diaria), el mismo OrderExecutor y el mismo PaperVenue que
 * el dry-run (mismo modelo de comisión y slippage). Todo sobre una base de datos
 * SQLite en memoria, propia de cada corrida, y con un reloj simulado.
 *
 * Sin sesgo de futuro ("look-ahead bias"): en cada vela, en orden temporal,
 *   1. APERTURA: se ejecuta la señal pendiente de la vela anterior, al precio de
 *      apertura de esta vela (más slippage).
 *   2. CIERRE: límites de riesgo (pérdida diaria, con lo no realizado) y punto de
 *      la curva de capital.
 *   3. CIERRE: la estrategia evalúa con las velas hasta esta (inclusive). Si hay
 *      señal, queda pendiente para la apertura de la SIGUIENTE vela.
 * Una señal nunca se ejecuta a un precio que ya se conocía al generarla.
 *
 * Pérdida diaria: si se alcanza, el riesgo detiene el "bot" como en vivo; aquí la
 * reanudación manual se simula a las 00:00 UTC del día siguiente.
 *
 * Reproducible: sin azar ni reloj real (IDs de orden deterministas, reloj
 * simulado). Mismas velas y parámetros → mismo resultado, siempre.
 */
import os from 'node:os';
import path from 'node:path';
import { OrderExecutor } from '../execution/executor.js';
import { PaperVenue } from '../execution/venues.js';
import { timeframeToMs } from '../lib/timeframes.js';
import { KillSwitch } from '../risk/kill-switch.js';
import { checkMarketFilters } from '../risk/market-filters.js';
import { utcDay } from '../risk/pnl.js';
import { RiskManager } from '../risk/risk-manager.js';
import { openDatabase } from '../storage/db.js';
import { OrderStore } from '../storage/order-store.js';
import { RiskStore } from '../storage/risk-store.js';
import { buyAndHold, maxDrawdown, tradeStats } from './metrics.js';

export class BacktestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BacktestError';
  }
}

const SILENT = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return SILENT; } };
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {object} args
 * @param {Array<{time,open,high,low,close,volume}>} args.candles velas cerradas, en orden; puede incluir
 *        velas ANTERIORES al período (solo para calentar indicadores)
 * @param {number} args.from inicio del período a operar (ms, inclusive)
 * @param {number} args.to fin del período (ms, exclusivo)
 * @param {import('../strategy/base-strategy.js').Strategy} args.strategy instancia (misma clase que en vivo)
 * @param {object} args.market reglas del par (precision, limits)
 * @param {string} args.timeframe
 * @param {number} args.capital capital inicial (USDT)
 * @param {number} args.feeRate
 * @param {number} args.slippageBps
 * @param {{ maxTradeUsdt: number, maxDailyLossUsdt: number, maxOpenPositions: number }} args.limits
 * @param {import('pino').Logger} [args.logger]
 */
export async function runBacktest({ candles, from, to, strategy, market, timeframe, capital, feeRate, slippageBps, limits, logger = SILENT }) {
  const stepMs = timeframeToMs(timeframe);
  const symbol = market.symbol;
  const start = candles.findIndex((c) => c.time >= from);
  const endIdx = candles.findIndex((c) => c.time >= to);
  const end = endIdx === -1 ? candles.length : endIdx;
  if (start === -1 || start >= end) throw new BacktestError(`no hay velas en el período ${iso(from)} → ${iso(to)}`);
  const period = candles.slice(start, end);

  // --- El "bot" simulado: los módulos reales sobre una base de datos en memoria --------
  const db = openDatabase(':memory:');
  const scope = { env: 'testnet', mode: 'dry-run' }; // ámbito interno de la base temporal
  let clock = period[0].time;
  const now = () => clock;
  let price = period[0].open;
  let cash = capital;
  const risk = new RiskManager({
    store: new RiskStore(db, scope),
    // un archivo que no existe: en un backtest nadie activa el kill switch
    killSwitch: new KillSwitch(path.join(os.tmpdir(), `backtest-sin-kill-switch-${process.pid}`)),
    limits, feeRate, slippageBps, logger, now,
  });
  const orders = new OrderStore(db, scope, { now });
  let sequence = 0;
  const executor = new OrderExecutor({
    risk, orders, market, logger, now,
    venue: new PaperVenue({ scope, market, feeRate, slippageBps, now }),
    getPrice: () => price,
    getFreeQuote: () => cash,
    idGenerator: () => `bt-${String(++sequence).padStart(6, '0')}`,
  });

  try {
    // El capital debe alcanzar al menos una orden válida del par.
    const probe = risk.sizeBuy({ market, price: period[0].open, budget: capital });
    const violations = probe.amount > 0
      ? checkMarketFilters({ side: 'buy', type: 'market', amount: probe.amount, price: period[0].open }, market)
      : ['la cantidad resultante es 0'];
    if (violations.length) {
      throw new BacktestError(`con un capital de ${capital} USDT no se puede comprar ${symbol}: ${violations.join('; ')}`);
    }

    const equity = [{ time: period[0].time, value: capital }];
    const decisions = [];
    let pending = null;
    let haltDay = null;
    let halts = 0;
    let unexecutedFinalSignal = null;

    for (let i = start; i < end; i++) {
      const candle = candles[i];

      // 1. APERTURA ---------------------------------------------------------------------
      clock = candle.time;
      price = candle.open;
      if (haltDay !== null && utcDay(clock) !== haltDay) {
        risk.resume({ by: 'backtest: reanudación simulada a las 00:00 UTC' });
        haltDay = null;
      }
      if (pending) {
        const result = await executor.submit(pending.intent);
        applyToCash(result);
        decisions.push({ signalTime: iso(pending.signalTime), executedAt: iso(clock), side: pending.intent.side, price, status: result.status, code: result.code ?? null });
        pending = null;
      }

      // 2. CIERRE: límites y curva de capital ------------------------------------------------
      clock = candle.time + stepMs - 1;
      price = candle.close;
      if (haltDay === null) {
        const check = await risk.enforceLimits({ markPrices: { [symbol]: candle.close }, cancelOpenOrders: () => executor.cancelAll() });
        if (check.halted) {
          halts++;
          haltDay = utcDay(clock);
        }
      }
      equity.push({ time: candle.time, value: cash + openValue(candle.close) });

      // 3. CIERRE: señal para la apertura de la vela siguiente ------------------------------------
      const window = candles.slice(Math.max(0, i + 1 - strategy.lookback), i + 1);
      const signal = strategy.evaluate(window, { position: risk.store.openPositions()[0] ?? null });
      if (signal.action !== 'HOLD') {
        const intent = {
          side: signal.action.toLowerCase(),
          signalKey: `${strategy.id}:${symbol}:${timeframe}:${candle.time}:${signal.action}`,
          strategy: strategy.id,
          signalCode: signal.code,
        };
        if (i + 1 < end) pending = { intent, signalTime: candle.time };
        else unexecutedFinalSignal = { time: iso(candle.time), action: signal.action }; // no hay vela siguiente
      }
    }

    // --- Resultado --------------------------------------------------------------------------
    const last = period.at(-1);
    const open = risk.store.openPositions();
    // Una posición abierta al final se VALORA como si se vendiera al último cierre
    // (con slippage y comisión), pero no cuenta como operación cerrada.
    const liquidation = open.reduce((sum, p) => sum + p.qty * last.close * (1 - slippageBps / 10_000) * (1 - feeRate), 0);
    const finalEquity = cash + liquidation;
    const trades = risk.store.closedPositions().map((p, index) => ({
      n: index + 1,
      entryTime: p.entryTime,
      entryPrice: p.entryPrice,
      exitTime: p.exitTime,
      exitPrice: p.exitPrice,
      qty: p.exitQty,
      fees: p.entryFee + p.exitFee,
      pnl: p.realizedPnl,
      pnlPct: (p.realizedPnl / p.entryCost) * 100,
    }));
    const allOrders = orders.list();
    const rejections = {};
    for (const o of allOrders.filter((x) => x.status === 'rejected')) rejections[o.rejectCode] = (rejections[o.rejectCode] ?? 0) + 1;
    const benchmark = buyAndHold({ firstOpen: period[0].open, lastClose: last.close, capital, feeRate, slippageBps, market });
    const netPnl = finalEquity - capital;

    return {
      period: { from: iso(period[0].time), to: iso(last.time + stepMs), candles: period.length },
      capital,
      finalEquity,
      netPnl,
      netPnlPct: (netPnl / capital) * 100,
      ...tradeStats(trades),
      ...maxDrawdown(equity.map((p) => p.value)),
      totalFees: allOrders.reduce((sum, o) => sum + o.feeQuote, 0),
      buyAndHold: benchmark,
      vsBuyAndHold: benchmark.possible ? netPnl - benchmark.pnl : null,
      openPositionAtEnd: open.length
        ? { qty: open[0].qty, entryPrice: open[0].entryPrice, markPrice: last.close, valuedAt: liquidation }
        : null,
      halts,
      rejections,
      unexecutedFinalSignal,
      tradesList: trades,
      decisions,
      equity,
    };
  } finally {
    db.close();
  }

  function applyToCash(result) {
    const order = result.order;
    if (!order || !(order.filledQty > 0)) return;
    // PaperVenue cobra la comisión en USDT
    cash += order.side === 'buy' ? -(order.filledQuote + order.feeQuote) : order.filledQuote - order.feeQuote;
  }

  function openValue(markPrice) {
    return risk.store.openPositions().reduce((sum, p) => sum + p.qty * markPrice, 0);
  }
}
