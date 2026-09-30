/**
 * El bot cuando lo corre el lanzador (proceso "binance-bot" de pm2).
 *
 * Es el mismo bot que `npm start` (src/index.js), con una sola diferencia: pm2
 * pide el apagado con un mensaje (en Windows no puede mandar Ctrl+C sin matar el
 * proceso) y aquí se convierte en el mismo apagado ordenado de Ctrl+C.
 */
import { forwardShutdownMessage } from './lib/shutdown-message.js';

forwardShutdownMessage();
await import('../src/index.js');
