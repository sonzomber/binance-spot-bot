/**
 * Actualizaciones en tiempo real por Server-Sent Events (SSE).
 *
 * SSE es una conexión HTTP que queda abierta y por la que el servidor envía
 * eventos de texto. Alcanza porque la comunicación es en un solo sentido
 * (servidor → navegador), y el EventSource del navegador se reconecta solo.
 *
 * Una vez por segundo, mientras haya alguien conectado, se revisa:
 *   - PRAGMA data_version: cambia cuando el bot (u otro proceso) guarda algo en
 *     SQLite → evento "db" (el navegador vuelve a pedir lo que muestra);
 *   - el archivo del kill switch → evento "killswitch";
 *   - líneas nuevas del log → evento "logs" (ya filtradas de secretos).
 * Cada 15 s se envía un comentario (": ping") para que la conexión no se corte.
 */
import { LogTail } from './log-reader.js';

export const MAX_CLIENTS = 20;

export class LiveHub {
  /**
   * @param {object} deps
   * @param {import('./database.js').PanelDatabase} deps.database
   * @param {import('../../src/risk/kill-switch.js').KillSwitch} deps.killSwitch
   * @param {string} deps.logFile
   * @param {number} [deps.intervalMs]
   * @param {number} [deps.keepAliveMs]
   * @param {() => number} [deps.now]
   */
  constructor({ database, killSwitch, logFile, intervalMs = 1000, keepAliveMs = 15_000, now = Date.now }) {
    Object.assign(this, { database, killSwitch, logFile, intervalMs, keepAliveMs, now });
    this.clients = new Set();
    this.timers = null;
    this.last = null;
  }

  /** Conecta un navegador. @returns {boolean} false si ya hay demasiados conectados */
  addClient(req, res) {
    if (this.clients.size >= MAX_CLIENTS) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n'); // si se corta, el navegador reintenta a los 3 s
    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.#stop();
    });
    if (!this.timers) this.#start();
    this.#send(res, 'hello', { serverTime: new Date(this.now()).toISOString(), ...this.last });
    return true;
  }

  /** Revisa si algo cambió y avisa. Público para las pruebas. */
  poll() {
    const current = this.#snapshot();
    const previous = this.last;
    this.last = current;
    if (previous && (current.dataVersion !== previous.dataVersion || current.database.state !== previous.database.state)) {
      this.broadcast('db', { database: current.database });
    }
    if (previous && JSON.stringify(current.killSwitch) !== JSON.stringify(previous.killSwitch)) {
      this.broadcast('killswitch', current.killSwitch);
    }
    const lines = this.tail.poll();
    if (lines.length) this.broadcast('logs', { lines });
  }

  broadcast(event, data) {
    for (const res of this.clients) this.#send(res, event, data);
  }

  close() {
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.#stop();
  }

  #snapshot() {
    const database = this.database.status();
    const file = this.killSwitch.read();
    return {
      database,
      dataVersion: this.database.dataVersion(),
      killSwitch: { active: Boolean(file), reason: file?.reason ?? null, createdAt: file?.createdAt ?? null },
    };
  }

  #start() {
    this.tail = new LogTail(this.logFile);
    this.last = this.#snapshot();
    const safePoll = () => {
      try {
        this.poll();
      } catch {
        // un error puntual (p. ej. el log rotando) no corta las actualizaciones
      }
    };
    this.timers = {
      poll: setInterval(safePoll, this.intervalMs),
      ping: setInterval(() => { for (const res of this.clients) res.write(': ping\n\n'); }, this.keepAliveMs),
    };
    this.timers.poll.unref?.();
    this.timers.ping.unref?.();
  }

  #stop() {
    if (!this.timers) return;
    clearInterval(this.timers.poll);
    clearInterval(this.timers.ping);
    this.timers = null;
  }

  #send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
