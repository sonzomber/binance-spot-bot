/**
 * Estado del bot por ámbito (tabla bot_status), para el panel de monitoreo.
 *
 * El bot escribe y el panel solo lee. Hay una fila por ámbito (entorno + modo),
 * que pasa por: starting → running → stopping → stopped.
 *
 * Si el proceso se cierra de golpe, no alcanza a registrar la parada: la fila
 * queda en "running" con un heartbeat cada vez más viejo. Por eso se guarda el
 * intervalo del heartbeat, para que el panel detecte ese silencio.
 *
 * settings es una LISTA BLANCA de valores públicos (publicSettings): nunca
 * API keys ni otros secretos.
 */
import { tradingScope } from './scope.js';

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * Configuración pública que se guarda con el estado. Lista blanca explícita:
 * lo que no está aquí (p. ej. apiKey y apiSecret) nunca sale del bot.
 */
export function publicSettings(config) {
  return {
    dryRun: config.dryRun,
    maxTradeUsdt: config.risk.maxTradeUsdt,
    maxDailyLossUsdt: config.risk.maxDailyLossUsdt,
    maxOpenPositions: config.risk.maxOpenPositions,
    feeRate: config.execution.feeRate,
    slippageBps: config.execution.slippageBps,
    dataFeed: config.dataFeed,
    dataStaleAfterMs: config.dataStaleAfterMs,
  };
}

export class BotStatusStore {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {{ env: 'testnet'|'demo', mode: 'dry-run'|'exchange' }} scope
   */
  constructor(db, scope) {
    this.db = db;
    this.scope = tradingScope(scope);
    const where = 'env = @env AND mode = @mode';
    this.sql = {
      // Un arranque nuevo reemplaza lo que quedó de la ejecución anterior.
      start: db.prepare(
        `INSERT INTO bot_status (env, mode, state, pid, started_at, updated_at, heartbeat_ms,
                                 strategy, params, symbol, timeframe, settings)
           VALUES (@env, @mode, 'starting', @pid, @time, @time, @heartbeatMs,
                   @strategy, @params, @symbol, @timeframe, @settings)
         ON CONFLICT (env, mode) DO UPDATE SET
           state = 'starting', pid = excluded.pid, started_at = excluded.started_at,
           updated_at = excluded.updated_at, heartbeat_at = NULL, heartbeat_ms = excluded.heartbeat_ms,
           stopped_at = NULL, stop_reason = NULL, exit_code = NULL,
           strategy = excluded.strategy, params = excluded.params, symbol = excluded.symbol,
           timeframe = excluded.timeframe, last_candle = NULL, price = NULL, price_time = NULL,
           data_stale = NULL, data_reason = NULL, settings = excluded.settings`,
      ),
      running: db.prepare(`UPDATE bot_status SET state = 'running', updated_at = @time WHERE ${where}`),
      heartbeat: db.prepare(
        `UPDATE bot_status SET heartbeat_at = @time, updated_at = @time, last_candle = @lastCandle,
           price = @price, price_time = @priceTime, data_stale = @dataStale, data_reason = @dataReason
         WHERE ${where}`,
      ),
      candle: db.prepare(`UPDATE bot_status SET last_candle = @lastCandle, updated_at = @time WHERE ${where}`),
      stopping: db.prepare(
        `UPDATE bot_status SET state = 'stopping', stop_reason = @reason, updated_at = @time WHERE ${where}`,
      ),
      stopped: db.prepare(
        `UPDATE bot_status SET state = 'stopped', stopped_at = @time, stop_reason = @reason,
           exit_code = @exitCode, updated_at = @time
         WHERE ${where}`,
      ),
      get: db.prepare(`SELECT * FROM bot_status WHERE ${where}`),
    };
  }

  /** Arranque: estado "starting", con la estrategia y la configuración pública. */
  start({ time, pid, heartbeatMs, strategy, params, symbol, timeframe, settings }) {
    this.sql.start.run({
      ...this.scope, time: iso(time), pid, heartbeatMs, strategy, params: JSON.stringify(params ?? {}),
      symbol, timeframe, settings: JSON.stringify(settings ?? {}),
    });
  }

  /** Arranque completo: el bot espera velas. */
  running({ time }) {
    this.sql.running.run({ ...this.scope, time: iso(time) });
  }

  /**
   * Latido periódico: última vela procesada, último precio y frescura de los datos.
   * @param {{ time: number, lastCandle?: number|null, price?: number|null, priceTime?: number|null,
   *           data?: { stale: boolean, reason: string|null } }} info
   */
  heartbeat({ time, lastCandle = null, price = null, priceTime = null, data }) {
    this.sql.heartbeat.run({
      ...this.scope, time: iso(time), lastCandle: iso(lastCandle), price: price ?? null, priceTime: iso(priceTime),
      dataStale: data ? Number(Boolean(data.stale)) : null, dataReason: data?.reason ?? null,
    });
  }

  /** Tras procesar una vela (no espera al heartbeat para mostrarla). */
  candleProcessed({ time, lastCandle }) {
    this.sql.candle.run({ ...this.scope, time: iso(time), lastCandle: iso(lastCandle) });
  }

  stopping({ time, reason }) {
    this.sql.stopping.run({ ...this.scope, time: iso(time), reason });
  }

  stopped({ time, reason, exitCode }) {
    this.sql.stopped.run({ ...this.scope, time: iso(time), reason, exitCode });
  }

  /** @returns {object|null} la fila del ámbito (params y settings ya parseados) */
  get() {
    return toStatus(this.sql.get.get(this.scope));
  }

  /** Estado de todos los ámbitos que tienen fila (lo usa el panel). */
  static all(db) {
    return db.prepare('SELECT * FROM bot_status ORDER BY env, mode').all().map(toStatus);
  }
}

function toStatus(row) {
  if (!row) return null;
  return {
    env: row.env,
    mode: row.mode,
    state: row.state,
    pid: row.pid,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    heartbeatAt: row.heartbeat_at,
    heartbeatMs: row.heartbeat_ms,
    stoppedAt: row.stopped_at,
    stopReason: row.stop_reason,
    exitCode: row.exit_code,
    strategy: row.strategy,
    params: row.params ? JSON.parse(row.params) : null,
    symbol: row.symbol,
    timeframe: row.timeframe,
    lastCandle: row.last_candle,
    price: row.price,
    priceTime: row.price_time,
    dataStale: row.data_stale === null ? null : row.data_stale === 1,
    dataReason: row.data_reason,
    settings: row.settings ? JSON.parse(row.settings) : null,
  };
}
