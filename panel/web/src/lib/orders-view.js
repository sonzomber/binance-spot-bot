/**
 * Cómo se muestran las órdenes (funciones puras: se prueban sin navegador).
 */

/** Estados de una orden (src/storage/order-store.js), en el orden en que se muestran. */
export const ORDER_STATUSES = Object.freeze([
  { id: 'filled', label: 'Ejecutada', tone: 'ok' },
  { id: 'partially_filled', label: 'Parcial', tone: 'warn' },
  { id: 'open', label: 'Abierta', tone: 'info' },
  { id: 'pending', label: 'Pendiente', tone: 'info' },
  { id: 'rejected', label: 'Rechazada', tone: 'danger' },
  { id: 'canceled', label: 'Cancelada', tone: 'neutral' },
  { id: 'expired', label: 'Vencida', tone: 'neutral' },
]);

export const orderStatus = (id) => ORDER_STATUSES.find((s) => s.id === id) ?? { id, label: id, tone: 'neutral' };

export const SIDES = Object.freeze([
  { id: null, label: 'Todas' },
  { id: 'buy', label: 'Compras' },
  { id: 'sell', label: 'Ventas' },
]);

export const sideLabel = (side) => (side === 'buy' ? 'Compra' : side === 'sell' ? 'Venta' : side);

/** Motivos de rechazo del riesgo (RiskCode) y del ejecutor, en palabras. */
export const REJECT_LABELS = Object.freeze({
  INVALID_ORDER: 'orden inválida',
  HALTED: 'bot detenido (parada guardada)',
  KILL_SWITCH: 'kill switch activo',
  DAILY_LOSS: 'límite de pérdida diaria',
  MAX_POSITIONS: 'máximo de posiciones abiertas',
  MAX_TRADE: 'supera el máximo por operación',
  INSUFFICIENT_BALANCE: 'saldo insuficiente',
  NO_POSITION: 'no hay posición para vender',
  EXCEEDS_POSITION: 'vende más que la posición',
  MARKET_FILTER: 'no cumple los filtros del par',
  STALE_DATA: 'datos de mercado desactualizados',
  RECONCILIATION: 'diferencias con el exchange sin resolver',
  DUPLICATE_SIGNAL: 'señal repetida',
  ORDER_IN_FLIGHT: 'otra orden sin resolver',
  NOT_CREATED: 'no llegó al exchange',
});

/**
 * Motivo de rechazo para la tabla: quién rechazó y por qué.
 * @returns {{ who: string, code: string, text: string, reason: string }|null}
 */
export function rejection(order) {
  if (order.status !== 'rejected' && !order.rejectReason) return null;
  const who = order.rejectSource === 'risk' ? 'Riesgo (no se envió)' : order.rejectSource === 'exchange' ? 'Exchange' : 'Rechazo';
  const code = order.rejectCode ?? '';
  return { who, code, text: REJECT_LABELS[code] ?? code, reason: order.rejectReason ?? '' };
}

/**
 * Precio a mostrar: el promedio de ejecución si algo se ejecutó; si no, el
 * esperado (en órdenes de mercado es el precio de referencia al decidir).
 */
export function displayPrice(order) {
  if (order.filledQty > 0 && order.avgFillPrice) return { value: order.avgFillPrice, kind: 'ejecutado' };
  if (order.price) return { value: order.price, kind: 'esperado' };
  return { value: null, kind: null };
}

/** Cantidad: ejecutada si hubo algo; "parcial" si no se completó. */
export function displayQty(order) {
  if (order.filledQty > 0 && order.filledQty < order.amount) return { value: order.filledQty, of: order.amount };
  return { value: order.filledQty > 0 ? order.filledQty : order.amount, of: null };
}

export const PAGE_SIZE = 25;

/** Texto de paginación: "1–25 de 60". */
export function pageLabel(offset, count, total) {
  if (!total) return '0 de 0';
  return `${offset + 1}–${offset + count} de ${total}`;
}
