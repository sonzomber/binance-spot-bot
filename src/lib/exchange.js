/**
 * Fábrica del cliente de trading (ccxt).
 *
 * Es el ÚNICO lugar donde el bot crea un cliente con API keys. Siempre sale en
 * Spot Testnet o Demo Mode, con la guardia de red instalada y verificada.
 */
import ccxt from 'ccxt';
import {
  SafetyError,
  assertExchangeUrls,
  installRequestGuard,
} from '../config/safety.js';

/**
 * @param {object} config configuración validada (config/index.js)
 * @returns {import('ccxt').pro.binance}
 */
export function createTradingExchange(config) {
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

  installRequestGuard(exchange, config.env);
  assertExchangeUrls(exchange, config.env);
  return exchange;
}
