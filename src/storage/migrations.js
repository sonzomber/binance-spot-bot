/**
 * Migraciones del esquema SQLite, en orden. NUNCA edites una migración ya
 * publicada: agrega una nueva al final. La versión aplicada se guarda en
 * PRAGMA user_version.
 *
 * Convenciones:
 *   - Tiempos: texto ISO 8601 en UTC ("2026-09-28T14:03:00.000Z").
 *   - Días: texto "YYYY-MM-DD" en UTC (el "día" del límite de pérdida diaria).
 *   - Montos en la moneda de cotización (USDT) salvo qty, que está en la base (p. ej. BTC).
 */
export const MIGRATIONS = Object.freeze([
  // 1 — Módulo 3: estado de riesgo, posiciones y eventos
  `
  CREATE TABLE risk_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),          -- una sola fila
    halted      INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0, 1)),
    halt_code   TEXT,                                        -- KILL_SWITCH | DAILY_LOSS
    halt_reason TEXT,
    halted_at   TEXT,
    updated_at  TEXT NOT NULL
  );
  INSERT INTO risk_state (id, halted, updated_at)
    VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  -- Una posición = una compra y (cuando se cierra) su venta. Cerrada = operación completa.
  CREATE TABLE positions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mode          TEXT NOT NULL,                             -- dry-run | testnet | demo
    symbol        TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    qty           REAL NOT NULL CHECK (qty > 0),             -- base en poder (neto de comisiones en base)
    entry_price   REAL NOT NULL CHECK (entry_price > 0),
    entry_fee     REAL NOT NULL CHECK (entry_fee >= 0),      -- comisión de compra, en USDT
    entry_cost    REAL NOT NULL,                             -- USDT gastados, comisión incluida
    entry_time    TEXT NOT NULL,
    exit_qty      REAL,
    exit_price    REAL,
    exit_fee      REAL,                                      -- comisión de venta, en USDT
    exit_proceeds REAL,                                      -- USDT recibidos, neto de comisión
    exit_time     TEXT,
    exit_day      TEXT,                                      -- día UTC del cierre
    realized_pnl  REAL                                       -- exit_proceeds - entry_cost
  );
  CREATE INDEX idx_positions_status ON positions (mode, status);
  CREATE INDEX idx_positions_exit_day ON positions (mode, exit_day);

  -- Bitácora de eventos importantes (paradas, reanudaciones...), para auditoría.
  CREATE TABLE events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    time    TEXT NOT NULL,
    type    TEXT NOT NULL,
    code    TEXT,
    message TEXT NOT NULL,
    data    TEXT                                             -- JSON opcional
  );
  `,
]);
