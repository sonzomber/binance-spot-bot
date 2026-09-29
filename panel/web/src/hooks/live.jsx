/**
 * Conexión en vivo con el servidor del panel (Server-Sent Events).
 *
 *   - "db": el bot guardó algo → `dbTick` aumenta y cada sección vuelve a pedir sus datos.
 *   - "killswitch": cambió el archivo STOP.
 *   - "logs": líneas nuevas del log (las secciones se suscriben).
 *   - "hello": al (re)conectar. Si trae otro instanceId, el panel se reinició y el
 *     token de esta página ya no sirve: hay que recargar.
 * EventSource se reconecta solo si la conexión se corta.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const LiveContext = createContext(null);

export function LiveProvider({ instanceId, children }) {
  const [connection, setConnection] = useState('connecting');
  const [dbTick, setDbTick] = useState(0);
  const [killSwitch, setKillSwitch] = useState(null);
  const [restarted, setRestarted] = useState(false);
  const logListeners = useRef(new Set());

  useEffect(() => {
    const source = new EventSource('/api/live');
    const read = (event) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    };
    source.addEventListener('hello', (event) => {
      const data = read(event);
      setConnection('open');
      if (data?.killSwitch) setKillSwitch(data.killSwitch);
      if (instanceId && data?.instanceId && data.instanceId !== instanceId) setRestarted(true);
      setDbTick((t) => t + 1); // al reconectar, puede haberse perdido algún cambio
    });
    source.addEventListener('db', () => setDbTick((t) => t + 1));
    source.addEventListener('killswitch', (event) => {
      const data = read(event);
      if (data) setKillSwitch(data);
      setDbTick((t) => t + 1);
    });
    source.addEventListener('logs', (event) => {
      const lines = read(event)?.lines ?? [];
      for (const listener of logListeners.current) listener(lines);
    });
    source.onerror = () => setConnection('reconnecting');
    return () => source.close();
  }, [instanceId]);

  /** Suscripción a las líneas nuevas del log. @returns {() => void} para desuscribirse */
  const subscribeLogs = useCallback((listener) => {
    logListeners.current.add(listener);
    return () => logListeners.current.delete(listener);
  }, []);

  const value = useMemo(
    () => ({ connection, dbTick, killSwitch, setKillSwitch, restarted, subscribeLogs }),
    [connection, dbTick, killSwitch, restarted, subscribeLogs],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  const value = useContext(LiveContext);
  if (!value) throw new Error('useLive debe usarse dentro de <LiveProvider>');
  return value;
}
