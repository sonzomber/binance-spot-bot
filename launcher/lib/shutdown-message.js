/**
 * Apagado pedido por pm2 → el mismo apagado que Ctrl+C.
 *
 * En Windows no se le puede mandar Ctrl+C a otro proceso: pm2 lo terminaría de
 * golpe (sin cancelar órdenes pendientes ni guardar el estado). Con la opción
 * `shutdown_with_message`, pm2 manda en cambio el mensaje "shutdown" por su canal
 * IPC. Aquí se convierte en el evento SIGINT, así corre exactamente el mismo
 * manejador de Ctrl+C que instala el proceso (src/lifecycle.js en el bot).
 */

/**
 * @param {{ proc?: NodeJS.Process, log?: (message: string) => void }} [options]
 * @returns {boolean} false si el proceso no tiene canal IPC (no lo corre pm2)
 */
export function forwardShutdownMessage({ proc = process, log = (message) => console.log(message) } = {}) {
  if (typeof proc.send !== 'function') return false;
  proc.on('message', (message) => {
    if (message !== 'shutdown') return;
    if (proc.listenerCount('SIGINT') > 0) {
      log('Pedido de apagado del lanzador (pm2): se hace el mismo apagado ordenado que con Ctrl+C.');
      proc.emit('SIGINT', 'SIGINT');
    } else {
      // No hay un apagado ordenado que hacer: la rotación de logs, o un proceso que
      // todavía no instaló su manejador de Ctrl+C.
      log('Pedido de apagado del lanzador (pm2): no hay un apagado ordenado pendiente; sale de inmediato.');
      proc.exit(0);
    }
  });
  // El canal no mantiene vivo el proceso por sí solo: cuando el bot termina, el proceso sale.
  proc.channel?.unref?.();
  return true;
}
