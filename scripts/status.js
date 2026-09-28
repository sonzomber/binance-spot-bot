/**
 * Estado de riesgo del bot, leído de la base de datos (no usa la red).
 *
 *   npm run status
 */
import pino from 'pino';
import { ConfigError, loadConfig, loadEnvFile } from '../src/config/index.js';
import { createRiskManager } from '../src/risk/risk-manager.js';
import { openDatabase } from '../src/storage/db.js';

loadEnvFile();
let db;
try {
  const config = loadConfig();
  db = openDatabase(config.storage.dbPath);
  const risk = createRiskManager(config, db, pino({ level: 'silent' }));
  const halt = risk.haltState();
  const daily = risk.dailyPnl(); // sin precios actuales: lo no realizado solo cuenta comisiones
  const open = risk.store.openPositions(config.mode);
  const fmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)} USDT`;

  console.log(`Modo: ${config.mode}   Día UTC: ${daily.day}`);
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
