import type { BridgethingClient, CapabilitiesSnapshot } from '@bridgething/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type AudioApp = {
  key: string;
  name: string;
  volume: number;
  muted: boolean;
  active: boolean;
  peak: number;
};

type Message =
  | { type: 'sessions'; apps: AudioApp[] }
  | { type: 'icon'; key: string; png: string | null }
  | { type: 'error'; message: string };

// a local change wins over what the pc reports until the pc has caught up
type Override = { volume?: number; muted?: boolean; until: number };

const OVERRIDE_MS = 1200;
const SEND_EVERY_MS = 60;
export const SYSTEM_SOUNDS = 'system:sounds';

function byName(a: AudioApp, b: AudioApp) {
  if (a.key === SYSTEM_SOUNDS) return 1;
  if (b.key === SYSTEM_SOUNDS) return -1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function useAudio(client: BridgethingClient) {
  const [linked, setLinked] = useState(false);
  const [reported, setReported] = useState<AudioApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [fresh, setFresh] = useState(false);
  const linkedRef = useRef(false);
  const canSend = useRef(false);
  const requested = useRef(new Set<string>());
  const volumeSends = useRef(new Map<string, { timer?: ReturnType<typeof setTimeout>; next?: number }>());

  useEffect(() => {
    let disposed = false;
    const invalidate = () => {
      canSend.current = false;
      setFresh(false);
      setOverrides({});
      for (const send of volumeSends.current.values()) clearTimeout(send.timer);
      volumeSends.current.clear();
    };
    const link = (available: boolean) => {
      if (disposed) return;
      linkedRef.current = available;
      setLinked(available);
      if (!available) invalidate();
    };
    const apply = (snap: CapabilitiesSnapshot) => link(snap.capabilities.available.forward);
    const check = async () => {
      try {
        const caps = await client.capabilities.get();
        link(caps.ok && caps.response.capabilities.available.forward);
      } catch {
        link(false);
      }
    };
    void check();
    const poll = setInterval(check, 3000);
    const offCaps = client.capabilities.subscribePartial({ snapshot: apply, update: apply });

    const offForward = client.forward.onJson(raw => {
      const msg = raw as Message;
      if (msg.type === 'sessions') {
        if (!linkedRef.current) return;
        setReported(msg.apps);
        setError(null);
        setFresh(true);
        canSend.current = true;
      } else if (msg.type === 'icon') {
        setIcons(prev => ({ ...prev, [msg.key]: msg.png ? `data:image/png;base64,${msg.png}` : null }));
      } else if (msg.type === 'error') {
        setError(msg.message);
        invalidate();
      }
    });

    return () => {
      disposed = true;
      linkedRef.current = false;
      canSend.current = false;
      for (const send of volumeSends.current.values()) clearTimeout(send.timer);
      volumeSends.current.clear();
      clearInterval(poll);
      offCaps();
      offForward();
    };
  }, [client]);

  // forwards sent while unlinked are dropped, so ask again on every link
  useEffect(() => {
    if (!linked) return;
    requested.current.clear();
    void client.forward.json({ type: 'refresh' });
  }, [client, linked]);

  useEffect(() => {
    if (!linked || !reported) return;
    for (const app of reported) {
      if (requested.current.has(app.key) || icons[app.key] !== undefined) continue;
      requested.current.add(app.key);
      void client.forward.json({ type: 'icon', key: app.key });
    }
  }, [client, linked, reported, icons]);

  const apps = useMemo(() => {
    if (!reported) return null;
    const now = Date.now();
    return reported
      .map(app => {
        const local = overrides[app.key];
        if (!local || local.until < now) return app;
        return { ...app, volume: local.volume ?? app.volume, muted: local.muted ?? app.muted };
      })
      .sort(byName);
  }, [reported, overrides]);

  const override = useCallback((key: string, change: Omit<Override, 'until'>) => {
    setOverrides(prev => ({ ...prev, [key]: { ...prev[key], ...change, until: Date.now() + OVERRIDE_MS } }));
  }, []);

  // the wheel can fire faster than the pc needs, so send at most every SEND_EVERY_MS per app
  const setVolume = useCallback(
    (key: string, volume: number) => {
      if (!canSend.current) return;
      override(key, { volume });
      const send = volumeSends.current.get(key) ?? {};
      volumeSends.current.set(key, send);
      if (send.timer) {
        send.next = volume;
        return;
      }
      void client.forward.json({ type: 'setVolume', key, volume });
      const flush = () => {
        if (!canSend.current || send.next === undefined) {
          send.timer = undefined;
          return;
        }
        void client.forward.json({ type: 'setVolume', key, volume: send.next });
        send.next = undefined;
        send.timer = setTimeout(flush, SEND_EVERY_MS);
      };
      send.timer = setTimeout(flush, SEND_EVERY_MS);
    },
    [client, override],
  );

  const setMuted = useCallback(
    (key: string, muted: boolean) => {
      if (!canSend.current) return;
      override(key, { muted });
      void client.forward.json({ type: 'setMute', key, muted });
    },
    [client, override],
  );

  return { linked, apps, error, icons, canControl: linked && fresh && error === null, setVolume, setMuted };
}

// the wheel sends +-120 per click on the car thing; a desktop mouse or trackpad sends other
// sizes, so a big delta counts as one click and small ones add up to one
export function wheelClicks(event: WheelEvent, carry: { value: number }): number {
  const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
  if (Math.abs(delta) >= 50) {
    carry.value = 0;
    return Math.sign(delta);
  }
  carry.value += delta;
  if (Math.abs(carry.value) < 120) return 0;
  const clicks = Math.sign(carry.value);
  carry.value = 0;
  return clicks;
}
