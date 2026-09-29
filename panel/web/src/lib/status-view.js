/**
 * Cómo se muestra el estado del bot (funciones puras: se prueban sin navegador).
 */
import { botState } from './labels.js';

/** Motivos de parada guardados en SQLite. */
export const HALT_LABELS = Object.freeze({
  KILL_SWITCH: 'kill switch',
  DAILY_LOSS: 'pérdida diaria alcanzada',
  RECONCILIATION: 'diferencias con el exchange',
});
export const haltLabel = (code) => HALT_LABELS[code] ?? code ?? 'parada';

/**
 * Etiquetas del encabezado de la sección: el estado del proceso y, además,
 * cualquier motivo que impida operar (kill switch, parada de riesgo). Pueden
 * coexistir: p. ej. "Corriendo" durante el segundo que tarda en ver el kill switch.
 * @returns {Array<{ label: string, tone: string, title?: string }>}
 */
export function statusBadges(status) {
  const badges = [botState(status.state)];
  if (status.killSwitch?.active) {
    badges.push({ label: 'Kill switch activo', tone: 'danger', title: status.killSwitch.file?.reason ?? status.halt?.reason ?? undefined });
  } else if (status.halt?.halted) {
    badges.push({ label: `Parada: ${haltLabel(status.halt.code)}`, tone: 'danger', title: status.halt.reason ?? undefined });
  }
  return badges;
}

/**
 * ¿Los datos de mercado están al día? Solo lo sabe el bot en marcha (lo mide él).
 * @returns {{ label: string, tone: string, detail: string|null }}
 */
export function dataFreshness(status) {
  const data = status.data;
  if (!data?.known) {
    return { label: 'Sin información', tone: 'neutral', detail: 'Solo se sabe con el bot en marcha.' };
  }
  if (data.stale) {
    return { label: 'Desactualizados', tone: 'danger', detail: `${data.reason ?? 'sin datos recientes'}: el bot no envía órdenes.` };
  }
  return { label: 'Al día', tone: 'ok', detail: null };
}

/** { fast: 9, slow: 21 } → "fast 9 · slow 21" */
export function formatParams(params) {
  const entries = Object.entries(params ?? {});
  return entries.length ? entries.map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ') : 'sin parámetros';
}

/** Explicación para los estados que la necesitan (null si no hace falta). */
export function stateExplanation(status) {
  switch (status.state) {
    case 'never':
      return 'El bot nunca corrió con este entorno y modo. Para verlo aquí, arráncalo con "npm start" usando este BINANCE_ENV y DRY_RUN.';
    case 'unresponsive':
      return 'El último heartbeat es de hace más de dos intervalos. El proceso pudo cerrarse de golpe (sin registrar la parada) o estar colgado. Revisa la terminal del bot.';
    case 'stopping':
      return 'Apagado ordenado en curso: termina la operación en curso, cancela las órdenes pendientes y guarda el estado. No vende posiciones.';
    case 'starting':
      return 'Arranque en curso: hora del servidor, estado de riesgo, reconciliación y velas históricas.';
    default:
      return null;
  }
}
