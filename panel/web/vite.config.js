/**
 * Compilación de la interfaz del panel (React) a panel/web/dist.
 *
 * No se usa el servidor de desarrollo de Vite: el panel se sirve SIEMPRE desde
 * su servidor Express (127.0.0.1, mismas cabeceras de seguridad, CSP estricta).
 * Para desarrollar, `npm run panel:dev` recompila al guardar y basta con recargar.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Nada incrustado como data: URI: todo son archivos del propio panel (CSP 'self').
    assetsInlineLimit: 0,
  },
});
