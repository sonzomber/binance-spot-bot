/**
 * Persistencia del estado de riesgo: parada (halt), posiciones y eventos.
 * Solo SQL; las reglas viven en src/risk/.
 */

const iso = (ms) => new Date(ms).toISOString();

function toPosition(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    symbol: row.symbol,
    status: row.status,
    qty: row.qty,
    entryPrice: row.entry_price,
    entryFee: row.entry_fee,
    entryCost: row.entry_cost,
    entryTime: row.entry_time,
    exitQty: row.exit_qty,
    exitPrice: row.exit_price,
    exitFee: row.exit_fee,
    exitProceeds: row.exit_proceeds,
    exitTime: row.exit_time,
    exitDay: row.exit_day,
    realizedPnl: row.realized_pnl,
  };
}

export class RiskStore {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.sql = {
      getHalt: db.prepare('SELECT halted, halt_code, halt_reason, halted_at FROM risk_state WHERE id = 1'),
      setHalt: db.prepare(
        `UPDATE risk_state SET halted = 1, halt_code = @code, halt_reason = @reason,
           halted_at = @time, updated_at = @time WHERE id = 1`,
      ),
      clearHalt: db.prepare(
        `UPDATE risk_state SET halted = 0, halt_code = NULL, halt_reason = NULL,
           halted_at = NULL, updated_at = @time WHERE id = 1`,
      ),
      openPositions: db.prepare(
        `SELECT * FROM positions WHERE mode = ? AND status = 'open' ORDER BY entry_time, id`,
      ),
      oldestOpen: db.prepare(
        `SELECT * FROM positions WHERE mode = ? AND symbol = ? AND status = 'open'
           ORDER BY entry_time, id LIMIT 1`,
      ),
      getPosition: db.prepare('SELECT * FROM positions WHERE id = ?'),
      insertPosition: db.prepare(
        `INSERT INTO positions (mode, symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time)
           VALUES (@mode, @symbol, 'open', @qty, @entryPrice, @entryFee, @entryCost, @entryTime)`,
      ),
      closePosition: db.prepare(
        `UPDATE positions SET status = 'closed', exit_qty = @exitQty, exit_price = @exitPrice,
           exit_fee = @exitFee, exit_proceeds = @exitProceeds, exit_time = @exitTime,
           exit_day = @exitDay, realized_pnl = @realizedPnl
         WHERE id = @id AND status = 'open'`,
      ),
      realizedForDay: db.prepare(
        `SELECT COALESCE(SUM(realized_pnl), 0) AS pnl,
                COALESCE(SUM(entry_fee + exit_fee), 0) AS fees,
                COUNT(*) AS trades
           FROM positions WHERE mode = ? AND status = 'closed' AND exit_day = ?`,
      ),
      addEvent: db.prepare(
        'INSERT INTO events (time, type, code, message, data) VALUES (@time, @type, @code, @message, @data)',
      ),
      recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
    };
  }

  // --- Parada (halt) ----------------------------------------------------------

  getHaltState() {
    const row = this.sql.getHalt.get();
    return {
      halted: row.halted === 1,
      code: row.halt_code,
      reason: row.halt_reason,
      haltedAt: row.halted_at,
    };
  }

  /** Marca el bot como detenido y lo registra en la bitácora (atómico). */
  setHalt({ code, reason, time }) {
    this.db.transaction(() => {
      this.sql.setHalt.run({ code, reason, time: iso(time) });
      this.addEvent({ time, type: 'HALT', code, message: reason });
    })();
  }

  clearHalt({ time, message, data }) {
    this.db.transaction(() => {
      this.sql.clearHalt.run({ time: iso(time) });
      this.addEvent({ time, type: 'RESUME', code: null, message, data });
    })();
  }

  // --- Posiciones ---------------------------------------------------------------

  openPositions(mode) {
    return this.sql.openPositions.all(mode).map(toPosition);
  }

  oldestOpenPosition(mode, symbol) {
    return toPosition(this.sql.oldestOpen.get(mode, symbol));
  }

  insertPosition({ mode, symbol, qty, entryPrice, entryFee, entryCost, entryTime }) {
    const { lastInsertRowid } = this.sql.insertPosition.run({
      mode, symbol, qty, entryPrice, entryFee, entryCost, entryTime: iso(entryTime),
    });
    return toPosition(this.sql.getPosition.get(lastInsertRowid));
  }

  closePosition(id, { exitQty, exitPrice, exitFee, exitProceeds, exitTime, exitDay, realizedPnl }) {
    const { changes } = this.sql.closePosition.run({
      id, exitQty, exitPrice, exitFee, exitProceeds, exitTime: iso(exitTime), exitDay, realizedPnl,
    });
    if (changes !== 1) throw new Error(`La posición ${id} no existe o ya estaba cerrada`);
    return toPosition(this.sql.getPosition.get(id));
  }

  /** PnL realizado (neto de comisiones) de las posiciones cerradas en un día UTC. */
  realizedForDay(mode, day) {
    return this.sql.realizedForDay.get(mode, day);
  }

  // --- Eventos ------------------------------------------------------------------

  addEvent({ time, type, code = null, message, data }) {
    this.sql.addEvent.run({
      time: iso(time), type, code, message, data: data === undefined ? null : JSON.stringify(data),
    });
  }

  recentEvents(limit = 10) {
    return this.sql.recentEvents.all(limit).map((row) => ({
      ...row,
      data: row.data === null ? null : JSON.parse(row.data),
    }));
  }
}
