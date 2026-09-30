/**
 * El panel cuando lo corre el lanzador (proceso "binance-panel" de pm2).
 *
 * Es el mismo panel que `npm run panel` (scripts/panel.js, sin compilar: el
 * lanzador compila la interfaz antes si hace falta). El apagado que pide pm2 se
 * convierte en el mismo cierre de Ctrl+C.
 */
import { forwardShutdownMessage } from './lib/shutdown-message.js';

forwardShutdownMessage();
await import('../scripts/panel.js');
