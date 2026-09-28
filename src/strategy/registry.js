/**
 * Registro de estrategias.
 *
 * Descubre automáticamente las estrategias en src/strategy/strategies/ (cada
 * archivo .js exporta por defecto una clase que extiende Strategy). El
 * descubrimiento solo las REGISTRA: la estrategia activa se elige
 * explícitamente con STRATEGY en el .env. Si no existe, el bot no arranca.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Strategy, StrategyError } from './base-strategy.js';

const STRATEGIES_DIR = fileURLToPath(new URL('./strategies/', import.meta.url));
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @param {string} [dir] carpeta a escanear (configurable para tests)
 * @returns {Promise<Map<string, typeof Strategy>>} id → clase
 */
export async function discoverStrategies(dir = STRATEGIES_DIR) {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.js')).sort();
  const registry = new Map();
  const sources = new Map();

  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dir, file)).href);
    const Klass = module.default;

    if (typeof Klass !== 'function' || !(Klass.prototype instanceof Strategy)) {
      throw new StrategyError(`${file}: debe exportar por defecto una clase que extienda Strategy`);
    }
    if (typeof Klass.id !== 'string' || !ID_PATTERN.test(Klass.id)) {
      throw new StrategyError(`${file}: static id debe estar en kebab-case (recibido ${String(Klass.id)})`);
    }
    if (registry.has(Klass.id)) {
      throw new StrategyError(`id "${Klass.id}" duplicado en ${sources.get(Klass.id)} y ${file}`);
    }
    registry.set(Klass.id, Klass);
    sources.set(Klass.id, file);
  }
  return registry;
}

/**
 * Crea la estrategia activa a partir de la config.
 * @throws {StrategyError} si no hay estrategia configurada, no existe o sus parámetros son inválidos
 */
export async function createStrategy(id, params = {}, { dir } = {}) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new StrategyError('No hay estrategia configurada. Define STRATEGY en el .env (p. ej. STRATEGY=sma-cross).');
  }
  const registry = await discoverStrategies(dir);
  const Klass = registry.get(id);
  if (!Klass) {
    const available = [...registry.keys()].join(', ') || '(ninguna)';
    throw new StrategyError(`La estrategia "${id}" no existe. Disponibles: ${available}.`);
  }
  return new Klass(params);
}
