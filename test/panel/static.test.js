/**
 * El servidor sirve SOLO la interfaz compilada (panel/web/dist), con el token
 * dentro del HTML. Nunca los fuentes, archivos ocultos ni nada fuera de dist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request, setupPanel } from './support.js';

let ctx;
let web;
beforeEach(async () => {
  ctx = await setupPanel();
  web = path.join(ctx.tmp.dir, 'web');
  fs.mkdirSync(path.join(web, 'dist', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(web, 'src'), { recursive: true });
  fs.writeFileSync(path.join(web, 'dist', 'index.html'), '<!doctype html>\n<html lang="es">\n  <head>\n    <script type="module" src="/assets/app.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n');
  fs.writeFileSync(path.join(web, 'dist', 'assets', 'app.js'), 'console.log("interfaz");\n');
  fs.writeFileSync(path.join(web, 'dist', 'theme-init.js'), '// tema\n');
  fs.writeFileSync(path.join(web, 'dist', '.secreto'), 'NO-DEBE-SERVIRSE');
  fs.writeFileSync(path.join(web, 'src', 'main.jsx'), 'FUENTE-NO-DEBE-SERVIRSE');
});
afterEach(() => ctx.cleanup());

describe('interfaz compilada', () => {
  it('"/" sirve el index compilado con el token del panel dentro, sin caché', async () => {
    const res = await ctx.get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`<head>\n    <meta name="panel-token" content="${ctx.panel.token}">`);
    expect(res.text).toContain('<script type="module" src="/assets/app.js">');
  });

  it('los archivos de dist se sirven con su tipo, nosniff y la CSP', async () => {
    const js = await ctx.get('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.headers['content-security-policy']).toMatch(/script-src 'self';/);
    expect(js.text).not.toContain(ctx.panel.token); // el token solo va en el HTML
    expect((await ctx.get('/theme-init.js')).text).toBe('// tema\n');
  });

  it('rutas de la interfaz (p. ej. al recargar) → el index; nunca fuentes, ocultos ni archivos del proyecto', async () => {
    for (const url of ['/backtests', '/src/main.jsx', '/.secreto', '/../package.json', '/%2e%2e/package.json', '/../../.env']) {
      const res = await request(ctx.port, { path: url });
      expect(res.text, url).not.toMatch(/NO-DEBE-SERVIRSE|"binance-spot-bot"|BINANCE_API/);
      if (res.status === 200) expect(res.text, url).toContain('<div id="root">');
    }
  });

  it('sin interfaz compilada: una página que explica cómo compilarla (también con token)', async () => {
    fs.rmSync(path.join(web, 'dist'), { recursive: true });
    const res = await ctx.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/la interfaz no está compilada/);
    expect(res.text).toMatch(/npm run panel/);
    expect(res.text).toContain('name="panel-token"');
  });
});
