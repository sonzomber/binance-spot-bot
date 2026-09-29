/**
 * "Venues": dónde se ejecuta una orden. El ejecutor usa uno u otro según el modo,
 * con EXACTAMENTE el mismo flujo (riesgo → registro → envío → ejecuciones → posición).
 *
 *   PaperVenue    (dry-run)  → simula la ejecución con slippage y comisión.
 *   ExchangeVenue (exchange) → envía al testnet/demo por el cliente ccxt protegido.
 *
 * Ambos EXIGEN una aprobación auténtica del gestor de riesgo para cada orden.
 *
 * Resultado normalizado de place() y query():
 *   { exchangeOrderId, status: 'open'|'partially_filled'|'filled'|'canceled'|'expired'|'rejected',
 *     fills: [{ tradeId, qty, price, feeAmount, feeCurrency, feeQuote, time }] }
 */
import ccxt from 'ccxt';
import { RateLimitedError } from '../data/rate-limiter.js';
import { roundDownToStep } from '../risk/market-filters.js';
import { consumeApproval } from '../risk/risk-manager.js';
import { simulateMarketFill } from './fill-model.js';
import { getOrderGate } from './order-gate.js';

/** Timeout o error de red al ENVIAR: no se sabe si la orden llegó a Binance. */
export class AmbiguousOrderError extends Error {
  constructor(clientOrderId, cause) {
    super(`resultado desconocido al enviar ${clientOrderId}: ${cause?.message}`, { cause });
    this.name = 'AmbiguousOrderError';
    this.clientOrderId = clientOrderId;
  }
}

/**
 * ¿El error deja la orden en estado desconocido? Timeouts, cortes de red, 5xx y 429.
 * Los rechazos del exchange (fondos insuficientes, orden inválida…) son definitivos:
 * la orden NO se creó. Lo bloqueado por la guardia o el riesgo nunca salió.
 */
export function isAmbiguousSendError(err) {
  return err instanceof ccxt.NetworkError || err instanceof RateLimitedError;
}

// --- Dry-run ---------------------------------------------------------------------------

export class PaperVenue {
  /**
   * @param {object} deps
   * @param {{ env: string, mode: 'dry-run' }} deps.scope
   * @param {object} deps.market mercado ccxt (paso de cantidad)
   * @param {number} deps.feeRate
   * @param {number} deps.slippageBps
   * @param {() => number} [deps.now]
   * @param {number} [deps.fillRatio] fracción que se ejecuta (1 = todo). < 1 simula una
   *        ejecución parcial: la orden de mercado queda "expired" con lo ejecutado.
   */
  constructor({ scope, market, feeRate, slippageBps, now = Date.now, fillRatio = 1 }) {
    Object.assign(this, { scope, market, feeRate, slippageBps, now, fillRatio });
  }

  async place(order, approval) {
    consumeApproval(approval, order, { scope: this.scope, now: this.now() });
    const qty = this.fillRatio >= 1 ? order.amount : roundDownToStep(order.amount * this.fillRatio, this.market.precision?.amount);
    const fills = qty > 0
      ? [{ tradeId: `${order.clientOrderId}-1`, ...simulateMarketFill({ ...order, amount: qty, slippageBps: this.slippageBps, feeRate: this.feeRate, quote: this.market.quote }), time: this.now() }]
      : [];
    return { exchangeOrderId: `paper-${order.clientOrderId}`, status: qty >= order.amount ? 'filled' : 'expired', fills };
  }

  /** En dry-run la ejecución es instantánea: una orden "pending" que quedó de un corte nunca se ejecutó. */
  async query() {
    return { found: false };
  }

  async openOrders() {
    return [];
  }

  async cancelAll() {
    return [];
  }
}

// --- Exchange (testnet / demo) ------------------------------------------------------------

const STATUS = { open: 'open', closed: 'filled', canceled: 'canceled', expired: 'expired', rejected: 'rejected' };

export class ExchangeVenue {
  /**
   * @param {object} deps
   * @param {import('ccxt').Exchange} deps.exchange cliente protegido (guardia + filtro de órdenes)
   * @param {object} deps.market
   * @param {number} deps.feeRate para estimar comisiones cobradas en otra moneda (p. ej. BNB)
   * @param {import('pino').Logger} [deps.logger]
   */
  constructor({ exchange, market, feeRate, logger }) {
    Object.assign(this, { exchange, market, feeRate, logger });
  }

  async place(order, approval) {
    // Autoriza SOLO este clientOrderId en el filtro de red (consume la aprobación).
    getOrderGate(this.exchange).authorize(order, approval);
    let response;
    try {
      response = await this.exchange.createOrder(
        order.symbol, order.type, order.side, order.amount,
        order.type === 'limit' ? order.price : undefined,
        { newClientOrderId: order.clientOrderId },
      );
    } catch (err) {
      if (isAmbiguousSendError(err)) throw new AmbiguousOrderError(order.clientOrderId, err);
      throw err; // rechazo definitivo: la orden no se creó
    }
    return this.#normalize(response);
  }

  /** Estado real de la orden, buscada por NUESTRO clientOrderId. */
  async query(order) {
    let response;
    try {
      response = await this.exchange.fetchOrder(undefined, order.symbol, { origClientOrderId: order.clientOrderId });
    } catch (err) {
      if (err instanceof ccxt.OrderNotFound) return { found: false };
      throw err;
    }
    const normalized = this.#normalize(response);
    // fetchOrder no trae las ejecuciones: se piden aparte si hubo alguna.
    if (normalized.fills.length === 0 && (response.filled ?? 0) > 0) {
      const trades = await this.exchange.fetchMyTrades(order.symbol, undefined, undefined, { orderId: response.id });
      normalized.fills = trades.filter((t) => String(t.order) === String(response.id)).map((t) => this.#fill(t));
    }
    return { found: true, ...normalized };
  }

  /** Órdenes abiertas en Binance para el par (para la reconciliación). */
  async openOrders(symbol) {
    const orders = await this.exchange.fetchOpenOrders(symbol);
    return orders.map((o) => ({
      clientOrderId: o.clientOrderId, exchangeOrderId: String(o.id), side: o.side, amount: o.amount, filled: o.filled,
    }));
  }

  /** Cancela todas las órdenes abiertas del par. */
  async cancelAll(symbol) {
    try {
      const canceled = await this.exchange.cancelAllOrders(symbol);
      return canceled.map((o) => ({ clientOrderId: o.clientOrderId, exchangeOrderId: String(o.id) }));
    } catch (err) {
      if (err instanceof ccxt.OrderNotFound) return []; // no había órdenes abiertas
      throw err;
    }
  }

  /** Saldo total (libre + en órdenes) de los assets pedidos. */
  async balances(assets) {
    const balance = await this.exchange.fetchBalance();
    return Object.fromEntries(assets.map((asset) => [asset, balance.total?.[asset] ?? 0]));
  }

  #normalize(order) {
    let status = STATUS[order.status] ?? 'open';
    if (status === 'open' && (order.filled ?? 0) > 0) status = 'partially_filled';
    return {
      exchangeOrderId: order.id === undefined ? null : String(order.id),
      status,
      fills: (order.trades ?? []).map((t) => this.#fill(t)),
    };
  }

  #fill(trade) {
    const { base, quote } = this.market;
    const feeAmount = trade.fee?.cost ?? 0;
    const feeCurrency = trade.fee?.currency ?? null;
    let feeQuote;
    if (feeCurrency === quote || feeAmount === 0) feeQuote = feeAmount;
    else if (feeCurrency === base) feeQuote = feeAmount * trade.price;
    else {
      feeQuote = trade.amount * trade.price * this.feeRate; // p. ej. BNB: se estima con la comisión configurada
      this.logger?.info({ feeCurrency, feeAmount, estimatedQuote: feeQuote }, 'Comisión en otra moneda: su valor en USDT es estimado');
    }
    return {
      tradeId: String(trade.id),
      qty: trade.amount,
      price: trade.price,
      feeAmount,
      feeCurrency,
      feeQuote,
      time: trade.timestamp ?? Date.now(),
    };
  }
}
