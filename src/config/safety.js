/**
 * Guardia de entorno: garantiza que el bot SOLO hable con Spot Testnet o Demo Mode.
 *
 * Tres capas:
 *   1. La config solo acepta BINANCE_ENV = testnet | demo (ver config/index.js).
 *   2. assertExchangeUrls(): al crear el cliente, todas las URLs Spot que usa
 *      deben estar en la lista blanca del entorno. Si no, el bot no arranca.
 *   3. installRequestGuard(): envuelve el fetch (REST) y el client (WebSocket)
 *      internos de ccxt. Cada conexión se valida justo antes de salir, así que ni
 *      un bug ni un cambio posterior de URLs puede llegar a mainnet.
 */

export class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyError';
  }
}

/** Lista blanca exacta de hosts por entorno y protocolo. */
export const ALLOWED_HOSTS = Object.freeze({
  testnet: Object.freeze({
    'https:': Object.freeze(['testnet.binance.vision']),
    'wss:': Object.freeze([
      'stream.testnet.binance.vision',
      'ws-api.testnet.binance.vision',
      'testnet.binance.vision',
    ]),
  }),
  demo: Object.freeze({
    'https:': Object.freeze(['demo-api.binance.com']),
    'wss:': Object.freeze(['demo-stream.binance.com', 'demo-ws-api.binance.com']),
  }),
});

/** Rutas dentro de exchange.urls.api que usa un bot Spot (REST y WebSocket). */
const SPOT_URL_PATHS = Object.freeze([
  ['public'],
  ['private'],
  ['v1'],
  ['ws', 'spot'],
  ['ws', 'ws-api', 'spot'],
]);

const GUARD_MARK = Symbol.for('binance-spot-bot.requestGuard');

/**
 * Valida una URL contra la lista blanca del entorno.
 * @returns {URL} la URL parseada si es válida
 * @throws {SafetyError}
 */
export function assertAllowedUrl(rawUrl, env) {
  const allowed = ALLOWED_HOSTS[env];
  if (!allowed) {
    throw new SafetyError(
      `Entorno "${env}" no permitido. Solo se admite: ${Object.keys(ALLOWED_HOSTS).join(', ')}.`,
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafetyError(`Conexión bloqueada: URL inválida (${String(rawUrl)}).`);
  }

  if (url.username || url.password) {
    throw new SafetyError(`Conexión bloqueada: la URL no puede incluir credenciales (${url.host}).`);
  }

  const hosts = allowed[url.protocol];
  if (!hosts) {
    throw new SafetyError(
      `Conexión bloqueada: protocolo ${url.protocol} no permitido (solo https: y wss: cifrados).`,
    );
  }

  // Comparación EXACTA de hostname: "testnet.binance.vision.evil.com" no pasa.
  if (!hosts.includes(url.hostname)) {
    throw new SafetyError(
      `Conexión bloqueada a "${url.hostname}": no pertenece al entorno "${env}" ` +
        `(permitidos para ${url.protocol} ${hosts.join(', ')}). Este bot nunca se conecta a mainnet.`,
    );
  }
  return url;
}

/**
 * Verificación estática al arrancar: el cliente ccxt está en el modo correcto
 * y todas sus URLs Spot apuntan al entorno permitido.
 * @throws {SafetyError}
 */
export function assertExchangeUrls(exchange, env) {
  if (env === 'testnet' && exchange.isSandboxModeEnabled !== true) {
    throw new SafetyError('El cliente no está en modo sandbox (Spot Testnet).');
  }
  if (env === 'demo' && exchange.options?.enableDemoTrading !== true) {
    throw new SafetyError('El cliente no está en Demo Mode.');
  }

  for (const keys of SPOT_URL_PATHS) {
    const value = keys.reduce((node, key) => node?.[key], exchange.urls?.api);
    if (typeof value !== 'string') {
      throw new SafetyError(`Falta la URL urls.api.${keys.join('.')} en el cliente del exchange.`);
    }
    assertAllowedUrl(value, env);
  }
}

/**
 * Instala la guardia en tiempo de ejecución sobre un cliente ccxt.
 * Tras esto, cualquier request REST o conexión WebSocket fuera de la lista
 * blanca falla ANTES de salir de la máquina.
 * @param {{ beforeRequest?: (url: string, method: string, headers: object, body: string) => Promise<void> }} [hooks]
 *        se ejecuta antes de cada petición REST permitida: el filtro de órdenes (src/execution/order-gate.js)
 *        y el limitador de peso (src/data/rate-limiter.js)
 */
export function installRequestGuard(exchange, env, { beforeRequest } = {}) {
  if (!ALLOWED_HOSTS[env]) assertAllowedUrl('https://invalid.invalid', env); // lanza el error de entorno
  if (exchange[GUARD_MARK]) {
    throw new SafetyError('La guardia de red ya está instalada en este cliente.');
  }

  const originalFetch = exchange.fetch.bind(exchange);
  const originalClient = exchange.client.bind(exchange);

  const guardedFetch = async (url, method, headers, body) => {
    assertAllowedUrl(url, env); // primero la guardia: una URL prohibida no espera ni cuenta peso
    await beforeRequest?.(url, method, headers, body);
    return originalFetch(url, method, headers, body);
  };
  const guardedClient = (url) => {
    const parsed = assertAllowedUrl(url, env);
    // La WebSocket API permite crear órdenes por fuera de REST, donde está el filtro
    // de órdenes. El bot no la usa: se bloquea para que no exista ese camino.
    if (parsed.pathname.startsWith('/ws-api')) {
      throw new SafetyError('WebSocket API bloqueada: toda orden debe pasar por REST y por el gestor de riesgo.');
    }
    return originalClient(url);
  };

  // No escribibles ni reconfigurables: nadie puede quitar la guardia después.
  Object.defineProperties(exchange, {
    fetch: { value: guardedFetch, writable: false, configurable: false, enumerable: false },
    client: { value: guardedClient, writable: false, configurable: false, enumerable: false },
    [GUARD_MARK]: { value: env, writable: false, configurable: false, enumerable: false },
  });
  return exchange;
}

export function hasRequestGuard(exchange) {
  return Boolean(exchange?.[GUARD_MARK]);
}
