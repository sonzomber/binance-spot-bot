/**
 * Reintentos con backoff exponencial y jitter.
 *
 * Backoff exponencial: cada reintento espera el doble que el anterior
 * (1 s, 2 s, 4 s, 8 s…) hasta un máximo. Así, si el exchange está caído, el
 * bot no lo bombardea con peticiones.
 *
 * Jitter (azar): si muchos clientes se desconectan a la vez y todos reintentan
 * exactamente a los 1, 2, 4 s, vuelven a chocar. Agregar una parte aleatoria
 * los reparte en el tiempo. Se usa "equal jitter": la mitad fija + la mitad al azar.
 */
import ccxt from 'ccxt';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {number} attempt 0 para el primer reintento
 * @returns {number} milisegundos a esperar: entre techo/2 y techo, con techo = min(max, base × 2^attempt)
 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 60_000, random = Math.random } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * ¿Vale la pena reintentar? Solo errores transitorios de red o del exchange.
 * Nunca errores de lógica (fondos insuficientes, orden inválida, credenciales)
 * ni una IP bloqueada (418): reintentar solo empeoraría las cosas.
 */
export function isRetryable(err) {
  if (err?.retryable !== undefined) return err.retryable; // errores propios (429 sí, 418 no)
  return err instanceof ccxt.NetworkError; // incluye timeouts, exchange no disponible, mantenimiento
}

/**
 * Ejecuta fn con reintentos.
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, maxMs?: number, logger?: object, label?: string,
 *           random?: () => number, wait?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, { retries = 5, baseMs = 1000, maxMs = 30_000, logger, label = 'petición', random, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = backoffDelay(attempt, { baseMs, maxMs, random });
      logger?.warn({ err: err.message, attempt: attempt + 1, retries, delayMs: delay }, `${label} falló; reintento en ${delay} ms`);
      await wait(delay);
    }
  }
}
