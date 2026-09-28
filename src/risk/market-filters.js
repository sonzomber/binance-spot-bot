/**
 * Filtros del par en Binance (reglas que toda orden debe cumplir).
 * Funciones puras sobre un "market" de ccxt; Binance rechaza cualquier orden
 * que no los cumpla, así que se verifican ANTES de enviarla.
 *
 *   precision.amount → paso de cantidad (LOT_SIZE.stepSize), p. ej. 0.00001 BTC
 *   precision.price  → tick de precio (PRICE_FILTER.tickSize), p. ej. 0.01 USDT
 *   limits.amount    → cantidad mín./máx. (LOT_SIZE)
 *   limits.market    → cantidad máx. para órdenes de mercado (MARKET_LOT_SIZE)
 *   limits.price     → precio mín./máx. (PRICE_FILTER)
 *   limits.cost      → valor mín./máx. de la orden en USDT (NOTIONAL: cantidad × precio)
 */

/** Cantidad de decimales de un paso: 0.00001 → 5, 0.01 → 2, 1 → 0. */
export function decimalsOf(step) {
  const [, decimals = ''] = step.toFixed(12).replace(/0+$/, '').split('.');
  return decimals.length;
}

/** Redondea HACIA ABAJO al múltiplo del paso (nunca compra/vende más de lo pedido). */
export function roundDownToStep(value, step) {
  if (!step) return value;
  const units = Math.floor(value / step + 1e-9); // 1e-9 absorbe errores tipo 58.999999999
  return Number((units * step).toFixed(decimalsOf(step)));
}

/** ¿Es value múltiplo exacto del paso? (con tolerancia de redondeo de floats) */
export function isMultipleOfStep(value, step) {
  if (!step) return true;
  const units = value / step;
  return Math.abs(units - Math.round(units)) < 1e-6;
}

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Verifica una orden contra los filtros del par.
 * @param {{ side: 'buy'|'sell', type: 'market'|'limit', amount: number, price: number }} order
 *        price: precio límite (limit) o precio estimado de ejecución (market)
 * @param {object} market mercado de ccxt
 * @returns {string[]} lista de violaciones (vacía si la orden es válida)
 */
export function checkMarketFilters(order, market) {
  const { type, amount, price } = order;
  const { precision = {}, limits = {} } = market;
  const violations = [];

  if (!positive(amount)) return [`cantidad inválida (${amount})`];
  if (!positive(price)) return [`precio inválido (${price})`];

  // Cantidad
  if (!isMultipleOfStep(amount, precision.amount)) {
    violations.push(
      `la cantidad ${amount} no es múltiplo del paso ${precision.amount} (máx. ${decimalsOf(precision.amount)} decimales)`,
    );
  }
  if (limits.amount?.min && amount < limits.amount.min) {
    violations.push(`la cantidad ${amount} es menor que el mínimo ${limits.amount.min}`);
  }
  if (limits.amount?.max && amount > limits.amount.max) {
    violations.push(`la cantidad ${amount} supera el máximo ${limits.amount.max}`);
  }
  if (type === 'market' && limits.market?.max && amount > limits.market.max) {
    violations.push(`la cantidad ${amount} supera el máximo para órdenes de mercado ${limits.market.max}`);
  }

  // Precio: solo se envía en órdenes limit; en market es una estimación
  if (type === 'limit') {
    if (!isMultipleOfStep(price, precision.price)) {
      violations.push(
        `el precio ${price} no es múltiplo del tick ${precision.price} (máx. ${decimalsOf(precision.price)} decimales)`,
      );
    }
    if (limits.price?.min && price < limits.price.min) {
      violations.push(`el precio ${price} es menor que el mínimo ${limits.price.min}`);
    }
    if (limits.price?.max && price > limits.price.max) {
      violations.push(`el precio ${price} supera el máximo ${limits.price.max}`);
    }
  }

  // Valor de la orden (notional)
  const notional = amount * price;
  if (limits.cost?.min && notional < limits.cost.min) {
    violations.push(
      `el valor de la orden (${notional.toFixed(2)} USDT) es menor que el mínimo del par (${limits.cost.min} USDT)`,
    );
  }
  if (type === 'limit' && limits.cost?.max && notional > limits.cost.max) {
    violations.push(`el valor de la orden (${notional.toFixed(2)} USDT) supera el máximo del par`);
  }
  return violations;
}
