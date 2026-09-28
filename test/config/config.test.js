import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  PROJECT_ROOT,
  describeConfig,
  loadConfig,
} from '../../src/config/index.js';

/** Devuelve la lista de problemas de una config inválida. */
function issuesOf(env) {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err.issues;
  }
  throw new Error('se esperaba ConfigError');
}

describe('loadConfig — valores por defecto', () => {
  it('sin variables: testnet, dry-run y parámetros seguros', () => {
    const config = loadConfig({});
    expect(config.env).toBe('testnet');
    expect(config.dryRun).toBe(true);
    expect(config.symbol).toBe('BTC/USDT');
    expect(config.timeframe).toBe('15m');
    expect(config.dataFeed).toBe('rest');
    expect(config.strategy).toEqual({ id: 'sma-cross', params: {} });
    expect(config.risk.maxTradeUsdt).toBe(50);
    expect(config.risk.maxDailyLossUsdt).toBe(20);
    expect(config.risk.killSwitchFlatten).toBe(false);
    expect(config.execution).toEqual({ feeRate: 0.001, slippageBps: 5 });
  });

  it('trata las líneas vacías del .env ("KEY=") como no definidas', () => {
    const config = loadConfig({ BINANCE_ENV: '', DRY_RUN: '', MAX_TRADE_USDT: '  ', BINANCE_API_KEY: '' });
    expect(config.env).toBe('testnet');
    expect(config.dryRun).toBe(true);
    expect(config.risk.maxTradeUsdt).toBe(50);
    expect(config.apiKey).toBeUndefined();
  });

  it('resuelve las rutas relativas desde la raíz del proyecto', () => {
    const config = loadConfig({ DB_PATH: './data/test.db' });
    expect(config.storage.dbPath).toBe(path.resolve(PROJECT_ROOT, 'data/test.db'));
    expect(path.isAbsolute(config.risk.killSwitchFile)).toBe(true);
  });
});

describe('loadConfig — entorno (nunca mainnet)', () => {
  it.each(['testnet', 'demo', 'TESTNET', ' Demo '])('acepta "%s"', (value) => {
    expect(['testnet', 'demo']).toContain(loadConfig({ BINANCE_ENV: value }).env);
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
    const config = loadConfig({ DRY_RUN: 'false', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' });
    expect(config.dryRun).toBe(false);
  });

  it.each([
    ['true', true], ['TRUE', true], ['1', true], ['yes', true],
    ['false', false], ['0', false], ['no', false],
  ])('interpreta DRY_RUN=%s como %s', (value, expected) => {
    const keys = { BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' };
    expect(loadConfig({ DRY_RUN: value, ...keys }).dryRun).toBe(expected);
  });

  it('rechaza booleanos ambiguos', () => {
    expect(issuesOf({ DRY_RUN: 'maybe' }).join()).toMatch(/DRY_RUN: debe ser true o false/);
  });

  it('normaliza el símbolo y exige cotización en USDT', () => {
    expect(loadConfig({ SYMBOL: 'eth/usdt' }).symbol).toBe('ETH/USDT');
    expect(issuesOf({ SYMBOL: 'ETH/BTC' }).join()).toMatch(/SYMBOL/);
    expect(issuesOf({ SYMBOL: 'BTCUSDT' }).join()).toMatch(/SYMBOL/);
  });

  it('parsea STRATEGY_PARAMS como objeto JSON', () => {
    expect(loadConfig({ STRATEGY_PARAMS: '{"fast":9,"slow":21}' }).strategy.params).toEqual({ fast: 9, slow: 21 });
    expect(issuesOf({ STRATEGY_PARAMS: '{fast:9}' }).join()).toMatch(/STRATEGY_PARAMS/);
    expect(issuesOf({ STRATEGY_PARAMS: '[1,2]' }).join()).toMatch(/STRATEGY_PARAMS/);
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
    const config = loadConfig({});
    expect(() => { config.env = 'mainnet'; }).toThrow(TypeError);
    expect(() => { config.risk.maxTradeUsdt = 1e9; }).toThrow(TypeError);
    expect(config.env).toBe('testnet');
  });
});

describe('describeConfig', () => {
  it('no expone secretos, solo si están configurados', () => {
    const config = loadConfig({ BINANCE_API_KEY: 'abcd1234efgh5678', BINANCE_API_SECRET: 'supersecret' });
    const safe = describeConfig(config);
    expect(JSON.stringify(safe)).not.toContain('supersecret');
    expect(JSON.stringify(safe)).not.toContain('abcd');
    expect(safe).not.toHaveProperty('apiKey');
    expect(safe).not.toHaveProperty('apiSecret');
    expect(safe.credentials).toBe('configuradas');
    expect(describeConfig(loadConfig({})).credentials).toBe('no configuradas');
  });
});
