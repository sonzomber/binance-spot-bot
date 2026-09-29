/**
 * Ejecutor de órdenes: la ÚNICA forma de operar.
 *
 * Flujo de cada orden (igual en dry-run y en testnet/demo):
 *   1. Calcula la cantidad (tope por operación, o la posición a cerrar).
 *   2. Genera el clientOrderId y consulta al gestor de riesgo. Si rechaza, la
 *      orden se registra como rechazada con su motivo y no sale.
 *   3. Guarda la orden en SQLite como "pending" ANTES de enviarla.
 *   4. La envía con la aprobación del riesgo (de un solo uso).
 *   5. Ante un timeout o error de red NO la reenvía: espera a que venza la ventana
 *      de Binance (recvWindow) y consulta su estado por clientOrderId.
 *   6. Registra las ejecuciones (fills) y actualiza la posición con la cantidad
 *      REALMENTE ejecutada (incluidas ejecuciones parciales).
 *
 * Las órdenes se procesan de a una (cola), así el control de "orden en curso"
 * no tiene carreras.
 */
import { withRetry, sleep as defaultSleep } from '../lib/backoff.js';
import { newClientOrderId } from '../lib/ids.js';
import { RiskCode } from '../risk/risk-manager.js';
import { FINAL_STATUSES } from '../storage/order-store.js';
import { AmbiguousOrderError } from './venues.js';

export class OrderExecutor {
  /**
   * @param {object} deps
   * @param {import('../risk/risk-manager.js').RiskManager} deps.risk
   * @param {import('../storage/order-store.js').OrderStore} deps.orders mismo ámbito que el riesgo
   * @param {import('./venues.js').PaperVenue | import('./venues.js').ExchangeVenue} deps.venue
   * @param {object} deps.market mercado ccxt
   * @param {() => Promise<number>|number} deps.getPrice último precio conocido
   * @param {import('pino').Logger} [deps.logger]
   * @param {() => number} [deps.now]
   * @param {number} [deps.resolveDelayMs] espera antes de consultar tras un timeout
   *        (recvWindow de Binance, 5 s, + margen: pasado ese tiempo la orden ya no puede entrar)
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   */
  constructor({ risk, orders, venue, market, getPrice, logger, now = Date.now, resolveDelayMs = 6000, sleep = defaultSleep }) {
    const { env, mode } = orders.scope;
    if (risk.scope.env !== env || risk.scope.mode !== mode) {
      throw new Error(`riesgo (${risk.scope.env}/${risk.scope.mode}) y órdenes (${env}/${mode}) deben ser del mismo ámbito`);
    }
    Object.assign(this, { risk, orders, venue, market, getPrice, logger, now, resolveDelayMs, sleep });
    this.queue = Promise.resolve();
  }

  get scope() {
    return this.orders.scope;
  }

  /**
   * Opera una señal. Siempre de mercado.
   * @param {{ side: 'buy'|'sell', signalKey?: string, strategy?: string, signalCode?: string }} intent
   *        signalKey identifica la señal (estrategia + par + vela + acción): una señal
   *        produce como máximo una orden.
   * @returns {Promise<{ status: string, code?: string, reason?: string, order?: object }>}
   */
  submit(intent) {
    const run = () => this.#submit(intent);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async #submit({ side, signalKey = null, strategy = null, signalCode = null }) {
    const { market } = this;
    const symbol = market.symbol;
    const price = await this.getPrice();

    const sizing = side === 'buy' ? this.risk.sizeBuy({ market, price }) : this.risk.sizeSell({ market });
    if (!sizing || !(sizing.amount > 0)) {
      const reason = side === 'sell' ? `no hay posición abierta en ${symbol} para vender` : 'la cantidad a comprar resulta 0';
      this.logger?.info({ side, signalKey }, `Señal ignorada: ${reason}`);
      return { status: 'skipped', reason };
    }

    const order = {
      clientOrderId: newClientOrderId(this.scope, this.now()),
      symbol, side, type: 'market', amount: sizing.amount, price,
    };
    const meta = { strategy, signalCode, signalKey };

    // 1. Riesgo (obligatorio)
    const decision = this.risk.checkOrder(order, {
      market,
      markPrices: { [symbol]: price },
      activeOrders: this.orders.activeOrders(symbol).length,
      duplicateOf: signalKey ? this.orders.getBySignalKey(signalKey) : null,
    });
    if (!decision.ok) {
      // La clave de la señal ya pertenece a la orden original: el duplicado se registra sin ella.
      const signalKeyToStore = decision.code === RiskCode.DUPLICATE_SIGNAL ? null : signalKey;
      const record = this.orders.createRejected({ ...order, ...meta, signalKey: signalKeyToStore }, decision);
      this.logger?.warn({ clientOrderId: order.clientOrderId, code: decision.code, side }, `Orden rechazada por el riesgo: ${decision.reason}`);
      return { status: 'rejected', code: decision.code, reason: decision.reason, order: record };
    }

    // 2. Registrar como pendiente ANTES de enviar
    this.orders.create({ ...order, ...meta });
    this.logger?.info({ clientOrderId: order.clientOrderId, side, amount: order.amount, price, mode: this.scope.mode }, 'Enviando orden');

    // 3. Enviar
    let result;
    try {
      result = await this.venue.place(order, decision.approval);
    } catch (err) {
      if (err instanceof AmbiguousOrderError) return this.#resolveAmbiguous(order);
      // Rechazo definitivo (fondos insuficientes, orden inválida, bloqueo de la guardia…): no se creó.
      const updated = this.orders.markRejected(order.clientOrderId, { code: exchangeCode(err), reason: err.message });
      this.logger?.error({ clientOrderId: order.clientOrderId, err: err.message }, 'Orden rechazada al enviarla');
      return { status: 'rejected', code: updated.rejectCode, reason: err.message, order: updated };
    }
    return this.#apply(order.clientOrderId, result);
  }

  /** Timeout o error de red: consultar por clientOrderId, NUNCA reenviar. */
  async #resolveAmbiguous(order) {
    this.logger?.warn(
      { clientOrderId: order.clientOrderId, waitMs: this.resolveDelayMs },
      'Resultado desconocido al enviar la orden: se consultará su estado (no se reenvía)',
    );
    await this.sleep(this.resolveDelayMs);
    let remote;
    try {
      remote = await withRetry(() => this.venue.query(order), { retries: 3, wait: this.sleep, logger: this.logger, label: 'consulta de orden' });
    } catch (err) {
      // Sigue "pending": el riesgo bloquea nuevas órdenes del par hasta resolverla (reconciliación).
      this.logger?.error({ clientOrderId: order.clientOrderId, err: err.message }, 'No se pudo consultar la orden: queda pendiente de reconciliación');
      return { status: 'unknown', order: this.orders.get(order.clientOrderId) };
    }
    if (!remote.found) {
      const updated = this.orders.markRejected(order.clientOrderId, {
        code: 'NOT_CREATED',
        reason: 'la orden no llegó a Binance (timeout); confirmado consultando por clientOrderId',
      });
      this.logger?.warn({ clientOrderId: order.clientOrderId }, 'La orden no se creó en Binance');
      return { status: 'not_created', order: updated };
    }
    this.logger?.info({ clientOrderId: order.clientOrderId, status: remote.status }, 'La orden sí se creó: se registra su estado real');
    return this.#apply(order.clientOrderId, remote);
  }

  /**
   * Resuelve órdenes que quedaron pendientes (p. ej. tras un corte): consulta su
   * estado real y lo registra. Lo usa la reconciliación.
   * @returns {Promise<Array<{ clientOrderId, status, found }>>}
   */
  async resolveActive() {
    const results = [];
    for (const local of this.orders.activeOrders(this.market.symbol)) {
      const remote = await this.venue.query(local);
      if (!remote.found) {
        if (local.status === 'pending') {
          this.orders.markRejected(local.clientOrderId, { code: 'NOT_CREATED', reason: 'no existe en el exchange (resuelta en la reconciliación)' });
          results.push({ clientOrderId: local.clientOrderId, status: 'not_created', found: false });
        } else {
          results.push({ clientOrderId: local.clientOrderId, status: local.status, found: false });
        }
        continue;
      }
      const { status } = this.#apply(local.clientOrderId, remote);
      results.push({ clientOrderId: local.clientOrderId, status, found: true });
    }
    return results;
  }

  /** Cancela todas las órdenes abiertas del par y registra su estado final (parada de emergencia). */
  async cancelAll() {
    const canceled = await this.venue.cancelAll(this.market.symbol);
    await this.resolveActive();
    return canceled;
  }

  /** Aplica el estado del exchange (o de la simulación) a la orden local y, si terminó, a la posición. */
  #apply(clientOrderId, remote) {
    let local = this.orders.get(clientOrderId);
    if (local.status === 'pending' && remote.status !== 'rejected') {
      local = this.orders.markAccepted(clientOrderId, { exchangeOrderId: remote.exchangeOrderId });
    }
    for (const fill of remote.fills) this.orders.addFill(clientOrderId, fill); // idempotente por tradeId
    local = this.orders.get(clientOrderId);

    if (remote.status === 'rejected' && local.status === 'pending') {
      local = this.orders.markRejected(clientOrderId, { code: 'EXCHANGE_REJECTED', reason: 'el exchange rechazó la orden' });
    } else if (remote.status === 'canceled' && !FINAL_STATUSES.includes(local.status)) {
      local = this.orders.markCanceled(clientOrderId);
    } else if (remote.status === 'expired' && !FINAL_STATUSES.includes(local.status)) {
      local = this.orders.markExpired(clientOrderId);
    } else if (remote.status === 'filled' && local.status !== 'filled') {
      this.logger?.warn({ clientOrderId, filledQty: local.filledQty, amount: local.amount }, 'El exchange dice "filled" pero faltan ejecuciones registradas');
    }

    if (FINAL_STATUSES.includes(local.status) && local.filledQty > 0) this.#updatePosition(local);
    if (local.status === 'expired' || (local.status === 'canceled' && local.filledQty > 0)) {
      this.logger?.warn(
        { clientOrderId, amount: local.amount, filledQty: local.filledQty },
        `Ejecución parcial: se ejecutó ${local.filledQty} de ${local.amount}`,
      );
    }
    this.logger?.info(
      { clientOrderId, status: local.status, filledQty: local.filledQty, avgPrice: local.avgFillPrice, fee: local.feeQuote },
      `Orden ${local.status}`,
    );
    return { status: local.status, order: local };
  }

  /** Posición = cantidad REALMENTE ejecutada. Idempotente: una orden se aplica una sola vez. */
  #updatePosition(order) {
    if (this.risk.store.isOrderApplied(order.id)) return;
    const time = Date.parse(order.closedAt ?? order.updatedAt);
    if (order.side === 'buy') {
      // Si la comisión se cobró en la moneda base, se recibió menos de lo ejecutado.
      const feesInBase = order.fills
        .filter((f) => f.feeCurrency === this.market.base)
        .reduce((sum, f) => sum + f.feeAmount, 0);
      this.risk.recordEntry({
        symbol: order.symbol, qty: order.filledQty - feesInBase, price: order.avgFillPrice,
        feeQuote: order.feeQuote, time, orderId: order.id,
      });
    } else {
      this.risk.recordExit({
        symbol: order.symbol, qty: order.filledQty, price: order.avgFillPrice, feeQuote: order.feeQuote,
        time, orderId: order.id,
        // Un resto menor que la cantidad mínima vendible no se puede vender: es "dust".
        dustQty: Math.max(this.market.precision?.amount ?? 0, this.market.limits?.amount?.min ?? 0),
      });
    }
  }
}

/** Código de error del exchange si viene en el mensaje (p. ej. -2010), o el tipo de error. */
function exchangeCode(err) {
  const match = /"code":\s*(-?\d+)/.exec(err?.message ?? '');
  return match ? match[1] : err?.name ?? 'ERROR';
}
