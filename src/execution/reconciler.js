/**
 * Reconciliación al iniciar: ¿lo que el bot tiene registrado coincide con Binance?
 *
 * Por qué: si el bot se cortó a mitad de una orden, si alguien operó a mano en
 * la misma cuenta, o si el testnet reinició los saldos, el registro local ya no
 * refleja la realidad. Operar así es peligroso: el bot podría comprar de más o
 * intentar vender lo que no tiene.
 *
 * Pasos (modo exchange):
 *   1. Órdenes locales sin terminar → se consulta su estado real por
 *      clientOrderId y se registra (esto las RESUELVE, no es una diferencia).
 *      Si no se puede consultar → diferencia.
 *   2. Órdenes abiertas en Binance que el bot no registró → diferencia.
 *   3. Saldos: esperado = foto de referencia + ejecuciones registradas desde
 *      entonces. Si Binance dice otra cosa → diferencia. La primera vez se toma
 *      la foto de referencia.
 *
 * Si hay diferencias: se registran (log + bitácora) y status() queda en
 * "no ok", con lo que el gestor de riesgo rechaza toda orden. Se resuelven a
 * mano (npm run reconcile) y se vuelve a reconciliar.
 *
 * En dry-run no hay nada que comparar con Binance: solo se resuelven las
 * órdenes simuladas que hayan quedado a medias.
 */
import { balanceEffects } from '../storage/balance-store.js';

export class Reconciler {
  /**
   * @param {object} deps
   * @param {import('./executor.js').OrderExecutor} deps.executor
   * @param {import('../storage/order-store.js').OrderStore} deps.orders
   * @param {import('../storage/balance-store.js').BalanceStore} deps.balances
   * @param {import('../storage/risk-store.js').RiskStore} deps.riskStore bitácora de eventos
   * @param {object} deps.venue
   * @param {object} deps.market
   * @param {import('pino').Logger} [deps.logger]
   * @param {() => number} [deps.now]
   * @param {number} [deps.tolerance] diferencia de saldo aceptable (relativa)
   */
  constructor({ executor, orders, balances, riskStore, venue, market, logger, now = Date.now, tolerance = 1e-8 }) {
    Object.assign(this, { executor, orders, balances, riskStore, venue, market, logger, now, tolerance });
    this.report = null; // hasta reconciliar, no se opera
  }

  /** Para el gestor de riesgo: ¿se puede operar? */
  status() {
    if (!this.report) return { ok: false, reason: 'todavía no se reconcilió con el exchange' };
    if (!this.report.ok) {
      return { ok: false, reason: `${this.report.differences.length} diferencia(s) sin resolver (npm run reconcile)` };
    }
    return { ok: true, reason: null };
  }

  async run() {
    const differences = [];
    const exchangeMode = this.orders.scope.mode === 'exchange';

    // 1. Resolver las órdenes locales sin terminar consultando su estado real.
    let resolved = [];
    try {
      resolved = await this.executor.resolveActive();
    } catch (err) {
      differences.push({ type: 'ORDER_UNRESOLVED', detail: `no se pudo consultar el estado de las órdenes pendientes: ${err.message}` });
    }
    for (const r of resolved) {
      if (!r.found && r.status !== 'not_created') {
        differences.push({ type: 'LOCAL_ORDER_MISSING', clientOrderId: r.clientOrderId, detail: `la orden ${r.clientOrderId} figura como ${r.status} localmente pero no existe en el exchange` });
      }
    }

    if (exchangeMode) {
      // 2. Órdenes abiertas en Binance que el bot no conoce.
      const remoteOpen = await this.venue.openOrders(this.market.symbol);
      for (const remote of remoteOpen) {
        if (!remote.clientOrderId || !this.orders.get(remote.clientOrderId)) {
          differences.push({
            type: 'UNKNOWN_EXCHANGE_ORDER',
            exchangeOrderId: remote.exchangeOrderId,
            detail: `orden abierta en Binance que el bot no registró: ${remote.side} ${remote.amount} (id ${remote.exchangeOrderId}, clientOrderId ${remote.clientOrderId ?? '—'})`,
          });
        }
      }

      // 3. Saldos esperados vs reales.
      differences.push(...(await this.#compareBalances()));
    }

    this.report = { ok: differences.length === 0, differences, resolved, time: new Date(this.now()).toISOString() };
    this.riskStore.addEvent({
      time: this.now(),
      type: 'RECONCILIATION',
      code: this.report.ok ? 'OK' : 'DIFFERENCES',
      message: this.report.ok ? 'Reconciliación sin diferencias' : `${differences.length} diferencia(s) con el exchange`,
      data: this.report,
    });
    if (this.report.ok) {
      this.logger?.info({ resolved: resolved.length }, 'Reconciliación OK: el registro local coincide con el exchange');
    } else {
      for (const d of differences) this.logger?.error(d, `Diferencia de reconciliación: ${d.detail}`);
      this.logger?.error('No se operará hasta resolver las diferencias (revisa con: npm run reconcile)');
    }
    return this.report;
  }

  /** Acepta los saldos actuales de Binance como nueva referencia (resolución manual). */
  async acceptCurrentBalances(reason = 'aceptado manualmente') {
    const assets = [this.market.base, this.market.quote];
    const actual = await this.venue.balances(assets);
    this.balances.saveSnapshot(actual, { time: this.now(), reason });
    this.riskStore.addEvent({ time: this.now(), type: 'BALANCE_BASELINE', message: `Saldos de referencia: ${reason}`, data: actual });
    return actual;
  }

  async #compareBalances() {
    const assets = [this.market.base, this.market.quote];
    const actual = await this.venue.balances(assets);
    const differences = [];
    const missing = assets.filter((asset) => !this.balances.latest(asset));
    if (missing.length > 0) {
      // Primera reconciliación: la foto actual es la referencia.
      this.balances.saveSnapshot(actual, { time: this.now(), reason: 'referencia inicial' });
      this.logger?.info({ balances: actual }, 'Primera reconciliación: se toman los saldos actuales como referencia');
      return differences;
    }
    for (const asset of assets) {
      const snapshot = this.balances.latest(asset);
      const effects = balanceEffects(this.orders.fillsSince(Date.parse(snapshot.time)));
      const expected = snapshot.amount + (effects[asset] ?? 0);
      const diff = actual[asset] - expected;
      if (Math.abs(diff) > Math.max(this.tolerance * Math.abs(expected), 1e-8)) {
        differences.push({
          type: 'BALANCE_MISMATCH',
          asset,
          expected,
          actual: actual[asset],
          diff,
          detail: `saldo de ${asset}: el registro espera ${expected} y Binance tiene ${actual[asset]} (diferencia ${diff})`,
        });
      }
    }
    return differences;
  }
}
