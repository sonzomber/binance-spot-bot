/**
 * Sincronización de hora con el servidor de Binance.
 *
 * Cada petición firmada lleva un timestamp. Binance la rechaza (error -1021) si
 * ese timestamp está fuera de su ventana (recvWindow, 5 s por defecto), algo que
 * pasa si el reloj de la PC se adelanta o atrasa. Además el bot necesita la hora
 * del servidor para saber cuándo una vela está cerrada.
 *
 * Método: se pide la hora al servidor y se mide cuánto tardó la respuesta (RTT).
 * Se asume que el servidor respondió a mitad de camino:
 *     desfase = horaServidor − (horaLocalAlPedir + RTT / 2)
 * y se repite periódicamente, porque los relojes se desvían con el tiempo.
 */
export class TimeSync {
  /**
   * @param {object} deps
   * @param {{ fetchTime: () => Promise<number>, options: object }} deps.exchange cliente ccxt
   * @param {import('pino').Logger} [deps.logger]
   * @param {() => number} [deps.localNow] reloj local (inyectable en tests)
   * @param {number} [deps.intervalMs] cada cuánto re-sincronizar
   * @param {number} [deps.warnDriftMs] desfase a partir del cual se avisa
   */
  constructor({ exchange, logger, localNow = Date.now, intervalMs = 30 * 60_000, warnDriftMs = 1000 }) {
    this.exchange = exchange;
    this.logger = logger;
    this.localNow = localNow;
    this.intervalMs = intervalMs;
    this.warnDriftMs = warnDriftMs;
    this.offsetMs = 0;
    this.lastSyncAt = null;
    this.timer = null;
  }

  /** Hora estimada del servidor (ms epoch). */
  now() {
    return this.localNow() + this.offsetMs;
  }

  async sync() {
    const sentAt = this.localNow();
    const serverTime = await this.exchange.fetchTime();
    const receivedAt = this.localNow();
    const rttMs = receivedAt - sentAt;
    this.offsetMs = Math.round(serverTime - (sentAt + rttMs / 2));
    this.lastSyncAt = receivedAt;
    // ccxt firma con: timestamp = hora local − timeDifference  →  timeDifference = −desfase
    this.exchange.options.timeDifference = -this.offsetMs;

    const details = { offsetMs: this.offsetMs, rttMs };
    if (Math.abs(this.offsetMs) >= this.warnDriftMs) {
      this.logger?.warn(details, `El reloj local difiere ${this.offsetMs} ms del servidor: se compensa, pero conviene sincronizar la hora de la PC`);
    } else {
      this.logger?.debug(details, 'Hora sincronizada con el servidor');
    }
    if (rttMs > 2000) this.logger?.warn(details, 'Respuesta lenta del servidor: la sincronización de hora es menos precisa');
    return details;
  }

  /** Re-sincroniza cada intervalMs. Un fallo se registra y se reintenta en el siguiente ciclo. */
  start() {
    this.stop();
    this.timer = setInterval(() => {
      this.sync().catch((err) => this.logger?.warn({ err: err.message }, 'No se pudo sincronizar la hora; se reintentará'));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
