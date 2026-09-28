/**
 * Cruce de medias móviles simples (SMA crossover).
 *
 * - "Golden cross": la SMA rápida cruza POR ENCIMA de la lenta → BUY.
 *   El precio reciente sube más rápido que el promedio largo (posible tendencia alcista).
 * - "Death cross": la SMA rápida cruza POR DEBAJO de la lenta → SELL.
 * - En cualquier otro caso → HOLD.
 *
 * Solo hay señal en la vela donde ocurre el cruce. Si el bot arranca a mitad
 * de una tendencia, espera al próximo cruce.
 *
 * Es una estrategia de ejemplo: sirve para aprender, no para ganar dinero.
 */
import { z } from 'zod';
import { Action, Strategy, hold, signal } from '../base-strategy.js';
import { sma } from '../indicators.js';

/**
 * Tolerancia relativa para considerar dos medias "iguales". Los floats tienen
 * error de redondeo (0.1 + 0.2 !== 0.3); sin tolerancia, dos medias iguales
 * podrían diferir en 1e-17 y producir un cruce falso. 1e-9 de BTC a 60 000 USDT
 * son 0.00006 USDT, muy por debajo del tick de precio (0.01).
 */
const EQUALITY_TOLERANCE = 1e-9;

const period = () =>
  z.number({ error: 'debe ser un número' }).int('debe ser un entero').min(1, 'debe ser ≥ 1');

export default class SmaCrossStrategy extends Strategy {
  static id = 'sma-cross';
  static description =
    'Compra cuando la SMA rápida cruza por encima de la lenta y vende cuando cruza por debajo.';
  static defaults = { fast: 9, slow: 21 };
  static paramsSchema = z
    .strictObject({ fast: period(), slow: period() })
    .refine((p) => p.fast < p.slow, { message: 'debe ser menor que slow', path: ['fast'] });

  /** slow velas para la primera SMA lenta + 1 para tener un punto anterior con qué comparar. */
  get warmup() {
    return this.params.slow + 1;
  }

  /**
   * Ventana extra hacia atrás: si las medias quedaron iguales durante algunas
   * velas, se busca la última diferencia distinta de cero hasta `slow` velas atrás.
   */
  get lookback() {
    return this.params.slow * 2;
  }

  onCandle(candles) {
    const { fast, slow } = this.params;
    const closes = candles.map((candle) => candle.close);
    const fastSeries = sma(closes, fast);
    const slowSeries = sma(closes, slow);

    // diferencia (rápida − lenta) por vela; 0 si son "iguales"; null si aún no hay SMA lenta
    const diffs = slowSeries.map((slowValue, i) => {
      if (slowValue === null) return null;
      const diff = fastSeries[i] - slowValue;
      return Math.abs(diff) <= EQUALITY_TOLERANCE * Math.abs(slowValue) ? 0 : diff;
    });

    const last = diffs.length - 1;
    const current = diffs[last];
    const extra = { indicators: { smaFast: fastSeries[last], smaSlow: slowSeries[last] } };
    const names = `SMA${fast}/SMA${slow}`;

    if (current === 0) {
      return hold('EQUAL', `${names}: las medias son iguales, no hay cruce`, extra);
    }

    // Última diferencia distinta de cero antes de la vela actual.
    let previous = 0;
    for (let i = last - 1; i >= 0 && diffs[i] !== null; i--) {
      if (diffs[i] !== 0) {
        previous = diffs[i];
        break;
      }
    }

    if (previous < 0 && current > 0) {
      return signal(Action.BUY, 'GOLDEN_CROSS', `${names}: la rápida cruzó por encima de la lenta`, extra);
    }
    if (previous > 0 && current < 0) {
      return signal(Action.SELL, 'DEATH_CROSS', `${names}: la rápida cruzó por debajo de la lenta`, extra);
    }
    if (previous === 0) {
      return hold('NO_CROSS', `${names}: sin referencia previa para detectar un cruce`, extra);
    }
    return hold(
      'NO_CROSS',
      `${names}: la rápida sigue ${current > 0 ? 'por encima' : 'por debajo'} de la lenta`,
      extra,
    );
  }
}
