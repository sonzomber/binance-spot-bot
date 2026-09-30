/**
 * El lanzador no opera ni se conecta a Binance: ninguno de sus módulos (ni lo que
 * importan) carga ccxt, el WebSocket, el cliente del exchange, la ejecución, el
 * feed ni el bot. El bot corre en su PROPIO proceso (bot-process.js → src/index.js).
 *
 * Tampoco importa pm2 como librería: lo usa por su línea de comandos (pm2 es
 * AGPL-3.0 y así queda como programa externo).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { importGraph } from '../support/import-graph.js';

const FORBIDDEN_PACKAGES = ['ccxt', 'ws', 'pm2'];
const FORBIDDEN_FILES = ['src/lib/exchange.js', 'src/execution/', 'src/data/', 'src/app.js', 'src/bot.js', 'src/index.js'];

describe('el lanzador está aislado del trading y usa pm2 solo como programa externo', () => {
  for (const entry of ['launcher/cli.js', 'launcher/log-rotator.js', 'launcher/ecosystem.config.cjs']) {
    it(`${entry} no importa pm2, ccxt, ws, el exchange, la ejecución, el feed ni el bot`, () => {
      const graph = importGraph(path.join(PROJECT_ROOT, entry));
      expect(graph.packages.filter((p) => FORBIDDEN_PACKAGES.includes(p))).toEqual([]);
      expect(graph.files.filter((f) => FORBIDDEN_FILES.some((bad) => f.startsWith(bad)))).toEqual([]);
    });
  }

  it('el recorrido sigue el import dinámico de cli.js (control de la propia prueba)', () => {
    const graph = importGraph(path.join(PROJECT_ROOT, 'launcher/cli.js'));
    expect(graph.files).toContain('launcher/lib/main.js');
    expect(graph.files).toContain('launcher/lib/actions.js');
    expect(graph.files.length).toBeGreaterThan(15);
  });

  it('solo bot-process.js carga el bot, y lo hace en su propio proceso (el de pm2)', () => {
    const graph = importGraph(path.join(PROJECT_ROOT, 'launcher/bot-process.js'));
    expect(graph.files).toContain('src/index.js');
    expect(graph.packages).toContain('ccxt'); // control: el recorrido sí detecta lo prohibido
  });
});
