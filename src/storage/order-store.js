/**
 * Registro de órdenes y sus ejecuciones (fills).
 *
 * Se registra CADA intento de orden, incluso las que nunca se enviaron porque
 * el gestor de riesgo las rechazó, con el motivo. Así el historial muestra no
 * solo lo que el bot hizo, sino lo que intentó hacer y por qué no pudo.
 *
 * Ciclo de vida:
 *   pending ──► open ──► partially_filled ──► filled
 *      │          │              │
 *      │          └──────────────┴──► canceled / expired
 *      └──► rejected   (por el riesgo antes de enviar, o por el exchange)
 *
 * Una instancia está atada a UN ámbito (entorno + modo): sus consultas y
 * reportes nunca incluyen órdenes de otro entorno.
 */
import { tradingScope } from './scope.js';

export const OrderStatus = Object.freeze({
  PENDING: 'pending', // creada localmente, aún sin confirmar por el exchange
  OPEN: 'open', // aceptada por el exchange, sin ejecuciones
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

const { PENDING, OPEN, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED } = OrderStatus;

/** Estados en los que la orden sigue viva en el exchange (hay que cancelarla en una parada). */
export const ACTIVE_STATUSES = Object.freeze([PENDING, OPEN, PARTIALLY_FILLED]);
export const FINAL_STATUSES = Object.freeze([FILLED, CANCELED, REJECTED, EXPIRED]);

export class OrderStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderStoreError';
  }
}

const iso = (ms) => new Date(ms).toISOString();
const QTY_TOLERANCE = 1e-9;
// Fin del rango por defecto. Ojo: new Date(8.64e15).toISOString() es "+275760-…", que en
// comparación de texto queda ANTES que "2026-…".
const END_OF_TIME = Date.UTC(9999, 11, 31);

function toOrder(row, fills) {
  if (!row) return null;
  return {
    id: row.id,
    env: row.env,
    mode: row.mode,
    clientOrderId: row.client_order_id,
    exchangeOrderId: row.exchange_order_id,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    amount: row.amount,
    price: row.price,
    status: row.status,
    filledQty: row.filled_qty,
    filledQuote: row.filled_quote,
    avgFillPrice: row.avg_fill_price,
    feeQuote: row.fee_quote,
    rejectSource: row.reject_source,
    rejectCode: row.reject_code,
    rejectReason: row.reject_reason,
    strategy: row.strategy,
    signalCode: row.signal_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    closedAt: row.closed_at,
    ...(fills ? { fills } : {}),
  };
}

function toFill(row) {
  return {
    tradeId: row.trade_id,
    qty: row.qty,
    price: row.price,
    feeAmount: row.fee_amount,
    feeCurrency: row.fee_currency,
    feeQuote: row.fee_quote,
    time: row.time,
  };
}

export class OrderStore {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {{ env: 'testnet'|'demo', mode: 'dry-run'|'exchange' }} scope
   * @param {{ now?: () => number }} [options]
   */
  constructor(db, scope, { now = Date.now } = {}) {
    this.db = db;
    this.scope = tradingScope(scope);
    this.now = now;
    const where = 'env = @env AND mode = @mode';
    this.sql = {
      insert: db.prepare(
        `INSERT INTO orders (env, mode, client_order_id, symbol, side, type, amount, price, status,
                             reject_source, reject_code, reject_reason, strategy, signal_code,
                             created_at, updated_at, closed_at)
           VALUES (@env, @mode, @clientOrderId, @symbol, @side, @type, @amount, @price, @status,
                   @rejectSource, @rejectCode, @rejectReason, @strategy, @signalCode,
                   @time, @time, @closedAt)`,
      ),
      byClientId: db.prepare(`SELECT * FROM orders WHERE ${where} AND client_order_id = @clientOrderId`),
      byExchangeId: db.prepare(`SELECT * FROM orders WHERE ${where} AND exchange_order_id = @exchangeOrderId`),
      fills: db.prepare(
        `SELECT * FROM order_fills WHERE ${where} AND order_id = @orderId ORDER BY time, id`,
      ),
      accept: db.prepare(
        `UPDATE orders SET status = @status, exchange_order_id = @exchangeOrderId,
           accepted_at = @time, updated_at = @time WHERE ${where} AND id = @id`,
      ),
      setFinal: db.prepare(
        `UPDATE orders SET status = @status, reject_source = @rejectSource, reject_code = @rejectCode,
           reject_reason = @rejectReason, updated_at = @time, closed_at = @time
         WHERE ${where} AND id = @id`,
      ),
      insertFill: db.prepare(
        `INSERT INTO order_fills (order_id, env, mode, trade_id, qty, price, fee_amount, fee_currency,
                                  fee_quote, time)
           VALUES (@orderId, @env, @mode, @tradeId, @qty, @price, @feeAmount, @feeCurrency, @feeQuote, @time)
         ON CONFLICT (order_id, trade_id) DO NOTHING`,
      ),
      fillTotals: db.prepare(
        `SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(qty * price), 0) AS quote,
                COALESCE(SUM(fee_quote), 0) AS fee
           FROM order_fills WHERE ${where} AND order_id = @orderId`,
      ),
      updateFilled: db.prepare(
        `UPDATE orders SET filled_qty = @qty, filled_quote = @quote, avg_fill_price = @avg,
           fee_quote = @fee, status = @status, updated_at = @time, closed_at = @closedAt
         WHERE ${where} AND id = @id`,
      ),
      active: db.prepare(
        `SELECT * FROM orders WHERE ${where}
           AND status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')}) ORDER BY id`,
      ),
      list: db.prepare(
        `SELECT * FROM orders WHERE ${where} AND created_at >= @from AND created_at < @to ORDER BY id`,
      ),
      summary: db.prepare(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(filled_quote), 0) AS quote,
                COALESCE(SUM(fee_quote), 0) AS fees
           FROM orders WHERE ${where} AND created_at >= @from AND created_at < @to
           GROUP BY status`,
      ),
      rejectedBySource: db.prepare(
        `SELECT reject_source AS source, reject_code AS code, COUNT(*) AS count
           FROM orders WHERE ${where} AND status = 'rejected' AND created_at >= @from AND created_at < @to
           GROUP BY reject_source, reject_code ORDER BY count DESC`,
      ),
    };
  }

  // --- Creación ---------------------------------------------------------------

  /**
   * Registra una orden ANTES de enviarla (estado pending).
   * @param {{ clientOrderId: string, symbol: string, side: 'buy'|'sell', type: 'market'|'limit',
   *           amount: number, price?: number, strategy?: string, signalCode?: string }} order
   */
  create(order) {
    return this.#insert({ ...order, status: PENDING });
  }

  /**
   * Registra una orden que el gestor de riesgo rechazó: nunca se envió.
   * @param {object} order igual que create()
   * @param {{ code: string, reason: string }} rejection
   */
  createRejected(order, { code, reason }) {
    return this.#insert({ ...order, status: REJECTED, rejectSource: 'risk', rejectCode: code, rejectReason: reason });
  }

  #insert({ clientOrderId, symbol, side, type, amount, price = null, strategy = null, signalCode = null,
    status, rejectSource = null, rejectCode = null, rejectReason = null }) {
    const time = iso(this.now());
    try {
      this.sql.insert.run({
        ...this.scope, clientOrderId, symbol, side, type, amount, price, status,
        rejectSource, rejectCode, rejectReason, strategy, signalCode,
        time, closedAt: FINAL_STATUSES.includes(status) ? time : null,
      });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new OrderStoreError(`clientOrderId duplicado: ${clientOrderId}`);
      }
      throw err;
    }
    return this.get(clientOrderId);
  }

  // --- Transiciones -------------------------------------------------------------

  /** El exchange aceptó la orden y le asignó su ID. */
  markAccepted(clientOrderId, { exchangeOrderId }) {
    const order = this.#require(clientOrderId);
    this.#assertStatus(order, [PENDING], 'aceptar');
    this.sql.accept.run({
      ...this.scope, id: order.id, status: OPEN, exchangeOrderId: String(exchangeOrderId), time: iso(this.now()),
    });
    return this.get(clientOrderId);
  }

  /** El exchange rechazó la orden (p. ej. fondos insuficientes). */
  markRejected(clientOrderId, { code = null, reason }) {
    const order = this.#require(clientOrderId);
    this.#assertStatus(order, [PENDING], 'rechazar');
    return this.#setFinal(order, REJECTED, { rejectSource: 'exchange', rejectCode: code, rejectReason: reason });
  }

  /** Cancelada (por el bot o por una parada de emergencia). Puede tener ejecuciones parciales. */
  markCanceled(clientOrderId) {
    const order = this.#require(clientOrderId);
    if (order.status === CANCELED) return order; // idempotente
    this.#assertStatus(order, ACTIVE_STATUSES, 'cancelar');
    return this.#setFinal(order, CANCELED);
  }

  markExpired(clientOrderId) {
    const order = this.#require(clientOrderId);
    this.#assertStatus(order, ACTIVE_STATUSES, 'marcar como expirada');
    return this.#setFinal(order, EXPIRED);
  }

  /**
   * Registra una ejecución (fill). Idempotente: la misma tradeId no se cuenta
   * dos veces. Recalcula cantidad ejecutada, precio promedio, comisión y estado.
   * @param {{ tradeId: string|number, qty: number, price: number, feeAmount?: number,
   *           feeCurrency?: string, feeQuote?: number, time?: number }} fill
   * @returns {{ order: object, duplicate: boolean }}
   */
  addFill(clientOrderId, { tradeId, qty, price, feeAmount = 0, feeCurrency = null, feeQuote = 0, time = this.now() }) {
    return this.db.transaction(() => {
      const order = this.#require(clientOrderId);
      if (order.status === REJECTED) {
        throw new OrderStoreError(`la orden ${clientOrderId} fue rechazada: no puede tener ejecuciones`);
      }
      const { changes } = this.sql.insertFill.run({
        ...this.scope, orderId: order.id, tradeId: String(tradeId), qty, price,
        feeAmount, feeCurrency, feeQuote, time: iso(time),
      });
      if (changes === 0) return { order, duplicate: true };

      const totals = this.sql.fillTotals.get({ ...this.scope, orderId: order.id });
      if (totals.qty > order.amount * (1 + QTY_TOLERANCE)) {
        throw new OrderStoreError(
          `la orden ${clientOrderId} tendría ${totals.qty} ejecutado, más que lo pedido (${order.amount})`,
        );
      }
      const complete = totals.qty >= order.amount * (1 - QTY_TOLERANCE);
      // Una orden cancelada/expirada puede recibir ejecuciones que ocurrieron antes de cancelarse.
      const status = [CANCELED, EXPIRED].includes(order.status) ? order.status : complete ? FILLED : PARTIALLY_FILLED;
      const now = iso(this.now());
      this.sql.updateFilled.run({
        ...this.scope, id: order.id, qty: totals.qty, quote: totals.quote, fee: totals.fee,
        avg: totals.quote / totals.qty, status, time: now,
        closedAt: FINAL_STATUSES.includes(status) ? order.closedAt ?? now : null,
      });
      return { order: this.get(clientOrderId), duplicate: false };
    })();
  }

  // --- Consultas (siempre dentro del ámbito) ---------------------------------------

  get(clientOrderId) {
    const row = this.sql.byClientId.get({ ...this.scope, clientOrderId });
    if (!row) return null;
    return toOrder(row, this.sql.fills.all({ ...this.scope, orderId: row.id }).map(toFill));
  }

  getByExchangeId(exchangeOrderId) {
    const row = this.sql.byExchangeId.get({ ...this.scope, exchangeOrderId: String(exchangeOrderId) });
    return row ? this.get(row.client_order_id) : null;
  }

  /** Órdenes vivas (pending/open/partially_filled): las que una parada debe cancelar. */
  activeOrders() {
    return this.sql.active.all(this.scope).map((row) => toOrder(row));
  }

  /** Órdenes creadas en [from, to) (ms). */
  list({ from = 0, to = END_OF_TIME } = {}) {
    return this.sql.list.all({ ...this.scope, from: iso(from), to: iso(to) }).map((row) => toOrder(row));
  }

  /**
   * Reporte de órdenes en [from, to): cantidad por estado, volumen ejecutado,
   * comisiones y rechazos por motivo. Solo del ámbito de esta instancia.
   */
  summary({ from = 0, to = END_OF_TIME } = {}) {
    const range = { ...this.scope, from: iso(from), to: iso(to) };
    const byStatus = Object.fromEntries(Object.values(OrderStatus).map((s) => [s, 0]));
    let total = 0;
    let filledQuote = 0;
    let fees = 0;
    for (const row of this.sql.summary.all(range)) {
      byStatus[row.status] = row.count;
      total += row.count;
      filledQuote += row.quote;
      fees += row.fees;
    }
    return {
      ...this.scope,
      total,
      byStatus,
      filledQuote,
      fees,
      rejections: this.sql.rejectedBySource.all(range),
    };
  }

  // --- Internos ------------------------------------------------------------------

  #require(clientOrderId) {
    const order = this.get(clientOrderId);
    if (!order) {
      throw new OrderStoreError(`no existe la orden ${clientOrderId} en ${this.scope.env}/${this.scope.mode}`);
    }
    return order;
  }

  #assertStatus(order, allowed, action) {
    if (!allowed.includes(order.status)) {
      throw new OrderStoreError(`no se puede ${action} la orden ${order.clientOrderId}: está ${order.status}`);
    }
  }

  #setFinal(order, status, { rejectSource = null, rejectCode = null, rejectReason = null } = {}) {
    this.sql.setFinal.run({
      ...this.scope, id: order.id, status, rejectSource, rejectCode, rejectReason, time: iso(this.now()),
    });
    return this.get(order.clientOrderId);
  }
}
