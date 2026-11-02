export type AudioApp = {
  key: string;
  name: string;
  volume: number;
  muted: boolean;
  active: boolean;
  peak: number;
};

export type Reply =
  | { id: number; type: 'ready' | 'ok' }
  | { id: number; type: 'sessions'; apps: AudioApp[] }
  | { id: number; type: 'icon'; key: string; png: string | null }
  | { id: number; type: 'error'; message: string };

type Log = { info(...args: unknown[]): void; warn(...args: unknown[]): void };

type Waiter = { resolve(reply: Reply): void; reject(err: Error): void };
type Connection = {
  child: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  ready: Promise<void>;
  waiters: Map<number, Waiter>;
};

const STARTUP_MS = 30_000;
const RETRY_MS = 3_000;
const STOP_GRACE_MS = 750;
const KILL_GRACE_MS = 250;
const encoder = new TextEncoder();

// Keys are opaque executable hashes, process IDs, or "system:sounds"; never whitespace.
const KEY = /^[A-Za-z0-9%._~:!*'()-]+$/;

export function validKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key);
}

// the helper's C# ships as a plain file beside this bundle (vite.config.ts puts it there)
const HELPER_SOURCE = windowsPath(new URL('./AudioHost.cs', import.meta.url));

// file:///C:/a%20b/x.cs is C:\a b\x.cs, and file://server/share/x.cs is \\server\share\x.cs
function windowsPath(url: URL): string {
  const path = decodeURIComponent(url.pathname).replaceAll('/', '\\');
  return url.host ? `\\\\${url.host}${path}` : path.slice(1);
}

// The whole command line, readable as it is in Task Manager. Execution policy only covers
// script files, so -Command needs no bypass, and progress records would otherwise reach
// stderr as CLIXML.
function helperCommand(source: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Path ${quote(source)} -ReferencedAssemblies System.Drawing`,
    '[AudioController.Host]::Run()',
  ].join('; ');
}

// powershell also ends a single-quoted string at a curly quote, so those double up too
function quote(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, '$&$&')}'`;
}

// One long-lived powershell running the C# helper in AudioHost.cs. It starts on the first
// request and restarts on the next request after it dies, at most once per RETRY_MS.
export class AudioHost {
  #log: Log;
  #connection: Connection | undefined;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #nextId = 1;
  #retryAt = 0;

  constructor(log: Log) {
    this.#log = log;
  }

  async request(command: string, timeoutMs = 5_000): Promise<Reply> {
    const connection = await this.#start();
    if (this.#stopped || this.#connection !== connection) throw new Error('audio helper is unavailable');
    const id = this.#nextId++;
    const reply = this.#wait(connection, id, timeoutMs, command);
    try {
      // Observe both promises immediately. The reply deadline also covers a blocked write.
      const [, result] = await Promise.all([
        Promise.resolve().then(() => connection.stdin.write(encoder.encode(`${id} ${command}\n`))),
        reply,
      ]);
      return result;
    } catch (err) {
      this.#fail(connection, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  stop(): Promise<void> {
    return (this.#stopping ??= this.#stop());
  }

  async #stop() {
    this.#stopped = true;
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return;
    this.#rejectAll(connection, new Error('audio helper stopped'));
    // Closing stdin normally ends Run(). A blocked native call or write needs a forced exit.
    void connection.stdin.close().catch(() => {});
    if (await exitedWithin(connection.child, STOP_GRACE_MS)) return;
    this.#kill(connection.child);
    if (!(await exitedWithin(connection.child, KILL_GRACE_MS))) {
      this.#log.warn('audio helper did not exit after termination');
    }
  }

  async #start(): Promise<Connection> {
    if (this.#stopped) throw new Error('audio helper stopped');
    if (this.#connection) {
      const connection = this.#connection;
      await connection.ready;
      return connection;
    }
    if (Date.now() < this.#retryAt) throw new Error('audio helper is restarting');

    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command('powershell.exe', {
        args: ['-NoProfile', '-NonInteractive', '-Command', helperCommand(HELPER_SOURCE)],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
    } catch (err) {
      // a missing run permission throws here rather than failing the exit code
      this.#retryAt = Date.now() + RETRY_MS;
      throw new Error(`could not start powershell: ${err}`);
    }

    const connection: Connection = {
      child,
      stdin: child.stdin.getWriter(),
      ready: Promise.resolve(),
      waiters: new Map(),
    };
    this.#connection = connection;
    connection.ready = this.#wait(connection, 0, STARTUP_MS, 'startup').then(() => this.#log.info('audio helper ready'));

    void this.#readLines(child.stdout, line => this.#onLine(connection, line));
    void this.#readLines(child.stderr, line => {
      if (line.trim() && !line.startsWith('#< CLIXML')) this.#log.warn(`audio helper: ${line}`);
    });
    void child.status.then(
      status => this.#fail(connection, new Error(`audio helper exited with code ${status.code}`), false),
      err => this.#fail(connection, new Error(`audio helper status failed: ${err}`)),
    );
    await connection.ready;
    return connection;
  }

  #wait(connection: Connection, id: number, timeoutMs: number, label: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(connection, new Error(`audio helper timed out on ${label}`));
      }, timeoutMs);
      connection.waiters.set(id, {
        resolve: reply => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  #onLine(connection: Connection, line: string) {
    if (this.#connection !== connection || !line.startsWith('{')) return;
    let reply: Reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    if (reply.id === 0 && reply.type !== 'ready') return;
    const waiter = connection.waiters.get(reply.id);
    if (!waiter) return;
    connection.waiters.delete(reply.id);
    waiter.resolve(reply);
  }

  #fail(connection: Connection, err: Error, kill = true) {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    this.#retryAt = Date.now() + RETRY_MS;
    this.#rejectAll(connection, err);
    if (kill) this.#kill(connection.child);
  }

  #rejectAll(connection: Connection, err: Error) {
    for (const waiter of connection.waiters.values()) waiter.reject(err);
    connection.waiters.clear();
  }

  #kill(child: Deno.ChildProcess) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited before its status promise settled.
    }
  }

  async #readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          onLine(buffered.slice(0, newline).replace(/\r$/, ''));
          buffered = buffered.slice(newline + 1);
        }
      }
    } catch {
      // the stream closes with the process
    }
  }
}

async function exitedWithin(child: Deno.ChildProcess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.status.then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
