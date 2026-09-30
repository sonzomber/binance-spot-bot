/**
 * Accesos directos de Windows (.lnk): la carpeta "Binance Spot Bot" en el
 * escritorio y el acceso del inicio automático (carpeta Inicio de Windows).
 *
 * - Todos apuntan a launcher\windows\lanzador.bat con una acción. Llevan la ruta
 *   del proyecto: si mueves la carpeta, vuelve a crearlos.
 * - Se crean con PowerShell (WScript.Shell). Los datos van por una variable de
 *   entorno en JSON, no pegados en el script: así una ruta con comillas o
 *   acentos no rompe nada. PowerShell con -Command no ejecuta archivos de script,
 *   así que no depende de (ni cambia) la política de ejecución.
 * - Las carpetas se piden a Windows ([Environment]::GetFolderPath): el
 *   escritorio puede estar en OneDrive.
 * - Íconos de Windows (shell32.dll e imageres.dll): no hay archivos nuevos.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/config/index.js';

export const LAUNCHER_BAT = path.join(PROJECT_ROOT, 'launcher', 'windows', 'lanzador.bat');
export const DESKTOP_FOLDER = 'Binance Spot Bot';
export const AUTOSTART_NAME = 'Binance Spot Bot (inicio automático)';

const shell32 = (n) => `%SystemRoot%\\System32\\shell32.dll,${n}`;
const imageres = (n) => `%SystemRoot%\\System32\\imageres.dll,${n}`;
const NORMAL = 1;
const MINIMIZED = 7;

/** Los accesos del escritorio: nombre, acción del lanzador, ícono y descripción (se ve al pasar el mouse). */
export const DESKTOP_SHORTCUTS = Object.freeze([
  { name: 'Iniciar bot', action: 'start-bot', icon: shell32(176), description: 'Inicia el bot en segundo plano (pm2). Con DRY_RUN=false pide escribir OPERAR.' },
  { name: 'Detener bot', action: 'stop-bot', icon: shell32(215), description: 'Apagado ordenado, igual que Ctrl+C: cancela órdenes pendientes y no vende posiciones.' },
  { name: 'Iniciar panel', action: 'start-panel', icon: imageres(144), description: 'Inicia el panel de monitoreo y lo abre en el navegador.' },
  { name: 'Detener panel', action: 'stop-panel', icon: imageres(193), description: 'Detiene el panel (el bot sigue).' },
  { name: 'Estado del bot', action: 'status', icon: imageres(76), description: 'Bot, panel, entorno, DRY_RUN y estado de riesgo. Espera una tecla para cerrar.' },
  { name: 'Kill switch', action: 'kill', icon: shell32(219), description: 'Detiene el bot en todos los entornos. Pide escribir SI.' },
  { name: 'Reanudar bot', action: 'resume', icon: imageres(229), description: 'Reanuda después de un kill switch o una parada. Pide escribir REANUDAR.' },
].map(Object.freeze));

/** Especificación completa de un .lnk que apunta al lanzador. */
export function shortcutSpec({ name, action, icon, description, windowStyle = NORMAL }) {
  return {
    name,
    target: LAUNCHER_BAT,
    arguments: action,
    workingDirectory: path.resolve(PROJECT_ROOT),
    icon,
    description,
    windowStyle,
  };
}

export const AUTOSTART_SHORTCUT = Object.freeze(shortcutSpec({
  name: AUTOSTART_NAME,
  action: 'autostart',
  icon: shell32(176),
  description: 'Inicia el panel y el bot (solo en dry-run y sin parada) al iniciar sesión en Windows.',
  windowStyle: MINIMIZED,
}));

// El script de PowerShell. Lee todo de $env:BOT_LAUNCHER_SHORTCUTS y escribe una ruta por línea.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$spec = $env:BOT_LAUNCHER_SHORTCUTS | ConvertFrom-Json
$dir = if ($spec.path) { $spec.path } else { [Environment]::GetFolderPath($spec.folder) }
if (-not $dir) { throw "Windows no informó la carpeta $($spec.folder)" }
if ($spec.subfolder) { $dir = Join-Path $dir $spec.subfolder }
Write-Output "DIR $dir"
if ($spec.mode -eq 'create') {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  foreach ($s in $spec.shortcuts) {
    $file = Join-Path $dir ($s.name + '.lnk')
    $lnk = $shell.CreateShortcut($file)
    $lnk.TargetPath = $s.target
    $lnk.Arguments = $s.arguments
    $lnk.WorkingDirectory = $s.workingDirectory
    $lnk.IconLocation = $s.icon
    $lnk.Description = $s.description
    $lnk.WindowStyle = [int]$s.windowStyle
    $lnk.Save()
    Write-Output "LNK $file"
  }
} else {
  foreach ($s in $spec.shortcuts) {
    $file = Join-Path $dir ($s.name + '.lnk')
    if (Test-Path -LiteralPath $file) {
      if ($spec.mode -eq 'remove') { Remove-Item -LiteralPath $file -Force }
      Write-Output "LNK $file"
    }
  }
  if ($spec.mode -eq 'remove' -and $spec.subfolder -and (Test-Path -LiteralPath $dir)) {
    if (-not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
  }
}
`;

/**
 * Corre el script de PowerShell con la especificación en una variable de entorno.
 * El script va como -EncodedCommand (UTF-16 en base64): PowerShell 5.1 maneja mal
 * las comillas dentro de -Command, y así llega intacto (acentos incluidos).
 * @returns {Promise<string>} la salida (UTF-8)
 */
export function runPowerShell(spec) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, BOT_LAUNCHER_SHORTCUTS: JSON.stringify(spec) }, windowsHide: true, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`PowerShell falló: ${(stderr || err.message).trim().split('\n')[0]}`));
        else resolve(stdout);
      },
    );
  });
}

/** Interpreta la salida del script: la carpeta y los accesos que tocó. */
export function parseOutput(output) {
  const lines = output.replace(/^\uFEFF/, '').split(/\r?\n/);
  return {
    dir: lines.find((l) => l.startsWith('DIR '))?.slice(4) ?? null,
    files: lines.filter((l) => l.startsWith('LNK ')).map((l) => l.slice(4)),
  };
}

/**
 * @param {{ run?: typeof runPowerShell, platform?: string, paths?: { desktop?: string, startup?: string } }} [options]
 *        run y paths: para pruebas (paths: carpetas en lugar del escritorio y de Inicio)
 */
export function createShortcuts({ run = runPowerShell, platform = process.platform, paths = {} } = {}) {
  const call = async (spec) => {
    if (platform !== 'win32') throw new Error('Los accesos directos solo existen en Windows.');
    return parseOutput(await run(spec));
  };
  const desktop = (mode) => call({
    mode, folder: 'Desktop', path: paths.desktop ?? null, subfolder: DESKTOP_FOLDER, shortcuts: DESKTOP_SHORTCUTS.map(shortcutSpec),
  });
  const startup = (mode) => call({ mode, folder: 'Startup', path: paths.startup ?? null, subfolder: null, shortcuts: [AUTOSTART_SHORTCUT] });
  return {
    /** Crea (o recrea) la carpeta del escritorio con los 7 accesos. */
    installDesktop: () => desktop('create'),
    /** Quita esos accesos (y la carpeta, si quedó vacía). */
    removeDesktop: () => desktop('remove'),
    enableAutostart: () => startup('create'),
    disableAutostart: () => startup('remove'),
    /** ¿Está activado el inicio automático? */
    async autostartEnabled() {
      return (await startup('list')).files.length > 0;
    },
  };
}
