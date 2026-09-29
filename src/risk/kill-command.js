/**
 * Activar el kill switch: la lógica de `npm run kill`, compartida con el panel
 * para que ambos usen EXACTAMENTE el mismo mecanismo.
 *
 *   1. Primero el archivo (./STOP): es lo que vigila el bot y no depende de la
 *      base de datos. Si no se puede crear, se lanza el error y no se sigue.
 *   2. Además, la parada se guarda en SQLite en TODOS los entornos y modos (el
 *      kill switch no depende de la config). Si esto falla, el archivo basta: el
 *      error se devuelve (no se lanza) para que quien llama lo informe.
 */
import { openDatabase } from '../storage/db.js';
import { RiskStore } from '../storage/risk-store.js';
import { KillSwitch } from './kill-switch.js';
import { RiskCode } from './risk-manager.js';

/**
 * @param {object} args
 * @param {string} args.killSwitchFile ruta absoluta del archivo de parada
 * @param {string} args.dbPath ruta de la base de datos
 * @param {string} [args.reason]
 * @param {number} [args.now]
 * @returns {{ reason: string, file: string, halted: number|null, dbError: Error|null }}
 *          halted: cuántos ámbitos se detuvieron (los que ya estaban detenidos no cuentan)
 */
export function activateKillSwitch({ killSwitchFile, dbPath, reason = 'kill switch manual', now = Date.now() }) {
  new KillSwitch(killSwitchFile).activate(reason, now);

  let db;
  try {
    db = openDatabase(dbPath);
    const halted = RiskStore.haltAll(db, { code: RiskCode.KILL_SWITCH, reason: `kill switch: ${reason}`, time: now });
    return { reason, file: killSwitchFile, halted, dbError: null };
  } catch (err) {
    return { reason, file: killSwitchFile, halted: null, dbError: err };
  } finally {
    db?.close();
  }
}
