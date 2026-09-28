import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StrategyError } from '../../src/strategy/base-strategy.js';
import { createStrategy, discoverStrategies } from '../../src/strategy/registry.js';
import SmaCrossStrategy from '../../src/strategy/strategies/sma-cross.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));

describe('discoverStrategies', () => {
  it('registra las estrategias del proyecto', async () => {
    const registry = await discoverStrategies();
    expect(registry.get('sma-cross')).toBe(SmaCrossStrategy);
  });

  it('agregar una estrategia = agregar un archivo (y se ignora lo que no es .js)', async () => {
    const registry = await discoverStrategies(fixture('valid'));
    expect([...registry.keys()]).toEqual(['alpha', 'beta-two']);
  });

  it('rechaza ids duplicados', async () => {
    await expect(discoverStrategies(fixture('duplicate'))).rejects.toThrow(/id "same" duplicado en a\.js y b\.js/);
  });

  it('rechaza módulos que no exportan una Strategy', async () => {
    await expect(discoverStrategies(fixture('not-a-strategy'))).rejects.toThrow(/debe exportar por defecto una clase/);
  });

  it('rechaza ids que no están en kebab-case', async () => {
    await expect(discoverStrategies(fixture('bad-id'))).rejects.toThrow(/kebab-case/);
  });
});

describe('createStrategy — la estrategia activa se elige explícitamente', () => {
  it('crea la estrategia configurada con sus parámetros', async () => {
    const strategy = await createStrategy('sma-cross', { fast: 5, slow: 10 });
    expect(strategy).toBeInstanceOf(SmaCrossStrategy);
    expect(strategy.params).toEqual({ fast: 5, slow: 10 });
  });

  it.each([undefined, null, '', '   '])('sin estrategia configurada (%j) → no arranca', async (id) => {
    await expect(createStrategy(id)).rejects.toThrow(StrategyError);
    await expect(createStrategy(id)).rejects.toThrow(/No hay estrategia configurada/);
  });

  it('nombre inexistente → no arranca y lista las disponibles', async () => {
    await expect(createStrategy('rsi-magic')).rejects.toThrow(
      /La estrategia "rsi-magic" no existe\. Disponibles: sma-cross/,
    );
  });

  it('no adivina: un nombre parecido tampoco sirve', async () => {
    await expect(createStrategy('SMA-CROSS')).rejects.toThrow(/no existe/);
    await expect(createStrategy('sma')).rejects.toThrow(/no existe/);
  });

  it('parámetros inválidos → no arranca', async () => {
    await expect(createStrategy('sma-cross', { fast: 50 })).rejects.toThrow(/fast: debe ser menor que slow/);
  });
});
