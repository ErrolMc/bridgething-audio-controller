import { asJson, defineExtension, json, type Device } from '@bridgething/extension';
import { AudioHost, validKey } from './audio';

type Command =
  | { type: 'refresh' }
  | { type: 'setVolume'; key: string; volume: number }
  | { type: 'setMute'; key: string; muted: boolean }
  | { type: 'icon'; key: string };

const POLL_MS = 500;

let timer: ReturnType<typeof setInterval> | undefined;
let host: AudioHost | undefined;

defineExtension({
  start(ctx) {
    const audio = new AudioHost(ctx.log);
    host = audio;
    let polling = false;
    let lastError = '';

    const report = (err: unknown, device?: Device) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) ctx.log.warn(message);
      lastError = message;
      const payload = json({ type: 'error', message });
      if (device) device.send(payload);
      else ctx.broadcast(payload);
    };

    // the helper only runs while some car thing has this app open
    const poll = async () => {
      if (polling || !ctx.devices.some(device => device.connected && device.active)) return;
      polling = true;
      try {
        const reply = await audio.request('list');
        if (reply.type === 'sessions') {
          lastError = '';
          ctx.broadcast(json({ type: 'sessions', apps: reply.apps }));
        } else if (reply.type === 'error') report(reply.message);
      } catch (err) {
        report(err);
      } finally {
        polling = false;
      }
    };

    const run = async (device: Device, command: string) => {
      try {
        const reply = await audio.request(command);
        if (reply.type === 'error') report(reply.message, device);
      } catch (err) {
        report(err, device);
      }
      void poll();
    };

    ctx.on('device', event => {
      if (event.type === 'disconnected' || !event.device.active) return;
      void poll();
    });

    ctx.on('message', (device, message) => {
      const command = asJson<Command>(message);
      if (!command) return;
      if (command.type === 'refresh') return void poll();
      if (!validKey(command.key)) return;

      if (command.type === 'setVolume' && Number.isFinite(command.volume)) {
        const volume = Math.min(1, Math.max(0, command.volume));
        void run(device, `volume ${command.key} ${volume.toFixed(3)}`);
      } else if (command.type === 'setMute') {
        void run(device, `mute ${command.key} ${command.muted ? 1 : 0}`);
      } else if (command.type === 'icon') {
        const key = command.key;
        void audio.request(`icon ${key}`, 10_000).then(
          reply => device.send(json({ type: 'icon', key, png: reply.type === 'icon' ? reply.png : null })),
          err => ctx.log.warn(`icon for ${key}: ${err}`),
        );
      }
    });

    timer = setInterval(() => void poll(), POLL_MS);
  },
  async stop() {
    clearInterval(timer);
    await host?.stop();
  },
});
