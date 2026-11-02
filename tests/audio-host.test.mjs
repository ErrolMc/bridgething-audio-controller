import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioHost } from '../extension/audio.ts';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const log = { info() {}, warn() {} };

function fakeChild({ ready = true, write = 'reply', closeExits = true, killExits = true } = {}) {
  let output, errors, finish;
  const child = {
    killed: 0,
    writes: [],
    stdout: new ReadableStream({ start(c) { output = c; } }),
    stderr: new ReadableStream({ start(c) { errors = c; } }),
    status: new Promise(resolve => { finish = resolve; }),
    send(reply) { output.enqueue(new TextEncoder().encode(JSON.stringify(reply) + '\n')); },
    exit() { output.close(); errors.close(); finish({ code: 0 }); },
    kill() { this.killed++; if (killExits) this.exit(); },
  };
  child.stdin = new WritableStream({
    write(bytes) {
      const command = new TextDecoder().decode(bytes);
      child.writes.push(command);
      if (write === 'fail') throw new Error('broken pipe');
      if (write === 'block') return new Promise(() => {});
      if (write === 'reply') child.send({ id: Number(command.split(' ')[0]), type: 'ok' });
    },
    close() { if (closeExits) child.exit(); },
  });
  if (ready) child.send({ id: 0, type: 'ready' });
  return child;
}

function setup(t, ...children) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const previous = globalThis.Deno;
  let spawns = 0;
  globalThis.Deno = { Command: class { spawn() { return children[spawns++]; } } };
  t.after(() => { globalThis.Deno = previous; });
  return { host: new AudioHost(log), spawns: () => spawns };
}

test('startup timeout kills the old child and permits retry after backoff', async t => {
  const old = fakeChild({ ready: false, killExits: false });
  const next = fakeChild();
  const { host, spawns } = setup(t, old, next);
  const failed = assert.rejects(host.request('list'), /timed out on startup/);
  t.mock.timers.tick(30_000);
  await failed;
  assert.equal(old.killed, 1);
  await assert.rejects(host.request('list'), /restarting/);
  t.mock.timers.tick(3_000);
  const recovery = host.request('list');
  // A delayed ready/exit from the old generation must not affect the replacement.
  old.send({ id: 0, type: 'ready' });
  old.exit();
  assert.equal((await recovery).type, 'ok');
  assert.equal(spawns(), 2);
  await host.stop();
});

test('broken writes reject every concurrent request without orphaned promises', async t => {
  const child = fakeChild({ write: 'fail' });
  const { host } = setup(t, child);
  const results = await Promise.allSettled([host.request('list'), host.request('icon test')]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(child.killed, 1);
  t.mock.timers.tick(60_000);
  await flush(); // node:test also fails on any unhandled rejection after the requests end.
  await host.stop();
});

test('request deadline includes a blocked stdin write', async t => {
  const child = fakeChild({ write: 'block' });
  const { host } = setup(t, child);
  const failed = assert.rejects(host.request('list', 100), /timed out on list/);
  await flush();
  assert.equal(child.writes.length, 1);
  t.mock.timers.tick(100);
  await failed;
  assert.equal(child.killed, 1);
  await host.stop();
});

test('a helper that stops replying is replaced on the next request', async t => {
  const child = fakeChild({ write: 'silent' });
  const { host } = setup(t, child, fakeChild());
  const failed = assert.rejects(host.request('list', 100), /timed out on list/);
  await flush();
  t.mock.timers.tick(100);
  await failed;
  t.mock.timers.tick(3_000);
  assert.equal((await host.request('list')).type, 'ok');
  await host.stop();
});

test('normal shutdown waits for EOF exit without killing and prevents restart', async t => {
  const child = fakeChild();
  const { host } = setup(t, child);
  await host.request('list');
  await host.stop();
  assert.equal(child.killed, 0);
  await assert.rejects(host.request('list'), /stopped/);
});

test('shutdown awaits forced termination of a stuck child', async t => {
  const child = fakeChild({ write: 'block', closeExits: false });
  const { host } = setup(t, child);
  const pending = assert.rejects(host.request('list'), /stopped/);
  await flush();
  let finished = false;
  const stopping = host.stop().then(() => { finished = true; });
  await pending;
  assert.equal(finished, false);
  assert.equal(child.killed, 0);
  t.mock.timers.tick(750);
  await stopping;
  assert.equal(child.killed, 1);
  assert.equal(finished, true);
});

test('shutdown also cancels startup and stays within the host grace period', async t => {
  const child = fakeChild({ ready: false, closeExits: false, killExits: false });
  const { host } = setup(t, child);
  const pending = assert.rejects(host.request('list'), /stopped/);
  const stopping = host.stop();
  await pending;
  t.mock.timers.tick(750);
  await flush();
  t.mock.timers.tick(250);
  await stopping;
  assert.equal(child.killed, 1);
  child.exit();
});
