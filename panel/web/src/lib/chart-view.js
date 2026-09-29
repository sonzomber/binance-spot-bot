/**
 * Datos del gráfico en el formato de lightweight-charts (funciones puras).
 *
 * lightweight-charts usa tiempos en SEGUNDOS UTC. La API del panel usa ms.
 * Las marcas se ubican en la vela en que se ejecutó la orden (el servidor ya
 * las alinea al inicio de esa vela).
 */

export const toSeconds = (ms) => Math.floor(ms / 1000);

/** Cantidades de velas que se pueden elegir. */
export const LIMIT_OPTIONS = Object.freeze([100, 300, 1000]);

/** Velas → { time (s), open, high, low, close } */
export const chartCandles = (candles) => candles.map((c) => ({ time: toSeconds(c.time), open: c.open, high: c.high, low: c.low, close: c.close }));

/** Puntos de un indicador → { time (s), value } */
export const lineData = (points) => points.map((p) => ({ time: toSeconds(p.time), value: p.value }));

/** Nombre legible de un indicador que reporta la estrategia. */
export function seriesLabel(key, params = {}) {
  if (key === 'smaFast') return `SMA ${params.fast ?? ''} (rápida)`.replace('  ', ' ');
  if (key === 'smaSlow') return `SMA ${params.slow ?? ''} (lenta)`.replace('  ', ' ');
  return key;
}

/**
 * Órdenes ejecutadas → marcas: compra con flecha hacia arriba debajo de la
 * vela; venta con flecha hacia abajo encima. Ordenadas por tiempo (lo exige la librería).
 */
export function chartMarkers(markers, colors) {
  return [...markers]
    .sort((a, b) => a.candleTime - b.candleTime || a.executedAt.localeCompare(b.executedAt))
    .map((m) => {
      const buy = m.side === 'buy';
      return {
        id: m.clientOrderId,
        time: toSeconds(m.candleTime),
        position: buy ? 'belowBar' : 'aboveBar',
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? colors.buy : colors.sell,
        text: buy ? 'Compra' : 'Venta',
      };
    });
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Etiquetas del eje de tiempo en HORA LOCAL (la librería usa UTC por defecto).
 * tickMarkType: 0 año, 1 mes, 2 día, 3 hora, 4 hora con segundos.
 */
export function tickLabel(seconds, tickMarkType) {
  const d = new Date(seconds * 1000);
  switch (tickMarkType) {
    case 0: return String(d.getFullYear());
    case 1: return `${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
    case 2: return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`;
    case 4: return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    default: return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

/**
 * Datos de una vela para la leyenda (la del cursor o, si no hay, la última).
 * @returns {{ time: number, open, high, low, close, change: number, lines: Array<{ key, value }> }|null}
 */
export function legendFor(chart, seconds) {
  const candles = chart?.candles ?? [];
  if (!candles.length) return null;
  const candle = seconds === null || seconds === undefined
    ? candles.at(-1)
    : candles.find((c) => toSeconds(c.time) === seconds) ?? candles.at(-1);
  const lines = (chart.series ?? []).map((s) => ({ key: s.key, value: s.points.find((p) => p.time === candle.time)?.value ?? null }));
  return { ...candle, change: ((candle.close - candle.open) / candle.open) * 100, lines };
}
