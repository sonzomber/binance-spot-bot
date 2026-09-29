import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  PROJECT_ROOT,
  describeConfig,
  loadConfig,
  loadPaths,
} from '../../src/config/index.js';
import { testEnv } from '../helpers.js';

/** Carga la config con la estrategia mínima obligatoria ya definida. */
const load = (env = {}) => loadConfig(testEnv(env));

/** Devuelve la lista de problemas de una config inválida. */
function issuesOf(env) {
  try {
    load(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err.issues;
  }
  throw new Error('se esperaba ConfigError');
}

describe('loadConfig — valores por defecto', () => {
  it('solo con STRATEGY: testnet, dry-run y parámetros seguros', () => {
    const config = load();
    expect(config.env).toBe('testnet');
    expect(config.dryRun).toBe(true);
    expect(config.symbol).toBe('BTC/USDT');
    expect(config.timeframe).toBe('15m');
    expect(config.dataFeed).toBe('rest');
    expect(config.strategy).toEqual({ id: 'sma-cross', params: {} });
    expect(config.risk.maxTradeUsdt).toBe(50);
    expect(config.risk.maxDailyLossUsdt).toBe(20);
    expect(config.risk.maxOpenPositions).toBe(1);
    expect(config.mode).toBe('dry-run');
    expect(config.execution).toEqual({ feeRate: 0.001, slippageBps: 5 });
  });

  it('trata las líneas vacías del .env ("KEY=") como no definidas', () => {
    const config = load({ BINANCE_ENV: '', DRY_RUN: '', MAX_TRADE_USDT: '  ', BINANCE_API_KEY: '' });
    expect(config.env).toBe('testnet');
    expect(config.dryRun).toBe(true);
    expect(config.risk.maxTradeUsdt).toBe(50);
    expect(config.apiKey).toBeUndefined();
  });

  it('resuelve las rutas relativas desde la raíz del proyecto', () => {
    const config = load({ DB_PATH: './data/test.db' });
    expect(config.storage.dbPath).toBe(path.resolve(PROJECT_ROOT, 'data/test.db'));
    expect(path.isAbsolute(config.risk.killSwitchFile)).toBe(true);
  });
});

describe('loadConfig — estrategia activa (obligatoria)', () => {
  it.each([
    ['sin definir', {}],
    ['vacía', { STRATEGY: '' }],
    ['solo espacios', { STRATEGY: '   ' }],
  ])('STRATEGY %s: no arranca', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(/STRATEGY: es obligatoria/);
  });

  it('usa el nombre elegido explícitamente', () => {
    expect(loadConfig({ STRATEGY: ' sma-cross ' }).strategy.id).toBe('sma-cross');
  });
});

describe('loadConfig — entorno (nunca mainnet)', () => {
  it.each(['testnet', 'demo', 'TESTNET', ' Demo '])('acepta "%s"', (value) => {
    expect(['testnet', 'demo']).toContain(load({ BINANCE_ENV: value }).env);
  });

  it.each(['mainnet', 'live', 'production', 'prod', 'real', 'api.binance.com'])(
    'rechaza "%s"',
    (value) => {
      const issues = issuesOf({ BINANCE_ENV: value });
      expect(issues.join()).toMatch(/BINANCE_ENV.*no soporta mainnet/);
    },
  );
});

describe('loadConfig — validaciones', () => {
  it('exige API keys cuando DRY_RUN=false', () => {
    const issues = issuesOf({ DRY_RUN: 'false' });
    expect(issues).toHaveLength(2);
    expect(issues.join()).toMatch(/BINANCE_API_KEY/);
    expect(issues.join()).toMatch(/BINANCE_API_SECRET/);
  });

  it('acepta DRY_RUN=false con keys', () => {
    const config = load({ DRY_RUN: 'false', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' });
    expect(config.dryRun).toBe(false);
  });

  it.each([['true', true], ['TRUE', true], [' false ', false], ['False', false]])(
    'interpreta DRY_RUN=%j como %s',
    (value, expected) => {
      const keys = { BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' };
      expect(load({ DRY_RUN: value, ...keys }).dryRun).toBe(expected);
    },
  );

  it.each(['0', 'no', 'off', '1', 'yes', 'flase', 'maybe'])(
    'desactivar el dry-run exige escribir exactamente "false": DRY_RUN=%s es un error',
    (value) => {
      expect(issuesOf({ DRY_RUN: value }).join()).toMatch(/DRY_RUN: debe ser exactamente "true" o "false"/);
    },
  );

  it('normaliza el símbolo y exige cotización en USDT', () => {
    expect(load({ SYMBOL: 'eth/usdt' }).symbol).toBe('ETH/USDT');
    expect(issuesOf({ SYMBOL: 'ETH/BTC' }).join()).toMatch(/SYMBOL/);
    expect(issuesOf({ SYMBOL: 'BTCUSDT' }).join()).toMatch(/SYMBOL/);
  });

  it('parsea STRATEGY_PARAMS como objeto JSON', () => {
    expect(load({ STRATEGY_PARAMS: '{"fast":9,"slow":21}' }).strategy.params).toEqual({ fast: 9, slow: 21 });
    expect(issuesOf({ STRATEGY_PARAMS: '{fast:9}' }).join()).toMatch(/STRATEGY_PARAMS/);
    expect(issuesOf({ STRATEGY_PARAMS: '[1,2]' }).join()).toMatch(/STRATEGY_PARAMS/);
  });

  it('el modo separa lo simulado de lo enviado al exchange', () => {
    const keys = { BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' };
    expect(load({ DRY_RUN: 'true' }).mode).toBe('dry-run');
    expect(load({ DRY_RUN: 'false', ...keys })).toMatchObject({ env: 'testnet', mode: 'exchange' });
    expect(load({ DRY_RUN: 'false', BINANCE_ENV: 'demo', ...keys })).toMatchObject({ env: 'demo', mode: 'exchange' });
  });

  it('valida MAX_OPEN_POSITIONS (entero ≥ 1)', () => {
    expect(load({ MAX_OPEN_POSITIONS: '3' }).risk.maxOpenPositions).toBe(3);
    expect(issuesOf({ MAX_OPEN_POSITIONS: '0' }).join()).toMatch(/MAX_OPEN_POSITIONS: debe ser ≥ 1/);
    expect(issuesOf({ MAX_OPEN_POSITIONS: '1.5' }).join()).toMatch(/MAX_OPEN_POSITIONS: debe ser un entero/);
  });

  it('valida montos de riesgo', () => {
    expect(issuesOf({ MAX_TRADE_USDT: '-5' }).join()).toMatch(/MAX_TRADE_USDT: debe ser mayor que 0/);
    expect(issuesOf({ MAX_DAILY_LOSS_USDT: '0' }).join()).toMatch(/MAX_DAILY_LOSS_USDT/);
    expect(issuesOf({ MAX_TRADE_USDT: 'cien' }).join()).toMatch(/MAX_TRADE_USDT/);
  });

  it('valida comisión y slippage', () => {
    expect(issuesOf({ FEE_RATE: '0.5' }).join()).toMatch(/FEE_RATE/);
    expect(issuesOf({ SLIPPAGE_BPS: '-1' }).join()).toMatch(/SLIPPAGE_BPS/);
  });

  it('DATA_STALE_AFTER_SECONDS: en segundos, con límites razonables', () => {
    expect(load().dataStaleAfterMs).toBe(60_000);
    expect(load({ DATA_STALE_AFTER_SECONDS: '120' }).dataStaleAfterMs).toBe(120_000);
    expect(issuesOf({ DATA_STALE_AFTER_SECONDS: '2' }).join()).toMatch(/DATA_STALE_AFTER_SECONDS: debe ser ≥ 5/);
  });

  it('valida timeframe y feed', () => {
    expect(issuesOf({ TIMEFRAME: '7m' }).join()).toMatch(/TIMEFRAME/);
    expect(issuesOf({ DATA_FEED: 'grpc' }).join()).toMatch(/DATA_FEED/);
  });

  it('reporta todos los problemas a la vez', () => {
    const issues = issuesOf({ BINANCE_ENV: 'mainnet', MAX_TRADE_USDT: '-1', TIMEFRAME: 'x' });
    expect(issues).toHaveLength(3);
  });
});

describe('loadConfig — inmutabilidad', () => {
  it('la config no se puede modificar en tiempo de ejecución', () => {
    const config = load();
    expect(() => { config.env = 'mainnet'; }).toThrow(TypeError);
    expect(() => { config.risk.maxTradeUsdt = 1e9; }).toThrow(TypeError);
    expect(config.env).toBe('testnet');
  });
});

describe('describeConfig', () => {
  it('no expone secretos, solo si están configurados', () => {
    const config = load({ BINANCE_API_KEY: 'abcd1234efgh5678', BINANCE_API_SECRET: 'supersecret' });
    const safe = describeConfig(config);
    expect(JSON.stringify(safe)).not.toContain('supersecret');
    expect(JSON.stringify(safe)).not.toContain('abcd');
    expect(safe).not.toHaveProperty('apiKey');
    expect(safe).not.toHaveProperty('apiSecret');
    expect(safe.credentials).toBe('configuradas');
    expect(describeConfig(load()).credentials).toBe('no configuradas');
  });
});

describe('loadPaths (herramientas de emergencia)', () => {
  it('lee las rutas aunque el resto de la config sea inválida', () => {
    const paths = loadPaths({ BINANCE_ENV: 'mainnet', KILL_SWITCH_FILE: './tmp/PARAR' }); // sin STRATEGY
    expect(paths.killSwitchFile).toBe(path.resolve(PROJECT_ROOT, 'tmp/PARAR'));
    expect(paths.dbPath).toBe(path.resolve(PROJECT_ROOT, 'data/bot.db'));
  });
});
