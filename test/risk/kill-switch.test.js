import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { tempDir } from '../helpers.js';

describe('KillSwitch', () => {
  let tmp;
  let killSwitch;
  beforeEach(async () => {
    tmp = await tempDir();
    killSwitch = new KillSwitch(path.join(tmp.dir, 'STOP'));
  });
  afterEach(() => tmp.cleanup());

  it('inactivo mientras el archivo no exista', () => {
    expect(killSwitch.isActive()).toBe(false);
    expect(killSwitch.read()).toBeNull();
  });

  it('activate() crea el archivo con motivo y fecha', () => {
    killSwitch.activate('mercado raro', Date.parse('2026-09-28T12:00:00Z'));
    expect(killSwitch.isActive()).toBe(true);
    expect(killSwitch.read()).toMatchObject({ reason: 'mercado raro', createdAt: '2026-09-28T12:00:00.000Z' });
  });

  it('un archivo creado a mano (vacío o con texto) también cuenta', () => {
    fs.writeFileSync(killSwitch.file, '');
    expect(killSwitch.read().reason).toBe('archivo de kill switch presente');
    fs.writeFileSync(killSwitch.file, 'me voy a dormir');
    expect(killSwitch.read().reason).toBe('me voy a dormir');
  });

  it('clear() lo desactiva y no falla si no existe', () => {
    killSwitch.activate();
    killSwitch.clear();
    expect(killSwitch.isActive()).toBe(false);
    expect(() => killSwitch.clear()).not.toThrow();
  });

  it('watch() avisa una sola vez cuando aparece el archivo', async () => {
    const onActivate = vi.fn();
    const stop = killSwitch.watch(onActivate, { intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onActivate).not.toHaveBeenCalled();

    killSwitch.activate('prueba');
    await vi.waitFor(() => expect(onActivate).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(onActivate.mock.calls[0][0]).toMatchObject({ reason: 'prueba' });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onActivate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('dejar de vigilar evita el aviso', async () => {
    const onActivate = vi.fn();
    const stop = killSwitch.watch(onActivate, { intervalMs: 10 });
    stop();
    killSwitch.activate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onActivate).not.toHaveBeenCalled();
  });
});
