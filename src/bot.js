/**
 * El ciclo del bot: cada vela cerrada pasa por límites → estrategia → ejecución.
 *
 * Cola secuencial: las velas se procesan DE A UNA, en orden. Si llega una vela
 * mientras otra se procesa, espera en la cola; nunca hay dos en paralelo (dos
 * decisiones simultáneas podrían, por ejemplo, comprar dos veces).
 *
 * Apagado ordenado (shutdown):
 *   1. deja de aceptar velas/señales nuevas (las encoladas se descartan),
 *   2. espera a que termine la operación en curso (máximo shutdownTimeoutMs),
 *   3. cancela las órdenes pendientes NO ejecutadas,
 *   4. guarda el estado y el motivo en SQLite,
 *   5. cierra WebSocket, timers, cliente y base de datos.
 * Las posiciones abiertas NO se cierran ni se venden: vender sería una decisión
 * de trading, y apagar el bot no debe tomar decisiones de trading.
 *
 * Estado para el panel: si recibe un BotStatusStore, guarda ahí el arranque, cada
 * heartbeat, cada vela procesada y el apagado. Es solo un registro: si guardarlo
 * falla, se advierte en el log y el bot sigue igual (no afecta ninguna decisión).
 */
import { timeframeToMs } from './lib/timeframes.js';

const iso = (ms) => new Date(ms).toISOString();

export class TradingBot {
  /**
   * @param {object} deps
   * @param {object} deps.config configuración validada
   * @param {import('./strategy/base-strategy.js').Strategy} deps.strategy
   * @param {import('./data/candle-feed.js').CandleFeed} deps.feed
   * @param {import('./execution/executor.js').OrderExecutor} deps.executor
   * @param {import('./risk/risk-manager.js').RiskManager} deps.risk
   * @param {import('./data/data-health.js').DataHealth} [deps.health]
   * @param {import('./risk/kill-switch.js').KillSwitch} [deps.killSwitch]
   * @param {import('pino').Logger} deps.logger
   * @param {() => number} [deps.now] hora del servidor
   * @param {Array<{ name: string, close: () => unknown }>} [deps.resources] a cerrar al apagar
   *        (en orden: feed, timers, cliente, base de datos…)
   * @param {import('./storage/bot-status-store.js').BotStatusStore} [deps.status] estado para el panel
   */
  constructor({ config, strategy, feed, executor, risk, health, killSwitch, logger, now = Date.now, resources = [], status }) {
    Object.assign(this, { config, strategy, feed, executor, risk, health, killSwitch, logger, now, resources, status });
    this.symbol = config.symbol;
    this.stepMs = timeframeToMs(config.timeframe);
    this.shutdownTimeoutMs = config.lifecycle.shutdownTimeoutMs;
    this.heartbeatMs = config.lifecycle.heartbeatMs;
    // Una señal de una vela que cerró hace más que esto no se opera (llegó tarde, p. ej. tras un corte).
    this.maxSignalAgeMs = config.dataStaleAfterMs;

    this.queue = []; // velas cerradas esperando turno
    this.current = null; // promesa de la vela en proceso
    this.stopping = null; // promesa del apagado (si empezó)
    this.lastCandle = null;
    this.lastPrice = null;
    this.lastPriceTime = null; // hora del último precio recibido (evento "price")
    this.consecutiveErrors = 0;
    this.stats = { processed: 0, signals: 0, orders: 0 };
    this.timers = {};
    this.listeners = [];
    // Se resuelve cuando termina el apagado, lo inicie quien lo inicie (señal, kill switch, error).
    this.stopped = new Promise((resolve) => { this.resolveStopped = resolve; });
  }

  /** Empieza a escuchar velas cerradas, precios y el kill switch. */
  start() {
    this.#on(this.feed, 'candle', (event) => this.enqueue(event));
    this.#on(this.feed, 'price', ({ price, time }) => {
      this.lastPrice = price;
      this.lastPriceTime = time;
    });
    this.#on(this.feed, 'fatal', (err) => this.shutdown(`error irrecuperable en los datos: ${err.message}`, { exitCode: 1 }));
    this.stopKillSwitchWatch = this.killSwitch?.watch(() => this.#onKillSwitch());
    this.timers.heartbeat = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timers.heartbeat.unref?.();
    this.logger.info(
      { strategy: this.strategy.id, symbol: this.symbol, timeframe: this.config.timeframe, mode: this.config.mode },
      'Bot en marcha: esperando velas cerradas',
    );
    this.#saveStatus('en marcha', (status) => status.running({ time: this.now() }));
    this.heartbeat();
  }

  /** Precio para valorar posiciones y simular ejecuciones: el último conocido. */
  getPrice() {
    return this.lastPrice ?? this.lastCandle?.close ?? this.feed.getCandles(1)[0]?.close;
  }

  // --- Cola secuencial ----------------------------------------------------------------

  /** Encola una vela cerrada. Durante el apagado no se aceptan nuevas. */
  enqueue(event) {
    if (this.stopping) {
      this.logger.info({ candle: iso(event.candle.time) }, 'Apagando: se ignora la vela (no se aceptan señales nuevas)');
      return;
    }
    this.queue.push(event);
    if (this.queue.length > 1 || this.current) {
      this.logger.debug({ pending: this.queue.length }, 'Vela en cola: hay otra en proceso');
    }
    if (!this.current) this.current = this.#drain();
  }

  async #drain() {
    try {
      while (this.queue.length > 0 && !this.stopping) {
        const event = this.queue.shift();
        await this.#processSafely(event);
        this.#saveStatus('vela procesada', (status) => status.candleProcessed({ time: this.now(), lastCandle: this.lastCandle?.time }));
      }
    } finally {
      this.current = null;
    }
  }

  async #processSafely(event) {
    try {
      await this.processCandle(event);
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      this.logger.error({ err, candle: iso(event.candle.time) }, 'Error procesando la vela');
      if (this.consecutiveErrors >= 3) {
        void this.shutdown(`${this.consecutiveErrors} errores seguidos procesando velas`, { exitCode: 1 });
      }
    }
  }

  /** Una vela cerrada: límites → estrategia → (orden) → límites. */
  async processCandle({ candle, source = 'ws' }) {
    this.stats.processed++;
    this.lastCandle = candle;
    // El cierre de la vela es el precio más reciente, salvo que llegara uno posterior a su cierre.
    if (this.lastPriceTime === null || this.lastPriceTime < candle.time + this.stepMs) this.lastPrice = candle.close;
    const cancelOpenOrders = () => this.executor.cancelAll();
    const markPrices = () => ({ [this.symbol]: this.getPrice() });

    // 1. Límites (kill switch, pérdida diaria, parada guardada)
    const before = await this.risk.enforceLimits({ markPrices: markPrices(), cancelOpenOrders });
    if (before.halted) {
      void this.shutdown(`parada de riesgo: ${before.reason}`, { exitCode: 1 });
      return;
    }

    // 2. Estrategia (solo velas cerradas, desde el caché)
    const candles = this.feed.getCandles(this.strategy.lookback);
    const position = this.risk.store.openPositions()[0] ?? null;
    const signal = this.strategy.evaluate(candles, { position });
    this.logger.info(
      { candle: iso(candle.time), close: candle.close, source, action: signal.action, code: signal.code, indicators: signal.indicators },
      `Vela ${iso(candle.time)} cerrada: ${signal.action} (${signal.reason})`,
    );
    if (signal.action === 'HOLD') return;
    this.stats.signals++;

    const ageMs = this.now() - (candle.time + this.stepMs);
    if (ageMs > this.maxSignalAgeMs) {
      this.logger.warn({ ageMs }, `Señal ${signal.action} descartada: la vela cerró hace ${Math.round(ageMs / 1000)} s (llegó tarde)`);
      return;
    }

    // 3. Orden (pasa por el riesgo dentro del ejecutor)
    const result = await this.executor.submit({
      side: signal.action.toLowerCase(),
      signalKey: `${this.strategy.id}:${this.symbol}:${this.config.timeframe}:${candle.time}:${signal.action}`,
      strategy: this.strategy.id,
      signalCode: signal.code,
    });
    if (result.status !== 'skipped') this.stats.orders++;
    this.logger.info({ status: result.status, code: result.code, clientOrderId: result.order?.clientOrderId }, `Resultado de la señal ${signal.action}: ${result.status}`);

    // 4. Límites otra vez: una operación cerrada con pérdida puede alcanzar el máximo diario
    const after = await this.risk.enforceLimits({ markPrices: markPrices(), cancelOpenOrders });
    if (after.halted) void this.shutdown(`parada de riesgo: ${after.reason}`, { exitCode: 1 });
  }

  async #onKillSwitch() {
    try {
      const result = await this.risk.enforceLimits({
        markPrices: { [this.symbol]: this.getPrice() },
        cancelOpenOrders: () => this.executor.cancelAll(),
      });
      await this.shutdown(result.reason ?? 'kill switch activado', { exitCode: 1 });
    } catch (err) {
      this.logger.error({ err }, 'Error al procesar el kill switch');
      await this.shutdown('kill switch (con errores al procesarlo)', { exitCode: 1 });
    }
  }

  // --- Heartbeat ----------------------------------------------------------------------

  /** Registra el estado del bot: entorno, estrategia, última vela, posiciones y PnL del día. */
  heartbeat() {
    const price = this.getPrice();
    const daily = this.risk.dailyPnl(price ? { [this.symbol]: price } : {});
    const positions = this.risk.store.openPositions().map((p) => ({ id: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice }));
    const data = this.health?.status();
    const round = (n) => Math.round(n * 10_000) / 10_000;
    this.logger.info(
      {
        env: this.config.env,
        mode: this.config.mode,
        strategy: { id: this.strategy.id, params: this.strategy.params },
        lastCandle: this.lastCandle ? iso(this.lastCandle.time) : null,
        price,
        positions,
        dailyPnl: { day: daily.day, realized: round(daily.realized), unrealized: round(daily.unrealized), total: round(daily.total) },
        data: data ? (data.stale ? `desactualizados: ${data.reason}` : 'al día') : undefined,
        queue: this.queue.length,
        stats: this.stats,
      },
      `Estado: ${this.config.env}/${this.config.mode} · ${this.strategy.id} · ${positions.length} posición(es) · PnL del día ${round(daily.total)} USDT`,
    );
    this.#saveStatus('heartbeat', (status) => status.heartbeat({
      time: this.now(), lastCandle: this.lastCandle?.time, price, priceTime: this.#priceTime(), data,
    }));
  }

  /** Hora del precio que devuelve getPrice(): el último evento "price" o el cierre de la última vela. */
  #priceTime() {
    const candle = this.lastCandle ?? this.feed.getCandles(1)[0];
    const closeTime = candle ? candle.time + this.stepMs : null;
    if (this.lastPriceTime === null) return closeTime;
    return closeTime === null ? this.lastPriceTime : Math.max(this.lastPriceTime, closeTime);
  }

  /**
   * Guarda el estado para el panel. Nunca lanza: un fallo aquí no debe afectar al bot.
   * @param {string} what qué se guardaba (para el aviso)
   * @param {(status: import('./storage/bot-status-store.js').BotStatusStore) => void} write
   */
  #saveStatus(what, write) {
    if (!this.status) return;
    try {
      write(this.status);
    } catch (err) {
      this.logger.warn({ err: err.message }, `No se pudo guardar el estado del bot para el panel (${what}); el bot sigue normalmente`);
    }
  }

  // --- Apagado ordenado ---------------------------------------------------------------

  /**
   * Apagado ordenado. Idempotente: llamarlo de nuevo devuelve el mismo apagado.
   * @returns {Promise<{ reason: string, exitCode: number, timedOut: boolean }>}
   */
  shutdown(reason, { exitCode = 0 } = {}) {
    this.stopping ??= this.#shutdown(reason, exitCode);
    return this.stopping;
  }

  async #shutdown(reason, exitCode) {
    const level = exitCode === 0 ? 'info' : 'warn';
    this.logger[level]({ reason }, `Apagando el bot: ${reason}`);
    this.#saveStatus('apagando', (status) => status.stopping({ time: this.now(), reason }));

    // 1. No se aceptan señales nuevas (enqueue las rechaza y lo registra mientras dura el apagado)
    this.stopKillSwitchWatch?.();
    clearInterval(this.timers.heartbeat);
    const discarded = this.queue.splice(0).length;
    if (discarded) this.logger.info({ discarded }, `Se descartan ${discarded} vela(s) en cola`);

    // 2. Esperar la operación en curso (con tiempo máximo)
    let timedOut = false;
    if (this.current) {
      this.logger.info(`Esperando a que termine la operación en curso (máximo ${this.shutdownTimeoutMs / 1000} s)…`);
      const finished = await Promise.race([
        this.current.then(() => true, () => true),
        new Promise((resolve) => { this.timers.shutdown = setTimeout(() => resolve(false), this.shutdownTimeoutMs); }),
      ]);
      clearTimeout(this.timers.shutdown);
      if (!finished) {
        timedOut = true;
        this.logger.warn(`La operación en curso no terminó en ${this.shutdownTimeoutMs / 1000} s: se sigue con el apagado`);
      }
    }

    // 3. Cancelar órdenes pendientes NO ejecutadas (no se tocan las posiciones)
    try {
      const canceled = await this.executor.cancelAll();
      this.logger.info({ canceled: canceled.length }, `Órdenes pendientes canceladas: ${canceled.length}`);
    } catch (err) {
      this.logger.error({ err }, 'No se pudieron cancelar las órdenes pendientes: revísalas en el exchange');
    }

    // 4. Guardar estado y motivo
    const positions = this.risk.store.openPositions();
    if (positions.length > 0) {
      this.logger.warn(
        { positions: positions.map((p) => ({ id: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice })) },
        `Quedan ${positions.length} posición(es) abierta(s): NO se cierran al apagar`,
      );
    }
    try {
      this.risk.store.addEvent({
        time: this.now(),
        type: 'SHUTDOWN',
        code: exitCode === 0 ? 'NORMAL' : 'ABNORMAL',
        message: reason,
        data: { lastCandle: this.lastCandle && iso(this.lastCandle.time), openPositions: positions.length, stats: this.stats, timedOut },
      });
    } catch (err) {
      this.logger.error({ err }, 'No se pudo registrar el apagado en la base de datos');
    }
    this.#saveStatus('detenido', (status) => status.stopped({ time: this.now(), reason, exitCode }));

    // 5. Cerrar recursos (WebSocket, timers, cliente, base de datos)
    this.#removeListeners();
    for (const resource of this.resources) {
      try {
        await resource.close();
      } catch (err) {
        this.logger.warn({ err: err.message, resource: resource.name }, `Error al cerrar ${resource.name}`);
      }
    }
    this.logger[level]({ reason, exitCode }, `Bot detenido: ${reason}`);
    const result = { reason, exitCode, timedOut };
    this.resolveStopped(result);
    return result;
  }

  #on(emitter, event, handler) {
    emitter.on(event, handler);
    this.listeners.push([emitter, event, handler]);
  }

  #removeListeners() {
    for (const [emitter, event, handler] of this.listeners.splice(0)) emitter.off(event, handler);
  }
}
