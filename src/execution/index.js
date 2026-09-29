/**
 * Arma la ejecución para el entorno y modo configurados:
 *   dry-run  → PaperVenue (simulación con comisión y slippage)
 *   exchange → ExchangeVenue (órdenes al testnet/demo por el cliente protegido)
 * con el mismo ejecutor, el mismo registro y la misma reconciliación.
 */
import { BalanceStore } from '../storage/balance-store.js';
import { OrderStore } from '../storage/order-store.js';
import { OrderExecutor } from './executor.js';
import { Reconciler } from './reconciler.js';
import { ExchangeVenue, PaperVenue } from './venues.js';

export function createExecution({ config, db, exchange, market, risk, getPrice, logger, now = Date.now }) {
  const scope = { env: config.env, mode: config.mode };
  const { feeRate, slippageBps } = config.execution;
  const orders = new OrderStore(db, scope, { now });
  const venue = config.dryRun
    ? new PaperVenue({ scope, market, feeRate, slippageBps, now })
    : new ExchangeVenue({ exchange, market, feeRate, logger });
  const executor = new OrderExecutor({ risk, orders, venue, market, getPrice, logger, now });
  const balances = new BalanceStore(db, scope);
  const reconciler = new Reconciler({ executor, orders, balances, riskStore: risk.store, venue, market, logger, now });
  // Mientras la reconciliación no pase sin diferencias, el riesgo rechaza toda orden.
  risk.reconciliation = reconciler;
  return { scope, orders, balances, venue, executor, reconciler };
}
