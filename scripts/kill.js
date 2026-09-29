/**
 * Kill switch manual: detiene el bot de forma segura.
 *
 *   npm run kill                    → motivo genérico
 *   npm run kill -- "motivo"        → con motivo
 *
 * Funciona aunque la config tenga errores: solo lee las rutas de archivos.
 * Detiene TODOS los entornos y modos (testnet/demo × dry-run/exchange).
 * Si el bot está corriendo, lo detecta en ~1 s, cancela las órdenes pendientes
 * y se detiene. Si no está corriendo, no podrá arrancar hasta `npm run resume`,
 * que reanuda el entorno y modo configurados en el .env.
 */
import { loadEnvFile, loadPaths } from '../src/config/index.js';
import { KillSwitch } from '../src/risk/kill-switch.js';
import { RiskCode } from '../src/risk/risk-manager.js';
import { openDatabase } from '../src/storage/db.js';
import { RiskStore } from '../src/storage/risk-store.js';

loadEnvFile();
const paths = loadPaths();
const reason = process.argv.slice(2).join(' ').trim() || 'kill switch manual';

// 1. Primero el archivo: es lo que vigila el bot y no depende de la base de datos.
new KillSwitch(paths.killSwitchFile).activate(reason);
console.log(`Kill switch ACTIVADO (${paths.killSwitchFile}): ${reason}`);

// 2. Además, deja la parada guardada en SQLite. Si esto falla, el archivo basta.
let db;
try {
  db = openDatabase(paths.dbPath);
  // Detiene TODOS los entornos y modos: el kill switch no depende de la config.
  const count = RiskStore.haltAll(db, { code: RiskCode.KILL_SWITCH, reason: `kill switch: ${reason}`, time: Date.now() });
  console.log(`Parada registrada en la base de datos (${count} entorno(s)/modo(s) detenidos).`);
} catch (err) {
  console.warn(`Aviso: no se pudo registrar la parada en la base de datos (${err.message}). El archivo es suficiente.`);
} finally {
  db?.close();
}

console.log('Si el bot está corriendo, cancelará las órdenes pendientes y se detendrá en ~1 segundo.');
console.log('Para reanudar: npm run resume');
