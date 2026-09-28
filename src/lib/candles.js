/**
 * Formato común de velas (candles) para todo el bot.
 *
 * Una vela resume un intervalo de tiempo (el "timeframe", p. ej. 15m) en:
 *   time   → inicio del intervalo (ms desde epoch, UTC)
 *   open   → primer precio del intervalo
 *   high   → precio máximo
 *   low    → precio mínimo
 *   close  → último precio (el más usado por los indicadores)
 *   volume → cantidad negociada del activo base
 */

/** Convierte una fila OHLCV de ccxt ([time, open, high, low, close, volume]) en objeto. */
export function toCandle([time, open, high, low, close, volume]) {
  return { time, open, high, low, close, volume };
}

const isPositiveFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Busca la primera vela inválida de una serie.
 * @returns {string | null} descripción del problema, o null si todo es válido
 */
export function findInvalidCandle(candles) {
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const where = `vela ${i + 1}/${candles.length}`;

    if (candle === null || typeof candle !== 'object') {
      return `${where}: no es un objeto (${String(candle)})`;
    }
    if (typeof candle.time !== 'number' || !Number.isFinite(candle.time)) {
      return `${where}: time inválido (${String(candle.time)})`;
    }
    for (const field of ['open', 'high', 'low', 'close']) {
      if (!isPositiveFinite(candle[field])) {
        return `${where}: ${field} inválido (${String(candle[field])})`;
      }
    }
    if (typeof candle.volume !== 'number' || !Number.isFinite(candle.volume) || candle.volume < 0) {
      return `${where}: volume inválido (${String(candle.volume)})`;
    }
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      return `${where}: high/low inconsistentes con open/close`;
    }
    if (i > 0 && candle.time <= candles[i - 1].time) {
      return `${where}: el tiempo no es creciente (vela duplicada o desordenada)`;
    }
  }
  return null;
}
