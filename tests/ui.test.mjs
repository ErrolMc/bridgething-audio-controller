import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';

const browser = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(path => path && existsSync(path));

test('detail controls, pending sends, and reconnection in Chromium', { skip: !browser, timeout: 30_000 }, async () => {
  const bundle = await build({
    entryPoints: ['tests/ui-fixture.tsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@bridgething/client': resolve('tests/fake-client.ts') },
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_BRIDGETHING_URL': 'undefined', 'process.env.NODE_ENV': '"production"' },
  });
  const assets = resolve('dist/assets');
  const assetNames = existsSync(assets) ? readdirSync(assets) : [];
  const cssName = assetNames.find(name => name.endsWith('.css'));
  const css = cssName ? readFileSync(join(assets, cssName)) : '';
  const server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (assetNames.includes(req.url?.slice(1))) res.end(readFileSync(join(assets, req.url.slice(1))));
    else res.end('<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'audio-controller-ui-'));
  try {
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--user-data-dir=${profile}`, '--window-size=800,480', '--virtual-time-budget=3000', '--dump-dom',
      ...(process.env.AUDIO_UI_SCREENSHOT ? [`--screenshot=${resolve(process.env.AUDIO_UI_SCREENSHOT)}`] : []),
      `http://127.0.0.1:${server.address().port}/`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, errors);
      assert.match(output, /data-result="passed"/, output || errors);
    } finally { clearTimeout(timer); }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Only remove the specific temporary profile this test created.
    assert.equal(dirname(profile), resolve(tmpdir()));
    assert.ok(profile.startsWith(join(tmpdir(), 'audio-controller-ui-')));
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
