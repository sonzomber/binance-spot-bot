/**
 * Estado del bot en un ámbito: si está corriendo, detenido o sin responder,
 * kill switch, parada de riesgo, estrategia, datos y último heartbeat.
 *
 * "Sin responder" (unresponsive): la fila dice que corre, pero el último
 * heartbeat es más viejo que 2 intervalos + margen. Pasa si el proceso se
 * cerró de golpe (sin alcanzar a registrar la parada) o si está colgado.
 */
import { BotStatusStore } from '../../../src/storage/bot-status-store.js';
import { RiskStore } from '../../../src/storage/risk-store.js';
import { TRADING_ENVS, MODES } from '../../../src/storage/scope.js';

export const UNRESPONSIVE_GRACE_MS = 10_000;

/**
 * Estado derivado a partir de la fila y la hora actual.
 * @returns {'never'|'starting'|'running'|'stopping'|'stopped'|'unresponsive'}
 */
export function deriveState(status, now) {
  if (!status) return 'never';
  if (status.state === 'stopped') return 'stopped';
  const last = Date.parse(status.heartbeatAt ?? status.updatedAt);
  const limit = 2 * (status.heartbeatMs ?? 60_000) + UNRESPONSIVE_GRACE_MS;
  return now - last > limit ? 'unresponsive' : status.state;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ env: string, mode: string }} scope
 * @param {{ killSwitch: import('../../../src/risk/kill-switch.js').KillSwitch, now: number }} context
 */
export function botStatus(db, scope, { killSwitch, now }) {
  const status = new BotStatusStore(db, scope).get();
  const halt = new RiskStore(db, scope).getHaltState();
  const file = killSwitch.read();
  // El bot guarda sus horas con el reloj de Binance (sincronizado) y el panel usa
  // el de la PC: una diferencia de milisegundos daría edades negativas.
  const age = (iso) => (iso ? Math.max(0, now - Date.parse(iso)) : null);
  const state = deriveState(status, now);
  return {
    scope,
    state,
    serverTime: new Date(now).toISOString(),
    killSwitch: {
      // Activo si existe el archivo STOP o si la parada guardada vino del kill switch.
      active: Boolean(file) || halt.code === 'KILL_SWITCH',
      file: file ? { reason: file.reason, createdAt: file.createdAt ?? null } : null,
    },
    halt,
    bot: status && {
      pid: status.pid,
      startedAt: status.startedAt,
      heartbeatAt: status.heartbeatAt,
      heartbeatAgeMs: age(status.heartbeatAt),
      heartbeatMs: status.heartbeatMs,
      stoppedAt: status.stoppedAt,
      stopReason: status.stopReason,
      exitCode: status.exitCode,
      strategy: status.strategy,
      params: status.params,
      symbol: status.symbol,
      timeframe: status.timeframe,
      lastCandle: status.lastCandle,
      price: status.price,
      priceTime: status.priceTime,
      settings: status.settings,
    },
    // La frescura de los datos solo tiene sentido con el bot corriendo (la mide él).
    data: status && ['running', 'starting'].includes(state)
      ? { known: true, stale: status.dataStale, reason: status.dataReason, checkedAt: status.heartbeatAt }
      : { known: false, stale: null, reason: null, checkedAt: status?.heartbeatAt ?? null },
  };
}

/**
 * Ámbitos con información, y cuál mostrar por defecto: el del último estado
 * guardado; si el bot nunca corrió, el del .env.
 */
export function listScopes(db, { defaultScope }) {
  const statuses = BotStatusStore.all(db);
  const orderCounts = db.prepare('SELECT env, mode, COUNT(*) AS n FROM orders GROUP BY env, mode').all();
  const scopes = TRADING_ENVS.flatMap((env) => MODES.map((mode) => {
    const status = statuses.find((s) => s.env === env && s.mode === mode);
    return {
      env,
      mode,
      hasStatus: Boolean(status),
      updatedAt: status?.updatedAt ?? null,
      orders: orderCounts.find((c) => c.env === env && c.mode === mode)?.n ?? 0,
    };
  }));
  const latest = statuses.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return { scopes, defaultScope: latest ? { env: latest.env, mode: latest.mode } : defaultScope };
}
