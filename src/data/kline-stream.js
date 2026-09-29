/**
 * Cliente WebSocket del stream de velas de Binance (<símbolo>@kline_<intervalo>).
 *
 * Por qué no watchOHLCV de ccxt: descarta el campo "x" que Binance envía para
 * indicar si la vela está CERRADA. Sin él no se puede distinguir una vela
 * terminada de una actualización de la vela en curso, y la estrategia solo
 * debe ver velas cerradas.
 *
 * Mensaje de Binance (resumido):
 *   { e: 'kline', E: 1790645766092, k: { t: inicio, T: fin, o, h, l, c, v, x: ¿cerrada? } }
 *
 * Manejo de la conexión:
 *   - Pings: el servidor envía un ping cada ~20 s y corta la conexión si no
 *     recibe el pong en un minuto. Se responde cada ping explícitamente.
 *   - Cierre periódico: Binance corta cada conexión a las 24 h. El cliente la
 *     rota por su cuenta antes (23 h) y, si igual se corta, reconecta.
 *   - Conexión "zombi": si no llega nada (ni mensajes ni pings) en
 *     livenessTimeoutMs, se asume muerta y se fuerza la reconexión.
 *   - Reconexión automática con backoff exponencial y jitter.
 *
 * Eventos: 'open' { reconnect, downtimeMs }, 'kline' { candle, closed, eventTime },
 *          'close' { code, reason, planned }, 'activity', 'fatal' (no se puede conectar).
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { assertAllowedUrl } from '../config/safety.js';
import { backoffDelay } from '../lib/backoff.js';

const HOUR = 3_600_000;

/** URL del stream: wss://<host>/ws/btcusdt@kline_15m */
export function klineStreamUrl(baseWsUrl, marketId, timeframe) {
  return `${baseWsUrl.replace(/\/+$/, '')}/${marketId.toLowerCase()}@kline_${timeframe}`;
}

/** Conecta con el paquete ws, pasando SIEMPRE por la guardia de red. */
export function defaultSocketFactory(url, env) {
  assertAllowedUrl(url, env);
  return new WebSocket(url, { autoPong: false, handshakeTimeout: 10_000 });
}

/** Convierte un mensaje kline de Binance en { candle, closed, eventTime }, o null si no lo es. */
export function parseKlineMessage(raw) {
  const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  if (message?.e !== 'kline' || !message.k) return null;
  const k = message.k;
  return {
    candle: { time: k.t, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) },
    closed: k.x === true,
    eventTime: message.E,
  };
}

export class KlineStream extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url URL completa del stream
   * @param {string} options.env entorno (para la guardia de red)
   * @param {(url: string, env: string) => object} [options.createSocket] fábrica (tests: socket falso)
   * @param {import('pino').Logger} [options.logger]
   * @param {() => number} [options.now]
   * @param {() => number} [options.random] para el jitter
   * @param {{ baseMs?: number, maxMs?: number }} [options.backoff]
   * @param {number} [options.maxConnectionAgeMs] rotación programada (Binance corta a las 24 h)
   * @param {number} [options.livenessTimeoutMs] silencio máximo antes de dar la conexión por muerta
   */
  constructor({
    url, env, createSocket = defaultSocketFactory, logger, now = Date.now, random = Math.random,
    backoff = { baseMs: 1000, maxMs: 60_000 }, maxConnectionAgeMs = 23 * HOUR, livenessTimeoutMs = 60_000,
  }) {
    super();
    Object.assign(this, { url, env, createSocket, logger, now, random, backoff, maxConnectionAgeMs, livenessTimeoutMs });
    this.socket = null;
    this.stopped = true;
    this.attempt = 0; // reconexiones fallidas seguidas
    this.hasConnected = false;
    this.disconnectedAt = null;
    this.plannedClose = false;
    this.timers = {};
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.#clearTimers();
    clearTimeout(this.timers.reconnect);
    this.socket?.close(1000, 'stop');
    this.socket = null;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN || this.socket?.isOpen === true;
  }

  #connect() {
    let socket;
    try {
      socket = this.createSocket(this.url, this.env);
    } catch (err) {
      // p. ej. la guardia rechazó la URL: no tiene sentido reintentar
      this.logger?.error({ err: err.message }, 'No se pudo abrir el WebSocket');
      this.stopped = true;
      this.emit('fatal', err);
      return;
    }
    this.socket = socket;
    this.lastActivityAt = this.now();

    socket.on('open', () => {
      const reconnect = this.hasConnected;
      const downtimeMs = this.disconnectedAt === null ? 0 : this.now() - this.disconnectedAt;
      this.hasConnected = true;
      this.attempt = 0;
      this.disconnectedAt = null;
      this.plannedClose = false;
      this.#touch();
      this.#startTimers();
      this.logger?.info({ url: this.url, reconnect, downtimeMs }, reconnect ? 'WebSocket reconectado' : 'WebSocket conectado');
      this.emit('open', { reconnect, downtimeMs });
    });

    socket.on('ping', (data) => {
      socket.pong(data); // responder SIEMPRE: sin pong, Binance corta la conexión
      this.#touch();
    });

    socket.on('message', (raw) => {
      this.#touch();
      let parsed;
      try {
        parsed = parseKlineMessage(raw);
      } catch (err) {
        this.logger?.warn({ err: err.message }, 'Mensaje WebSocket inválido: se ignora');
        return;
      }
      if (parsed) this.emit('kline', parsed);
    });

    socket.on('error', (err) => {
      this.logger?.warn({ err: err.message }, 'Error en el WebSocket');
    });

    socket.on('close', (code, reasonBuffer) => {
      if (socket !== this.socket) return; // cierre de un socket anterior
      const reason = reasonBuffer?.toString?.() ?? '';
      const planned = this.plannedClose;
      this.#clearTimers();
      this.socket = null;
      this.disconnectedAt ??= this.now();
      this.emit('close', { code, reason, planned });
      if (this.stopped) return;

      const delay = planned ? 0 : backoffDelay(this.attempt, { ...this.backoff, random: this.random });
      this.attempt += planned ? 0 : 1;
      const level = planned ? 'info' : 'warn';
      this.logger?.[level]({ code, reason, delayMs: delay, attempt: this.attempt },
        planned ? 'Rotación programada del WebSocket: reconectando' : `WebSocket cerrado (${code}); reconexión en ${delay} ms`);
      this.timers.reconnect = setTimeout(() => this.#connect(), delay);
    });
  }

  #touch() {
    this.lastActivityAt = this.now();
    this.emit('activity');
  }

  #startTimers() {
    this.#clearTimers();
    // Rotación programada antes del corte de 24 h de Binance.
    this.timers.rotate = setTimeout(() => {
      this.plannedClose = true;
      this.socket?.close(1000, 'rotación programada');
    }, this.maxConnectionAgeMs);
    // Conexión zombi: sin mensajes ni pings.
    this.timers.liveness = setInterval(() => {
      const silentMs = this.now() - this.lastActivityAt;
      if (silentMs > this.livenessTimeoutMs) {
        this.logger?.warn({ silentMs }, 'WebSocket sin actividad: se fuerza la reconexión');
        this.socket?.terminate();
      }
    }, Math.min(5000, this.livenessTimeoutMs));
    for (const timer of [this.timers.rotate, this.timers.liveness]) timer.unref?.();
  }

  #clearTimers() {
    clearTimeout(this.timers.rotate);
    clearInterval(this.timers.liveness);
  }
}
