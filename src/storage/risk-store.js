/**
 * Persistencia del estado de riesgo: parada (halt), posiciones y eventos.
 * Solo SQL; las reglas viven en src/risk/.
 *
 * Cada instancia está atada a UN ámbito (entorno + modo): todas las consultas
 * filtran por él y todo lo que inserta queda marcado con él.
 */
import { ALL_TRADING_SCOPES, tradingScope } from './scope.js';

const iso = (ms) => new Date(ms).toISOString();

function toPosition(row) {
  if (!row) return null;
  return {
    id: row.id,
    env: row.env,
    mode: row.mode,
    symbol: row.symbol,
    status: row.status,
    qty: row.qty,
    entryPrice: row.entry_price,
    entryFee: row.entry_fee,
    entryCost: row.entry_cost,
    entryTime: row.entry_time,
    entryOrderId: row.entry_order_id,
    exitQty: row.exit_qty,
    exitPrice: row.exit_price,
    exitFee: row.exit_fee,
    exitProceeds: row.exit_proceeds,
    exitTime: row.exit_time,
    exitDay: row.exit_day,
    exitOrderId: row.exit_order_id,
    realizedPnl: row.realized_pnl,
  };
}

export class RiskStore {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {{ env: 'testnet'|'demo', mode: 'dry-run'|'exchange' }} scope
   */
  constructor(db, scope) {
    this.db = db;
    this.scope = tradingScope(scope);
    const where = 'env = @env AND mode = @mode';
    this.sql = {
      getHalt: db.prepare(`SELECT halted, halt_code, halt_reason, halted_at FROM risk_state WHERE ${where}`),
      setHalt: db.prepare(
        `UPDATE risk_state SET halted = 1, halt_code = @code, halt_reason = @reason,
           halted_at = @time, updated_at = @time WHERE ${where}`,
      ),
      clearHalt: db.prepare(
        `UPDATE risk_state SET halted = 0, halt_code = NULL, halt_reason = NULL,
           halted_at = NULL, updated_at = @time WHERE ${where}`,
      ),
      openPositions: db.prepare(
        `SELECT * FROM positions WHERE ${where} AND status = 'open' ORDER BY entry_time, id`,
      ),
      oldestOpen: db.prepare(
        `SELECT * FROM positions WHERE ${where} AND symbol = @symbol AND status = 'open'
           ORDER BY entry_time, id LIMIT 1`,
      ),
      getPosition: db.prepare(`SELECT * FROM positions WHERE ${where} AND id = @id`),
      insertPosition: db.prepare(
        `INSERT INTO positions (env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost,
                                entry_time, entry_order_id)
           VALUES (@env, @mode, @symbol, 'open', @qty, @entryPrice, @entryFee, @entryCost,
                   @entryTime, @entryOrderId)`,
      ),
      closePosition: db.prepare(
        `UPDATE positions SET status = 'closed', exit_qty = @exitQty, exit_price = @exitPrice,
           exit_fee = @exitFee, exit_proceeds = @exitProceeds, exit_time = @exitTime,
           exit_day = @exitDay, exit_order_id = @exitOrderId, realized_pnl = @realizedPnl
         WHERE ${where} AND id = @id AND status = 'open'`,
      ),
      reducePosition: db.prepare(
        `UPDATE positions SET qty = qty - @soldQty, entry_cost = entry_cost - @soldCost,
           entry_fee = entry_fee - @soldEntryFee
         WHERE ${where} AND id = @id AND status = 'open' AND qty > @soldQty`,
      ),
      insertClosedPart: db.prepare(
        `INSERT INTO positions (env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time,
                                entry_order_id, exit_qty, exit_price, exit_fee, exit_proceeds, exit_time,
                                exit_day, exit_order_id, realized_pnl)
         SELECT env, mode, symbol, 'closed', @soldQty, entry_price, @soldEntryFee, @soldCost, entry_time,
                entry_order_id, @exitQty, @exitPrice, @exitFee, @exitProceeds, @exitTime,
                @exitDay, @exitOrderId, @realizedPnl
           FROM positions WHERE ${where} AND id = @id`,
      ),
      closedPositions: db.prepare(
        `SELECT * FROM positions WHERE ${where} AND status = 'closed' ORDER BY exit_time, id`,
      ),
      appliedOrder: db.prepare(
        `SELECT 1 FROM positions WHERE ${where} AND (entry_order_id = @orderId OR exit_order_id = @orderId) LIMIT 1`,
      ),
      realizedForDay: db.prepare(
        `SELECT COALESCE(SUM(realized_pnl), 0) AS pnl,
                COALESCE(SUM(entry_fee + exit_fee), 0) AS fees,
                COUNT(*) AS trades
           FROM positions WHERE ${where} AND status = 'closed' AND exit_day = @day`,
      ),
      addEvent: db.prepare(
        `INSERT INTO events (env, mode, time, type, code, message, data)
           VALUES (@env, @mode, @time, @type, @code, @message, @data)`,
      ),
      recentEvents: db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY id DESC LIMIT @limit`),
    };
  }

  // --- Parada (halt) ----------------------------------------------------------

  getHaltState() {
    const row = this.sql.getHalt.get(this.scope);
    return {
      halted: row.halted === 1,
      code: row.halt_code,
      reason: row.halt_reason,
      haltedAt: row.halted_at,
    };
  }

  /** Marca este ámbito como detenido y lo registra en la bitácora (atómico). */
  setHalt({ code, reason, time }) {
    this.db.transaction(() => {
      this.sql.setHalt.run({ ...this.scope, code, reason, time: iso(time) });
      this.addEvent({ time, type: 'HALT', code, message: reason });
    })();
  }

  clearHalt({ time, message, data }) {
    this.db.transaction(() => {
      this.sql.clearHalt.run({ ...this.scope, time: iso(time) });
      this.addEvent({ time, type: 'RESUME', code: null, message, data });
    })();
  }

  /**
   * Detiene TODOS los ámbitos que no estén ya detenidos (lo usa `npm run kill`:
   * el kill switch detiene el bot sin importar el entorno o modo).
   * @returns {number} cuántos ámbitos se detuvieron
   */
  static haltAll(db, { code, reason, time }) {
    let halted = 0;
    db.transaction(() => {
      for (const scope of ALL_TRADING_SCOPES) {
        const store = new RiskStore(db, scope);
        if (!store.getHaltState().halted) {
          store.setHalt({ code, reason, time });
          halted++;
        }
      }
    })();
    return halted;
  }

  // --- Posiciones ---------------------------------------------------------------

  openPositions() {
    return this.sql.openPositions.all(this.scope).map(toPosition);
  }

  oldestOpenPosition(symbol) {
    return toPosition(this.sql.oldestOpen.get({ ...this.scope, symbol }));
  }

  insertPosition({ symbol, qty, entryPrice, entryFee, entryCost, entryTime, entryOrderId = null }) {
    const { lastInsertRowid } = this.sql.insertPosition.run({
      ...this.scope, symbol, qty, entryPrice, entryFee, entryCost, entryTime: iso(entryTime), entryOrderId,
    });
    return toPosition(this.sql.getPosition.get({ ...this.scope, id: lastInsertRowid }));
  }

  closePosition(id, { exitQty, exitPrice, exitFee, exitProceeds, exitTime, exitDay, exitOrderId = null, realizedPnl }) {
    const { changes } = this.sql.closePosition.run({
      ...this.scope, id, exitQty, exitPrice, exitFee, exitProceeds,
      exitTime: iso(exitTime), exitDay, exitOrderId, realizedPnl,
    });
    if (changes !== 1) throw new Error(`La posición ${id} no existe en este ámbito o ya estaba cerrada`);
    return toPosition(this.sql.getPosition.get({ ...this.scope, id }));
  }

  /**
   * Venta parcial: la parte vendida pasa a una fila CERRADA (con su parte del costo)
   * y la posición original sigue abierta con lo que queda. Todo en una transacción.
   * @returns la fila cerrada nueva
   */
  splitPosition(id, { soldQty, soldCost, soldEntryFee, exitQty, exitPrice, exitFee, exitProceeds, exitTime,
    exitDay, exitOrderId = null, realizedPnl }) {
    return this.db.transaction(() => {
      const params = {
        ...this.scope, id, soldQty, soldCost, soldEntryFee, exitQty, exitPrice, exitFee, exitProceeds,
        exitTime: iso(exitTime), exitDay, exitOrderId, realizedPnl,
      };
      const { lastInsertRowid } = this.sql.insertClosedPart.run(params);
      const { changes } = this.sql.reducePosition.run(params);
      if (changes !== 1) throw new Error(`La posición ${id} no existe en este ámbito, no está abierta o no tiene ${soldQty}`);
      return toPosition(this.sql.getPosition.get({ ...this.scope, id: lastInsertRowid }));
    })();
  }

  /** Operaciones cerradas del ámbito, en orden de cierre. */
  closedPositions() {
    return this.sql.closedPositions.all(this.scope).map(toPosition);
  }

  /** ¿Esta orden ya se aplicó a alguna posición (como entrada o salida)? */
  isOrderApplied(orderId) {
    return this.sql.appliedOrder.get({ ...this.scope, orderId }) !== undefined;
  }

  /** PnL realizado (neto de comisiones) de las posiciones cerradas en un día UTC. */
  realizedForDay(day) {
    return this.sql.realizedForDay.get({ ...this.scope, day });
  }

  // --- Eventos ------------------------------------------------------------------

  addEvent({ time, type, code = null, message, data }) {
    this.sql.addEvent.run({
      ...this.scope,
      time: iso(time),
      type,
      code,
      message,
      data: data === undefined ? null : JSON.stringify(data),
    });
  }

  recentEvents(limit = 10) {
    return this.sql.recentEvents.all({ ...this.scope, limit }).map((row) => ({
      ...row,
      data: row.data === null ? null : JSON.parse(row.data),
    }));
  }
}
