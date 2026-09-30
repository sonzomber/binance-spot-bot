/**
 * Acciones del lanzador: iniciar y detener el bot y el panel, estado, kill
 * switch y reanudar. Cada una verifica antes de actuar y explica en español qué
 * pasó y qué hacer.
 *
 * Reglas que cumple:
 *   - Nunca modifica el .env ni la configuración: solo los lee.
 *   - El kill switch y reanudar usan los MISMOS scripts que `npm run kill` y
 *     `npm run resume` (no hay lógica nueva), con confirmación escrita.
 *   - DRY_RUN=false exige escribir OPERAR (la cuenta regresiva de 5 s del bot no
 *     se ve en segundo plano), y el inicio automático nunca arranca el bot así.
 *   - Nunca hay dos bots a la vez: además de pm2, mira el heartbeat en la base
 *     (un bot abierto con `npm start` en una terminal).
 *
 * Todas las dependencias se inyectan (pm2, consola, reloj, scripts…) para
 * probarlas sin procesos reales.
 */
import fs from 'node:fs';
import { PANEL_HOST, loadPanelConfig } from '../../panel/server/config.js';
import { ago, dateTime } from '../../panel/web/src/lib/format.js';
import { EXIT_CODES, describeExitCode } from '../../src/lib/exit-codes.js';
import {
  LauncherError, botLooksAlive, describeSetup, haltedScopes, panelBuildState, probePanel, readBotState, requireBotConfig,
} from './checks.js';
import { DEFAULT_ENV_FILE, readEnv } from './env.js';
import { ACTIVE_STATUSES, APPS } from './pm2.js';

export const KILL_REASON = 'kill switch desde el acceso directo del escritorio';
/** Palabras que hay que escribir para confirmar. */
export const WORDS = Object.freeze({ kill: 'SI', resume: 'REANUDAR', orders: 'OPERAR' });
const RESUME_HINT = 'Para volver a operar: "Reanudar bot" y después "Iniciar bot".';

const findApp = (apps, name) => apps.find((app) => app.name === name) ?? null;
const isActive = (app) => Boolean(app) && ACTIVE_STATUSES.includes(app.status);
const scopeName = (scope) => `${scope.env}/${scope.mode}`;

/**
 * Últimos mensajes importantes (advertencias y errores) de un log de pm2. Las
 * líneas del bot y del panel son JSON de pino, con la fecha de pm2 adelante.
 * @returns {string[]}
 */
export function lastProblems(file, { max = 3, bytes = 64 * 1024 } = {}) {
  let text;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, bytes));
      fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const messages = [];
  for (const line of text.split('\n')) {
    const json = line.indexOf('{');
    if (json === -1) continue;
    try {
      const entry = JSON.parse(line.slice(json));
      if (entry.level >= 40 && typeof entry.msg === 'string') messages.push(entry.msg);
    } catch {
      // no es una línea de pino
    }
  }
  return messages.slice(-max);
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./console.js').createConsoleUi>} deps.ui
 * @param {ReturnType<import('./pm2.js').createPm2>} deps.pm2
 * @param {{ info: Function, warn: Function, error: Function }} deps.journal registro de acciones (lanzador.log)
 * @param {(script: string, args?: string[]) => Promise<{ code: number|null }>} deps.runScript
 * @param {() => Promise<void>} deps.buildPanel compila la interfaz (lanza LauncherError si falla)
 * @param {(url: string) => void} deps.openBrowser
 */
export function createLauncher({
  ui,
  pm2,
  journal,
  runScript,
  buildPanel,
  openBrowser,
  envFile = DEFAULT_ENV_FILE,
  env = process.env,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  buildState = panelBuildState,
  probe = probePanel,
  timeouts = {},
}) {
  const wait = { botStartMs: 90_000, panelStartMs: 20_000, stopMs: 120_000, pollMs: 1_000, ...timeouts };
  const envInfo = () => readEnv({ envFile, env });
  /** Config pública (lista blanca del panel): nunca incluye API keys. Sirve aunque el .env tenga errores. */
  const publicConfig = () => loadPanelConfig({ envFile, env });
  const stateOf = (cfg) => readBotState({
    dbPath: cfg.dbPath, killSwitchFile: cfg.killSwitchFile, scope: cfg.defaultScope, now: now(),
  });

  /** Si ni el bot ni el panel corren: detiene la rotación, y si pm2 quedó vacío, su daemon. */
  async function cleanupIfIdle() {
    let apps = await pm2.list();
    if (isActive(findApp(apps, APPS.bot)) || isActive(findApp(apps, APPS.panel))) return;
    if (findApp(apps, APPS.logs)) {
      await pm2.remove(APPS.logs);
      apps = await pm2.list();
    }
    if (apps.length === 0 && pm2.daemonRunning()) await pm2.kill();
  }

  async function ensureRotator() {
    const logs = findApp(await pm2.list(), APPS.logs);
    if (isActive(logs)) return;
    if (logs) await pm2.remove(APPS.logs);
    await pm2.start(APPS.logs);
  }

  /** Muestra qué impide operar (kill switch, parada guardada) según el estado leído de la base. */
  function showHalt(state) {
    if (state.killSwitch.file) ui.warn(`Kill switch ACTIVO (archivo STOP): ${state.killSwitch.file.reason}`);
    if (state.halt.halted) {
      ui.warn(`Detenido desde ${dateTime(state.halt.haltedAt)} (${state.halt.code}): ${state.halt.reason}`);
    }
  }

  // --- Bot ---------------------------------------------------------------------------

  /**
   * @param {{ unattended?: boolean }} [options] unattended: inicio automático (nadie puede confirmar)
   */
  async function startBot({ unattended = false } = {}) {
    ui.title('Iniciar bot');
    const config = requireBotConfig(envInfo());
    const scope = { env: config.env, mode: config.mode };
    ui.info(describeSetup(config));

    if (!config.dryRun) {
      if (unattended) {
        throw new LauncherError('DRY_RUN=false: el inicio automático nunca arranca el bot en ese modo.', {
          hint: 'Para enviar órdenes, inícialo a mano con "Iniciar bot" (pide confirmación).',
        });
      }
      ui.line();
      ui.warn('DRY_RUN está DESACTIVADO: el bot enviará órdenes de mercado al exchange (testnet o demo, fondos ficticios).');
      ui.warn('Al correr en segundo plano no verás la cuenta regresiva de 5 s del bot para cancelar.');
      const confirmed = await ui.confirm({
        word: WORDS.orders,
        prompt: `Escribe ${WORDS.orders} y presiona Enter para iniciarlo enviando órdenes (cualquier otra cosa cancela): `,
      });
      if (!confirmed) {
        ui.info('Cancelado: el bot no se inició.');
        journal.info({ action: 'start-bot', outcome: 'cancelado' }, 'Inicio del bot cancelado (DRY_RUN=false sin confirmar)');
        return { ok: true, cancelled: true };
      }
    }

    const state = readBotState({ dbPath: config.storage.dbPath, killSwitchFile: config.risk.killSwitchFile, scope, now: now() });
    if (state.killSwitch.active || state.halt.halted) {
      showHalt(state);
      throw new LauncherError(`El bot está detenido en ${scopeName(scope)} y no puede iniciarse.`, { hint: RESUME_HINT });
    }

    const apps = await pm2.list();
    const app = findApp(apps, APPS.bot);
    if (isActive(app)) {
      throw new LauncherError(`El bot ya está corriendo desde el lanzador (${ago(now() - app.since).replace('hace', 'desde hace')}).`, {
        hint: 'Para ver cómo va, usa "Estado del bot" o el panel.',
      });
    }
    if (botLooksAlive(state)) {
      throw new LauncherError(
        `El bot ya está corriendo fuera del lanzador (por ejemplo, con npm start en una terminal): último heartbeat ${ago(state.bot.heartbeatAgeMs)}.`,
        { hint: 'No se inicia otro para no tener dos bots a la vez. Detenlo en esa terminal con Ctrl+C si quieres usar el lanzador.' },
      );
    }
    if (state.state === 'unresponsive') {
      ui.warn(`El último registro dice que el bot corría, pero su último heartbeat fue ${ago(state.bot.heartbeatAgeMs)} (probablemente se cerró de golpe). Se inicia igual.`);
    }

    if (app) await pm2.remove(APPS.bot); // quedó detenido o con errores: se inicia de cero con la config actual
    ui.info('Iniciando el bot en segundo plano…');
    const before = state.bot;
    await pm2.start(APPS.bot);
    await ensureRotator();

    const result = await waitForBot({ config, scope, before });
    if (result.ok) {
      ui.ok(`Bot en marcha en ${scopeName(scope)} (${config.dryRun ? 'dry-run: órdenes simuladas' : 'enviando órdenes al exchange'}).`);
      ui.detail('Síguelo en el panel o con "Estado del bot". Para apagarlo: "Detener bot".');
      journal.info({ action: 'start-bot', outcome: 'ok', scope: scopeName(scope) }, 'Bot iniciado desde el lanzador');
      return { ok: true };
    }
    const reason = result.reason;
    journal.warn({ action: 'start-bot', outcome: result.outcome, reason }, 'El bot no arrancó desde el lanzador');
    if (result.outcome === 'retrying') {
      throw new LauncherError(`El bot se cayó al arrancar: ${reason}`, {
        hint: 'pm2 lo está reintentando con espera creciente. Revisa "Estado del bot" en un rato.',
      });
    }
    if (result.outcome === 'timeout') {
      throw new LauncherError(`El bot sigue arrancando después de ${wait.botStartMs / 1000} s.`, {
        hint: 'Puede estar esperando a la red o descargando velas. Revisa "Estado del bot" en un rato.',
      });
    }
    throw new LauncherError(`El bot no arrancó: ${reason}`, {
      hint: result.exitCode === EXIT_CODES.NEEDS_ATTENTION
        ? 'Se detuvo a propósito (código 3) y no se reinicia solo: resuelve el motivo y vuelve a iniciarlo.'
        : 'Revisa el motivo y vuelve a intentarlo.',
    });
  }

  /** Espera a que el bot quede en marcha (según la base) o a que pm2 diga que no arrancó. */
  async function waitForBot({ config, scope, before }) {
    const deadline = now() + wait.botStartMs;
    for (;;) {
      await sleep(wait.pollMs);
      const app = findApp(await pm2.list(), APPS.bot);
      const state = readBotState({ dbPath: config.storage.dbPath, killSwitchFile: config.risk.killSwitchFile, scope, now: now() });
      // ¿La fila es de ESTE arranque? (el bot la escribe desde el paso 3)
      const fresh = state.bot && (state.bot.startedAt !== before?.startedAt || state.bot.stoppedAt !== before?.stoppedAt);
      const reason = () => (fresh && state.bot.stopReason
        ? state.bot.stopReason.replace(/^no arrancó: /, '')
        : lastProblems(app?.outLog).join(' / ') || 'sin detalle en los logs');
      if (app?.status === 'online' && fresh && state.state === 'running' && state.bot.pid === app.pid) return { ok: true };
      if (!app || app.status === 'stopped' || app.status === 'errored') {
        return { ok: false, outcome: 'stopped', reason: reason(), exitCode: app?.exitCode ?? null };
      }
      if (app.status === 'waiting restart' || app.restarts > 0) return { ok: false, outcome: 'retrying', reason: reason() };
      if (now() >= deadline) return { ok: false, outcome: 'timeout' };
    }
  }

  async function stopBot() {
    ui.title('Detener bot');
    const app = findApp(await pm2.list(), APPS.bot);
    if (!isActive(app)) {
      if (app) await pm2.remove(APPS.bot); // detenido o con errores: se quita de la lista
      const state = stateOf(publicConfig());
      if (botLooksAlive(state)) {
        throw new LauncherError('El bot está corriendo fuera del lanzador (en una terminal): desde aquí no se puede detener ordenadamente.', {
          hint: 'Detenlo en esa terminal con Ctrl+C, o usa "Kill switch".',
        });
      }
      ui.ok('El bot no está corriendo: no hay nada que detener.');
      await cleanupIfIdle();
      return { ok: true };
    }
    ui.info('Apagado ordenado (igual que Ctrl+C): termina la operación en curso, cancela las órdenes pendientes y NO vende las posiciones abiertas…');
    await pm2.remove(APPS.bot); // pm2 manda "shutdown" y espera a que termine
    const { state, bot } = stateOf(publicConfig());
    if (state !== 'stopped') {
      ui.warn('El proceso del bot terminó, pero no quedó registrado un apagado ordenado: revisa el log del bot.');
    } else if (bot.exitCode === EXIT_CODES.OK) {
      ui.ok('Bot detenido (apagado ordenado).');
    } else {
      ui.ok(`Bot detenido: ${bot.stopReason} (${describeExitCode(bot.exitCode)}).`);
    }
    journal.info({ action: 'stop-bot', outcome: 'ok' }, 'Bot detenido desde el lanzador');
    await cleanupIfIdle();
    return { ok: true };
  }

  // --- Panel -------------------------------------------------------------------------

  async function startPanel({ open = true } = {}) {
    ui.title('Iniciar panel');
    const cfg = publicConfig();
    for (const warning of cfg.warnings) ui.warn(`Config del panel: ${warning}`);
    if (!cfg.envFileFound) ui.warn('No se encontró .env: el panel usa los valores por defecto.');
    const url = `http://${PANEL_HOST}:${cfg.port}`;
    const app = findApp(await pm2.list(), APPS.panel);
    const found = await probe(cfg.port);
    const show = () => { if (open) { ui.detail('Abriendo el navegador…'); openBrowser(url); } };

    if (found === 'ours') {
      ui.ok(isActive(app) ? `El panel ya estaba corriendo: ${url}` : `El panel ya está corriendo fuera del lanzador (en una terminal): ${url}`);
      show();
      return { ok: true };
    }
    if (found === 'other') {
      throw new LauncherError(`El puerto ${cfg.port} está ocupado por otro programa.`, {
        hint: 'Cierra ese programa, o cambia PANEL_PORT en el .env (el lanzador no cambia la configuración).',
      });
    }

    const build = buildState();
    if (!build.built || build.outdated) {
      ui.info(build.built
        ? 'La interfaz cambió desde la última compilación: compilando…'
        : 'Falta compilar la interfaz del panel: compilando (tarda unos segundos)…');
      await buildPanel();
      ui.ok('Interfaz compilada.');
    }

    if (app) await pm2.remove(APPS.panel);
    ui.info('Iniciando el panel en segundo plano…');
    await pm2.start(APPS.panel);
    await ensureRotator();

    const deadline = now() + wait.panelStartMs;
    for (;;) {
      await sleep(wait.pollMs);
      if (await probe(cfg.port) === 'ours') break;
      const current = findApp(await pm2.list(), APPS.panel);
      if (!isActive(current) || current.restarts > 0 || now() >= deadline) {
        const problems = lastProblems(current?.outLog).join(' / ');
        journal.warn({ action: 'start-panel', outcome: 'error', reason: problems }, 'El panel no arrancó desde el lanzador');
        throw new LauncherError(`El panel no arrancó${problems ? `: ${problems}` : '.'}`, {
          hint: `Revisa ${current?.outLog ?? 'los logs de pm2'}.`,
        });
      }
    }
    ui.ok(`Panel en marcha: ${url} (solo lectura; única acción: kill switch).`);
    journal.info({ action: 'start-panel', outcome: 'ok', url }, 'Panel iniciado desde el lanzador');
    show();
    return { ok: true };
  }

  async function stopPanel() {
    ui.title('Detener panel');
    const app = findApp(await pm2.list(), APPS.panel);
    if (isActive(app)) {
      await pm2.remove(APPS.panel);
      ui.ok('Panel detenido (el bot no se ve afectado).');
      journal.info({ action: 'stop-panel', outcome: 'ok' }, 'Panel detenido desde el lanzador');
      await cleanupIfIdle();
      return { ok: true };
    }
    if (app) await pm2.remove(APPS.panel);
    const cfg = publicConfig();
    if (await probe(cfg.port) === 'ours') {
      throw new LauncherError('El panel está corriendo fuera del lanzador (en una terminal).', { hint: 'Ciérralo en esa terminal con Ctrl+C.' });
    }
    ui.ok('El panel no está corriendo: no hay nada que detener.');
    await cleanupIfIdle();
    return { ok: true };
  }

  // --- Estado ------------------------------------------------------------------------

  function appLine(label, app, extra = '') {
    const text = (() => {
      if (!app) return 'detenido';
      switch (app.status) {
        case 'online': return `corriendo (${ago(now() - app.since).replace('hace', 'desde hace')}) · reinicios: ${app.restarts}${extra}`;
        case 'launching': return 'arrancando';
        case 'waiting restart': return `se cayó; pm2 lo reinicia con espera creciente (reinicios: ${app.restarts})`;
        case 'stopping': return 'deteniéndose';
        case 'errored': return `con errores: pm2 dejó de reiniciarlo tras ${app.restarts} reinicios seguidos`;
        case 'stopped': return app.exitCode === EXIT_CODES.OK || app.exitCode === null ? 'detenido' : `detenido: ${describeExitCode(app.exitCode)}`;
        default: return app.status;
      }
    })();
    return `${label.padEnd(8)}${text}`;
  }

  async function status() {
    ui.title(`Estado del bot · ${dateTime(now())}`);
    const cfg = publicConfig();
    const apps = await pm2.list();
    const bot = findApp(apps, APPS.bot);
    const panel = findApp(apps, APPS.panel);

    ui.section('Procesos del lanzador (pm2)');
    ui.info(appLine('Bot', bot));
    ui.info(appLine('Panel', panel, isActive(panel) ? ` · http://${PANEL_HOST}:${cfg.port}` : ''));
    ui.info(appLine('Logs', findApp(apps, APPS.logs), ' · rotación cada 5 min'));

    ui.section('Configuración (.env)');
    let configOk = true;
    try {
      ui.info(describeSetup(requireBotConfig(envInfo())));
    } catch (err) {
      if (!(err instanceof LauncherError)) throw err;
      configOk = false;
      ui.error(err.message);
      if (err.hint) ui.detail(err.hint);
    }

    ui.section(`Bot en ${scopeName(cfg.defaultScope)} (según la base de datos)`);
    const state = stateOf(cfg);
    if (!state.available) ui.info(state.database.message);
    const b = state.bot;
    switch (state.state) {
      case 'running':
        ui.ok(`En marcha · último heartbeat ${ago(b.heartbeatAgeMs)}${isActive(bot) ? '' : ' · corre FUERA del lanzador (en una terminal)'}`);
        if (state.data.stale) ui.warn(`Datos desactualizados: ${state.data.reason}`);
        break;
      case 'starting': ui.info('Arrancando…'); break;
      case 'stopping': ui.info('Apagándose…'); break;
      case 'unresponsive':
        ui.warn(`Sin responder: el último heartbeat fue ${ago(b.heartbeatAgeMs)} (se cerró de golpe o está colgado).`);
        break;
      case 'stopped':
        if (b.exitCode === EXIT_CODES.NEEDS_ATTENTION) {
          ui.warn(`Detenido a propósito (${dateTime(b.stoppedAt)}): ${b.stopReason}`);
          ui.detail('Código 3: no se reinicia solo. Revisa el motivo antes de volver a iniciarlo.');
        } else if (b.exitCode === EXIT_CODES.OK) {
          ui.info(`Detenido: apagado ordenado (${dateTime(b.stoppedAt)}).`);
        } else {
          ui.warn(`Detenido por una caída (${dateTime(b.stoppedAt)}): ${b.stopReason} (${describeExitCode(b.exitCode)}).`);
        }
        break;
      default: ui.info('Nunca corrió en este entorno y modo.');
    }
    showHalt(state);
    if (state.killSwitch.active || state.halt.halted) ui.detail(RESUME_HINT);

    ui.section('Riesgo (npm run status)');
    if (configOk) await runScript('scripts/status.js');
    else ui.info('No disponible hasta corregir el .env.');
    return { ok: true, keepOpen: true };
  }

  // --- Kill switch y reanudar --------------------------------------------------------

  async function kill() {
    ui.title('Kill switch');
    ui.info('Detiene el bot en TODOS los entornos y modos (testnet/demo × dry-run/exchange):');
    ui.info('  - si está corriendo, cancela las órdenes pendientes y se apaga en ~1 segundo;');
    ui.info('  - NO vende ni cierra las posiciones abiertas;');
    ui.info('  - no podrá volver a operar hasta que uses "Reanudar bot" (pide confirmación).');
    const confirmed = await ui.confirm({
      word: WORDS.kill,
      prompt: `Escribe ${WORDS.kill} y presiona Enter para activarlo (cualquier otra cosa cancela): `,
    });
    if (!confirmed) {
      ui.info('Cancelado: no se activó el kill switch.');
      journal.info({ action: 'kill', outcome: 'cancelado' }, 'Kill switch cancelado en el lanzador');
      return { ok: true, cancelled: true };
    }
    ui.line();
    // ¿Corría ANTES de activarlo? (después podría haberse detenido ya)
    const cfg = publicConfig();
    const running = isActive(findApp(await pm2.list(), APPS.bot)) || botLooksAlive(stateOf(cfg));
    const { code } = await runScript('scripts/kill.js', [KILL_REASON]); // el mismo mecanismo que npm run kill
    if (code !== 0) throw new LauncherError('El comando del kill switch falló (el detalle está arriba).');
    journal.warn({ action: 'kill', outcome: 'ok' }, 'Kill switch activado desde el lanzador');

    if (!running) {
      ui.ok('Kill switch activado. El bot no estaba corriendo: no podrá iniciarse hasta reanudarlo.');
      return { ok: true };
    }
    ui.info('Esperando a que el bot se detenga…');
    const deadline = now() + wait.stopMs;
    for (;;) {
      await sleep(wait.pollMs);
      const app = findApp(await pm2.list(), APPS.bot);
      const state = stateOf(cfg);
      if (!isActive(app) && !botLooksAlive(state)) {
        ui.ok(`Bot detenido${state.bot?.stopReason ? `: ${state.bot.stopReason}` : ''}. No se reinicia solo.`);
        await cleanupIfIdle();
        return { ok: true };
      }
      if (now() >= deadline) {
        throw new LauncherError(`El bot no se detuvo en ${wait.stopMs / 1000} s.`, {
          hint: 'El kill switch sigue activo. Revisa "Estado del bot"; si no se detiene, ciérralo desde el Administrador de tareas.',
        });
      }
    }
  }

  async function resume() {
    ui.title('Reanudar bot');
    const config = requireBotConfig(envInfo()); // resume necesita la config completa (como npm run resume)
    const scope = { env: config.env, mode: config.mode };
    const state = readBotState({ dbPath: config.storage.dbPath, killSwitchFile: config.risk.killSwitchFile, scope, now: now() });
    const others = haltedScopes(config.storage.dbPath).filter((s) => s.env !== scope.env || s.mode !== scope.mode);

    if (!state.killSwitch.file && !state.halt.halted) {
      ui.ok(`No hay nada que reanudar: el bot no está detenido en ${scopeName(scope)}.`);
      if (others.length) ui.detail(`Siguen detenidos otros ámbitos: ${others.map(scopeName).join(', ')}.`);
      return { ok: true };
    }
    if (!state.available) ui.warn(state.database.message);
    showHalt(state);
    ui.line();
    ui.info(`Se reanuda SOLO ${scopeName(scope)} (el entorno y modo del .env): se borra la parada guardada y el archivo STOP.`);
    if (others.length) ui.info(`Seguirán detenidos: ${others.map(scopeName).join(', ')}.`);
    ui.info('Antes de reanudar, asegúrate de haber revisado por qué se detuvo.');
    const confirmed = await ui.confirm({
      word: WORDS.resume,
      prompt: `Escribe ${WORDS.resume} y presiona Enter para confirmar (cualquier otra cosa cancela): `,
    });
    if (!confirmed) {
      ui.info('Cancelado: el bot sigue detenido.');
      journal.info({ action: 'resume', outcome: 'cancelado' }, 'Reanudación cancelada en el lanzador');
      return { ok: true, cancelled: true };
    }
    ui.line();
    const { code } = await runScript('scripts/resume.js'); // el mismo mecanismo que npm run resume
    if (code !== 0) {
      journal.warn({ action: 'resume', outcome: 'rechazado' }, 'npm run resume no reanudó');
      throw new LauncherError('No se reanudó (el motivo está arriba).');
    }
    journal.warn({ action: 'resume', outcome: 'ok', scope: scopeName(scope) }, 'Reanudado desde el lanzador');
    ui.ok('Listo. Para volver a operar, usa "Iniciar bot".');
    return { ok: true };
  }

  return { startBot, stopBot, startPanel, stopPanel, status, kill, resume, cleanupIfIdle };
}
