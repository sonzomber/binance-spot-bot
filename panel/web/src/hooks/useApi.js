/**
 * Pide datos a la API y los vuelve a pedir cuando el bot guarda algo (evento
 * "db") o cada `refreshMs`.
 *
 * Los datos se atan a la URL exacta que los produjo: al cambiar de ámbito
 * (p. ej. de testnet a demo) NO se muestran los datos anteriores mientras
 * llegan los nuevos. Así nunca se ven mezclados dos entornos.
 */
import { useEffect, useState } from 'react';
import { buildUrl, getJson } from '../lib/api.js';
import { useLive } from './live.jsx';

/**
 * @param {string|null} path null = no pedir nada
 * @param {object} [params]
 * @param {{ refreshMs?: number, followDb?: boolean }} [options]
 *        followDb: false para datos que no salen de SQLite (p. ej. los logs, que llegan por SSE)
 * @returns {{ data: any, error: import('../lib/api.js').ApiError|null, loading: boolean, reload: () => void }}
 */
export function useApi(path, params = {}, { refreshMs, followDb = true } = {}) {
  const live = useLive();
  const dbTick = followDb ? live.dbTick : 0;
  const url = path ? buildUrl(path, params) : null;
  const [state, setState] = useState({ url: null, data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!refreshMs || !url) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, url]);

  useEffect(() => {
    if (!url) return undefined;
    const controller = new AbortController();
    getJson(url, {}, { signal: controller.signal })
      .then((data) => setState({ url, data, error: null }))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        // Si ya había datos de ESTA url, se conservan y se muestra el error aparte.
        setState((prev) => ({ url, data: prev.url === url ? prev.data : null, error }));
      });
    return () => controller.abort();
  }, [url, dbTick, tick]);

  return { ...currentResult(state, url), reload: () => setTick((t) => t + 1) };
}

/**
 * Lo que se muestra: los datos SOLO si son de la url pedida ahora. Si el
 * ámbito cambió y aún no llegó la respuesta nueva, no hay datos (cargando).
 */
export function currentResult(state, url) {
  const current = state.url === url;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: Boolean(url) && !current,
  };
}
