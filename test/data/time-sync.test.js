import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { TimeSync } from '../../src/data/time-sync.js';
import { createTradingExchange } from '../../src/lib/exchange.js';
import { captureLogger, createClock, testEnv } from '../helpers.js';

/** Exchange falso: el servidor va `serverAheadMs` adelante y la respuesta tarda `rttMs`. */
function fakeExchange(clock, { serverAheadMs, rttMs }) {
  return {
    options: { timeDifference: 0 },
    fetchTime: vi.fn(async () => {
      const serverTime = clock.now() + serverAheadMs + rttMs / 2; // responde a mitad de camino
      clock.advance(rttMs);
      return serverTime;
    }),
  };
}

describe('TimeSync', () => {
  afterEach(() => vi.useRealTimers());

  it('calcula el desfase compensando la latencia (RTT / 2)', async () => {
    const clock = createClock();
    const sync = new TimeSync({ exchange: fakeExchange(clock, { serverAheadMs: 1500, rttMs: 400 }), localNow: clock.now });
    const result = await sync.sync();
    expect(result).toEqual({ offsetMs: 1500, rttMs: 400 });
    expect(sync.now() - clock.now()).toBe(1500); // hora del servidor = local + desfase
  });

  it('ajusta a ccxt para que las peticiones firmadas usen la hora del servidor', async () => {
    const clock = createClock();
    const exchange = fakeExchange(clock, { serverAheadMs: -2500, rttMs: 100 }); // PC adelantada 2.5 s
    await new TimeSync({ exchange, localNow: clock.now }).sync();
    expect(exchange.options.timeDifference).toBe(2500); // ccxt: timestamp = local − timeDifference
  });

  it('con el cliente ccxt real: nonce() queda en la hora del servidor', async () => {
    const exchange = createTradingExchange(loadConfig(testEnv()));
    const serverAhead = 3000;
    exchange.fetchTime = vi.fn(async () => Date.now() + serverAhead);
    await new TimeSync({ exchange }).sync();
    expect(Math.abs(exchange.nonce() - (Date.now() + serverAhead))).toBeLessThan(50);
    await exchange.close();
  });

  it('avisa si el reloj local está muy desfasado', async () => {
    const clock = createClock();
    const { logger, lines } = await captureLogger();
    await new TimeSync({ exchange: fakeExchange(clock, { serverAheadMs: 4000, rttMs: 10 }), localNow: clock.now, logger }).sync();
    expect(lines.some((l) => l.level === 40 && /difiere 4000 ms/.test(l.msg))).toBe(true);
  });

  it('re-sincroniza periódicamente; un fallo se registra y no detiene nada', async () => {
    vi.useFakeTimers();
    const clock = createClock();
    const { logger, lines } = await captureLogger();
    const exchange = fakeExchange(clock, { serverAheadMs: 100, rttMs: 10 });
    const sync = new TimeSync({ exchange, localNow: clock.now, logger, intervalMs: 60_000 });
    sync.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exchange.fetchTime).toHaveBeenCalledTimes(1);
    exchange.fetchTime.mockRejectedValueOnce(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines.some((l) => /No se pudo sincronizar la hora/.test(l.msg))).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exchange.fetchTime).toHaveBeenCalledTimes(3);
    sync.stop();
  });
});
