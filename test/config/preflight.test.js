import ccxt from 'ccxt';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { testEnv } from '../helpers.js';
import { PreflightError, runPreflight } from '../../src/config/preflight.js';
import { SafetyError } from '../../src/config/safety.js';
import { createTradingExchange } from '../../src/lib/exchange.js';

const logger = pino({ level: 'silent' });

const BTC_USDT = {
  symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true,
  limits: { cost: { min: 5 }, amount: { min: 0.00001 } },
  precision: { amount: 0.00001, price: 0.01 },
};

/** Cliente real (con guardia) pero con las llamadas de red simuladas. */
function stubbedExchange(config) {
  const exchange = createTradingExchange(config);
  exchange.fetchImplementation = vi.fn(() => { throw new Error('no debería tocar la red'); });
  vi.spyOn(exchange, 'fetchTime').mockResolvedValue(Date.now());
  vi.spyOn(exchange, 'loadMarkets').mockImplementation(async () => {
    exchange.markets = { 'BTC/USDT': BTC_USDT };
    return exchange.markets;
  });
  vi.spyOn(exchange, 'fetchBalance').mockResolvedValue({ free: { BTC: 1, USDT: 10000 } });
  return exchange;
}

describe('runPreflight', () => {
  let exchange;
  beforeEach(() => { exchange = undefined; });
  afterEach(async () => {
    vi.restoreAllMocks();
    await exchange?.close();
  });

  it('dry-run sin keys: valida entorno, conexión y mercado; no pide saldo', async () => {
    exchange = stubbedExchange(loadConfig(testEnv()));
    const result = await runPreflight(exchange, loadConfig(testEnv()), logger);
    expect(result.market.symbol).toBe('BTC/USDT');
    expect(result.balances).toBeUndefined();
    expect(exchange.fetchBalance).not.toHaveBeenCalled();
  });

  it('con keys: confirma credenciales leyendo el saldo', async () => {
    const config = loadConfig(testEnv({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' }));
    exchange = stubbedExchange(config);
    const result = await runPreflight(exchange, config, logger);
    expect(result.balances).toEqual({ BTC: 1, USDT: 10000 });
  });

  it('keys de otro entorno (p. ej. mainnet): se niega a arrancar con un mensaje claro', async () => {
    const config = loadConfig(testEnv({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' }));
    exchange = stubbedExchange(config);
    exchange.fetchBalance.mockRejectedValue(new ccxt.AuthenticationError('binance {"code":-2008,"msg":"Invalid Api-Key ID."}'));
    await expect(runPreflight(exchange, config, logger)).rejects.toThrow(PreflightError);
    await expect(runPreflight(exchange, config, logger)).rejects.toThrow(/testnet\.binance\.vision/);
  });

  it('par inexistente en el entorno: se niega a arrancar', async () => {
    const config = loadConfig(testEnv({ SYMBOL: 'PEPE/USDT' }));
    exchange = stubbedExchange(config);
    await expect(runPreflight(exchange, config, logger)).rejects.toThrow(/PEPE\/USDT no existe/);
  });

  it('cliente sin guardia: se niega a arrancar', async () => {
    const naked = new ccxt.pro.binance();
    naked.setSandboxMode(true);
    await expect(runPreflight(naked, loadConfig(testEnv()), logger)).rejects.toThrow(SafetyError);
    await naked.close();
  });

  it('URLs alteradas: se niega a arrancar antes de cualquier llamada', async () => {
    const config = loadConfig(testEnv());
    exchange = stubbedExchange(config);
    exchange.urls.api.private = 'https://api.binance.com/api/v3';
    await expect(runPreflight(exchange, config, logger)).rejects.toThrow(SafetyError);
    expect(exchange.fetchTime).not.toHaveBeenCalled();
  });
});
