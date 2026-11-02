import { ConfigForm, closeSettings, type ConfigFormHandle } from '@bridgething/client/form';
import { settings, type SettingsContext } from '@bridgething/client/settings';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function Settings() {
  const form = useRef<ConfigFormHandle>(null);
  const [ctx, setCtx] = useState<SettingsContext | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    settings.context().then(setCtx, (err: unknown) => setStatus(errText(err)));
    return settings.onRefresh(setCtx);
  }, []);

  async function close() {
    try {
      await closeSettings(form.current);
    } catch (err) {
      setStatus(errText(err));
    }
  }

  return (
    <main>
      <h1>{ctx?.name ?? 'audio-controller'} settings</h1>
      <p className="hint">{ctx ? `${ctx.name} ${ctx.version}` : 'connecting to the companion host...'}</p>

      <ConfigForm ref={form} />

      <div className="row">
        <button type="button" onClick={close}>
          Done
        </button>
      </div>

      <p className="status">{status}</p>
    </main>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

createRoot(document.getElementById('root')!).render(<Settings />);
