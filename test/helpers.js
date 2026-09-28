/**
 * Utilidades compartidas por los tests.
 */

/** Entorno mínimo válido: la estrategia activa es obligatoria. */
export const testEnv = (overrides = {}) => ({ STRATEGY: 'sma-cross', ...overrides });

/**
 * Genera velas válidas a partir de precios de cierre (open = high = low = close).
 * @param {number[]} closes
 */
export function candlesFromCloses(closes, { start = Date.UTC(2026, 0, 1), stepMs = 60_000 } = {}) {
  return closes.map((close, i) => ({
    time: start + i * stepMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

/** Mercado BTC/USDT con los filtros reales del Spot Testnet (leídos por el preflight). */
export const BTC_USDT_MARKET = Object.freeze({
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  spot: true,
  active: true,
  precision: { amount: 0.00001, price: 0.01 },
  limits: {
    amount: { min: 0.00001, max: 9000 },
    price: { min: 0.01, max: 1_000_000 },
    cost: { min: 5, max: 9_000_000 },
    market: { min: 0, max: 105.07867116 },
  },
});

/** Reloj controlable: clock.set('2026-09-28T12:00:00Z'), clock.now() */
export function createClock(start = '2026-09-28T12:00:00.000Z') {
  let current = Date.parse(start);
  return {
    now: () => current,
    set: (iso) => { current = Date.parse(iso); },
    advance: (ms) => { current += ms; },
  };
}

/** Logger pino que guarda cada línea (ya parseada) en `lines`. */
export async function captureLogger() {
  const { default: pino } = await import('pino');
  const lines = [];
  const logger = pino({ level: 'trace', base: undefined }, { write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines, messages: () => lines.map((l) => l.msg) };
}

/** Directorio temporal único; devuelve la ruta y una función para borrarlo. */
export async function tempDir(prefix = 'bot-test-') {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
