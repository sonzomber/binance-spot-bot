/**
 * Reanudación manual después de una parada (kill switch o pérdida máxima diaria).
 *
 *   npm run resume
 *
 * Borra la parada guardada y el archivo del kill switch. Se niega si hoy (UTC)
 * ya se alcanzó la pérdida máxima: el bot se volvería a detener al arrancar.
 */
import { ConfigError, loadConfig, loadEnvFile } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { RiskError, createRiskManager } from '../src/risk/risk-manager.js';
import { openDatabase } from '../src/storage/db.js';

loadEnvFile();
let db;
try {
  const config = loadConfig();
  const logger = createLogger({ ...config.log, console: false }); // auditoría en el archivo de log
  db = openDatabase(config.storage.dbPath);
  const result = createRiskManager(config, db, logger).resume({ by: 'npm run resume' });

  if (result.resumed) {
    const { previous } = result;
    console.log('Bot reanudado.');
    if (previous.halted) console.log(`  Parada anterior (${previous.code}, ${previous.haltedAt}): ${previous.reason}`);
    console.log('  Kill switch desactivado. Ya puedes iniciar el bot con: npm start');
  } else {
    console.log('El bot no estaba detenido: no hay nada que reanudar.');
  }
} catch (err) {
  if (!(err instanceof ConfigError || err instanceof RiskError)) throw err;
  console.error(`No se reanudó: ${err.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}
