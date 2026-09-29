/**
 * Logs en el panel (funciones puras: se prueban sin navegador).
 *
 * Las líneas nuevas llegan por SSE SIN filtrar; se filtran aquí con la misma
 * regla que el servidor (panel/server/log-reader.js): nivel y ámbito, y las
 * líneas "generales" (sin ámbito: scripts, backtest, el panel) si se piden.
 */

export const LOG_LEVELS = Object.freeze([
  { id: 'info', label: 'Info', levels: [30], tone: 'info' },
  { id: 'warn', label: 'Aviso', levels: [40], tone: 'warn' },
  { id: 'error', label: 'Error', levels: [50, 60], tone: 'danger' }, // error incluye fatal
]);

export const MAX_LOG_LINES = 500;

export function levelTone(level) {
  if (level >= 50) return 'danger';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  return 'neutral';
}

/**
 * ¿La línea pasa el filtro?
 * @param {{ level: number, scope: string|null }} line
 * @param {{ scopeKey: string, levels: string[], includeGeneral: boolean }} filter
 */
export function matchesLog(line, { scopeKey, levels, includeGeneral }) {
  const allowed = LOG_LEVELS.filter((l) => levels.includes(l.id)).flatMap((l) => l.levels);
  if (!allowed.includes(line.level)) return false;
  if (!line.scope) return includeGeneral;
  return line.scope === scopeKey;
}

/** Identidad de una línea (para no mostrarla dos veces si llega por REST y por SSE). */
export const lineKey = (line) => `${line.time}|${line.level}|${line.scope ?? ''}|${line.msg}|${JSON.stringify(line.data ?? null)}`;

/**
 * Agrega líneas nuevas (de la más vieja a la más nueva) a la lista mostrada,
 * que va de la MÁS NUEVA a la más vieja. Sin duplicados y con un máximo.
 */
export function mergeLines(shown, incoming, max = MAX_LOG_LINES) {
  const seen = new Set(shown.map(lineKey));
  const fresh = [];
  for (const line of incoming) {
    const key = lineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(line);
  }
  return [...fresh.reverse(), ...shown].slice(0, max);
}
