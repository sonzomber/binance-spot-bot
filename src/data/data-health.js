/**
 * Frescura de los datos de mercado.
 *
 * Operar con datos viejos es operar a ciegas: el precio pudo moverse y la
 * estrategia no se enteró. Si los datos están DESACTUALIZADOS, el gestor de
 * riesgo bloquea toda orden nueva hasta que se recuperen.
 *
 * Los datos están desactualizados si ocurre cualquiera de estas cosas:
 *   1. Sin señales de vida de la fuente (mensaje, ping o respuesta REST) durante
 *      más de staleAfterMs: la conexión está caída o colgada.
 *   2. Falta la última vela cerrada y ya pasaron más de staleAfterMs desde su
 *      cierre: llegan mensajes pero no la vela que importa.
 *   3. Se están rellenando huecos tras una reconexión.
 *   4. Todavía no llegó ningún dato.
 *
 * Por qué dos criterios: en el testnet puede no haber operaciones durante un
 * rato y entonces no llegan mensajes de vela, pero los pings del servidor (cada
 * ~20 s) prueban que la conexión vive. Lo que importa es que llegue cada vela cerrada.
 */
import { EventEmitter } from 'node:events';
import { alignDown, timeframeToMs } from '../lib/timeframes.js';

export class DataHealth extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.timeframe intervalo de las velas
   * @param {number} options.staleAfterMs tiempo sin datos para marcarlos desactualizados
   * @param {() => number} [options.now] reloj (idealmente la hora del servidor)
   * @param {import('pino').Logger} [options.logger]
   */
  constructor({ timeframe, staleAfterMs, now = Date.now, logger }) {
    super();
    this.stepMs = timeframeToMs(timeframe);
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    this.logger = logger;
    this.lastHeartbeatAt = null;
    this.lastCandleTime = null;
    this.recovering = null; // motivo, si se están rellenando huecos
    this.wasStale = null; // último estado informado (para avisar solo en los cambios)
    this.timer = null;
  }

  /** Cualquier señal de vida de la fuente de datos. */
  markHeartbeat(at = this.now()) {
    this.lastHeartbeatAt = Math.max(this.lastHeartbeatAt ?? 0, at);
  }

  /** Se guardó una vela cerrada. */
  markCandle(candle) {
    this.lastCandleTime = Math.max(this.lastCandleTime ?? -Infinity, candle.time);
    this.markHeartbeat();
  }

  setRecovering(reason) {
    this.recovering = reason || null;
    this.check();
  }

  /** @returns {{ stale: boolean, reason: string | null }} */
  status(at = this.now()) {
    if (this.recovering) return { stale: true, reason: this.recovering };
    if (this.lastHeartbeatAt === null) return { stale: true, reason: 'todavía no llegan datos del exchange' };

    const silentMs = at - this.lastHeartbeatAt;
    if (silentMs > this.staleAfterMs) {
      return { stale: true, reason: `sin datos del exchange desde hace ${Math.round(silentMs / 1000)} s` };
    }

    // Inicio de la última vela que ya debería estar cerrada:
    const expectedCandle = alignDown(at, this.stepMs) - this.stepMs;
    if (this.lastCandleTime === null || this.lastCandleTime < expectedCandle) {
      // El retraso se mide desde el cierre de la PRIMERA vela que falta.
      const firstMissing = this.lastCandleTime === null ? expectedCandle : this.lastCandleTime + this.stepMs;
      const lateMs = at - (firstMissing + this.stepMs);
      if (lateMs > this.staleAfterMs) {
        return {
          stale: true,
          reason: `falta la vela de ${new Date(firstMissing).toISOString()}, cerrada hace ${Math.round(lateMs / 1000)} s`,
        };
      }
    }
    return { stale: false, reason: null };
  }

  isStale() {
    return this.status().stale;
  }

  /** Evalúa el estado y avisa (log + evento) solo cuando cambia. */
  check() {
    const { stale, reason } = this.status();
    if (stale !== this.wasStale) {
      if (stale && this.wasStale === null && this.lastHeartbeatAt === null) {
        this.logger?.info('Esperando los primeros datos del exchange: órdenes bloqueadas hasta recibirlos');
        this.emit('stale', { reason });
      } else if (stale) {
        this.logger?.warn({ reason }, `Datos DESACTUALIZADOS (${reason}): se bloquean las órdenes nuevas`);
        this.emit('stale', { reason });
      } else if (this.wasStale !== null) {
        this.logger?.info('Datos al día nuevamente: se permiten órdenes');
        this.emit('fresh');
      }
      this.wasStale = stale;
    }
    return { stale, reason };
  }

  start(intervalMs = 1000) {
    this.stop();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
