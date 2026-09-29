/**
 * Caché de velas en SQLite.
 *
 * Clave única: (entorno, par, intervalo, inicio de la vela). Guardar una vela
 * que ya existe no crea un duplicado: se ignora y se cuenta como tal.
 *
 * Solo se guardan velas CERRADAS y alineadas a su intervalo. Las velas de
 * distintos entornos nunca se mezclan: las del testnet no rellenan huecos de
 * las de producción, ni al revés.
 *
 * Huecos: si entre el inicio y el fin de un rango faltan velas, findGaps() los
 * lista y formatGapWarning() arma el aviso que se muestra antes de un backtest.
 * Un hueco puede ser real (Binance tuvo mantenimientos) o un error de descarga:
 * en ambos casos el backtest "salta" ese periodo, y conviene saberlo.
 */
import { validateCandle } from '../lib/candles.js';
import { alignDown, alignUp, timeframeToMs } from '../lib/timeframes.js';
import { dataEnv } from './scope.js';

export class CandleStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CandleStoreError';
  }
}

const iso = (ms) => new Date(ms).toISOString();

export class CandleStore {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {{ env: 'testnet'|'demo'|'production-readonly' }} scope
   */
  constructor(db, { env }) {
    this.db = db;
    this.env = dataEnv(env);
    const key = 'env = @env AND symbol = @symbol AND timeframe = @timeframe';
    this.sql = {
      insert: db.prepare(
        `INSERT INTO candles (env, symbol, timeframe, open_time, open, high, low, close, volume)
           VALUES (@env, @symbol, @timeframe, @time, @open, @high, @low, @close, @volume)
         ON CONFLICT (env, symbol, timeframe, open_time) DO NOTHING`,
      ),
      range: db.prepare(
        `SELECT open_time AS time, open, high, low, close, volume FROM candles
          WHERE ${key} AND open_time >= @from AND open_time < @to ORDER BY open_time`,
      ),
      times: db.prepare(
        `SELECT open_time FROM candles WHERE ${key} AND open_time >= @from AND open_time < @to
          ORDER BY open_time`,
      ),
      last: db.prepare(
        `SELECT open_time AS time, open, high, low, close, volume FROM candles
          WHERE ${key} ORDER BY open_time DESC LIMIT @count`,
      ),
      bounds: db.prepare(
        `SELECT MIN(open_time) AS first, MAX(open_time) AS last, COUNT(*) AS count
           FROM candles WHERE ${key}`,
      ),
    };
  }

  /**
   * Guarda velas cerradas. Las repetidas (misma clave) se ignoran.
   * @param {string} symbol p. ej. 'BTC/USDT'
   * @param {string} timeframe p. ej. '1h'
   * @param {Array<object>} candles velas en el formato común ({ time, open, ... })
   * @param {{ now?: number }} [options] instante actual, para descartar la vela en curso
   * @returns {{ inserted: number, duplicates: number, skippedOpen: number }}
   * @throws {CandleStoreError} si alguna vela es inválida o no está alineada (no guarda nada)
   */
  upsert(symbol, timeframe, candles, { now = Date.now() } = {}) {
    const step = timeframeToMs(timeframe);
    const closed = [];
    let skippedOpen = 0;

    candles.forEach((candle, i) => {
      const problem = validateCandle(candle);
      if (problem) throw new CandleStoreError(`vela ${i + 1}/${candles.length} de ${symbol} ${timeframe}: ${problem}`);
      if (candle.time % step !== 0) {
        throw new CandleStoreError(
          `vela ${i + 1}/${candles.length} de ${symbol} ${timeframe}: ${iso(candle.time)} no está alineada al intervalo`,
        );
      }
      // Una vela está cerrada cuando su intervalo terminó: time + step <= now.
      if (candle.time + step > now) skippedOpen++;
      else closed.push(candle);
    });

    let inserted = 0;
    this.db.transaction(() => {
      for (const { time, open, high, low, close, volume } of closed) {
        inserted += this.sql.insert.run({ env: this.env, symbol, timeframe, time, open, high, low, close, volume })
          .changes;
      }
    })();
    return { inserted, duplicates: closed.length - inserted, skippedOpen };
  }

  /** Velas en [from, to) ordenadas por tiempo. */
  get(symbol, timeframe, { from, to }) {
    return this.sql.range.all({ env: this.env, symbol, timeframe, from, to });
  }

  /** Las últimas `count` velas guardadas, de la más antigua a la más reciente. */
  last(symbol, timeframe, count) {
    return this.sql.last.all({ env: this.env, symbol, timeframe, count }).reverse();
  }

  /** Primera y última vela guardadas (para descargas incrementales). */
  bounds(symbol, timeframe) {
    return this.sql.bounds.get({ env: this.env, symbol, timeframe });
  }

  /**
   * Busca velas faltantes en [from, to). Los extremos se alinean al intervalo.
   * @returns {{ env, symbol, timeframe, from, to, expected, present, missing,
   *            gaps: Array<{ from: number, to: number, count: number }> }}
   *          cada hueco va de la primera a la última vela faltante (inclusive)
   */
  findGaps(symbol, timeframe, { from, to }) {
    const step = timeframeToMs(timeframe);
    const start = alignUp(from, step);
    const end = alignDown(to, step);
    const expected = Math.max(0, (end - start) / step);
    const times = this.sql.times.all({ env: this.env, symbol, timeframe, from: start, to: end }).map((r) => r.open_time);

    const gaps = [];
    let cursor = start; // próxima vela que debería existir
    for (const time of times) {
      if (time > cursor) gaps.push({ from: cursor, to: time - step, count: (time - cursor) / step });
      cursor = time + step;
    }
    if (cursor < end) gaps.push({ from: cursor, to: end - step, count: (end - cursor) / step });

    const missing = gaps.reduce((sum, gap) => sum + gap.count, 0);
    return { env: this.env, symbol, timeframe, from: start, to: end, expected, present: times.length, missing, gaps };
  }
}

/**
 * Aviso legible sobre huecos de datos, o null si el rango está completo.
 * @param {ReturnType<CandleStore['findGaps']>} report
 */
export function formatGapWarning(report, { maxListed = 5 } = {}) {
  if (report.missing === 0) return null;
  const pct = report.expected ? ((report.missing / report.expected) * 100).toFixed(2) : '100';
  const fmt = (ms) => iso(ms).replace('T', ' ').slice(0, 16);
  const lines = report.gaps
    .slice(0, maxListed)
    .map((gap) => `  - ${fmt(gap.from)} → ${fmt(gap.to)} UTC (${gap.count} vela${gap.count === 1 ? '' : 's'})`);
  if (report.gaps.length > maxListed) lines.push(`  - … y ${report.gaps.length - maxListed} hueco(s) más`);
  return [
    `Faltan ${report.missing} de ${report.expected} velas (${pct}%) de ${report.symbol} ${report.timeframe} ` +
      `[${report.env}] en ${report.gaps.length} hueco(s):`,
    ...lines,
    'El backtest saltará esos periodos: los resultados pueden no ser representativos.',
  ].join('\n');
}
