import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { IpBannedError, RateLimitedError, WeightLimiter } from '../../src/data/rate-limiter.js';
import { createTradingExchange } from '../../src/lib/exchange.js';
import { captureLogger, createClock, testEnv } from '../helpers.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Limitador con reloj y espera controlados: sleep avanza el reloj en vez de esperar. */
async function setup(options = {}) {
  const clock = createClock('2026-09-28T12:00:10.000Z');
  const sleep = vi.fn(async (ms) => clock.advance(ms));
  const { logger, lines } = await captureLogger();
  const limiter = new WeightLimiter({ now: clock.now, sleep, logger, ...options });
  return { limiter, clock, sleep, lines };
}

describe('WeightLimiter: peso usado (X-MBX-USED-WEIGHT-1M)', () => {
  it('lee el peso de las cabeceras', async () => {
    const { limiter } = await setup();
    limiter.observe(200, { 'X-MBX-USED-WEIGHT-1M': '1234' });
    expect(limiter.currentWeight()).toBe(1234);
  });

  it('por debajo del umbral no espera', async () => {
    const { limiter, sleep } = await setup();
    limiter.observe(200, new Headers({ 'x-mbx-used-weight-1m': '4799' })); // < 80% de 6000
    await limiter.beforeRequest();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('al llegar al 80% frena hasta el minuto siguiente, cuando el contador se reinicia', async () => {
    const { limiter, sleep, clock, lines } = await setup();
    limiter.observe(200, { 'x-mbx-used-weight-1m': '4800' });
    await limiter.beforeRequest();
    expect(sleep).toHaveBeenCalledWith(50_000 + 250); // de 12:00:10 a 12:01:00 (+ margen)
    expect(new Date(clock.now()).toISOString()).toBe('2026-09-28T12:01:00.250Z');
    expect(lines.some((l) => l.level === 40 && /Frenando: peso usado 4800\/6000/.test(l.msg))).toBe(true);
    expect(limiter.currentWeight()).toBe(0); // minuto nuevo
  });
});

describe('WeightLimiter: 429 y 418', () => {
  it('429: lanza RateLimitedError y la próxima petición espera Retry-After', async () => {
    const { limiter, sleep } = await setup();
    expect(() => limiter.observe(429, { 'retry-after': '7' })).toThrow(RateLimitedError);
    await limiter.beforeRequest();
    expect(sleep).toHaveBeenCalledWith(7000);
    sleep.mockClear();
    await limiter.beforeRequest(); // ya pasó la espera
    expect(sleep).not.toHaveBeenCalled();
  });

  it('429 sin Retry-After: usa una espera por defecto', async () => {
    const { limiter, sleep } = await setup({ defaultRetryAfterMs: 30_000 });
    expect(() => limiter.observe(429, {})).toThrow(RateLimitedError);
    await limiter.beforeRequest();
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('418: bloquea TODAS las peticiones siguientes, registra un error y avisa al bot', async () => {
    const onBan = vi.fn();
    const { limiter, lines } = await setup({ onBan });
    expect(() => limiter.observe(418, { 'retry-after': '120' })).toThrow(IpBannedError);
    expect(limiter.banned).toBe(true);
    await expect(limiter.beforeRequest()).rejects.toThrow(/bloqueó la IP \(418\) hasta 2026-09-28T12:02:10\.000Z/);
    expect(onBan).toHaveBeenCalledWith(expect.any(IpBannedError));
    expect(lines.some((l) => l.level === 50 && /bloqueó la IP/.test(l.msg))).toBe(true);
  });

  it('un 418 que llega mientras otra petición esperaba también la detiene', async () => {
    const { limiter, clock } = await setup();
    limiter.observe(200, { 'x-mbx-used-weight-1m': '5900' });
    limiter.sleep = async (ms) => {
      clock.advance(ms);
      expect(() => limiter.observe(418, { 'retry-after': '60' })).toThrow(); // otra petición recibe 418
    };
    await expect(limiter.beforeRequest()).rejects.toThrow(IpBannedError);
  });
});

describe('integración con el cliente ccxt (respuestas HTTP simuladas)', () => {
  let exchange;
  afterEach(async () => exchange?.close());

  async function mockedExchange() {
    const ctx = await setup();
    exchange = createTradingExchange(loadConfig(testEnv()), { limiter: ctx.limiter });
    exchange.fetchImplementation = vi.fn(); // la "red": cada test decide qué responde
    return { ...ctx, network: exchange.fetchImplementation };
  }

  it('lee el peso de cada respuesta real y frena la siguiente petición', async () => {
    const { network, limiter, sleep } = await mockedExchange();
    network.mockImplementation(async () => json({ serverTime: 1 }, 200, { 'x-mbx-used-weight-1m': '5000' }));
    await exchange.fetchTime();
    expect(limiter.currentWeight()).toBe(5000);
    await exchange.fetchTime();
    expect(sleep).toHaveBeenCalledWith(expect.any(Number)); // frenó antes de la 2ª
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('429 → RateLimitedError; la siguiente petición espera Retry-After y luego sale', async () => {
    const { network, sleep } = await mockedExchange();
    network
      .mockResolvedValueOnce(json({ code: -1003, msg: 'Too many requests' }, 429, { 'retry-after': '12' }))
      .mockResolvedValueOnce(json({ serverTime: 1 }));
    await expect(exchange.fetchTime()).rejects.toThrow(RateLimitedError);
    await expect(exchange.fetchTime()).resolves.toBe(1);
    expect(sleep).toHaveBeenCalledWith(12_000);
  });

  it('418 → IpBannedError; después ninguna petición llega a la red', async () => {
    const { network, lines } = await mockedExchange();
    network.mockResolvedValue(json({ code: -1003, msg: 'banned' }, 418, { 'retry-after': '300' }));
    await expect(exchange.fetchTime()).rejects.toThrow(IpBannedError);
    await expect(exchange.fetchTime()).rejects.toThrow(IpBannedError);
    await expect(exchange.fetchOHLCV('BTC/USDT', '1m')).rejects.toThrow(IpBannedError);
    expect(network).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.level === 50)).toHaveLength(1);
  });

  it('la guardia de red va primero: una URL prohibida ni espera ni cuenta', async () => {
    const { network, limiter, sleep } = await mockedExchange();
    limiter.observe(200, { 'x-mbx-used-weight-1m': '5999' });
    await expect(exchange.fetch('https://api.binance.com/api/v3/time')).rejects.toThrow(/nunca se conecta a mainnet/);
    expect(sleep).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
