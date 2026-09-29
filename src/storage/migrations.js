/**
 * Migraciones versionadas del esquema SQLite, en orden: la migración N lleva
 * la base de datos de la versión N−1 a la N. NUNCA edites una migración ya
 * publicada: agrega una nueva al final. La versión aplicada se guarda en
 * PRAGMA user_version y el historial en la tabla schema_migrations.
 *
 * Convenciones:
 *   - Tiempos: texto ISO 8601 en UTC ("2026-09-28T14:03:00.000Z"), salvo
 *     candles.open_time: entero en ms (UTC), para calcular huecos rápido.
 *   - Días: texto "YYYY-MM-DD" en UTC (el "día" del límite de pérdida diaria).
 *   - Montos en la moneda de cotización (USDT) salvo qty/amount, que están en la base (p. ej. BTC).
 *   - Entorno (env) y modo (mode) en cada registro: ver src/storage/scope.js.
 */
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'estado de riesgo, posiciones y eventos (módulo 3)',
    sql: `
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
  },

  {
    version: 2,
    name: 'entorno y modo en cada registro; órdenes, ejecuciones y caché de velas (módulo 4)',
    // SQLite no permite agregar CHECKs ni cambiar claves con ALTER TABLE: las
    // tablas existentes se reconstruyen (crear nueva → copiar → borrar → renombrar).
    sql: `
  -- 1. Órdenes: cada intento de orden, incluidas las rechazadas.
  --    Solo testnet/demo: el CHECK impide registrar órdenes de producción.
  CREATE TABLE orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    env               TEXT NOT NULL CHECK (env IN ('testnet', 'demo')),
    mode              TEXT NOT NULL CHECK (mode IN ('dry-run', 'exchange')),
    client_order_id   TEXT NOT NULL UNIQUE,                  -- ID propio (newClientOrderId en Binance)
    exchange_order_id TEXT,                                  -- ID de Binance (null en dry-run o si no llegó)
    symbol            TEXT NOT NULL,
    side              TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    type              TEXT NOT NULL CHECK (type IN ('market', 'limit')),
    amount            REAL NOT NULL CHECK (amount > 0),      -- cantidad pedida (base)
    price             REAL,                                  -- límite, o precio esperado si es de mercado
    status            TEXT NOT NULL CHECK (status IN
                        ('pending', 'open', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired')),
    filled_qty        REAL NOT NULL DEFAULT 0 CHECK (filled_qty >= 0),
    filled_quote      REAL NOT NULL DEFAULT 0,               -- Σ qty × precio de las ejecuciones (USDT)
    avg_fill_price    REAL,
    fee_quote         REAL NOT NULL DEFAULT 0,               -- Σ comisiones en USDT
    reject_source     TEXT CHECK (reject_source IN ('risk', 'exchange')),
    reject_code       TEXT,
    reject_reason     TEXT,
    strategy          TEXT,
    signal_code       TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    accepted_at       TEXT,                                  -- cuando el exchange la aceptó
    closed_at         TEXT,                                  -- cuando llegó a un estado final
    CHECK (status <> 'rejected' OR (reject_source IS NOT NULL AND reject_reason IS NOT NULL))
  );
  CREATE UNIQUE INDEX ux_orders_exchange_id ON orders (env, mode, exchange_order_id)
    WHERE exchange_order_id IS NOT NULL;
  CREATE INDEX idx_orders_scope_status ON orders (env, mode, status);
  CREATE INDEX idx_orders_scope_created ON orders (env, mode, created_at);

  -- 2. Ejecuciones (fills): una orden puede ejecutarse en varias partes.
  CREATE TABLE order_fills (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders (id),
    env          TEXT NOT NULL,
    mode         TEXT NOT NULL,
    trade_id     TEXT NOT NULL,                              -- ID de la ejecución en Binance
    qty          REAL NOT NULL CHECK (qty > 0),
    price        REAL NOT NULL CHECK (price > 0),
    fee_amount   REAL NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
    fee_currency TEXT,                                       -- moneda en que se cobró (USDT, BTC, BNB…)
    fee_quote    REAL NOT NULL DEFAULT 0 CHECK (fee_quote >= 0), -- su valor en USDT
    time         TEXT NOT NULL,
    UNIQUE (order_id, trade_id)                              -- la misma ejecución no se cuenta dos veces
  );
  CREATE TRIGGER order_fills_same_scope BEFORE INSERT ON order_fills
    WHEN NOT EXISTS (SELECT 1 FROM orders o
                     WHERE o.id = NEW.order_id AND o.env = NEW.env AND o.mode = NEW.mode)
  BEGIN
    SELECT RAISE(ABORT, 'order_fills: el entorno/modo no coincide con el de la orden');
  END;

  -- 3. Estado de riesgo: una fila por ámbito (entorno × modo) en vez de una global.
  CREATE TABLE risk_state_v2 (
    env         TEXT NOT NULL CHECK (env IN ('testnet', 'demo')),
    mode        TEXT NOT NULL CHECK (mode IN ('dry-run', 'exchange')),
    halted      INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0, 1)),
    halt_code   TEXT,
    halt_reason TEXT,
    halted_at   TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (env, mode)
  );
  INSERT INTO risk_state_v2 (env, mode, halted, halt_code, halt_reason, halted_at, updated_at)
    SELECT e.env, m.mode, old.halted, old.halt_code, old.halt_reason, old.halted_at, old.updated_at
      FROM (SELECT 'testnet' AS env UNION ALL SELECT 'demo') AS e
      CROSS JOIN (SELECT 'dry-run' AS mode UNION ALL SELECT 'exchange') AS m
      CROSS JOIN risk_state AS old;                          -- una parada global previa aplica a todos
  DROP TABLE risk_state;
  ALTER TABLE risk_state_v2 RENAME TO risk_state;

  -- 4. Posiciones: el antiguo "mode" (dry-run | testnet | demo) se separa en env + mode.
  --    Las posiciones dry-run anteriores no guardaban su entorno: se asignan a testnet (el defecto).
  CREATE TABLE positions_v2 (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    env            TEXT NOT NULL CHECK (env IN ('testnet', 'demo')),
    mode           TEXT NOT NULL CHECK (mode IN ('dry-run', 'exchange')),
    symbol         TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    qty            REAL NOT NULL CHECK (qty > 0),
    entry_price    REAL NOT NULL CHECK (entry_price > 0),
    entry_fee      REAL NOT NULL CHECK (entry_fee >= 0),
    entry_cost     REAL NOT NULL,
    entry_time     TEXT NOT NULL,
    entry_order_id INTEGER REFERENCES orders (id),
    exit_qty       REAL,
    exit_price     REAL,
    exit_fee       REAL,
    exit_proceeds  REAL,
    exit_time      TEXT,
    exit_day       TEXT,
    exit_order_id  INTEGER REFERENCES orders (id),
    realized_pnl   REAL
  );
  INSERT INTO positions_v2 (id, env, mode, symbol, status, qty, entry_price, entry_fee, entry_cost,
                            entry_time, exit_qty, exit_price, exit_fee, exit_proceeds, exit_time,
                            exit_day, realized_pnl)
    SELECT id,
           CASE mode WHEN 'demo' THEN 'demo' ELSE 'testnet' END,
           CASE mode WHEN 'dry-run' THEN 'dry-run' ELSE 'exchange' END,
           symbol, status, qty, entry_price, entry_fee, entry_cost, entry_time, exit_qty,
           exit_price, exit_fee, exit_proceeds, exit_time, exit_day, realized_pnl
      FROM positions;
  DROP TABLE positions;
  ALTER TABLE positions_v2 RENAME TO positions;
  CREATE INDEX idx_positions_scope_status ON positions (env, mode, status);
  CREATE INDEX idx_positions_scope_exit_day ON positions (env, mode, exit_day);
  CREATE TRIGGER positions_entry_order_same_scope BEFORE INSERT ON positions
    WHEN NEW.entry_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o
      WHERE o.id = NEW.entry_order_id AND o.env = NEW.env AND o.mode = NEW.mode)
  BEGIN
    SELECT RAISE(ABORT, 'positions: la orden de entrada es de otro entorno/modo');
  END;
  CREATE TRIGGER positions_exit_order_same_scope BEFORE UPDATE OF exit_order_id ON positions
    WHEN NEW.exit_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o
      WHERE o.id = NEW.exit_order_id AND o.env = NEW.env AND o.mode = NEW.mode)
  BEGIN
    SELECT RAISE(ABORT, 'positions: la orden de salida es de otro entorno/modo');
  END;

  -- 5. Eventos: con entorno y modo. Los anteriores (sin ámbito) se asignan a testnet/dry-run.
  CREATE TABLE events_v2 (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    env     TEXT NOT NULL CHECK (env IN ('testnet', 'demo')),
    mode    TEXT NOT NULL CHECK (mode IN ('dry-run', 'exchange')),
    time    TEXT NOT NULL,
    type    TEXT NOT NULL,
    code    TEXT,
    message TEXT NOT NULL,
    data    TEXT
  );
  INSERT INTO events_v2 (id, env, mode, time, type, code, message, data)
    SELECT id, 'testnet', 'dry-run', time, type, code, message, data FROM events;
  DROP TABLE events;
  ALTER TABLE events_v2 RENAME TO events;
  CREATE INDEX idx_events_scope ON events (env, mode, id);

  -- 6. Caché de velas: clave única (entorno, par, intervalo, inicio) → sin duplicados.
  CREATE TABLE candles (
    env       TEXT NOT NULL CHECK (env IN ('testnet', 'demo', 'production-readonly')),
    symbol    TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time INTEGER NOT NULL,                              -- inicio de la vela, ms UTC
    open      REAL NOT NULL CHECK (open > 0),
    high      REAL NOT NULL CHECK (high > 0),
    low       REAL NOT NULL CHECK (low > 0),
    close     REAL NOT NULL CHECK (close > 0),
    volume    REAL NOT NULL CHECK (volume >= 0),
    PRIMARY KEY (env, symbol, timeframe, open_time)
  ) WITHOUT ROWID;
  `,
  },

  {
    version: 3,
    name: 'clave de señal en órdenes y fotos de saldos para la reconciliación (módulo 6)',
    sql: `
  -- 1. Una señal de la estrategia (estrategia + par + vela + acción) produce como
  --    máximo UNA orden: un reenvío de la misma señal choca con este índice.
  ALTER TABLE orders ADD COLUMN signal_key TEXT;
  CREATE UNIQUE INDEX ux_orders_signal_key ON orders (env, mode, signal_key)
    WHERE signal_key IS NOT NULL;

  -- 2. Saldos de referencia del exchange. El saldo esperado es la última foto más
  --    las ejecuciones registradas desde entonces; si no coincide con Binance, hay
  --    una diferencia que resolver antes de operar.
  CREATE TABLE balance_snapshots (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    env    TEXT NOT NULL CHECK (env IN ('testnet', 'demo')),
    mode   TEXT NOT NULL CHECK (mode IN ('dry-run', 'exchange')),
    asset  TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),               -- saldo total (libre + en órdenes)
    time   TEXT NOT NULL,
    reason TEXT NOT NULL                                    -- p. ej. "referencia inicial", "aceptado manualmente"
  );
  CREATE INDEX idx_balance_snapshots_scope ON balance_snapshots (env, mode, asset, id);
  `,
  },

  {
    version: 4,
    name: 'resultados de backtests y sus operaciones (módulo 8)',
    sql: `
  -- Un resultado de backtest por fila. Un backtest con período de ajuste y de
  -- validación guarda dos filas con el mismo group_id.
  CREATE TABLE backtest_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id      TEXT NOT NULL,                             -- une ajuste y validación de una misma corrida
    segment       TEXT NOT NULL CHECK (segment IN ('full', 'train', 'validation')),
    created_at    TEXT NOT NULL,
    data_env      TEXT NOT NULL CHECK (data_env IN ('testnet', 'demo', 'production-readonly')),
    strategy      TEXT NOT NULL,
    params        TEXT NOT NULL,                             -- JSON: parámetros de la estrategia
    symbol        TEXT NOT NULL,
    timeframe     TEXT NOT NULL,
    period_from   TEXT NOT NULL,                             -- ISO UTC, inclusive
    period_to     TEXT NOT NULL,                             -- ISO UTC, exclusivo
    capital       REAL NOT NULL,
    fee_rate      REAL NOT NULL,
    slippage_bps  REAL NOT NULL,
    settings      TEXT NOT NULL,                             -- JSON: límites de riesgo, filtros del par, etc.
    metrics       TEXT NOT NULL,                             -- JSON: el reporte completo
    csv_path      TEXT
  );
  CREATE INDEX idx_backtest_runs_group ON backtest_runs (group_id);

  CREATE TABLE backtest_trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
    n           INTEGER NOT NULL,                            -- número de operación en la corrida
    entry_time  TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_time   TEXT NOT NULL,
    exit_price  REAL NOT NULL,
    qty         REAL NOT NULL,
    fees        REAL NOT NULL,                               -- comisión de compra + venta (USDT)
    pnl         REAL NOT NULL,                               -- neto de comisiones (USDT)
    pnl_pct     REAL NOT NULL,                               -- sobre el costo de entrada
    UNIQUE (run_id, n)
  );
  `,
  },

  {
    version: 5,
    name: 'estado del bot y curva de capital de los backtests (panel)',
    // Solo AGREGA tablas: no modifica ni borra datos existentes (una prueba lo verifica).
    sql: `
  -- 1. Estado del bot por ámbito, para el panel de monitoreo (que lo lee en solo
  --    lectura). El bot lo actualiza al arrancar, en cada heartbeat, tras cada vela
  --    y al apagarse. Nunca contiene secretos: settings es una lista blanca.
  CREATE TABLE bot_status (
    env          TEXT NOT NULL CHECK (env IN ('testnet', 'demo')),
    mode         TEXT NOT NULL CHECK (mode IN ('dry-run', 'exchange')),
    state        TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopping', 'stopped')),
    pid          INTEGER,
    started_at   TEXT,
    updated_at   TEXT NOT NULL,                             -- última escritura
    heartbeat_at TEXT,                                      -- último heartbeat
    heartbeat_ms INTEGER,                                   -- intervalo configurado (para detectar silencio)
    stopped_at   TEXT,
    stop_reason  TEXT,
    exit_code    INTEGER,
    strategy     TEXT,
    params       TEXT,                                      -- JSON: parámetros de la estrategia
    symbol       TEXT,
    timeframe    TEXT,
    last_candle  TEXT,                                      -- inicio de la última vela procesada
    price        REAL,                                      -- último precio conocido
    price_time   TEXT,
    data_stale   INTEGER CHECK (data_stale IN (0, 1)),
    data_reason  TEXT,
    settings     TEXT,                                      -- JSON: límites, dry-run, comisión… (sin secretos)
    PRIMARY KEY (env, mode)
  );

  -- 2. Curva de capital de cada backtest: n = 0 es el capital inicial (time = inicio
  --    del período); n ≥ 1 es el valor al CIERRE de la vela que empieza en time.
  CREATE TABLE backtest_equity (
    run_id INTEGER NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
    n      INTEGER NOT NULL,
    time   INTEGER NOT NULL,                                -- ms UTC
    equity REAL NOT NULL,                                   -- USDT
    PRIMARY KEY (run_id, n)
  ) WITHOUT ROWID;
  `,
  },
]);
