/**
 * activateKillSwitch: la lógica de `npm run kill`, compartida con el panel.
 * (El comando como proceso separado se prueba en test/scripts/kill-resume.test.js.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateKillSwitch } from '../../src/risk/kill-command.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { ALL_TRADING_SCOPES } from '../../src/storage/scope.js';
import { tempDir } from '../helpers.js';

let tmp;
let files;
beforeEach(async () => {
  tmp = await tempDir();
  files = { killSwitchFile: path.join(tmp.dir, 'STOP'), dbPath: path.join(tmp.dir, 'bot.db') };
});
afterEach(() => tmp.cleanup());

function haltStates() {
  const db = openDatabase(files.dbPath);
  try {
    return ALL_TRADING_SCOPES.map((scope) => new RiskStore(db, scope).getHaltState());
  } finally {
    db.close();
  }
}

describe('activateKillSwitch', () => {
  it('crea el archivo STOP con el motivo y detiene TODOS los entornos y modos en SQLite', () => {
    const now = Date.parse('2026-09-29T12:00:00.000Z');
    const result = activateKillSwitch({ ...files, reason: 'panel: volatilidad', now });

    expect(result).toEqual({ reason: 'panel: volatilidad', file: files.killSwitchFile, halted: 4, dbError: null });
    expect(new KillSwitch(files.killSwitchFile).read()).toMatchObject({ reason: 'panel: volatilidad', createdAt: '2026-09-29T12:00:00.000Z' });
    for (const state of haltStates()) {
      expect(state).toMatchObject({ halted: true, code: 'KILL_SWITCH', reason: 'kill switch: panel: volatilidad' });
    }
  });

  it('activarlo otra vez no cambia las paradas existentes (cuenta 0 ámbitos nuevos)', () => {
    activateKillSwitch({ ...files, reason: 'primero' });
    const again = activateKillSwitch({ ...files, reason: 'segundo' });
    expect(again.halted).toBe(0);
    expect(haltStates().every((s) => s.reason === 'kill switch: primero')).toBe(true);
  });

  it('si la base de datos falla, el archivo queda activo y el error se devuelve (no se lanza)', () => {
    fs.mkdirSync(files.dbPath); // una carpeta donde debería ir la base: no se puede abrir
    const result = activateKillSwitch({ ...files, reason: 'sin base' });
    expect(result.halted).toBeNull();
    expect(result.dbError).toBeInstanceOf(Error);
    expect(new KillSwitch(files.killSwitchFile).isActive()).toBe(true);
  });

  it('si no se puede crear el archivo, lanza el error y no toca la base de datos', () => {
    const blocked = { ...files, killSwitchFile: path.join(tmp.dir, 'no-es-carpeta', 'STOP') };
    fs.writeFileSync(path.join(tmp.dir, 'no-es-carpeta'), 'archivo');
    expect(() => activateKillSwitch({ ...blocked, reason: 'x' })).toThrow();
    expect(fs.existsSync(files.dbPath)).toBe(false);
  });
});
