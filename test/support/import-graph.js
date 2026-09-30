/**
 * Recorre los imports de un archivo (y de lo que importa, recursivamente) para
 * verificar qué módulos puede llegar a cargar. Lo usan las pruebas de
 * aislamiento del panel y del lanzador.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/config/index.js';

/**
 * Todos los archivos del proyecto alcanzables por import desde `entry`, y los paquetes externos.
 * @returns {{ files: string[], packages: string[] }} files: rutas relativas al proyecto, con "/"
 */
export function importGraph(entry) {
  const files = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    // import x from '…' · export … from '…' · import '…' (solo efectos) · import('…') · require('…')
    const specifiers = [...source.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gm)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    for (const spec of specifiers) {
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
      else if (!spec.startsWith('node:')) packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => path.relative(PROJECT_ROOT, f).split(path.sep).join('/')), packages: [...packages] };
}
