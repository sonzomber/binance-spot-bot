/**
 * La única acción del panel: activar el kill switch, con confirmación.
 *
 * Usa el mismo mecanismo que `npm run kill` (lo ejecuta el servidor). El
 * diálogo explica qué hace y qué NO hace, y que reanudar solo se puede desde
 * la terminal. Si el panel se reinició, el token de esta página ya no sirve:
 * se pide recargar en lugar de fallar al confirmar.
 */
import { useState } from 'react';
import { activateKillSwitch } from '../lib/api.js';
import { dateTime } from '../lib/format.js';
import { Dialog } from './Dialog.jsx';
import { Icon } from './Icon.jsx';
import { Cmd } from './ui.jsx';

const MAX_REASON = 200;

export function KillSwitchButton({ killSwitch, restarted, onActivated }) {
  const [open, setOpen] = useState(false);
  const active = Boolean(killSwitch?.active);

  return (
    <>
      <button
        type="button"
        className={`button button-danger${active ? ' is-active' : ''}`}
        onClick={() => setOpen(true)}
        title={active ? `Kill switch activo: ${killSwitch.reason ?? ''}` : 'Detener el bot en todos los entornos'}
      >
        <Icon name="stop" />
        <span>{active ? 'Kill switch activo' : 'Kill switch'}</span>
      </button>
      {open ? (
        <KillSwitchDialog
          active={active}
          killSwitch={killSwitch}
          restarted={restarted}
          onClose={() => setOpen(false)}
          onActivated={onActivated}
        />
      ) : null}
    </>
  );
}

function KillSwitchDialog({ active, killSwitch, restarted, onClose, onActivated }) {
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState({ state: 'idle', result: null, error: null });

  async function confirm() {
    setStatus({ state: 'sending', result: null, error: null });
    try {
      const result = await activateKillSwitch(reason);
      setStatus({ state: 'done', result, error: null });
      onActivated?.(result);
    } catch (error) {
      setStatus({ state: 'error', result: null, error });
    }
  }

  const done = status.state === 'done';
  const footer = done ? (
    <button type="button" className="button" onClick={onClose} autoFocus>Cerrar</button>
  ) : restarted ? (
    <>
      <button type="button" className="button" onClick={onClose}>Cancelar</button>
      <button type="button" className="button button-primary" onClick={() => window.location.reload()}>Recargar la página</button>
    </>
  ) : (
    <>
      <button type="button" className="button" onClick={onClose} disabled={status.state === 'sending'}>Cancelar</button>
      <button type="button" className="button button-danger button-solid" onClick={confirm} disabled={status.state === 'sending'}>
        {status.state === 'sending' ? 'Activando…' : active ? 'Activar de nuevo' : 'Sí, activar el kill switch'}
      </button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={done ? 'Kill switch activado' : '¿Activar el kill switch?'} footer={footer}>
      {done ? (
        <div className="stack">
          <p>
            Motivo registrado: <strong>{status.result.reason}</strong>.{' '}
            {status.result.halted === null ? null : `${status.result.halted} entorno(s)/modo(s) detenidos en la base de datos.`}
          </p>
          {status.result.warning ? <p className="text-warn">{status.result.warning}</p> : null}
          <p>Si el bot está corriendo, cancela las órdenes pendientes y se detiene en ~1 segundo.</p>
          <p>Para reanudar, revisa la causa y usa <Cmd>npm run resume</Cmd> en la terminal.</p>
        </div>
      ) : (
        <div className="stack">
          {active ? (
            <p className="text-warn">
              Ya está activo desde {dateTime(killSwitch.createdAt)} ({killSwitch.reason}). Activarlo de nuevo solo actualiza el motivo.
            </p>
          ) : null}
          <ul className="list">
            <li>Detiene el bot en <strong>todos</strong> los entornos y modos (testnet y demo, dry-run y exchange).</li>
            <li>Cancela las órdenes pendientes que no se ejecutaron.</li>
            <li><strong>No</strong> vende ni cierra las posiciones abiertas.</li>
            <li>El bot no podrá volver a arrancar hasta que lo reanudes con <Cmd>npm run resume</Cmd> en la terminal. El panel no puede reanudarlo.</li>
          </ul>
          {restarted ? (
            <p className="text-warn">El servidor del panel se reinició: recarga la página para poder usar el kill switch (o usa <Cmd>npm run kill</Cmd>).</p>
          ) : (
            <label className="field">
              <span>Motivo (opcional)</span>
              <input
                type="text"
                value={reason}
                maxLength={MAX_REASON}
                onChange={(event) => setReason(event.target.value)}
                placeholder="p. ej. volatilidad extrema"
              />
            </label>
          )}
          {status.error ? (
            <p className="text-danger" role="alert">
              No se activó: {status.error.message}. Como alternativa, usa <Cmd>npm run kill</Cmd> en una terminal.
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
