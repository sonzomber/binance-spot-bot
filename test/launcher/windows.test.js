/**
 * Lo propio de Windows: los .bat, los accesos directos (con el PowerShell REAL,
 * en una carpeta temporal: nunca en el escritorio) y que cada acceso apunte a
 * una acción que existe.
 */
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS } from '../../launcher/lib/main.js';
import {
  AUTOSTART_NAME, AUTOSTART_SHORTCUT, DESKTOP_FOLDER, DESKTOP_SHORTCUTS, LAUNCHER_BAT, createShortcuts, parseOutput, shortcutSpec,
} from '../../launcher/lib/shortcuts.js';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { tempDir } from '../helpers.js';

const WINDOWS_DIR = path.join(PROJECT_ROOT, 'launcher', 'windows');
const isWindows = process.platform === 'win32';
let tmp;
afterEach(() => tmp?.cleanup());

describe('archivos .bat', () => {
  const bats = fs.readdirSync(WINDOWS_DIR).filter((f) => f.endsWith('.bat'));

  it('los cinco, en ASCII (la consola rompe los acentos) y con CRLF (cmd.exe lo necesita)', () => {
    expect(bats.toSorted()).toEqual([
      'activar-inicio-automatico.bat', 'desactivar-inicio-automatico.bat', 'instalar-accesos-directos.bat',
      'lanzador.bat', 'quitar-accesos-directos.bat',
    ]);
    for (const bat of bats) {
      const bytes = fs.readFileSync(path.join(WINDOWS_DIR, bat));
      expect(bytes.every((b) => b < 128), bat).toBe(true);
      const text = bytes.toString('latin1');
      expect(text.split('\n').length - 1, bat).toBe(text.split('\r\n').length - 1); // todo salto de línea es CRLF
    }
  });

  it('lanzador.bat va a la carpeta del proyecto, avisa si falta Node y pasa la acción a cli.js', () => {
    const text = fs.readFileSync(LAUNCHER_BAT, 'utf8');
    expect(text).toContain('cd /d "%~dp0..\\.."');
    expect(text).toMatch(/where node >nul 2>nul\r\nif errorlevel 1 goto sin_node/);
    expect(text).toMatch(/:sin_node[\s\S]*No se encontro Node\.js[\s\S]*pause/);
    expect(text).toContain('node launcher\\cli.js %*');
    expect(text).not.toMatch(/\.env/); // no toca la configuración
  });

  it('cada .bat auxiliar llama al lanzador con una acción que existe', () => {
    const expected = {
      'instalar-accesos-directos.bat': 'install-shortcuts',
      'quitar-accesos-directos.bat': 'remove-shortcuts',
      'activar-inicio-automatico.bat': 'autostart-on',
      'desactivar-inicio-automatico.bat': 'autostart-off',
    };
    for (const [bat, action] of Object.entries(expected)) {
      const text = fs.readFileSync(path.join(WINDOWS_DIR, bat), 'utf8');
      expect(text).toContain(`call "%~dp0lanzador.bat" ${action}\r\n`);
      expect(Object.hasOwn(ACTIONS, action)).toBe(true);
    }
  });

  it.skipIf(!isWindows)('de punta a punta: lanzador.bat encuentra Node y el proyecto (acción inexistente → código 2)', () => {
    const result = spawnSync('cmd.exe', ['/d', '/c', LAUNCHER_BAT, 'accion-inexistente', '--no-pause'], { encoding: 'utf8', cwd: 'C:\\' });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Acción desconocida: accion-inexistente\./);
  });
});

describe('accesos directos', () => {
  it('los siete del escritorio, con nombres claros, cada uno con una acción del lanzador', () => {
    expect(DESKTOP_SHORTCUTS.map((s) => [s.name, s.action])).toEqual([
      ['Iniciar bot', 'start-bot'],
      ['Detener bot', 'stop-bot'],
      ['Iniciar panel', 'start-panel'],
      ['Detener panel', 'stop-panel'],
      ['Estado del bot', 'status'],
      ['Kill switch', 'kill'],
      ['Reanudar bot', 'resume'],
    ]);
    for (const s of DESKTOP_SHORTCUTS) {
      expect(ACTIONS[s.action].title).toBe(s.name); // el título de la ventana coincide con el acceso
      expect(s.icon).toMatch(/^%SystemRoot%\\System32\\(shell32|imageres)\.dll,\d+$/);
      expect(s.description.length).toBeGreaterThan(10);
    }
    expect(new Set(DESKTOP_SHORTCUTS.map((s) => s.icon)).size).toBe(7); // un ícono distinto para cada uno
    expect(DESKTOP_FOLDER).toBe('Binance Spot Bot');
  });

  it('apuntan a lanzador.bat, con la carpeta del proyecto como carpeta de trabajo; el automático, minimizado', () => {
    expect(fs.existsSync(LAUNCHER_BAT)).toBe(true);
    const spec = shortcutSpec(DESKTOP_SHORTCUTS[0]);
    expect(spec).toMatchObject({ name: 'Iniciar bot', target: LAUNCHER_BAT, arguments: 'start-bot', workingDirectory: path.resolve(PROJECT_ROOT), windowStyle: 1 });
    expect(AUTOSTART_SHORTCUT).toMatchObject({ name: AUTOSTART_NAME, target: LAUNCHER_BAT, arguments: 'autostart', windowStyle: 7 });
    expect(Object.hasOwn(ACTIONS, AUTOSTART_SHORTCUT.arguments)).toBe(true);
  });

  it('pide a PowerShell lo correcto: escritorio (carpeta Binance Spot Bot) e Inicio de Windows', async () => {
    const run = vi.fn(async () => 'DIR C:\\x\r\nLNK C:\\x\\a.lnk\r\n');
    const shortcuts = createShortcuts({ run, platform: 'win32' });
    await shortcuts.installDesktop();
    await shortcuts.removeDesktop();
    await shortcuts.enableAutostart();
    await shortcuts.disableAutostart();
    expect(await shortcuts.autostartEnabled()).toBe(true);
    expect(run.mock.calls.map(([s]) => [s.mode, s.folder, s.subfolder, s.shortcuts.length])).toEqual([
      ['create', 'Desktop', 'Binance Spot Bot', 7],
      ['remove', 'Desktop', 'Binance Spot Bot', 7],
      ['create', 'Startup', null, 1],
      ['remove', 'Startup', null, 1],
      ['list', 'Startup', null, 1],
    ]);
  });

  it('fuera de Windows no existen', async () => {
    await expect(createShortcuts({ platform: 'linux', run: vi.fn() }).installDesktop()).rejects.toThrow(/solo existen en Windows/);
  });

  it('salida de PowerShell: carpeta y accesos, con o sin BOM y CRLF', () => {
    expect(parseOutput('\uFEFFDIR C:\\Escritorio\\Binance Spot Bot\r\nLNK C:\\a ñ.lnk\r\nLNK C:\\b.lnk\r\n')).toEqual({
      dir: 'C:\\Escritorio\\Binance Spot Bot', files: ['C:\\a ñ.lnk', 'C:\\b.lnk'],
    });
    expect(parseOutput('')).toEqual({ dir: null, files: [] });
  });

  it.skipIf(!isWindows)('con el PowerShell real (en una carpeta temporal): crea, lista y quita los .lnk tal como se piden', async () => {
    tmp = await tempDir('lnk-test-');
    const desktop = path.join(tmp.dir, 'Escritorio con ñ');
    const startup = path.join(tmp.dir, 'Inicio');
    fs.mkdirSync(desktop);
    fs.mkdirSync(startup);
    const shortcuts = createShortcuts({ paths: { desktop, startup } });

    const created = await shortcuts.installDesktop();
    expect(created.dir).toBe(path.join(desktop, 'Binance Spot Bot'));
    expect(created.files.map((f) => path.basename(f))).toEqual(DESKTOP_SHORTCUTS.map((s) => `${s.name}.lnk`));
    // Leer un .lnk de vuelta con Windows: destino, acción, carpeta, ícono y ventana.
    const read = await new Promise((resolve, reject) => {
      const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); "$($l.TargetPath)|$($l.Arguments)|$($l.WorkingDirectory)|$($l.IconLocation)|$($l.WindowStyle)"`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { ...process.env, LNK: created.files[5] }, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out.trim())));
    });
    const [target, args, workdir, icon, windowStyle] = read.split('|');
    expect(target).toBe(LAUNCHER_BAT);
    expect(args).toBe('kill');
    expect(workdir).toBe(path.resolve(PROJECT_ROOT));
    expect(icon).toMatch(/shell32\.dll,219$/i); // Windows expande %SystemRoot%
    expect(windowStyle).toBe('1');

    expect(await shortcuts.autostartEnabled()).toBe(false);
    expect((await shortcuts.enableAutostart()).files).toEqual([path.join(startup, `${AUTOSTART_NAME}.lnk`)]);
    expect(await shortcuts.autostartEnabled()).toBe(true);
    expect((await shortcuts.disableAutostart()).files).toHaveLength(1);
    expect(await shortcuts.autostartEnabled()).toBe(false);
    expect((await shortcuts.disableAutostart()).files).toEqual([]); // ya no estaba

    expect((await shortcuts.removeDesktop()).files).toHaveLength(7);
    expect(fs.existsSync(path.join(desktop, 'Binance Spot Bot'))).toBe(false); // la carpeta vacía también se quita
  }, 60_000);

  it.skipIf(!isWindows)('quitar deja la carpeta si el usuario agregó algo propio', async () => {
    tmp = await tempDir('lnk-test-');
    const shortcuts = createShortcuts({ paths: { desktop: tmp.dir, startup: tmp.dir } });
    const { dir } = await shortcuts.installDesktop();
    fs.writeFileSync(path.join(dir, 'mis notas.txt'), 'hola');
    await shortcuts.removeDesktop();
    expect(fs.readdirSync(dir)).toEqual(['mis notas.txt']);
  }, 60_000);
});
