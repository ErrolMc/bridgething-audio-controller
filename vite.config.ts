import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { bridgething, daemonProxy } from './scripts/bridgething';

export default defineConfig(async ({ command }) => ({
  plugins: [react(), tailwindcss(), bridgething(), audioHelper()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: command === 'serve' ? { host: true, proxy: await daemonProxy() } : {},
}));

// The extension runs AudioHost.cs from a plain file beside its bundle (see extension/audio.ts),
// so a copy goes wherever the bundle does: dist/extension/ in a build, and .dev-extension/build/
// under the dev server.
function audioHelper(): Plugin {
  const source = resolve(import.meta.dirname, 'extension/AudioHost.cs');
  return {
    name: 'audio-controller:helper',
    configureServer(server) {
      const copy = () => {
        const dir = resolve(import.meta.dirname, '.dev-extension/build');
        mkdirSync(dir, { recursive: true });
        copyFileSync(source, resolve(dir, 'AudioHost.cs'));
      };
      copy();
      server.watcher.add(source);
      server.watcher.on('change', file => {
        if (resolve(file) === source) copy();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'extension/AudioHost.cs', source: readFileSync(source) });
    },
  };
}
