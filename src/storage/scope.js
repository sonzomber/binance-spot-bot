/**
 * Ámbitos de datos: cada registro guardado pertenece a UN entorno y (si es de
 * trading) a UN modo. Los repositorios se crean para un ámbito y TODAS sus
 * consultas filtran por él, así que los datos de distintos entornos nunca se
 * mezclan en consultas ni reportes.
 *
 * Entornos:
 *   testnet             → Spot Testnet (dinero ficticio)
 *   demo                → Demo Mode (dinero ficticio)
 *   production-readonly → datos públicos de mercado de producción, SOLO LECTURA
 *                         (velas para el backtest). Nunca tiene órdenes ni posiciones.
 *
 * Modos (solo para datos de trading):
 *   dry-run  → órdenes simuladas, nunca enviadas
 *   exchange → órdenes enviadas al exchange del entorno (testnet o demo)
 */

export const TRADING_ENVS = Object.freeze(['testnet', 'demo']);
export const DATA_ENVS = Object.freeze([...TRADING_ENVS, 'production-readonly']);
export const MODES = Object.freeze(['dry-run', 'exchange']);

export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** Ámbito de trading (órdenes, posiciones, riesgo): testnet/demo × dry-run/exchange. */
export function tradingScope({ env, mode } = {}) {
  if (!TRADING_ENVS.includes(env)) {
    throw new ScopeError(
      `entorno de trading inválido "${env}": solo ${TRADING_ENVS.join(' o ')} (nunca se registran órdenes de producción)`,
    );
  }
  if (!MODES.includes(mode)) {
    throw new ScopeError(`modo inválido "${mode}": solo ${MODES.join(' o ')}`);
  }
  return Object.freeze({ env, mode });
}

/** Entorno de datos de mercado (velas): testnet, demo o production-readonly. */
export function dataEnv(env) {
  if (!DATA_ENVS.includes(env)) {
    throw new ScopeError(`entorno de datos inválido "${env}": solo ${DATA_ENVS.join(', ')}`);
  }
  return env;
}

/** Todos los ámbitos de trading posibles (lo usa el kill switch para detener todo). */
export const ALL_TRADING_SCOPES = Object.freeze(
  TRADING_ENVS.flatMap((env) => MODES.map((mode) => tradingScope({ env, mode }))),
);
