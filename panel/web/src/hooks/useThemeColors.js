/**
 * Colores del tema actual (variables CSS), para lo que se dibuja en <canvas>
 * (el gráfico), que no puede usar CSS. Se actualizan al cambiar el tema del
 * panel o el del sistema.
 */
import { useEffect, useState } from 'react';

const VARIABLES = {
  background: '--surface',
  text: '--text-muted',
  grid: '--border',
  up: '--ok',
  down: '--danger',
  fast: '--accent',
  slow: '--warn',
  buy: '--ok',
  sell: '--danger',
};

function read() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(VARIABLES).map(([name, variable]) => [name, style.getPropertyValue(variable).trim()]));
}

export function useThemeColors() {
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const update = () => setColors(read());
    const observer = new MutationObserver(update); // data-theme en <html> (botón del tema)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)'); // tema del sistema
    media.addEventListener('change', update);
    // Por si el tema cambió entre la primera lectura (al montar) y este momento.
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);
  return colors;
}
