import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { testEnv } from '../helpers.js';
import {
  ALLOWED_HOSTS,
  SafetyError,
  assertAllowedUrl,
  assertExchangeUrls,
  hasRequestGuard,
  installRequestGuard,
} from '../../src/config/safety.js';
import { createTradingExchange } from '../../src/lib/exchange.js';

const MAINNET_URLS = [
  'https://api.binance.com/api/v3/order',
  'https://api1.binance.com/api/v3/time',
  'https://api-gcp.binance.com/api/v3/time',
  'https://data-api.binance.vision/api/v3/klines',
  'https://fapi.binance.com/fapi/v1/order',
  'https://testnet.binancefuture.com/fapi/v1/order',
  'wss://stream.binance.com:9443/ws',
  'wss://ws-api.binance.com/ws-api/v3',
];

const LOOKALIKE_URLS = [
  'https://testnet.binance.vision.evil.com/api/v3/order', // subdominio falso
  'https://evil.com/testnet.binance.vision/api/v3/order', // host en la ruta
  'https://api.binance.com/?host=testnet.binance.vision', // host en el query
  'https://testnet.binance.vision@api.binance.com/api/v3', // truco de credenciales
  'https://testnet.binance.vision./api/v3/time', // punto final
  'http://testnet.binance.vision/api/v3/time', // sin cifrar
  'ws://stream.testnet.binance.vision/ws', // sin cifrar
  'ftp://testnet.binance.vision/',
  'not a url',
  '',
];

describe('assertAllowedUrl', () => {
  it.each([
    ['testnet', 'https://testnet.binance.vision/api/v3/order'],
    ['testnet', 'wss://stream.testnet.binance.vision/ws/btcusdt@kline_1m'],
    ['testnet', 'wss://ws-api.testnet.binance.vision/ws-api/v3'],
    ['demo', 'https://demo-api.binance.com/api/v3/order'],
    ['demo', 'wss://demo-stream.binance.com/ws'],
    ['demo', 'wss://demo-ws-api.binance.com/ws-api/v3'],
  ])('permite %s → %s', (env, url) => {
    expect(assertAllowedUrl(url, env)).toBeInstanceOf(URL);
  });

  describe.each(['testnet', 'demo'])('en %s', (env) => {
    it.each(MAINNET_URLS)('bloquea mainnet: %s', (url) => {
      expect(() => assertAllowedUrl(url, env)).toThrow(SafetyError);
    });

    it.each(LOOKALIKE_URLS)('bloquea URL engañosa: %s', (url) => {
      expect(() => assertAllowedUrl(url, env)).toThrow(SafetyError);
    });
  });

  it('no mezcla entornos: demo no pasa en testnet y viceversa', () => {
    expect(() => assertAllowedUrl('https://demo-api.binance.com/api/v3/time', 'testnet')).toThrow(SafetyError);
    expect(() => assertAllowedUrl('https://testnet.binance.vision/api/v3/time', 'demo')).toThrow(SafetyError);
  });

  it.each(['mainnet', 'live', undefined, ''])('rechaza entorno desconocido: %s', (env) => {
    expect(() => assertAllowedUrl('https://testnet.binance.vision/api/v3/time', env)).toThrow(/no permitido/);
  });

  it('la lista blanca no se puede modificar', () => {
    expect(() => ALLOWED_HOSTS.testnet['https:'].push('api.binance.com')).toThrow(TypeError);
    expect(() => { ALLOWED_HOSTS.mainnet = {}; }).toThrow(TypeError);
  });
});

describe('createTradingExchange', () => {
  const exchanges = [];
  const make = (env) => {
    const exchange = createTradingExchange(loadConfig(testEnv({ BINANCE_ENV: env })));
    exchanges.push(exchange);
    return exchange;
  };
  afterEach(async () => {
    await Promise.all(exchanges.splice(0).map((exchange) => exchange.close()));
  });

  it('testnet: modo sandbox, URLs Spot correctas y guardia instalada', () => {
    const exchange = make('testnet');
    expect(exchange.isSandboxModeEnabled).toBe(true);
    expect(exchange.urls.api.public).toBe('https://testnet.binance.vision/api/v3');
    expect(exchange.urls.api.ws.spot).toBe('wss://stream.testnet.binance.vision/ws');
    expect(hasRequestGuard(exchange)).toBe(true);
  });

  it('demo: Demo Mode, URLs Spot correctas y guardia instalada', () => {
    const exchange = make('demo');
    expect(exchange.options.enableDemoTrading).toBe(true);
    expect(exchange.urls.api.public).toBe('https://demo-api.binance.com/api/v3');
    expect(exchange.urls.api.ws.spot).toBe('wss://demo-stream.binance.com/ws');
    expect(hasRequestGuard(exchange)).toBe(true);
  });

  it('solo carga mercados Spot', () => {
    expect(make('testnet').options.fetchMarkets.types).toEqual(['spot']);
  });

  it('se niega a crear un cliente para un entorno no permitido', () => {
    // Aunque alguien salte la validación de la config, la fábrica también lo rechaza.
    expect(() => createTradingExchange({ env: 'mainnet' })).toThrow(SafetyError);
  });
});

describe('guardia de red en tiempo de ejecución', () => {
  let exchange;
  afterEach(async () => {
    vi.restoreAllMocks();
    await exchange?.close();
  });

  it('bloquea REST a mainnet ANTES de enviar la petición', async () => {
    exchange = createTradingExchange(loadConfig(testEnv()));
    // ccxt usa fetchImplementation para la llamada HTTP real; si la guardia fallara,
    // la petición llegaría a este mock (y nunca a la red).
    const network = vi.fn();
    exchange.fetchImplementation = network;

    // Simula un bug o manipulación: alguien cambia la URL después de arrancar.
    exchange.urls.api.public = 'https://api.binance.com/api/v3';
    await expect(exchange.publicGetTime()).rejects.toThrow(SafetyError);
    await expect(exchange.fetch('https://api.binance.com/api/v3/order', 'POST')).rejects.toThrow(
      /api\.binance\.com.*nunca se conecta a mainnet/,
    );
    expect(network).not.toHaveBeenCalled();
  });

  it('bloquea aunque se desactive el modo sandbox', async () => {
    exchange = createTradingExchange(loadConfig(testEnv()));
    exchange.fetchImplementation = vi.fn();
    exchange.setSandboxMode(false); // las URLs vuelven a mainnet...
    expect(() => assertExchangeUrls(exchange, 'testnet')).toThrow(SafetyError); // ...el preflight lo detecta
    await expect(exchange.publicGetTime()).rejects.toThrow(SafetyError); // ...y la guardia lo bloquea
  });

  it('bloquea WebSockets a mainnet', () => {
    exchange = createTradingExchange(loadConfig(testEnv()));
    expect(() => exchange.client('wss://stream.binance.com:9443/ws')).toThrow(SafetyError);
    expect(exchange.clients?.['wss://stream.binance.com:9443/ws']).toBeUndefined();
  });

  it('la guardia no se puede quitar ni reinstalar', () => {
    exchange = createTradingExchange(loadConfig(testEnv()));
    expect(() => { exchange.fetch = async () => ({}); }).toThrow(TypeError);
    expect(() => { exchange.client = () => ({}); }).toThrow(TypeError);
    expect(() => installRequestGuard(exchange, 'demo')).toThrow(/ya está instalada/);
  });
});
