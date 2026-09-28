/**
 * Contrato común de todas las estrategias.
 *
 * Una estrategia SOLO decide: recibe velas cerradas y devuelve una señal
 * (BUY / SELL / HOLD). No conoce dinero, órdenes ni el exchange, por eso el
 * mismo código sirve para el bot en vivo y para el backtest.
 *
 * Para crear una estrategia nueva:
 *   1. Crea un archivo en src/strategy/strategies/ que exporte por defecto
 *      una clase que extienda Strategy.
 *   2. Define: static id, static defaults, static paramsSchema (zod),
 *      get warmup() y onCandle(candles, context).
 *   3. Actívala con STRATEGY=<id> en el .env.
 */
import { z } from 'zod';
import { findInvalidCandle } from '../lib/candles.js';

export const Action = Object.freeze({ BUY: 'BUY', SELL: 'SELL', HOLD: 'HOLD' });

export class StrategyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StrategyError';
  }
}

/**
 * Crea una señal inmutable.
 * @param {'BUY' | 'SELL' | 'HOLD'} action
 * @param {string} code identificador estable del motivo (p. ej. 'GOLDEN_CROSS')
 * @param {string} reason explicación legible para los logs
 * @param {object} [extra] datos adicionales (p. ej. valores de indicadores)
 */
export function signal(action, code, reason, extra = {}) {
  return Object.freeze({ ...extra, action, code, reason });
}

export const hold = (code, reason, extra) => signal(Action.HOLD, code, reason, extra);

export class Strategy {
  /** Identificador único en kebab-case; es el valor de STRATEGY en el .env. */
  static id = undefined;
  static description = '';
  /** Valores por defecto de los parámetros (se combinan con STRATEGY_PARAMS). */
  static defaults = {};
  /** Esquema zod que valida los parámetros ya combinados con los defaults. */
  static paramsSchema = z.strictObject({});

  constructor(params = {}) {
    const Klass = this.constructor;
    const result = Klass.paramsSchema.safeParse({ ...Klass.defaults, ...params });
    if (!result.success) {
      throw new StrategyError(
        `Parámetros inválidos para la estrategia "${Klass.id}": ${formatIssues(result.error.issues)}`,
      );
    }
    this.params = Object.freeze(result.data);
  }

  get id() {
    return this.constructor.id;
  }

  /** Mínimo de velas necesarias para poder emitir una señal. */
  get warmup() {
    throw new StrategyError(`La estrategia "${this.id}" no implementa warmup`);
  }

  /** Cuántas de las últimas velas recibe onCandle (por defecto, warmup). */
  get lookback() {
    return this.warmup;
  }

  /**
   * Punto de entrada público. Valida los datos y, solo si son válidos,
   * delega en onCandle(). Con datos insuficientes o inválidos devuelve HOLD:
   * ante la duda, no operar.
   *
   * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} candles
   *        velas CERRADAS, de la más antigua a la más reciente
   * @param {object} [context] información extra para estrategias que la necesiten (p. ej. posición)
   */
  evaluate(candles, context = {}) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return hold('NO_DATA', 'no hay velas para evaluar');
    }
    if (candles.length < this.warmup) {
      return hold('WARMUP', `se necesitan ${this.warmup} velas y hay ${candles.length}`);
    }

    const window = candles.slice(-this.lookback);
    const problem = findInvalidCandle(window);
    if (problem) {
      return hold('INVALID_DATA', `datos inválidos, no se opera: ${problem}`);
    }

    const result = this.onCandle(window, context);
    if (!result || !Object.values(Action).includes(result.action) || typeof result.code !== 'string') {
      throw new StrategyError(
        `La estrategia "${this.id}" devolvió una señal inválida: ${JSON.stringify(result)}`,
      );
    }
    const last = window.at(-1);
    return Object.freeze({ ...result, strategy: this.id, time: last.time, price: last.close });
  }

  /**
   * Lógica de la estrategia. Recibe entre warmup y lookback velas ya validadas.
   * Debe ser determinista y no modificar las velas.
   * @returns {ReturnType<typeof signal>}
   */
  onCandle(_candles, _context) {
    throw new StrategyError(`La estrategia "${this.id}" no implementa onCandle`);
  }
}

function formatIssues(issues) {
  return issues
    .map((issue) => {
      if (issue.code === 'unrecognized_keys') return `parámetro desconocido: ${issue.keys.join(', ')}`;
      return `${issue.path.join('.') || '(params)'}: ${issue.message}`;
    })
    .join('; ');
}
