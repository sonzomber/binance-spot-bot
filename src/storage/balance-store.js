/**
 * Saldos de referencia para la reconciliación.
 *
 * Idea: el bot no puede saber cuánto "debería" haber en la cuenta del testnet
 * (viene con saldos regalados y Binance la reinicia cada tanto). Entonces toma
 * una FOTO de los saldos reales como referencia y, desde ahí, suma o resta lo
 * que ejecutaron sus propias órdenes:
 *
 *   saldo esperado = foto + compras − ventas ± comisiones (registradas desde la foto)
 *
 * Si Binance dice otra cosa, algo cambió fuera del bot (otra app, una orden
 * manual, un reinicio del testnet) y hay que revisarlo antes de operar.
 */
import { tradingScope } from './scope.js';

const iso = (ms) => new Date(ms).toISOString();

export class BalanceStore {
  constructor(db, scope) {
    this.db = db;
    this.scope = tradingScope(scope);
    this.sql = {
      insert: db.prepare(
        `INSERT INTO balance_snapshots (env, mode, asset, amount, time, reason)
           VALUES (@env, @mode, @asset, @amount, @time, @reason)`,
      ),
      latest: db.prepare(
        `SELECT asset, amount, time, reason FROM balance_snapshots
          WHERE env = @env AND mode = @mode AND asset = @asset ORDER BY id DESC LIMIT 1`,
      ),
    };
  }

  /** Guarda una foto de saldos { BTC: 1.2, USDT: 9000 } como nueva referencia. */
  saveSnapshot(balances, { time, reason }) {
    this.db.transaction(() => {
      for (const [asset, amount] of Object.entries(balances)) {
        this.sql.insert.run({ ...this.scope, asset, amount, time: iso(time), reason });
      }
    })();
  }

  /** @returns {{ asset, amount, time: string, reason } | null} */
  latest(asset) {
    return this.sql.latest.get({ ...this.scope, asset }) ?? null;
  }
}

/**
 * Cambio de saldo por asset que produjeron las ejecuciones (fills).
 * Compra: +base, −quote. Venta: −base, +quote. La comisión resta en su moneda.
 * @param {Array<{ symbol, side, qty, price, fee_amount, fee_currency }>} fills
 * @returns {Record<string, number>}
 */
export function balanceEffects(fills) {
  const effects = {};
  const add = (asset, amount) => { effects[asset] = (effects[asset] ?? 0) + amount; };
  for (const fill of fills) {
    const [base, quote] = fill.symbol.split('/');
    const sign = fill.side === 'buy' ? 1 : -1;
    add(base, sign * fill.qty);
    add(quote, -sign * fill.qty * fill.price);
    if (fill.fee_currency && fill.fee_amount) add(fill.fee_currency, -fill.fee_amount);
  }
  return effects;
}
