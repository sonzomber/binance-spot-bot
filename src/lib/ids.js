/**
 * clientOrderId: ID que el BOT asigna a cada orden antes de enviarla (Binance
 * lo guarda como newClientOrderId). Permite preguntar "¿llegó mi orden?" si
 * la respuesta se pierde por un timeout, sin arriesgar una orden duplicada.
 *
 * Formato Binance: ^[a-zA-Z0-9-_]{1,36}$
 * Formato propio:  sb<e><m>-<tiempo base36>-<8 hex aleatorios>
 *   e = t (testnet) | d (demo);  m = p (dry-run, "paper") | x (exchange)
 *   p. ej. "sbtp-mg3k2l0a-9f1c2b7e" (23 caracteres)
 */
import { randomBytes } from 'node:crypto';

export const CLIENT_ORDER_ID_PATTERN = /^[a-zA-Z0-9-_]{1,36}$/;

export function newClientOrderId({ env, mode }, now = Date.now()) {
  const e = env === 'demo' ? 'd' : 't';
  const m = mode === 'exchange' ? 'x' : 'p';
  return `sb${e}${m}-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}
