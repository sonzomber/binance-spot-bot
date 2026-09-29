/**
 * Límites de peso de la API REST de Binance.
 *
 * Binance asigna un "peso" a cada petición (velas: 2, exchangeInfo: 20…) y
 * limita el peso total por IP y por minuto (6000 en Spot). Cada respuesta
 * trae la cabecera X-MBX-USED-WEIGHT-1M con el peso usado en el minuto actual.
 *
 *   - Antes de llegar al límite (por defecto al 80%), el limitador FRENA:
 *     espera al minuto siguiente, cuando el contador se reinicia.
 *   - 429 (Too Many Requests): se superó el límite. Se espera lo que indica la
 *     cabecera Retry-After antes de volver a pedir.
 *   - 418 (I'm a teapot): la IP fue BLOQUEADA por seguir pidiendo después de un
 *     429. Se detienen todas las peticiones y se registra un error: seguir solo
 *     alarga el bloqueo (de 2 minutos hasta 3 días).
 *
 * Se conecta al cliente ccxt en dos puntos: beforeRequest() antes de cada
 * petición (dentro de la guardia de red) y handleRestResponse, que ve el código
 * HTTP y las cabeceras de CADA respuesta antes de que ccxt la convierta en error.
 */
import { sleep as defaultSleep } from '../lib/backoff.js';

const MINUTE = 60_000;

export class RateLimitedError extends Error {
  constructor(retryAfterMs, detail) {
    super(`Binance respondió 429 (demasiadas peticiones): se esperará ${Math.ceil(retryAfterMs / 1000)} s. ${detail ?? ''}`.trim());
    this.name = 'RateLimitedError';
    this.status = 429;
    this.retryAfterMs = retryAfterMs;
    this.retryable = true; // el limitador espera Retry-After antes del siguiente intento
  }
}

export class IpBannedError extends Error {
  constructor(bannedUntil) {
    super(
      `Binance bloqueó la IP (418) hasta ${new Date(bannedUntil).toISOString()} por exceso de peticiones. ` +
        'Se detuvieron todas las peticiones. No reintentes antes de esa hora: el bloqueo se alarga.',
    );
    this.name = 'IpBannedError';
    this.status = 418;
    this.bannedUntil = bannedUntil;
    this.retryable = false;
  }
}

/** Lee una cabecera sin importar mayúsculas (Headers de fetch u objeto plano). */
function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

export class WeightLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.limit] peso máximo por minuto (REQUEST_WEIGHT de exchangeInfo)
   * @param {number} [options.threshold] fracción del límite a partir de la cual se frena
   * @param {number} [options.defaultRetryAfterMs] espera ante un 429/418 sin cabecera Retry-After
   * @param {() => number} [options.now] reloj (idealmente la hora del servidor)
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {import('pino').Logger} [options.logger]
   * @param {(err: IpBannedError) => void} [options.onBan] aviso al bot para detenerse
   */
  constructor({ limit = 6000, threshold = 0.8, defaultRetryAfterMs = 60_000, now = Date.now, sleep = defaultSleep, logger, onBan } = {}) {
    this.limit = limit;
    this.threshold = threshold;
    this.defaultRetryAfterMs = defaultRetryAfterMs;
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.onBan = onBan;
    this.usedWeight = 0;
    this.usedWeightMinute = -1; // minuto (epoch/60000) al que corresponde usedWeight
    this.pausedUntil = 0;
    this.bannedUntil = null;
  }

  get banned() {
    return this.bannedUntil !== null;
  }

  /** Peso usado en el minuto ACTUAL (el contador de Binance se reinicia cada minuto). */
  currentWeight(at = this.now()) {
    return Math.floor(at / MINUTE) === this.usedWeightMinute ? this.usedWeight : 0;
  }

  /** Espera lo necesario antes de una petición. Lanza IpBannedError si la IP está bloqueada. */
  async beforeRequest() {
    if (this.banned) throw new IpBannedError(this.bannedUntil);

    const now = this.now();
    if (now < this.pausedUntil) {
      const waitMs = this.pausedUntil - now;
      this.logger?.warn({ waitMs }, `Esperando ${Math.ceil(waitMs / 1000)} s por un 429 (Retry-After) antes de la próxima petición`);
      await this.sleep(waitMs);
    }

    const used = this.currentWeight();
    if (used >= this.limit * this.threshold) {
      const at = this.now();
      const waitMs = (Math.floor(at / MINUTE) + 1) * MINUTE - at + 250; // al minuto siguiente (+ margen)
      this.logger?.warn(
        { usedWeight: used, limit: this.limit, waitMs },
        `Frenando: peso usado ${used}/${this.limit} (≥ ${Math.round(this.threshold * 100)}%); espera de ${Math.ceil(waitMs / 1000)} s`,
      );
      await this.sleep(waitMs);
    }
    if (this.banned) throw new IpBannedError(this.bannedUntil); // pudo llegar un 418 mientras esperaba
  }

  /**
   * Registra una respuesta: actualiza el peso usado y reacciona a 429/418.
   * @throws {RateLimitedError | IpBannedError} si la respuesta fue 429 o 418
   */
  observe(status, headers) {
    const now = this.now();
    const weight = Number(header(headers, 'x-mbx-used-weight-1m'));
    if (Number.isFinite(weight)) {
      this.usedWeight = weight;
      this.usedWeightMinute = Math.floor(now / MINUTE);
    }
    if (status !== 429 && status !== 418) return;

    const retryAfterSeconds = Number(header(headers, 'retry-after'));
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : this.defaultRetryAfterMs;

    if (status === 429) {
      this.pausedUntil = Math.max(this.pausedUntil, now + retryAfterMs);
      this.logger?.warn({ retryAfterMs, usedWeight: this.usedWeight }, 'Binance respondió 429: límite de peticiones superado');
      throw new RateLimitedError(retryAfterMs);
    }

    this.bannedUntil = now + retryAfterMs;
    const err = new IpBannedError(this.bannedUntil);
    this.logger?.error({ bannedUntil: new Date(this.bannedUntil).toISOString() }, err.message);
    this.onBan?.(err);
    throw err;
  }

  /**
   * Conecta el limitador a un cliente ccxt: cada respuesta pasa por observe()
   * antes de que ccxt la procese. (beforeRequest se conecta en la guardia de red.)
   */
  attach(exchange) {
    const original = exchange.handleRestResponse.bind(exchange);
    exchange.handleRestResponse = (response, ...rest) => {
      try {
        this.observe(response.status, response.headers);
      } catch (err) {
        response.body?.cancel?.().catch(() => {}); // descarta el cuerpo para liberar la conexión
        throw err;
      }
      return original(response, ...rest);
    };
    return exchange;
  }
}
