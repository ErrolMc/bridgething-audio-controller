import { useRef, type PointerEvent } from 'react';
import type { AudioApp } from './audio';
import { AppIcon, BackGlyph, PlayingBars, SpeakerGlyph, isPlaying, percent } from './glyphs';

type Props = {
  app: AudioApp;
  icon: string | null | undefined;
  unavailable: string | null;
  onBack: () => void;
  onVolume: (volume: number) => void;
  onMuted: (muted: boolean) => void;
};

export function Detail({ app, icon, unavailable, onBack, onVolume, onMuted }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const level = percent(app.volume);

  // dragging along the bar sets the volume too, for when the wheel is out of reach
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (unavailable !== null) return;
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId);
    else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = track.current!.getBoundingClientRect();
    const volume = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onVolume(Math.round(volume * 100) / 100);
    if (app.muted) onMuted(false);
  };

  return (
    <div className="flex h-full flex-col px-10 pt-6 pb-8">
      <div className="flex h-14 shrink-0 items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="-ml-3 flex h-14 shrink-0 items-center gap-1 rounded-xl pr-5 pl-2 text-title font-medium text-near transition active:bg-neutral-soft">
          <BackGlyph className="h-7 w-7" />
          Back
        </button>
        {unavailable !== null && (
          <div role="status" className="min-w-0 truncate text-right text-hint text-warn" title={unavailable}>
            {unavailable}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-8">
        <AppIcon app={app} src={icon} className={`h-[120px] w-[120px] shrink-0 ${app.muted ? 'opacity-40' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-screen-title font-medium tracking-display text-off-white">{app.name}</div>
          <div className="mt-1 flex h-5 items-center gap-2 font-mono text-hint tracking-wider uppercase">
            {unavailable !== null ? (
              <span className="text-dim">last known volume</span>
            ) : app.muted ? (
              <span className="text-warn">muted</span>
            ) : isPlaying(app) ? (
              <>
                <PlayingBars className="h-3.5" />
                <span className="text-accent">playing</span>
              </>
            ) : (
              <span className="text-dim">silent</span>
            )}
          </div>
        </div>
        <div
          className={`font-display text-[104px] leading-none font-medium tracking-display tabular-nums ${
            app.muted ? 'text-dim' : 'text-off-white'
          }`}>
          {level}
          <span className="text-[44px] text-soft">%</span>
        </div>
      </div>

      <div
        ref={track}
        onPointerDown={drag}
        onPointerMove={drag}
        className={`mt-auto flex h-16 items-center ${unavailable !== null ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
        role="slider"
        aria-label="Volume"
        aria-disabled={unavailable !== null}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={level}>
        <div className="relative h-5 w-full rounded-full bg-rule-strong">
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-75 ${app.muted ? 'bg-dim' : 'bg-accent'}`}
            style={{ width: `${level}%` }}
          />
          <div
            className={`absolute top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-bg transition-[left] duration-75 ${
              app.muted ? 'bg-soft' : 'bg-off-white'
            }`}
            style={{ left: `${level}%` }}
          />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button
          disabled={unavailable !== null}
          onClick={() => onMuted(!app.muted)}
          className={`flex h-16 items-center gap-3 rounded-2xl px-7 text-title font-medium transition active:scale-[0.97] disabled:opacity-40 ${
            app.muted ? 'bg-warn text-screen' : 'bg-neutral-soft text-near'
          }`}>
          <SpeakerGlyph muted={app.muted} className="h-7 w-7" />
          {app.muted ? 'Unmute' : 'Mute'}
        </button>
        <div className="text-right font-mono text-hint leading-relaxed tracking-wider text-dim uppercase">
          {unavailable !== null ? 'controls unavailable' : (
            <>
              turn the wheel to adjust
              <br />
              press it to {app.muted ? 'unmute' : 'mute'}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
