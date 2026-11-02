import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('C# 5 compilation, executable identities, and volume/mute failures', { skip: process.platform !== 'win32' }, () => {
  const quote = path => "'" + resolve(path).replace(/['‘’‚‛]/g, '$&$&') + "'";
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Path @(${quote('extension/AudioHost.cs')}, ${quote('tests/AudioHostTests.cs')}) -ReferencedAssemblies System.Drawing`,
    '[AudioController.AudioHostTests]::Run()',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /regression checks passed/);
});
