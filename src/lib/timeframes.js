/**
 * Intervalos de vela (timeframes) soportados y su duración.
 * Binance alinea las velas al inicio de cada intervalo en UTC: una vela de 1h
 * empieza a las HH:00:00.000 UTC, una de 1d a las 00:00:00.000 UTC.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TIMEFRAME_MS = Object.freeze({
  '1m': MINUTE,
  '3m': 3 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': HOUR,
  '2h': 2 * HOUR,
  '4h': 4 * HOUR,
  '6h': 6 * HOUR,
  '8h': 8 * HOUR,
  '12h': 12 * HOUR,
  '1d': 24 * HOUR,
});

export const TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAME_MS));

export function timeframeToMs(timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  if (!ms) throw new RangeError(`Timeframe no soportado: ${timeframe} (usa: ${TIMEFRAMES.join(', ')})`);
  return ms;
}

/** Inicio del intervalo que contiene `ms` (redondeo hacia abajo). */
export const alignDown = (ms, stepMs) => Math.floor(ms / stepMs) * stepMs;

/** Primer inicio de intervalo ≥ `ms` (redondeo hacia arriba). */
export const alignUp = (ms, stepMs) => Math.ceil(ms / stepMs) * stepMs;
