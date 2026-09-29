/**
 * Estado del bot en el entorno y modo configurados, leído de la base de datos
 * (no usa la red). Nunca mezcla datos de otros entornos.
 *
 *   npm run status
 */
import pino from 'pino';
import { ConfigError, loadConfig, loadEnvFile } from '../src/config/index.js';
import { createRiskManager } from '../src/risk/risk-manager.js';
import { nextUtcMidnight, utcDay } from '../src/risk/pnl.js';
import { openDatabase, schemaInfo } from '../src/storage/db.js';
import { OrderStore } from '../src/storage/order-store.js';

loadEnvFile();
let db;
try {
  const config = loadConfig();
  db = openDatabase(config.storage.dbPath);
  const scope = { env: config.env, mode: config.mode };
  const risk = createRiskManager(config, db, pino({ level: 'silent' }));
  const halt = risk.haltState();
  const daily = risk.dailyPnl(); // sin precios actuales: lo no realizado solo cuenta comisiones
  const open = risk.store.openPositions();
  const now = Date.now();
  const dayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const orders = new OrderStore(db, scope).summary({ from: dayStart, to: nextUtcMidnight(now) });
  const fmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)} USDT`;

  console.log(`Entorno: ${scope.env}   Modo: ${scope.mode}   Día UTC: ${daily.day}   Esquema BD: v${schemaInfo(db).version}`);
  console.log(
    halt.halted
      ? `Estado: DETENIDO desde ${halt.haltedAt} (${halt.code}): ${halt.reason}`
      : 'Estado: habilitado',
  );
  console.log(`Kill switch: ${risk.killSwitch.isActive() ? `ACTIVO (${risk.killSwitch.read().reason})` : 'inactivo'}`);
  console.log(
    `PnL realizado hoy: ${fmt(daily.realized)} en ${daily.closedTrades} operación(es) ` +
      `(comisiones pagadas: ${daily.realizedFees.toFixed(2)} USDT); límite: −${config.risk.maxDailyLossUsdt} USDT`,
  );
  console.log(`Posiciones abiertas: ${open.length}/${config.risk.maxOpenPositions}`);
  for (const p of open) {
    console.log(`  #${p.id} ${p.symbol} qty=${p.qty} entrada=${p.entryPrice} costo=${p.entryCost.toFixed(2)} USDT (${p.entryTime})`);
  }
  const s = orders.byStatus;
  console.log(
    `Órdenes hoy: ${orders.total} (ejecutadas ${s.filled}, parciales ${s.partially_filled}, abiertas ${s.open + s.pending}, ` +
      `canceladas ${s.canceled}, rechazadas ${s.rejected})`,
  );
  for (const r of orders.rejections) console.log(`  rechazadas por ${r.source}${r.code ? ` (${r.code})` : ''}: ${r.count}`);
  const events = risk.store.recentEvents(5);
  if (events.length) {
    console.log('Últimos eventos:');
    for (const e of events) console.log(`  ${e.time} ${e.type}${e.code ? ` (${e.code})` : ''}: ${e.message}`);
  }
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
