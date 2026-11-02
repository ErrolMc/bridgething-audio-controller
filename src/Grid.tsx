import { useEffect, useRef } from 'react';
import type { AudioApp } from './audio';
import { AppIcon, PlayingBars, SpeakerGlyph, isPlaying, percent } from './glyphs';

type Props = {
  apps: AudioApp[];
  icons: Record<string, string | null>;
  selectedKey: string | null;
  onOpen: (key: string) => void;
};

export function Grid({ apps, icons, selectedKey, onOpen }: Props) {
  const tiles = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (selectedKey) tiles.current.get(selectedKey)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedKey]);

  return (
    <div className="h-full touch-pan-y overflow-y-auto px-6 pt-1 pb-6 [scrollbar-width:none]">
      <div className="grid grid-cols-4 gap-4">
        {apps.map(app => {
          const selected = app.key === selectedKey;
          return (
            <button
              key={app.key}
              ref={el => {
                if (el) tiles.current.set(app.key, el);
                else tiles.current.delete(app.key);
              }}
              onClick={() => onOpen(app.key)}
              className={`relative flex h-[176px] scroll-my-4 flex-col items-center rounded-2xl border-2 px-3 pt-5 pb-4 transition active:scale-[0.97] ${
                selected ? 'border-accent bg-accent-soft' : 'border-transparent bg-neutral-soft'
              }`}>
              {isPlaying(app) && <PlayingBars className="absolute top-3 right-3 h-4" />}
              <AppIcon app={app} src={icons[app.key]} className={`h-[72px] w-[72px] ${app.muted ? 'opacity-40' : ''}`} />
              <div className="mt-3 w-full truncate text-center text-row-lg font-medium text-near">{app.name}</div>
              <div className="mt-auto flex w-full items-center gap-2">
                {app.muted ? (
                  <div className="flex w-full items-center justify-center gap-1.5 font-mono text-hint tracking-wider text-warn uppercase">
                    <SpeakerGlyph muted className="h-4 w-4" />
                    muted
                  </div>
                ) : (
                  <>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-rule-strong">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${percent(app.volume)}%` }} />
                    </div>
                    <div className="w-9 text-right font-mono text-hint text-soft">{percent(app.volume)}</div>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
