/**
 * Verificación de arranque (preflight): antes de operar, confirma contra el
 * exchange que todo corresponde al entorno elegido. Si algo falla, el bot no arranca.
 */
import ccxt from 'ccxt';
import { SafetyError, assertExchangeUrls, hasRequestGuard } from './safety.js';

export class PreflightError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'PreflightError';
  }
}

/**
 * @returns {Promise<{ serverTime: number, market: object, balances?: Record<string, number> }>}
 */
export async function runPreflight(exchange, config, logger) {
  // 1. Guardia de entorno (sin red)
  if (!hasRequestGuard(exchange)) {
    throw new SafetyError('El cliente del exchange no tiene la guardia de red instalada.');
  }
  assertExchangeUrls(exchange, config.env);
  const host = new URL(exchange.urls.api.public).hostname;
  logger.info({ env: config.env, host }, 'Guardia de entorno OK');

  // 2. Conectividad (endpoint público)
  const serverTime = await exchange.fetchTime();
  logger.info(
    { serverTime: new Date(serverTime).toISOString(), clockDriftMs: serverTime - Date.now() },
    'Conexión con el exchange OK',
  );

  // 3. El par existe en ESTE entorno (el testnet tiene menos pares que el real)
  await exchange.loadMarkets();
  const market = exchange.markets[config.symbol];
  if (!market || !market.spot) {
    throw new PreflightError(`El par ${config.symbol} no existe como mercado Spot en ${host}.`);
  }
  if (market.active === false) {
    throw new PreflightError(`El par ${config.symbol} no está activo en ${host}.`);
  }
  logger.info(
    {
      symbol: market.symbol,
      minNotional: market.limits?.cost?.min,
      minAmount: market.limits?.amount?.min,
      amountStep: market.precision?.amount,
      priceTick: market.precision?.price,
    },
    'Mercado OK',
  );

  // 4. Credenciales: las keys de testnet solo funcionan en testnet (y las de demo en demo),
  //    así que una llamada privada exitosa confirma que corresponden al entorno.
  let balances;
  if (config.apiKey && config.apiSecret) {
    try {
      const balance = await exchange.fetchBalance();
      balances = {
        [market.base]: balance.free?.[market.base] ?? 0,
        [market.quote]: balance.free?.[market.quote] ?? 0,
      };
    } catch (err) {
      if (err instanceof ccxt.AuthenticationError) {
        throw new PreflightError(
          `${host} rechazó las API keys. Verifica que sean de ${
            config.env === 'testnet' ? 'testnet.binance.vision' : 'demo.binance.com'
          } (las keys de un entorno no sirven en otro)`,
          { cause: err },
        );
      }
      throw err;
    }
    logger.info({ balances }, 'Credenciales OK (saldo disponible)');
  } else {
    logger.warn('Sin API keys: se usarán solo datos públicos (válido únicamente en dry-run).');
  }

  return { serverTime, market, balances };
}
