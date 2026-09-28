import { describe, expect, it } from 'vitest';
import { sma } from '../../src/strategy/indicators.js';

describe('sma', () => {
  it('calcula el promedio móvil alineado con la entrada', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('periodo 1 devuelve los mismos valores', () => {
    expect(sma([4, 8, 15], 1)).toEqual([4, 8, 15]);
  });

  it('con menos valores que el periodo, todo es null', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it('serie vacía → serie vacía', () => {
    expect(sma([], 3)).toEqual([]);
  });

  it('maneja decimales con precisión razonable', () => {
    const [, , value] = sma([0.1, 0.2, 0.3], 3);
    expect(value).toBeCloseTo(0.2, 12);
  });

  it.each([0, -1, 1.5, NaN, '3', undefined])('rechaza periodo inválido: %s', (period) => {
    expect(() => sma([1, 2, 3], period)).toThrow(RangeError);
  });

  it.each([
    [[1, NaN, 3]],
    [[1, Infinity, 3]],
    [[1, null, 3]],
    [[1, '2', 3]],
  ])('rechaza valores no numéricos: %j', (values) => {
    expect(() => sma(values, 2)).toThrow(TypeError);
  });

  it('rechaza entradas que no son arrays', () => {
    expect(() => sma(null, 2)).toThrow(TypeError);
  });
});
