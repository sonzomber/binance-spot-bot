/**
 * Textos para entornos, modos y estados (en un solo lugar).
 * tone: color de la etiqueta (ok, info, warn, danger, neutral).
 */

export const ENV_LABELS = Object.freeze({ testnet: 'Spot Testnet', demo: 'Demo' });
export const MODE_LABELS = Object.freeze({ 'dry-run': 'dry-run', exchange: 'exchange' });
export const MODE_HINTS = Object.freeze({
  'dry-run': 'órdenes simuladas, nunca enviadas',
  exchange: 'órdenes enviadas al entorno (fondos ficticios)',
});

/** Todos los ámbitos posibles, en el orden en que se muestran. */
export const ALL_SCOPES = Object.freeze([
  { env: 'testnet', mode: 'dry-run' },
  { env: 'testnet', mode: 'exchange' },
  { env: 'demo', mode: 'dry-run' },
  { env: 'demo', mode: 'exchange' },
]);

export const scopeKey = (scope) => (scope ? `${scope.env}/${scope.mode}` : '');
export const scopeLabel = (scope) => (scope ? `${ENV_LABELS[scope.env] ?? scope.env} · ${MODE_LABELS[scope.mode] ?? scope.mode}` : '—');

/** "testnet/dry-run" → { env, mode } (o null si no es un ámbito válido). */
export function parseScopeKey(key) {
  return ALL_SCOPES.find((s) => scopeKey(s) === key) ?? null;
}

/** Estado del bot (ver panel/server/queries/status.js). */
export const BOT_STATES = Object.freeze({
  running: { label: 'Corriendo', tone: 'ok' },
  starting: { label: 'Arrancando', tone: 'info' },
  stopping: { label: 'Deteniéndose', tone: 'warn' },
  stopped: { label: 'Detenido', tone: 'neutral' },
  unresponsive: { label: 'Sin responder', tone: 'danger' },
  never: { label: 'Nunca corrió aquí', tone: 'neutral' },
});

export const botState = (state) => BOT_STATES[state] ?? { label: state ?? '—', tone: 'neutral' };

/** Conexión en vivo con el servidor del panel. */
export const CONNECTION_STATES = Object.freeze({
  connecting: { label: 'Conectando…', tone: 'info' },
  open: { label: 'En vivo', tone: 'ok' },
  reconnecting: { label: 'Reconectando…', tone: 'warn' },
});
