/**
 * Cómo se muestra el riesgo del día (funciones puras: se prueban sin navegador).
 *
 * Regla vigente del bot: PnL neto del día UTC = realizado (con comisiones) +
 * no realizado de las posiciones abiertas desde su entrada. Si llega a
 * −límite, parada de emergencia. Las ganancias del día dan margen extra.
 */

/** A partir de qué uso del límite la barra avisa (amarillo) o alarma (rojo). */
export const WARN_AT_PCT = 50;
export const DANGER_AT_PCT = 80;

/**
 * Barra de pérdida diaria.
 * @param {{ total: number, lossLimit: number, remaining: number, usedPct: number, reached: boolean }} risk
 * @returns {{ usedPct: number, tone: 'ok'|'warn'|'danger', loss: number, remaining: number, inProfit: boolean }}
 */
export function lossBar({ total, lossLimit, remaining, usedPct, reached }) {
  const tone = reached || usedPct >= DANGER_AT_PCT ? 'danger' : usedPct >= WARN_AT_PCT ? 'warn' : 'ok';
  return {
    usedPct,
    tone,
    loss: Math.max(0, -total), // pérdida neta del día (0 si va ganando)
    remaining,
    inProfit: total > 0,
    lossLimit,
  };
}

/** Color de un monto de PnL. */
export const pnlTone = (n) => (n > 0 ? 'ok' : n < 0 ? 'danger' : 'neutral');

/** Próximo reinicio del día de riesgo: las 00:00 UTC siguientes (ms). */
export function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Origen del precio con el que se valoran las posiciones abiertas. */
export function markSourceLabel(mark) {
  if (!mark) return 'sin precio actual: se valora a precio de entrada (solo cuenta comisiones)';
  return mark.source === 'bot' ? 'último precio registrado por el bot' : 'cierre de la última vela guardada';
}

/** Posiciones abiertas contra el máximo permitido. */
export function positionsUsage(open, max) {
  return { open, max, full: open >= max, tone: open >= max ? 'warn' : 'ok' };
}
