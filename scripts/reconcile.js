/**
 * Reconciliación manual con el exchange: muestra diferencias y ayuda a resolverlas.
 *
 *   npm run reconcile                         → compara y muestra el reporte
 *   npm run reconcile -- --accept-balances    → acepta los saldos actuales de Binance
 *                                               como nueva referencia (tras revisarlos)
 *   npm run reconcile -- --cancel-unknown     → cancela en Binance las órdenes abiertas
 *                                               que el bot no registró
 *
 * Usa el entorno y modo del .env. En dry-run no hay nada que comparar con Binance.
 */
import { parseArgs } from 'node:util';
import pino from 'pino';
import { ConfigError, loadConfig, loadEnvFile } from '../src/config/index.js';
import { runPreflight } from '../src/config/preflight.js';
import { WeightLimiter } from '../src/data/rate-limiter.js';
import { createExecution } from '../src/execution/index.js';
import { createTradingExchange } from '../src/lib/exchange.js';
import { createLogger } from '../src/lib/logger.js';
import { createRiskManager } from '../src/risk/risk-manager.js';
import { openDatabase } from '../src/storage/db.js';

const { values: flags } = parseArgs({
  options: { 'accept-balances': { type: 'boolean' }, 'cancel-unknown': { type: 'boolean' } },
});

loadEnvFile();
let db;
let exchange;
try {
  const config = loadConfig();
  const logger = createLogger({ ...config.log, console: false }); // auditoría en el archivo de log
  db = openDatabase(config.storage.dbPath);
  exchange = createTradingExchange(config, { limiter: new WeightLimiter({ logger }) });
  const { market } = await runPreflight(exchange, config, pino({ level: 'silent' }));
  const risk = createRiskManager(config, db, logger);
  const { reconciler } = createExecution({
    config, db, exchange, market, risk, logger,
    getPrice: async () => (await exchange.fetchTicker(config.symbol)).last,
  });

  console.log(`Entorno: ${config.env}   Modo: ${config.mode}   Par: ${config.symbol}`);
  if (config.dryRun) console.log('(dry-run: solo se resuelven órdenes simuladas que hayan quedado a medias)');

  if (flags['cancel-unknown'] && !config.dryRun) {
    const before = await reconciler.run();
    for (const d of before.differences.filter((x) => x.type === 'UNKNOWN_EXCHANGE_ORDER')) {
      await exchange.cancelOrder(d.exchangeOrderId, config.symbol);
      console.log(`Cancelada en Binance: orden ${d.exchangeOrderId}`);
    }
  }
  if (flags['accept-balances'] && !config.dryRun) {
    const accepted = await reconciler.acceptCurrentBalances('aceptado manualmente con npm run reconcile');
    console.log(`Nueva referencia de saldos: ${JSON.stringify(accepted)}`);
  }

  const report = await reconciler.run();
  for (const r of report.resolved) console.log(`Resuelta: ${r.clientOrderId} → ${r.status}`);
  if (report.ok) {
    console.log('Reconciliación OK: el registro local coincide con el exchange. El bot puede operar.');
  } else {
    console.log(`Diferencias (${report.differences.length}):`);
    for (const d of report.differences) console.log(`  - [${d.type}] ${d.detail}`);
    console.log('Opciones: --cancel-unknown (órdenes desconocidas) · --accept-balances (tras revisar los saldos)');
    process.exitCode = 1;
  }
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await exchange?.close();
  db?.close();
}
