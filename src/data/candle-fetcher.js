/**
 * Descarga de velas por REST (ccxt fetchOHLCV), con paginación y reintentos.
 * Devuelve SOLO velas cerradas según la hora del servidor.
 */
import { toCandle } from '../lib/candles.js';
import { withRetry } from '../lib/backoff.js';
import { timeframeToMs } from '../lib/timeframes.js';

const PAGE_LIMIT = 1000; // máximo de velas por petición en Binance

export class CandleFetcher {
  /**
   * @param {object} deps
   * @param {{ fetchOHLCV: Function }} deps.exchange cliente ccxt (con guardia y limitador)
   * @param {string} deps.symbol
   * @param {string} deps.timeframe
   * @param {() => number} deps.now hora del servidor
   * @param {import('pino').Logger} [deps.logger]
   * @param {object} [deps.retry] opciones de withRetry (tests: wait sin demora)
   */
  constructor({ exchange, symbol, timeframe, now, logger, retry = {} }) {
    Object.assign(this, { exchange, symbol, timeframe, now, logger, retry });
    this.stepMs = timeframeToMs(timeframe);
  }

  /**
   * Velas cerradas con inicio en [from, to), en orden y sin repetir.
   * @returns {Promise<Array<{time, open, high, low, close, volume}>>}
   */
  async fetchRange(from, to) {
    const now = this.now();
    const result = [];
    let since = from;
    while (since < to) {
      const rows = await withRetry(
        () => this.exchange.fetchOHLCV(this.symbol, this.timeframe, since, PAGE_LIMIT, { endTime: to - 1 }),
        { logger: this.logger, label: `descarga de velas ${this.symbol} ${this.timeframe}`, ...this.retry },
      );
      const page = rows
        .map(toCandle)
        .filter((c) => c.time >= since && c.time < to && c.time + this.stepMs <= now); // solo cerradas
      if (page.length === 0) break;
      result.push(...page);
      since = page.at(-1).time + this.stepMs;
      if (rows.length < PAGE_LIMIT) break; // última página
    }
    return result;
  }
}
