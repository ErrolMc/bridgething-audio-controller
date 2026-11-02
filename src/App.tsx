import { BridgethingClient } from '@bridgething/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAudio, wheelClicks } from './audio';
import { daemonUrl } from './daemon';
import { Detail } from './Detail';
import { Grid } from './Grid';

const DEFAULT_STEP = 2;
// clicks closer together than this count double, so a quick spin covers the range fast
const FAST_CLICK_MS = 45;

export default function App() {
  const client = useMemo(() => new BridgethingClient({ url: daemonUrl() }), []);
  const { linked, apps, error, icons, canControl, setVolume, setMuted } = useAudio(client);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [step, setStep] = useState(DEFAULT_STEP);
  const carry = useRef({ value: 0 });
  const lastClick = useRef(0);
  const target = useRef<{ key: string; level: number } | null>(null);
  const lastIndex = useRef(0);

  useEffect(() => {
    const apply = (value: string | null) => setStep(Number(value) || DEFAULT_STEP);
    void client.config.get({ key: 'step' }).then(r => r.ok && apply(r.response.value));
    return client.config.onChanged(change => change.key === 'step' && apply(change.value));
  }, [client]);

  const selectedIndex = apps ? apps.findIndex(app => app.key === selectedKey) : -1;
  const openApp = apps?.find(app => app.key === openKey) ?? null;

  useEffect(() => {
    if (!canControl) {
      target.current = null;
      carry.current.value = 0;
      lastClick.current = 0;
    }
  }, [canControl]);

  // keep a selection, and when the selected app goes away land on its neighbour
  useEffect(() => {
    if (!apps || apps.length === 0) return;
    if (selectedIndex >= 0) {
      lastIndex.current = selectedIndex;
      return;
    }
    setSelectedKey(apps[Math.min(lastIndex.current, apps.length - 1)].key);
  }, [apps, selectedIndex]);

  // an app that closes while open has nothing left to adjust
  useEffect(() => {
    if (openKey && apps && !openApp) setOpenKey(null);
  }, [apps, openKey, openApp]);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const clicks = wheelClicks(event, carry.current);
      if (!clicks || !apps || apps.length === 0) return;

      if (openApp) {
        if (!canControl) return;
        const now = performance.now();
        const fast = now - lastClick.current < FAST_CLICK_MS;
        // several clicks can land before a render, so build on the last value sent
        const recent = target.current?.key === openApp.key && now - lastClick.current < 1000;
        lastClick.current = now;
        const from = recent ? target.current!.level : Math.round(openApp.volume * 100);
        const level = Math.min(100, Math.max(0, from + clicks * step * (fast ? 2 : 1)));
        target.current = { key: openApp.key, level };
        setVolume(openApp.key, level / 100);
        // turning the knob on a muted app unmutes it, like the windows volume keys
        if (openApp.muted) setMuted(openApp.key, false);
        return;
      }

      setSelectedKey(current => {
        const from = Math.max(0, apps.findIndex(app => app.key === current));
        return apps[Math.min(apps.length - 1, Math.max(0, from + clicks))].key;
      });
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        // keeps a focused button from also clicking
        event.preventDefault();
        if (openApp) {
          if (canControl) setMuted(openApp.key, !openApp.muted);
        } else if (selectedKey && apps?.some(app => app.key === selectedKey)) setOpenKey(selectedKey);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setOpenKey(null);
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [apps, openApp, selectedKey, step, canControl, setVolume, setMuted]);

  if (openApp) {
    return (
      <main className="h-full w-full bg-bg text-off-white">
        <Detail
          app={openApp}
          icon={icons[openApp.key]}
          unavailable={!linked ? 'PC not connected' : error ?? (!canControl ? 'Waiting for your PC' : null)}
          onBack={() => setOpenKey(null)}
          onVolume={volume => {
            target.current = null;
            setVolume(openApp.key, volume);
          }}
          onMuted={muted => setMuted(openApp.key, muted)}
        />
      </main>
    );
  }

  return (
    <main className="flex h-full w-full flex-col bg-bg text-off-white">
      <header className="flex h-16 shrink-0 items-center justify-between px-7">
        <h1 className="font-display text-title font-medium tracking-display">Audio</h1>
        <Status linked={linked} count={apps?.length ?? null} error={error} />
      </header>
      <div className="min-h-0 flex-1">
        {apps && apps.length > 0 ? (
          <Grid
            apps={apps}
            icons={icons}
            selectedKey={selectedKey}
            onOpen={key => {
              setSelectedKey(key);
              setOpenKey(key);
            }}
          />
        ) : (
          <Empty linked={linked} loaded={apps !== null} error={error} />
        )}
      </div>
    </main>
  );
}

function Status({ linked, count, error }: { linked: boolean; count: number | null; error: string | null }) {
  const [text, tone] = !linked
    ? ['pc not connected', 'text-warn']
    : error
      ? [error, 'text-warn']
      : count === null
        ? ['connecting', 'text-dim']
        : [`${count} ${count === 1 ? 'app' : 'apps'} · turn to choose, press to open`, 'text-dim'];
  return <div className={`max-w-[560px] truncate font-mono text-hint tracking-wider uppercase ${tone}`}>{text}</div>;
}

function Empty({ linked, loaded, error }: { linked: boolean; loaded: boolean; error: string | null }) {
  const [title, body] = !linked
    ? ['Waiting for your PC', 'Open the BridgeThing desktop app on your PC and make sure audio-controller is enabled.']
    : !loaded
      ? ['Looking for apps', error ?? 'Asking your PC which apps play audio.']
      : ['Nothing to show', 'No app on your PC has opened an audio stream yet. Play something and it will appear here.'];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-16 pb-12 text-center">
      <div className="font-display text-hero font-medium text-near">{title}</div>
      <div className={`max-w-[520px] text-row ${error && linked && !loaded ? 'text-warn' : 'text-soft'}`}>{body}</div>
    </div>
  );
}
