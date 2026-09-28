import { describe, expect, it } from 'vitest';
import { Action, StrategyError } from '../../src/strategy/base-strategy.js';
import SmaCrossStrategy from '../../src/strategy/strategies/sma-cross.js';
import { candlesFromCloses } from '../helpers.js';

// Con periodos pequeños (fast=2, slow=4) los valores se pueden verificar a mano.
const small = () => new SmaCrossStrategy({ fast: 2, slow: 4 });
const evaluate = (closes, strategy = small()) => strategy.evaluate(candlesFromCloses(closes));

// Serie bajista que cruza hacia arriba pasando por un punto de igualdad:
//   closes: 10    9    8    7    6    9    12
//   SMA2:    -  9.5  8.5  7.5  6.5  7.5  10.5
//   SMA4:    -    -    -  8.5  7.5  7.5   8.5
//   dif:                  -1   -1    0    +2   → golden cross en la última vela
const GOLDEN = [10, 9, 8, 7, 6, 9, 12];

// Espejo alcista que cruza hacia abajo:
//   closes: 6    7    8    9   10    7    4
//   SMA2:   -  6.5  7.5  8.5  9.5  8.5  5.5
//   SMA4:   -    -    -  7.5  8.5  8.5  7.5
//   dif:                  +1   +1    0   -2    → death cross en la última vela
const DEATH = [6, 7, 8, 9, 10, 7, 4];

function deepFreeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

describe('SmaCrossStrategy — parámetros', () => {
  it('usa los valores por defecto 9/21', () => {
    const strategy = new SmaCrossStrategy();
    expect(strategy.params).toEqual({ fast: 9, slow: 21 });
    expect(strategy.warmup).toBe(22);
    expect(strategy.lookback).toBe(42);
  });

  it('combina parámetros parciales con los defaults', () => {
    expect(new SmaCrossStrategy({ fast: 5 }).params).toEqual({ fast: 5, slow: 21 });
  });

  it.each([
    [{ fast: 21, slow: 21 }, /fast: debe ser menor que slow/],
    [{ fast: 30, slow: 10 }, /fast: debe ser menor que slow/],
    [{ fast: 2.5 }, /fast: debe ser un entero/],
    [{ fast: 0 }, /fast: debe ser ≥ 1/],
    [{ slow: '21' }, /slow: debe ser un número/],
    [{ fsat: 5 }, /parámetro desconocido: fsat/],
  ])('rechaza %j', (params, message) => {
    expect(() => new SmaCrossStrategy(params)).toThrow(StrategyError);
    expect(() => new SmaCrossStrategy(params)).toThrow(message);
  });

  it('los parámetros no se pueden modificar', () => {
    const strategy = small();
    expect(() => { strategy.params.fast = 100; }).toThrow(TypeError);
  });
});

describe('SmaCrossStrategy — señales', () => {
  it('golden cross → BUY, con los valores de los indicadores', () => {
    const result = evaluate(GOLDEN);
    expect(result).toMatchObject({
      action: Action.BUY,
      code: 'GOLDEN_CROSS',
      strategy: 'sma-cross',
      price: 12,
      indicators: { smaFast: 10.5, smaSlow: 8.5 },
    });
    expect(result.time).toBe(candlesFromCloses(GOLDEN).at(-1).time);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('death cross → SELL', () => {
    expect(evaluate(DEATH)).toMatchObject({ action: Action.SELL, code: 'DEATH_CROSS' });
  });

  it('cruce directo, sin pasar por igualdad → BUY', () => {
    // SMA2 = 9, SMA4 = 8.25 en la última vela; antes la rápida estaba abajo
    expect(evaluate([10, 9, 8, 7, 6, 12])).toMatchObject({ action: Action.BUY });
  });

  it('solo hay señal en la vela del cruce, no en las siguientes', () => {
    // una vela más después del golden cross: la rápida sigue arriba
    expect(evaluate([...GOLDEN, 13])).toMatchObject({ action: Action.HOLD, code: 'NO_CROSS' });
  });

  it('sin cruce (la rápida sigue por debajo) → HOLD', () => {
    expect(evaluate(GOLDEN.slice(0, 5))).toMatchObject({ action: Action.HOLD, code: 'NO_CROSS' });
  });

  it('toque sin cruce (baja a igualdad y vuelve a subir) → HOLD', () => {
    // dif: +1, +1, 0, +1 → nunca estuvo por debajo, no es un cruce
    expect(evaluate([6, 7, 8, 9, 10, 7, 16])).toMatchObject({ action: Action.HOLD, code: 'NO_CROSS' });
  });
});

describe('SmaCrossStrategy — medias iguales (sin cruce)', () => {
  it('en el punto de igualdad → HOLD', () => {
    expect(evaluate(GOLDEN.slice(0, 6))).toMatchObject({ action: Action.HOLD, code: 'EQUAL' });
  });

  it('precio constante → HOLD', () => {
    expect(evaluate(Array(10).fill(100))).toMatchObject({ action: Action.HOLD, code: 'EQUAL' });
  });

  it('precio constante con decimales: el redondeo de floats no crea cruces falsos', () => {
    // 0.1 × 9 / 9 y 0.1 × 21 / 21 difieren en ~1e-17 por redondeo
    const result = evaluate(Array(50).fill(0.1), new SmaCrossStrategy());
    expect(result).toMatchObject({ action: Action.HOLD, code: 'EQUAL' });
  });

  it('medias iguales mucho tiempo y luego se separan: no es un cruce', () => {
    expect(evaluate([...Array(20).fill(10), 12])).toMatchObject({ action: Action.HOLD, code: 'NO_CROSS' });
  });
});

describe('SmaCrossStrategy — datos insuficientes', () => {
  it.each([
    ['menos velas que la SMA rápida', 1],
    ['menos velas que la SMA lenta', 3],
    ['exactamente el periodo de la SMA lenta (falta un punto previo)', 4],
  ])('%s → HOLD (WARMUP)', (_label, count) => {
    expect(evaluate(GOLDEN.slice(0, count))).toMatchObject({ action: Action.HOLD, code: 'WARMUP' });
  });

  it('con los periodos por defecto, 21 velas no alcanzan y 22 sí', () => {
    const strategy = new SmaCrossStrategy();
    expect(evaluate(Array(21).fill(100), strategy).code).toBe('WARMUP');
    expect(evaluate(Array(22).fill(100), strategy).code).not.toBe('WARMUP');
  });

  it.each([
    ['array vacío', []],
    ['null', null],
    ['undefined', undefined],
    ['no es un array', { close: 100 }],
  ])('datos vacíos (%s) → HOLD (NO_DATA)', (_label, input) => {
    expect(small().evaluate(input)).toMatchObject({ action: Action.HOLD, code: 'NO_DATA' });
  });
});

describe('SmaCrossStrategy — valores inválidos', () => {
  /** Toma la serie del golden cross (que daría BUY) y rompe la última vela. */
  const corruptLast = (patch) => {
    const candles = candlesFromCloses(GOLDEN);
    candles[candles.length - 1] = typeof patch === 'function' ? patch(candles.at(-1), candles) : patch;
    return candles;
  };

  it.each([
    ['close NaN', (c) => ({ ...c, close: NaN })],
    ['close null', (c) => ({ ...c, close: null })],
    ['close ausente', ({ close, ...c }) => c],
    ['close como string', (c) => ({ ...c, close: '12' })],
    ['close negativo', (c) => ({ ...c, close: -12, low: -12 })],
    ['close cero', (c) => ({ ...c, close: 0, low: 0 })],
    ['close Infinity', (c) => ({ ...c, close: Infinity, high: Infinity })],
    ['high menor que close', (c) => ({ ...c, high: 11 })],
    ['volumen negativo', (c) => ({ ...c, volume: -1 })],
    ['time inválido', (c) => ({ ...c, time: 'ayer' })],
    ['vela duplicada', (c, all) => ({ ...c, time: all.at(-2).time })],
    ['vela desordenada', (c, all) => ({ ...c, time: all.at(-2).time - 1 })],
    ['vela null', () => null],
    ['vela que no es objeto', () => 'vela'],
  ])('%s → HOLD (INVALID_DATA), aunque habría un cruce', (_label, patch) => {
    const result = small().evaluate(corruptLast(patch));
    expect(result).toMatchObject({ action: Action.HOLD, code: 'INVALID_DATA' });
    expect(result.reason).toMatch(/datos inválidos/);
  });

  it('una vela inválida fuera de la ventana de cálculo no bloquea la evaluación', () => {
    // lookback = 8: la vela 0 de 20 no participa en ninguna SMA
    const candles = candlesFromCloses([...Array(13).fill(50), ...GOLDEN]);
    candles[0] = { ...candles[0], close: NaN };
    expect(small().evaluate(candles)).toMatchObject({ action: Action.BUY });
  });
});

describe('SmaCrossStrategy — pureza', () => {
  it('no modifica las velas y es determinista', () => {
    const candles = deepFreeze(candlesFromCloses(GOLDEN));
    const first = small().evaluate(candles); // lanzaría TypeError si intentara mutarlas
    const second = small().evaluate(candles);
    expect(second).toEqual(first);
  });
});
