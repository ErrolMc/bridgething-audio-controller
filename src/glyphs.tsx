import type { AudioApp } from './audio';

type GlyphProps = { className?: string };

export function SpeakerGlyph({ muted, className }: GlyphProps & { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
      {muted ? (
        <path d="m16 9 5 6m0-6-5 6" />
      ) : (
        <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
      )}
    </svg>
  );
}

export function BackGlyph({ className }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m15 5-7 7 7 7" />
    </svg>
  );
}

// three bars that bounce while the app is actually making sound
export function PlayingBars({ className }: GlyphProps) {
  return (
    <span className={`flex items-end gap-[3px] ${className ?? ''}`} aria-label="playing">
      <span className="playing-bar h-full w-[4px] rounded-full bg-accent" />
      <span className="playing-bar h-full w-[4px] rounded-full bg-accent [animation-delay:-0.3s]" />
      <span className="playing-bar h-full w-[4px] rounded-full bg-accent [animation-delay:-0.6s]" />
    </span>
  );
}

const TINTS = ['#00a8e8', '#3ddc84', '#ffb066', '#ff7070', '#b18cff', '#4dd0c8'];

export function AppIcon({ app, src, className }: GlyphProps & { app: AudioApp; src: string | null | undefined }) {
  if (src) return <img src={src} alt="" draggable={false} className={`object-contain ${className ?? ''}`} />;
  let hash = 0;
  for (const char of app.key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const tint = TINTS[Math.abs(hash) % TINTS.length];
  return (
    <div
      className={`grid place-items-center rounded-[22%] font-display font-semibold text-screen ${className ?? ''}`}
      style={{ backgroundColor: tint, fontSize: '2.75em' }}>
      {app.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export const isPlaying = (app: AudioApp) => !app.muted && app.peak > 0.001;
export const percent = (volume: number) => Math.round(volume * 100);
