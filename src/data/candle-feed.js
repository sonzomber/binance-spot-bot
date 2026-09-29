/**
 * Feed de velas: la única fuente de datos de mercado para la estrategia.
 *
 * Garantías:
 *   - Solo emite velas CERRADAS ('candle'). Las actualizaciones de la vela en
 *     curso solo emiten 'price' (útil para valorar posiciones), nunca 'candle'.
 *   - Serie continua y sin duplicados: toda vela pasa por el caché SQLite
 *     (módulo 4) y, si falta alguna, se rellena por REST antes de seguir.
 *   - Tras una reconexión del WebSocket, rellena por REST lo perdido durante la
 *     desconexión ANTES de reanudar. Mientras tanto los datos figuran como
 *     desactualizados y el gestor de riesgo bloquea órdenes.
 *   - Las velas perdidas NO se emiten una por una: solo la más reciente. Así
 *     una señal vieja (de hace varias velas) no se ejecuta tarde.
 *
 * Modos (DATA_FEED):
 *   ws   → stream de velas por WebSocket; REST solo para rellenar huecos.
 *   rest → consulta REST justo después de cada cierre de vela, más un
 *          "latido" de precio cada pocos segundos.
 *
 * Eventos: 'candle' { candle, source: 'ws'|'rest'|'backfill', added? },
 *          'price' { price, time }, 'fatal' (error irrecuperable, p. ej. IP bloqueada).
 */
import { EventEmitter } from 'node:events';
import { alignDown, timeframeToMs } from '../lib/timeframes.js';
import { CandleStore, formatGapWarning } from '../storage/candle-store.js';
import { CandleFetcher } from './candle-fetcher.js';
import { KlineStream, klineStreamUrl } from './kline-stream.js';
import { IpBannedError } from './rate-limiter.js';

export class CandleFeed extends EventEmitter {
  /**
   * @param {object} deps
   * @param {string} deps.symbol
   * @param {string} deps.timeframe
   * @param {'ws'|'rest'} deps.mode
   * @param {import('../storage/candle-store.js').CandleStore} deps.store caché de velas
   * @param {{ fetchRange: (from: number, to: number) => Promise<object[]> }} deps.fetcher REST
   * @param {import('./data-health.js').DataHealth} deps.health
   * @param {() => number} deps.now hora del servidor
   * @param {() => import('./kline-stream.js').KlineStream} [deps.createStream] modo ws
   * @param {() => Promise<number>} [deps.fetchPrice] modo rest (latido de precio)
   * @param {number} [deps.warmupCandles] velas a tener en caché al arrancar
   * @param {{ pollDelayMs?: number, heartbeatMs?: number, retryMs?: number }} [deps.rest]
   * @param {import('pino').Logger} [deps.logger]
   */
  constructor({ symbol, timeframe, mode, store, fetcher, health, now, createStream, fetchPrice,
    warmupCandles = 200, rest = {}, logger }) {
    super();
    Object.assign(this, { symbol, timeframe, mode, store, fetcher, health, now, createStream, fetchPrice, warmupCandles, logger });
    this.stepMs = timeframeToMs(timeframe);
    this.rest = { pollDelayMs: 2000, heartbeatMs: 15_000, retryMs: 5000, ...rest };
    this.lastClosed = null;
    this.recovering = false;
    this.pending = []; // velas cerradas que llegan por WS mientras se rellenan huecos
    this.queue = Promise.resolve(); // procesa las velas cerradas de a una, en orden
    this.timers = {};
    this.running = false;
  }

  /** Carga el historial inicial (caché + REST) y arranca la fuente de datos. */
  async start() {
    this.running = true;
    this.health.setRecovering('cargando el historial de velas');
    try {
      const result = await this.#backfill();
      this.logger?.info(
        { added: result.added, latest: result.latest && new Date(result.latest.time).toISOString() },
        `Historial listo: ${this.warmupCandles} velas ${this.symbol} ${this.timeframe} (${result.added} descargadas, el resto del caché)`,
      );
    } finally {
      this.health.setRecovering(null);
    }
    if (this.mode === 'ws') this.#startStream();
    else this.#startPolling();
  }

  async stop() {
    this.running = false;
    this.stream?.stop();
    clearTimeout(this.timers.poll);
    clearInterval(this.timers.heartbeat);
    await this.queue;
  }

  /** Las últimas `count` velas cerradas (lo que recibe la estrategia). */
  getCandles(count) {
    return this.store.last(this.symbol, this.timeframe, count);
  }

  // --- WebSocket -----------------------------------------------------------------

  #startStream() {
    this.stream = this.createStream();
    this.stream.on('activity', () => this.health.markHeartbeat());
    this.stream.on('kline', (message) => this.#onKline(message));
    this.stream.on('open', ({ reconnect, downtimeMs }) => {
      if (reconnect) this.#recoverAfterReconnect(downtimeMs);
    });
    this.stream.on('fatal', (err) => this.#fatal(err));
    this.stream.start();
  }

  #onKline({ candle, closed }) {
    if (!closed) {
      // Vela en curso: su precio cambia hasta el cierre. Nunca llega a la estrategia.
      this.emit('price', { price: candle.close, time: this.now() });
      return;
    }
    if (this.recovering) {
      this.pending.push(candle);
      return;
    }
    this.#enqueue(() => this.#acceptClosed(candle, 'ws'));
  }

  #recoverAfterReconnect(downtimeMs) {
    this.recovering = true;
    this.health.setRecovering(`rellenando velas perdidas durante la desconexión (${Math.round(downtimeMs / 1000)} s)`);
    this.#enqueue(async () => {
      try {
        const result = await this.#backfill();
        this.logger?.info({ added: result.added, downtimeMs }, `Reconexión: ${result.added} vela(s) perdida(s) rellenadas por REST`);
        if (result.added > 0) this.emit('candle', { candle: result.latest, source: 'backfill', added: result.added });
      } finally {
        this.recovering = false;
        try {
          for (const candle of this.pending.splice(0)) await this.#acceptClosed(candle, 'ws');
        } finally {
          this.health.setRecovering(null); // aunque algo falle, no queda "rellenando" para siempre
        }
      }
    });
  }

  /** Incorpora una vela cerrada: rellena huecos previos, la guarda y la emite si es nueva. */
  async #acceptClosed(candle, source) {
    if (this.lastClosed && candle.time <= this.lastClosed.time) return; // ya la teníamos
    if (this.lastClosed && candle.time > this.lastClosed.time + this.stepMs) {
      this.health.setRecovering('rellenando velas faltantes');
      try {
        await this.#fillRange(this.lastClosed.time + this.stepMs, candle.time);
      } finally {
        this.health.setRecovering(null);
      }
    }
    // Binance marcó la vela como cerrada (x = true): se acepta aunque el reloj vaya unos ms atrás.
    const { inserted } = this.store.upsert(this.symbol, this.timeframe, [candle], {
      now: Math.max(this.now(), candle.time + this.stepMs),
    });
    this.#setLastClosed(candle);
    if (inserted) this.emit('candle', { candle, source });
  }

  // --- REST ------------------------------------------------------------------------

  #startPolling() {
    this.#scheduleCandlePoll();
    this.timers.heartbeat = setInterval(() => this.#heartbeat(), this.rest.heartbeatMs);
    this.#heartbeat();
  }

  #scheduleCandlePoll(delayMs) {
    if (!this.running) return;
    const now = this.now();
    const untilClose = alignDown(now, this.stepMs) + this.stepMs - now;
    this.timers.poll = setTimeout(() => this.#pollCandles(), delayMs ?? untilClose + this.rest.pollDelayMs);
  }

  #pollCandles() {
    this.#enqueue(async () => {
      const expected = alignDown(this.now(), this.stepMs) - this.stepMs;
      try {
        const result = await this.#backfill();
        if (result.added > 0) this.emit('candle', { candle: result.latest, source: 'rest', added: result.added });
      } finally {
        // Si Binance aún no publica la vela recién cerrada, se reintenta pronto.
        const late = !this.lastClosed || this.lastClosed.time < expected;
        this.#scheduleCandlePoll(late ? this.rest.retryMs : undefined);
      }
    });
  }

  async #heartbeat() {
    try {
      const price = await this.fetchPrice();
      this.health.markHeartbeat();
      this.emit('price', { price, time: this.now() });
    } catch (err) {
      if (err instanceof IpBannedError) this.#fatal(err);
      else this.logger?.warn({ err: err.message }, 'No se pudo consultar el precio');
    }
  }

  // --- Relleno de huecos (caché + REST) ------------------------------------------------

  /**
   * Se asegura de tener en caché todas las velas cerradas desde la última
   * conocida (o las últimas warmupCandles) hasta la más reciente. Solo descarga
   * las que faltan en el caché; lo repetido se ignora.
   */
  async #backfill() {
    const lastClosedOpen = alignDown(this.now(), this.stepMs) - this.stepMs; // vela más reciente ya cerrada
    const from = this.lastClosed
      ? this.lastClosed.time + this.stepMs
      : lastClosedOpen - (this.warmupCandles - 1) * this.stepMs;
    const added = from <= lastClosedOpen ? await this.#fillRange(from, lastClosedOpen + this.stepMs) : 0;
    const [latest] = this.store.last(this.symbol, this.timeframe, 1);
    if (latest) this.#setLastClosed(latest);
    return { added, latest };
  }

  /** Descarga por REST solo los huecos del caché en [from, to). */
  async #fillRange(from, to) {
    const now = this.now();
    let added = 0;
    for (const gap of this.store.findGaps(this.symbol, this.timeframe, { from, to }).gaps) {
      const candles = await this.fetcher.fetchRange(gap.from, gap.to + this.stepMs);
      added += this.store.upsert(this.symbol, this.timeframe, candles, { now }).inserted;
    }
    const remaining = this.store.findGaps(this.symbol, this.timeframe, { from, to });
    if (remaining.missing > 0) this.logger?.warn(formatGapWarning(remaining)); // faltan también en Binance
    return added;
  }

  #setLastClosed(candle) {
    if (!this.lastClosed || candle.time >= this.lastClosed.time) this.lastClosed = candle;
    this.health.markCandle(this.lastClosed);
  }

  // --- Errores ---------------------------------------------------------------------------

  #enqueue(task) {
    this.queue = this.queue.then(task).catch((err) => {
      if (err instanceof IpBannedError) return this.#fatal(err);
      // Los datos quedan desactualizados (DataHealth lo detecta) y el próximo
      // cierre de vela vuelve a intentar rellenar el hueco.
      this.logger?.error({ err: err.message }, 'Error procesando velas; se reintentará en el próximo cierre');
    });
    return this.queue;
  }

  #fatal(err) {
    this.logger?.error({ err: err.message }, 'Error irrecuperable en el feed de datos: se detiene');
    this.stop();
    this.emit('fatal', err);
  }
}

/**
 * Arma el feed con las piezas reales: caché SQLite del entorno, descarga REST
 * con el cliente protegido, y stream WebSocket del mismo entorno.
 */
export function createCandleFeed({ config, exchange, market, db, health, now, logger, warmupCandles }) {
  const { symbol, timeframe } = config;
  const url = klineStreamUrl(exchange.urls.api.ws.spot, market.id, timeframe);
  return new CandleFeed({
    symbol,
    timeframe,
    mode: config.dataFeed,
    store: new CandleStore(db, { env: config.env }),
    fetcher: new CandleFetcher({ exchange, symbol, timeframe, now, logger }),
    health,
    now,
    logger,
    warmupCandles,
    createStream: () => new KlineStream({ url, env: config.env, logger, now }),
    fetchPrice: async () => (await exchange.fetchTicker(symbol)).last,
  });
}
