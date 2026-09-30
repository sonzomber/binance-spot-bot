/**
 * El panel no puede conectarse a Binance ni operar: ninguno de sus módulos
 * (ni lo que importan, recursivamente) carga ccxt, el WebSocket, el cliente
 * del exchange, la ejecución de órdenes ni el feed de datos.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { importGraph } from '../support/import-graph.js';

const FORBIDDEN_PACKAGES = ['ccxt', 'ws'];
const FORBIDDEN_FILES = ['src/lib/exchange.js', 'src/execution/', 'src/data/', 'src/app.js', 'src/bot.js'];

describe('el panel está aislado de la red de Binance y de la ejecución', () => {
  for (const entry of ['scripts/panel.js', 'panel/server/index.js']) {
    it(`${entry} no importa ccxt, ws, el cliente del exchange, la ejecución ni el feed`, () => {
      const graph = importGraph(path.join(PROJECT_ROOT, entry));
      expect(graph.files.length).toBeGreaterThan(10); // el recorrido funciona
      expect(graph.packages.filter((p) => FORBIDDEN_PACKAGES.includes(p))).toEqual([]);
      expect(graph.files.filter((f) => FORBIDDEN_FILES.some((bad) => f.startsWith(bad)))).toEqual([]);
    });
  }

  it('el recorrido detecta un import prohibido (control de la propia prueba)', () => {
    const graph = importGraph(path.join(PROJECT_ROOT, 'src/app.js'));
    expect(graph.packages).toContain('ccxt');
    expect(graph.files).toContain('src/lib/exchange.js');
  });
});
