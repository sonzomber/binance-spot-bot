/**
 * Tabla de órdenes de un ámbito, con filtros y paginación.
 *
 * Toda consulta filtra por entorno y modo (los datos de distintos entornos
 * nunca se mezclan). Los filtros se validan contra listas blancas en la ruta y
 * aquí solo se usan como parámetros de SQL (nunca se concatenan valores).
 */
import { OrderStatus } from '../../../src/storage/order-store.js';

export const ORDER_STATUSES = Object.freeze(Object.values(OrderStatus));
export const ORDER_SIDES = Object.freeze(['buy', 'sell']);
export const MAX_PAGE = 200;

/** Escapa % y _ para buscar el texto tal cual con LIKE. */
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ env: string, mode: string }} scope
 * @param {{ statuses?: string[], side?: string|null, q?: string|null, limit: number, offset: number }} filters
 */
export function listOrders(db, scope, { statuses = [], side = null, q = null, limit, offset }) {
  const params = { ...scope, side, q: q ? likePattern(q) : null, limit, offset };
  const where = ['o.env = @env', 'o.mode = @mode'];
  if (statuses.length) {
    // Un parámetro por estado (los nombres @s0, @s1… los genera el código, no el usuario).
    where.push(`o.status IN (${statuses.map((_, i) => `@s${i}`).join(', ')})`);
    statuses.forEach((status, i) => { params[`s${i}`] = status; });
  }
  if (side) where.push('o.side = @side');
  if (q) where.push("o.client_order_id LIKE @q ESCAPE '\\'");
  const clause = where.join(' AND ');

  const rows = db.prepare(
    `SELECT o.id, o.client_order_id, o.exchange_order_id, o.symbol, o.side, o.type, o.amount, o.price,
            o.status, o.filled_qty, o.filled_quote, o.avg_fill_price, o.fee_quote,
            o.reject_source, o.reject_code, o.reject_reason, o.strategy, o.signal_code,
            o.created_at, o.accepted_at, o.closed_at,
            (SELECT COUNT(*) FROM order_fills f WHERE f.order_id = o.id) AS fills
       FROM orders o WHERE ${clause}
      ORDER BY o.id DESC LIMIT @limit OFFSET @offset`,
  ).all(params);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders o WHERE ${clause}`).get(params);
  // Conteo por estado del ámbito completo (para los filtros de la tabla).
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM orders WHERE env = @env AND mode = @mode GROUP BY status').all(scope)) {
    byStatus[row.status] = row.n;
  }

  return {
    scope,
    total,
    limit,
    offset,
    byStatus,
    orders: rows.map((r) => ({
      id: r.id,
      clientOrderId: r.client_order_id,
      exchangeOrderId: r.exchange_order_id,
      symbol: r.symbol,
      side: r.side,
      type: r.type,
      amount: r.amount,
      price: r.price, // precio esperado (mercado) o límite
      status: r.status,
      filledQty: r.filled_qty,
      filledQuote: r.filled_quote,
      avgFillPrice: r.avg_fill_price,
      feeQuote: r.fee_quote,
      fills: r.fills,
      rejectSource: r.reject_source,
      rejectCode: r.reject_code,
      rejectReason: r.reject_reason,
      strategy: r.strategy,
      signalCode: r.signal_code,
      createdAt: r.created_at,
      acceptedAt: r.accepted_at,
      closedAt: r.closed_at,
    })),
  };
}
