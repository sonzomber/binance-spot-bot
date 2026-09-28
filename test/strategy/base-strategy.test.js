import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { Action, Strategy, StrategyError, hold, signal } from '../../src/strategy/base-strategy.js';
import { candlesFromCloses } from '../helpers.js';

/** Estrategia mínima para probar el contrato. */
class EchoStrategy extends Strategy {
  static id = 'echo';
  static defaults = { size: 3 };
  static paramsSchema = z.strictObject({ size: z.number().int().min(1) });
  get warmup() { return this.params.size; }
  get lookback() { return this.params.size + 2; }
  onCandle = vi.fn(() => signal(Action.BUY, 'ECHO', 'siempre compra'));
}

describe('Strategy — contrato común', () => {
  it('onCandle recibe solo las últimas `lookback` velas y el contexto', () => {
    const strategy = new EchoStrategy();
    const candles = candlesFromCloses([1, 2, 3, 4, 5, 6, 7, 8]);
    const context = { position: null };
    strategy.evaluate(candles, context);
    const [window, receivedContext] = strategy.onCandle.mock.calls[0];
    expect(window.map((c) => c.close)).toEqual([4, 5, 6, 7, 8]);
    expect(receivedContext).toBe(context);
  });

  it('no llama a onCandle si los datos no alcanzan o son inválidos', () => {
    const strategy = new EchoStrategy();
    expect(strategy.evaluate(candlesFromCloses([1, 2])).code).toBe('WARMUP');
    const broken = candlesFromCloses([1, 2, 3]);
    broken[1].close = NaN;
    expect(strategy.evaluate(broken).code).toBe('INVALID_DATA');
    expect(strategy.onCandle).not.toHaveBeenCalled();
  });

  it('agrega estrategia, tiempo y precio de la última vela a la señal', () => {
    const candles = candlesFromCloses([1, 2, 3]);
    expect(new EchoStrategy().evaluate(candles)).toMatchObject({
      action: Action.BUY, code: 'ECHO', strategy: 'echo', time: candles[2].time, price: 3,
    });
  });

  it('una señal mal formada de la estrategia es un error, no una orden', () => {
    const strategy = new EchoStrategy();
    strategy.onCandle.mockReturnValue({ action: 'COMPRAR_TODO', code: 'X' });
    expect(() => strategy.evaluate(candlesFromCloses([1, 2, 3]))).toThrow(StrategyError);
  });

  it('una estrategia sin warmup ni onCandle falla con un mensaje claro', () => {
    class Empty extends Strategy { static id = 'empty'; }
    expect(() => new Empty().evaluate(candlesFromCloses([1]))).toThrow(/no implementa warmup/);
  });

  it('valida parámetros con el esquema de la estrategia', () => {
    expect(() => new EchoStrategy({ size: 0 })).toThrow(/Parámetros inválidos para la estrategia "echo"/);
  });

  it('hold() y signal() crean señales inmutables', () => {
    const s = hold('WAIT', 'esperando');
    expect(s).toEqual({ action: Action.HOLD, code: 'WAIT', reason: 'esperando' });
    expect(Object.isFrozen(s)).toBe(true);
  });
});
