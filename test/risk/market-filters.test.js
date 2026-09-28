import { describe, expect, it } from 'vitest';
import {
  checkMarketFilters,
  decimalsOf,
  isMultipleOfStep,
  roundDownToStep,
} from '../../src/risk/market-filters.js';
import { BTC_USDT_MARKET as market } from '../helpers.js';

describe('decimalsOf', () => {
  it.each([
    [0.00001, 5], [0.01, 2], [0.1, 1], [1, 0], [1e-8, 8], [0.25, 2],
  ])('%s → %i decimales', (step, decimals) => {
    expect(decimalsOf(step)).toBe(decimals);
  });
});

describe('roundDownToStep', () => {
  it('redondea hacia abajo, nunca hacia arriba', () => {
    expect(roundDownToStep(0.000599, 0.00001)).toBe(0.00059);
    expect(roundDownToStep(0.0000999, 0.00001)).toBe(0.00009);
    expect(roundDownToStep(1.23999, 0.01)).toBe(1.23);
  });

  it('no pierde un paso por errores de floats (0.00059 / 0.00001 = 58.999…)', () => {
    expect(roundDownToStep(0.00059, 0.00001)).toBe(0.00059);
  });

  it('valores menores que un paso → 0', () => {
    expect(roundDownToStep(0.000009, 0.00001)).toBe(0);
  });
});

describe('isMultipleOfStep', () => {
  it.each([
    [0.00059, 0.00001, true],
    [0.000595, 0.00001, false],
    [84000.01, 0.01, true],
    [84000.015, 0.01, false],
  ])('%s con paso %s → %s', (value, step, expected) => {
    expect(isMultipleOfStep(value, step)).toBe(expected);
  });
});

describe('checkMarketFilters (BTC/USDT del testnet)', () => {
  const buy = (amount, price, type = 'market') => checkMarketFilters({ side: 'buy', type, amount, price }, market);

  it('orden válida → sin violaciones', () => {
    expect(buy(0.00059, 84000)).toEqual([]);
    expect(buy(0.00059, 84000.01, 'limit')).toEqual([]);
  });

  it('cantidad con más decimales que el paso (LOT_SIZE)', () => {
    expect(buy(0.000595, 84000).join()).toMatch(/no es múltiplo del paso 0.00001 \(máx\. 5 decimales\)/);
  });

  it('cantidad bajo el mínimo (LOT_SIZE.minQty)', () => {
    expect(buy(0.000001, 84000).join()).toMatch(/menor que el mínimo 0.00001/);
  });

  it('valor de la orden bajo el mínimo del par (NOTIONAL: 5 USDT)', () => {
    // 0.00005 BTC × 84 000 = 4.20 USDT
    expect(buy(0.00005, 84000).join()).toMatch(/4\.20 USDT\) es menor que el mínimo del par \(5 USDT\)/);
  });

  it('cantidad sobre el máximo para órdenes de mercado (MARKET_LOT_SIZE)', () => {
    expect(buy(106, 84000).join()).toMatch(/máximo para órdenes de mercado/);
    expect(buy(106, 84000, 'limit').join()).not.toMatch(/órdenes de mercado/);
  });

  it('precio límite con más decimales que el tick (PRICE_FILTER)', () => {
    expect(buy(0.00059, 84000.015, 'limit').join()).toMatch(/no es múltiplo del tick 0.01 \(máx\. 2 decimales\)/);
  });

  it('en órdenes de mercado el precio es solo una estimación: no se exige el tick', () => {
    expect(buy(0.00059, 84000.015)).toEqual([]);
  });

  it('precio límite fuera de rango', () => {
    expect(buy(1, 0.001, 'limit').join()).toMatch(/precio 0.001 es menor que el mínimo/);
  });

  it.each([[NaN, 84000], [0, 84000], [-1, 84000], [0.001, 0], [0.001, undefined]])(
    'valores inválidos (amount=%s, price=%s)',
    (amount, price) => {
      expect(buy(amount, price).join()).toMatch(/inválid/);
    },
  );
});
