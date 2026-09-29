/**
 * Cómo se muestran los backtests guardados (funciones puras: se prueban sin navegador).
 */
import { toSeconds } from './chart-view.js';

export const SEGMENT_LABELS = Object.freeze({
  full: 'Período completo',
  train: 'Ajuste',
  validation: 'Validación',
});
export const segmentLabel = (segment) => SEGMENT_LABELS[segment] ?? segment;

/** Fecha UTC "AAAA-MM-DD" (los períodos del backtest son días UTC). */
export const utcDate = (iso) => (iso ? iso.slice(0, 10) : '—');

/** "2025-01-01 → 2025-05-01" (el fin es exclusivo: la última vela es la anterior). */
export const periodLabel = (from, to) => `${utcDate(from)} → ${utcDate(to)}`;

/**
 * Profit factor legible: sin pérdidas no está definido (sería infinito).
 * @returns {{ text: string, tone: string }}
 */
export function profitFactor(pf, trades) {
  if (!trades) return { text: '—', tone: 'neutral' };
  if (pf === null || pf === undefined) return { text: '∞ (sin pérdidas)', tone: 'ok' };
  return { text: pf.toFixed(2), tone: pf >= 1 ? 'ok' : 'danger' };
}

/**
 * Curva para lightweight-charts: tiempos en segundos, estrictamente crecientes
 * (si dos puntos caen en el mismo segundo, queda el último).
 */
export function equityLine(points) {
  const out = [];
  for (const p of points ?? []) {
    const time = toSeconds(p.time);
    if (out.length && out.at(-1).time === time) out[out.length - 1] = { time, value: p.value };
    else if (!out.length || time > out.at(-1).time) out.push({ time, value: p.value });
  }
  return out;
}

/**
 * Valor de una curva en un instante (s): el último punto en o antes de ese
 * instante (la curva es escalonada entre puntos). null si es anterior al primero.
 */
export function valueAt(points, seconds) {
  let found = null;
  for (const p of points ?? []) {
    if (toSeconds(p.time) > seconds) break;
    found = p.value;
  }
  return found;
}

/** Pestaña y corrida elegidas desde la URL: "#/backtests/12" → 12. */
export function runIdFromHash(hash) {
  const match = /^#\/backtests\/(\d+)$/.exec(hash ?? '');
  return match ? Number(match[1]) : null;
}

/** Corrida a mostrar por defecto: la de validación del grupo más reciente (si no, la última). */
export function defaultRunId(groups) {
  const runs = groups?.[0]?.runs ?? [];
  return (runs.find((r) => r.segment === 'validation') ?? runs.at(-1))?.id ?? null;
}

/**
 * Filas de la comparación ajuste vs validación: la validación usa datos que NO
 * se usaron para elegir los parámetros; si el resultado empeora mucho, los
 * parámetros probablemente estaban "sobreajustados" al período de ajuste.
 */
export function compareRows(runs) {
  if (!runs || runs.length < 2) return null;
  return runs.map((r) => ({
    id: r.id,
    segment: segmentLabel(r.segment),
    netPnlPct: r.netPnlPct,
    trades: r.trades,
    winRatePct: r.winRatePct,
    profitFactor: r.profitFactor,
    maxDrawdownPct: r.maxDrawdownPct,
    buyAndHoldPnl: r.buyAndHoldPnl,
    vsBuyAndHold: r.vsBuyAndHold,
  }));
}

/** Resultados del grid (ya vienen ordenados: el primero es el elegido). */
export function gridRows(grid) {
  return (grid ?? []).map((row, i) => ({ ...row, chosen: i === 0 }));
}

/** Rechazos del riesgo durante el backtest, de más a menos frecuentes. */
export const rejectionRows = (rejections) => Object.entries(rejections ?? {}).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
