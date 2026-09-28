/**
 * Prueba los comandos reales (npm run kill / resume / status) como procesos
 * separados, igual que los usarías desde otra terminal.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { tempDir } from '../helpers.js';

const run = promisify(execFile);
const script = (name) => path.join(PROJECT_ROOT, 'scripts', `${name}.js`);

let tmp;
let files;
beforeEach(async () => {
  tmp = await tempDir();
  files = {
    KILL_SWITCH_FILE: path.join(tmp.dir, 'STOP'),
    DB_PATH: path.join(tmp.dir, 'bot.db'),
    LOG_FILE: path.join(tmp.dir, 'bot.log'),
  };
});
afterEach(() => tmp.cleanup());

/** Ejecuta un script con variables explícitas (tienen prioridad sobre un .env local). */
function exec(name, args = [], env = {}) {
  return run(process.execPath, [script(name), ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...files, DRY_RUN: 'true', BINANCE_ENV: 'testnet', ...env },
  });
}

function haltState() {
  const db = openDatabase(files.DB_PATH);
  try {
    return new RiskStore(db).getHaltState();
  } finally {
    db.close();
  }
}

describe('npm run kill', () => {
  it('activa el kill switch y guarda la parada, aunque la config esté rota', async () => {
    // Config inválida a propósito: sin STRATEGY y con un entorno prohibido.
    const { stdout } = await exec('kill', ['volatilidad', 'extrema'], { STRATEGY: '', BINANCE_ENV: 'mainnet' });

    expect(stdout).toMatch(/Kill switch ACTIVADO/);
    expect(JSON.parse(fs.readFileSync(files.KILL_SWITCH_FILE, 'utf8'))).toMatchObject({ reason: 'volatilidad extrema' });
    expect(haltState()).toMatchObject({ halted: true, code: 'KILL_SWITCH', reason: 'kill switch: volatilidad extrema' });
  }, 20_000);
});

describe('npm run resume', () => {
  it('reanuda: borra el archivo y la parada', async () => {
    await exec('kill', ['prueba'], { STRATEGY: 'sma-cross' });
    const { stdout } = await exec('resume', [], { STRATEGY: 'sma-cross' });

    expect(stdout).toMatch(/Bot reanudado/);
    expect(stdout).toMatch(/KILL_SWITCH/);
    expect(fs.existsSync(files.KILL_SWITCH_FILE)).toBe(false);
    expect(haltState().halted).toBe(false);
  }, 20_000);

  it('si no estaba detenido, lo dice y no cambia nada', async () => {
    const { stdout } = await exec('resume', [], { STRATEGY: 'sma-cross' });
    expect(stdout).toMatch(/no estaba detenido/);
  }, 20_000);
});

describe('npm run status', () => {
  it('muestra el estado de riesgo', async () => {
    await exec('kill', ['revisando'], { STRATEGY: 'sma-cross' });
    const { stdout } = await exec('status', [], { STRATEGY: 'sma-cross' });
    expect(stdout).toMatch(/Estado: DETENIDO .*kill switch: revisando/);
    expect(stdout).toMatch(/Kill switch: ACTIVO \(revisando\)/);
    expect(stdout).toMatch(/Posiciones abiertas: 0\/1/);
  }, 20_000);
});
