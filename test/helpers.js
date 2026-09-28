/**
 * Utilidades compartidas por los tests.
 */

/** Entorno mínimo válido: la estrategia activa es obligatoria. */
export const testEnv = (overrides = {}) => ({ STRATEGY: 'sma-cross', ...overrides });

/**
 * Genera velas válidas a partir de precios de cierre (open = high = low = close).
 * @param {number[]} closes
 */
export function candlesFromCloses(closes, { start = Date.UTC(2026, 0, 1), stepMs = 60_000 } = {}) {
  return closes.map((close, i) => ({
    time: start + i * stepMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}
