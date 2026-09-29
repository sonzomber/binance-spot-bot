/**
 * Arma la ejecución completa para las pruebas: cliente ccxt REAL (con guardia de
 * red y filtro de órdenes) conectado a un Binance simulado por HTTP, gestor de
 * riesgo, registro de órdenes en SQLite (memoria) y ejecutor.
 */
import path from 'node:path';
import { vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createExecution } from '../../src/execution/index.js';
import { createTradingExchange } from '../../src/lib/exchange.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskManager } from '../../src/risk/risk-manager.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { captureLogger, tempDir, testEnv } from '../helpers.js';
import { FakeBinance, MARKET } from './fake-binance.js';

export async function setupExecution({ mode = 'exchange', fake = new FakeBinance(), limits = {}, db } = {}) {
  const tmp = await tempDir();
  const logs = await captureLogger();
  const database = db ?? openDatabase(':memory:');
  const config = loadConfig(testEnv({
    DRY_RUN: mode === 'dry-run' ? 'true' : 'false',
    BINANCE_API_KEY: 'test-api-key',
    BINANCE_API_SECRET: 'test-api-secret',
  }));

  const exchange = createTradingExchange(config);
  exchange.fetchImplementation = fake.fetch; // toda la "red" va al Binance simulado
  exchange.setMarkets([MARKET]);

  const risk = new RiskManager({
    store: new RiskStore(database, { env: config.env, mode: config.mode }),
    killSwitch: new KillSwitch(path.join(tmp.dir, 'STOP')),
    limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1, ...limits },
    feeRate: 0.001,
    slippageBps: 5,
    logger: logs.logger,
  });
  const execution = createExecution({ config, db: database, exchange, market: MARKET, risk, logger: logs.logger, getPrice: () => fake.price });
  execution.executor.sleep = vi.fn(async () => {}); // la espera tras un timeout no demora las pruebas

  return {
    config, fake, exchange, risk, db: database, logs, ...execution,
    async cleanup() {
      await exchange.close();
      if (!db) database.close();
      tmp.cleanup();
    },
  };
}
