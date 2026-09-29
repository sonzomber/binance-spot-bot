/**
 * Diálogo modal con el <dialog> nativo: atrapa el foco, se cierra con Esc y
 * bloquea el resto de la página mientras está abierto.
 */
import { useEffect, useRef } from 'react';

export function Dialog({ open, onClose, title, children, footer, labelledBy = 'dialog-title' }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={labelledBy}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault(); // Esc: cierra por onClose (un solo camino)
        onClose();
      }}
    >
      <h2 id={labelledBy} className="dialog-title">{title}</h2>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </dialog>
  );
}
