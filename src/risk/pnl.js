/**
 * Cálculos de ganancia/pérdida (PnL = "profit and loss"), siempre en USDT y
 * SIEMPRE con comisiones incluidas.
 *
 * Convención para que funcione sin importar en qué moneda cobra Binance la comisión:
 *   - qty      = cantidad del activo base que REALMENTE quedó en la cuenta
 *                (si la comisión se cobró en BTC, ya viene descontada)
 *   - feeQuote = valor de la comisión expresado en USDT
 *
 *   costo de entrada  = qty × precio + feeQuote     (USDT que salieron de la cuenta)
 *   ingreso de salida = qty × precio − feeQuote     (USDT que entraron a la cuenta)
 *   PnL realizado     = ingreso de salida − costo de entrada
 */

/** Día UTC ("YYYY-MM-DD") de un instante. Independiente de la zona horaria de la PC. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Inicio (00:00:00.000 UTC) del día siguiente. */
export function nextUtcMidnight(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function entryCost({ qty, price, feeQuote }) {
  return qty * price + feeQuote;
}

export function exitProceeds({ qty, price, feeQuote }) {
  return qty * price - feeQuote;
}

/**
 * PnL no realizado de una posición abierta: lo que se ganaría/perdería si se
 * vendiera ahora al precio de mercado, descontando la comisión estimada de venta.
 */
export function unrealizedPnl(position, markPrice, feeRate) {
  const proceeds = position.qty * markPrice * (1 - feeRate);
  return proceeds - position.entryCost;
}
