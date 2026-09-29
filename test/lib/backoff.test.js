import ccxt from 'ccxt';
import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, isRetryable, withRetry } from '../../src/lib/backoff.js';
import { IpBannedError, RateLimitedError } from '../../src/data/rate-limiter.js';

describe('backoffDelay (exponencial con jitter)', () => {
  it('crece al doble en cada intento', () => {
    const half = () => 0.5; // jitter fijo
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, { baseMs: 1000, random: half }))).toEqual([750, 1500, 3000, 6000]);
  });

  it('respeta el máximo', () => {
    expect(backoffDelay(20, { baseMs: 1000, maxMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it('el jitter varía la espera entre techo/2 y techo', () => {
    expect(backoffDelay(2, { baseMs: 1000, random: () => 0 })).toBe(2000);
    expect(backoffDelay(2, { baseMs: 1000, random: () => 1 })).toBe(4000);
    const samples = new Set(Array.from({ length: 50 }, () => backoffDelay(3)));
    expect(samples.size).toBeGreaterThan(10); // reparte los reintentos en el tiempo
  });
});

describe('isRetryable', () => {
  it.each([
    [new ccxt.NetworkError('x'), true],
    [new ccxt.RequestTimeout('x'), true],
    [new ccxt.ExchangeNotAvailable('x'), true],
    [new RateLimitedError(1000), true],
    [new IpBannedError(Date.now()), false],
    [new ccxt.InvalidOrder('x'), false],
    [new ccxt.InsufficientFunds('x'), false],
    [new ccxt.AuthenticationError('x'), false],
    [new Error('bug'), false],
  ])('%s → %s', (err, expected) => {
    expect(isRetryable(err)).toBe(expected);
  });
});

describe('withRetry', () => {
  const wait = vi.fn(async () => {});

  it('reintenta errores transitorios hasta lograrlo', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ccxt.NetworkError('caída'))
      .mockRejectedValueOnce(new ccxt.RequestTimeout('lento'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { wait, random: () => 0.5 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([750, 1500]);
  });

  it('no reintenta errores de lógica ni una IP bloqueada', async () => {
    for (const err of [new ccxt.InvalidOrder('x'), new IpBannedError(Date.now())]) {
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, { wait })).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('se rinde después de `retries` reintentos', async () => {
    const fn = vi.fn().mockRejectedValue(new ccxt.NetworkError('siempre'));
    await expect(withRetry(fn, { retries: 2, wait })).rejects.toThrow('siempre');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
