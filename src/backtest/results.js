/**
 * Resultados de backtests: se guardan en SQLite (con parámetros, período y fecha)
 * y las operaciones se exportan a CSV, para mostrarlos después en un panel.
 */
import fs from 'node:fs';
import path from 'node:path';

export class BacktestStore {
  constructor(db) {
    this.db = db;
    this.sql = {
      insertRun: db.prepare(
        `INSERT INTO backtest_runs (group_id, segment, created_at, data_env, strategy, params, symbol, timeframe,
                                    period_from, period_to, capital, fee_rate, slippage_bps, settings, metrics, csv_path)
         VALUES (@groupId, @segment, @createdAt, @dataEnv, @strategy, @params, @symbol, @timeframe,
                 @periodFrom, @periodTo, @capital, @feeRate, @slippageBps, @settings, @metrics, @csvPath)`,
      ),
      insertTrade: db.prepare(
        `INSERT INTO backtest_trades (run_id, n, entry_time, entry_price, exit_time, exit_price, qty, fees, pnl, pnl_pct)
         VALUES (@runId, @n, @entryTime, @entryPrice, @exitTime, @exitPrice, @qty, @fees, @pnl, @pnlPct)`,
      ),
      setCsv: db.prepare('UPDATE backtest_runs SET csv_path = ? WHERE id = ?'),
      run: db.prepare('SELECT * FROM backtest_runs WHERE id = ?'),
      trades: db.prepare('SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY n'),
      list: db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?'),
      group: db.prepare('SELECT * FROM backtest_runs WHERE group_id = ? ORDER BY id'),
    };
  }

  /** Guarda un resultado y sus operaciones (atómico). @returns {number} id */
  saveRun({ groupId, segment, createdAt, dataEnv, strategy, params, symbol, timeframe, report, capital, feeRate, slippageBps, settings }) {
    return this.db.transaction(() => {
      const { tradesList, decisions, equity, ...metrics } = report;
      const { lastInsertRowid: runId } = this.sql.insertRun.run({
        groupId, segment, createdAt: new Date(createdAt).toISOString(), dataEnv, strategy,
        params: JSON.stringify(params), symbol, timeframe,
        periodFrom: report.period.from, periodTo: report.period.to,
        capital, feeRate, slippageBps, settings: JSON.stringify(settings), metrics: JSON.stringify(metrics), csvPath: null,
      });
      for (const trade of tradesList) this.sql.insertTrade.run({ runId, ...trade });
      return Number(runId);
    })();
  }

  setCsvPath(runId, csvPath) {
    this.sql.setCsv.run(csvPath, runId);
  }

  getRun(id) {
    const row = this.sql.run.get(id);
    return row ? { ...parseRow(row), trades: this.sql.trades.all(id) } : null;
  }

  listRuns(limit = 20) {
    return this.sql.list.all(limit).map(parseRow);
  }

  getGroup(groupId) {
    return this.sql.group.all(groupId).map(parseRow);
  }
}

function parseRow(row) {
  return { ...row, params: JSON.parse(row.params), settings: JSON.parse(row.settings), metrics: JSON.parse(row.metrics) };
}

const CSV_COLUMNS = ['n', 'entry_time', 'entry_price', 'exit_time', 'exit_price', 'qty', 'fees', 'pnl', 'pnl_pct'];

/** Exporta las operaciones a CSV (separador coma, punto decimal, tiempos ISO UTC). */
export function writeTradesCsv(file, trades) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const round = (n) => String(Math.round(n * 1e8) / 1e8);
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of trades) {
    lines.push([t.n, t.entryTime, round(t.entryPrice), t.exitTime, round(t.exitPrice), round(t.qty), round(t.fees), round(t.pnl), round(t.pnlPct)].join(','));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
