// Tema elegido por el usuario (claro u oscuro); sin elección, sigue al sistema.
// Se ejecuta en el <head>, antes de pintar, para evitar un destello del tema equivocado.
try {
  var theme = window.localStorage.getItem('panel-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) {
  // sin acceso al almacenamiento (modo privado, bloqueado): se sigue al sistema
}
