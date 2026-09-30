/**
 * Procesos que el lanzador corre con pm2 (launcher/lib/pm2.js hace
 * `pm2 start launcher/ecosystem.config.cjs --only <nombre>`).
 *
 *   binance-bot    el bot (launcher/bot-process.js → src/index.js)
 *   binance-panel  el panel (launcher/panel-process.js → scripts/panel.js)
 *   binance-logs   la rotación de logs (launcher/log-rotator.js)
 *
 * Reinicio automático:
 *   - Si un proceso se cae (código 1), pm2 lo reinicia con espera creciente:
 *     2 s, 3 s, 4,5 s… hasta 15 s (el tope de pm2). La espera vuelve a 2 s cuando
 *     el proceso lleva 30 s en marcha.
 *   - Si se reinicia 10 veces seguidas sin durar 1 minuto, pm2 deja de
 *     intentarlo ("con errores"). pm2 solo cuenta estos intentos en los primeros
 *     10 minutos (10 × 1 min) desde que se inició.
 *   - El bot NO se reinicia con código 3 (detenido a propósito: kill switch,
 *     parada de riesgo, IP bloqueada, arranque rechazado) ni con 0 (apagado pedido).
 *
 * Apagado: pm2 manda el mensaje "shutdown" (en Windows no puede mandar Ctrl+C
 * sin matar el proceso) y cada proceso lo convierte en su apagado de Ctrl+C
 * (lib/shutdown-message.js). pm2 espera hasta `kill_timeout` antes de forzarlo.
 *
 * CommonJS (.cjs) porque pm2 carga este archivo con require().
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// El lanzador pasa la carpeta de logs (junto al LOG_FILE del .env). Por defecto, data/logs/pm2.
const LOG_DIR = process.env.BOT_LAUNCHER_LOG_DIR || path.join(ROOT, 'data', 'logs', 'pm2');

/** Código de salida del bot cuando se detiene a propósito (src/lib/exit-codes.js). */
const EXIT_NEEDS_ATTENTION = 3;

/**
 * El vigilante del bot fuerza la salida a los SHUTDOWN_TIMEOUT_SECONDS + 30 s
 * (máximo 600 + 30). pm2 espera un poco más: solo es un respaldo.
 */
const BOT_KILL_TIMEOUT_MS = 660_000;

const common = {
  cwd: ROOT,
  exec_mode: 'fork',
  instances: 1,
  watch: false,
  autorestart: true,
  exp_backoff_restart_delay: 2_000,
  min_uptime: 60_000,
  max_restarts: 10,
  shutdown_with_message: true,
  windowsHide: true,
  pmx: false, // sin el agente de métricas de pm2 dentro de los procesos
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
  // Sin esto, pm2 agrega el id del proceso al nombre (bot.out-0.log) y cambia en cada
  // inicio: la rotación y los mensajes del lanzador necesitan nombres fijos.
  merge_logs: true,
};

const logs = (name) => ({
  out_file: path.join(LOG_DIR, `${name}.out.log`),
  error_file: path.join(LOG_DIR, `${name}.err.log`),
});

module.exports = {
  apps: [
    {
      ...common,
      name: 'binance-bot',
      script: path.join(ROOT, 'launcher', 'bot-process.js'),
      kill_timeout: BOT_KILL_TIMEOUT_MS,
      stop_exit_codes: [0, EXIT_NEEDS_ATTENTION],
      ...logs('bot'),
    },
    {
      ...common,
      name: 'binance-panel',
      script: path.join(ROOT, 'launcher', 'panel-process.js'),
      kill_timeout: 10_000,
      stop_exit_codes: [0],
      ...logs('panel'),
    },
    {
      ...common,
      name: 'binance-logs',
      script: path.join(ROOT, 'launcher', 'log-rotator.js'),
      kill_timeout: 5_000,
      stop_exit_codes: [0],
      ...logs('rotacion'),
    },
  ],
};
