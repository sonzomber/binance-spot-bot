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
 *
 * La lógica está en src/risk/kill-command.js: el panel usa la misma función.
 */
import { loadEnvFile, loadPaths } from '../src/config/index.js';
import { activateKillSwitch } from '../src/risk/kill-command.js';

loadEnvFile();
const paths = loadPaths();
const reason = process.argv.slice(2).join(' ').trim() || 'kill switch manual';

// 1. El archivo (lo que vigila el bot) y 2. la parada en SQLite. Si 2 falla, el archivo basta.
const result = activateKillSwitch({ killSwitchFile: paths.killSwitchFile, dbPath: paths.dbPath, reason });
console.log(`Kill switch ACTIVADO (${paths.killSwitchFile}): ${reason}`);
if (result.dbError) {
  console.warn(`Aviso: no se pudo registrar la parada en la base de datos (${result.dbError.message}). El archivo es suficiente.`);
} else {
  console.log(`Parada registrada en la base de datos (${result.halted} entorno(s)/modo(s) detenidos).`);
}

console.log('Si el bot está corriendo, cancelará las órdenes pendientes y se detendrá en ~1 segundo.');
console.log('Para reanudar: npm run resume');
