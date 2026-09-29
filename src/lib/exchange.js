/**
 * Fábrica del cliente de trading (ccxt).
 *
 * Es el ÚNICO lugar donde el bot crea un cliente con API keys. Siempre sale en
 * Spot Testnet o Demo Mode, con la guardia de red instalada y verificada, el
 * filtro de órdenes (ninguna orden sale sin aprobación del riesgo) y, si se
 * entrega, el limitador de peso conectado a cada petición.
 */
import ccxt from 'ccxt';
import {
  SafetyError,
  assertExchangeUrls,
  installRequestGuard,
} from '../config/safety.js';
import { installOrderGate } from '../execution/order-gate.js';

/**
 * @param {object} config configuración validada (config/index.js)
 * @param {{ limiter?: import('../data/rate-limiter.js').WeightLimiter }} [options]
 * @returns {import('ccxt').pro.binance}
 */
export function createTradingExchange(config, { limiter } = {}) {
  // Se usa la clase "pro" porque incluye REST + WebSockets en un solo cliente.
  const exchange = new ccxt.pro.binance({
    apiKey: config.apiKey,
    secret: config.apiSecret,
    enableRateLimit: true, // throttler de ccxt: espacia requests según el límite de Binance
    options: {
      defaultType: 'spot',
      fetchMarkets: { types: ['spot'] }, // sin futuros: sus URLs no son del Spot Testnet
      fetchCurrencies: false, // usa /sapi, que no existe en testnet
      adjustForTimeDifference: true, // corrige desfases del reloj local (error -1021)
    },
  });

  switch (config.env) {
    case 'testnet':
      exchange.setSandboxMode(true);
      break;
    case 'demo':
      exchange.enableDemoTrading(true);
      break;
    default:
      throw new SafetyError(`Entorno "${config.env}" no permitido. Solo testnet o demo.`);
  }

  // Las órdenes reales solo existen en modo "exchange": el filtro valida aprobaciones de ese ámbito.
  const orderGate = installOrderGate(exchange, { env: config.env, mode: 'exchange' });
  installRequestGuard(exchange, config.env, {
    beforeRequest: async (url, method, headers, body) => {
      orderGate.check(url, method, body); // antes de esperar por el limitador: lo prohibido no espera
      await limiter?.beforeRequest();
    },
  });
  limiter?.attach(exchange);
  assertExchangeUrls(exchange, config.env);
  return exchange;
}
