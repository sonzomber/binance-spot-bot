/**
 * Tema claro/oscuro. "system" sigue la preferencia del sistema operativo; la
 * elección manual se recuerda en este navegador (localStorage). Si el
 * almacenamiento no está disponible, todo sigue funcionando con el del sistema.
 * (public/theme-init.js aplica lo mismo antes de pintar, para evitar un destello.)
 */
export const THEME_KEY = 'panel-theme';
export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const THEME_LABELS = Object.freeze({ system: 'Tema del sistema', light: 'Tema claro', dark: 'Tema oscuro' });

const safeStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadTheme(storage = safeStorage()) {
  try {
    const value = storage?.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(theme, storage = safeStorage()) {
  try {
    if (theme === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, theme);
  } catch {
    // sin almacenamiento: la elección dura hasta recargar
  }
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export const nextTheme = (theme) => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
