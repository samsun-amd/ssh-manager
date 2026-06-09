import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import {
  Endpoint,
  PoolOptions,
  RemoteOs,
  SshConnectionError,
} from '../types';

const DEFAULT_READY_TIMEOUT = 15000;
const DEFAULT_IDLE_TIMEOUT = 60000;
const DEFAULT_MAX_PER_KEY = 4;
const EXEC_TIMEOUT = 15000;
const SFTP_PROBE_TIMEOUT = 6000;

/** A live, OS-detected SSH session. Wraps an ssh2 Client (+ optional jump). */
export class SshSession {
  readonly endpoint: Endpoint;
  private readonly client: Client;
  private readonly jumpClient: Client | null;
  private cachedOs: RemoteOs | null;
  private sftpWrapper: SFTPWrapper | null = null;
  private sftpAvailable_: boolean | null = null;
  /** Set by the pool; identifies the bucket this session belongs to. */
  poolKey = '';

  constructor(endpoint: Endpoint, client: Client, jumpClient: Client | null) {
    this.endpoint = endpoint;
    this.client = client;
    this.jumpClient = jumpClient;
    this.cachedOs = endpoint.os || null;
  }

  get os(): RemoteOs | null {
    return this.cachedOs;
  }

  /**
   * Whether this endpoint's sshd exposes an SFTP subsystem. null until probed
   * by checkSftp(). Embedded sshds (e.g. a BusyBox SMC) often ship no
   * sftp-server, so callers must fall back to plain exec streaming there.
   */
  get sftpAvailable(): boolean | null {
    return this.sftpAvailable_;
  }

  /** Get (and cache) an SFTP channel for this session. */
  sftp(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return Promise.resolve(this.sftpWrapper);
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(new SshConnectionError(this.endpoint.id, `SFTP failed: ${err.message}`, err));
        this.sftpWrapper = sftp;
        // Drop the cached wrapper if the channel dies so a later sftp() call
        // re-opens a fresh one instead of handing back a dead channel.
        const drop = () => {
          if (this.sftpWrapper === sftp) this.sftpWrapper = null;
        };
        sftp.on('close', drop);
        sftp.on('error', drop);
        resolve(sftp);
      });
    });
  }

  /** Run a command, resolving stdout/stderr/exit code. POSIX endpoints only. */
  exec(command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      let activeStream: ClientChannel | null = null;
      const timer = setTimeout(() => {
        // Tear down the exec channel so it does not leak after the timeout.
        if (activeStream) {
          try {
            activeStream.close();
          } catch {
            /* ignore */
          }
        }
        reject(new SshConnectionError(this.endpoint.id, 'exec timed out'));
      }, EXEC_TIMEOUT);
      this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timer);
          return reject(new SshConnectionError(this.endpoint.id, `exec failed: ${err.message}`, err));
        }
        activeStream = stream;
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        stream
          .on('close', (c: number) => {
            clearTimeout(timer);
            code = typeof c === 'number' ? c : null;
            resolve({ stdout, stderr, code });
          })
          .on('error', (e: Error) => {
            clearTimeout(timer);
            reject(new SshConnectionError(this.endpoint.id, `exec stream error: ${e.message}`, e));
          })
          .on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
      });
    });
  }

  /** Probe the remote OS once and cache it. */
  async detectOs(): Promise<RemoteOs> {
    if (this.cachedOs) return this.cachedOs;
    try {
      const res = await this.exec('uname -s');
      // POSIX uname prints "Linux"/"Darwin"; Windows cmd errors or echoes the literal.
      if (res.code === 0 && /linux|darwin|bsd|sunos|aix/i.test(res.stdout)) {
        this.cachedOs = 'posix';
      } else {
        this.cachedOs = 'windows';
      }
    } catch {
      this.cachedOs = 'windows';
    }
    return this.cachedOs;
  }

  /**
   * Probe (once, cached) whether the remote sshd offers an SFTP subsystem.
   * Races an sftp() open against a short timeout so a server that silently
   * refuses the subsystem cannot hang the pool. A dead probe channel is torn
   * down. For jumped endpoints this.client is already the tunneled inner
   * client, so the probe naturally traverses the jump.
   */
  async checkSftp(): Promise<boolean> {
    if (this.sftpAvailable_ !== null) return this.sftpAvailable_;
    const available = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (val: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => finish(false), SFTP_PROBE_TIMEOUT);
      this.client.sftp((err, sftp) => {
        if (err) return finish(false);
        // Cache the wrapper so the first real sftp() call reuses it.
        this.sftpWrapper = sftp;
        const drop = () => {
          if (this.sftpWrapper === sftp) this.sftpWrapper = null;
        };
        sftp.on('close', drop);
        sftp.on('error', drop);
        finish(true);
      });
    });
    this.sftpAvailable_ = available;
    return available;
  }

  /**
   * Open a raw, unbuffered exec channel and hand back the live duplex stream.
   * Unlike exec(), this does not buffer stdout or impose an inactivity timeout
   * — the caller drives data/close. Used for binary-safe streaming on
   * endpoints without SFTP (`cat` to read, `cat > file` to write).
   */
  execChannel(command: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) return reject(new SshConnectionError(this.endpoint.id, `exec failed: ${err.message}`, err));
        resolve(stream);
      });
    });
  }

  /** True if the underlying transport still appears healthy. */
  isAlive(): boolean {
    // ssh2 sets internal sock; a destroyed socket means dead.
    const sock = (this.client as unknown as { _sock?: { destroyed?: boolean; writable?: boolean } })._sock;
    if (!sock) return false;
    return !sock.destroyed && sock.writable !== false;
  }

  end(): void {
    this.sftpWrapper = null;
    try {
      this.client.end();
    } catch {
      /* ignore */
    }
    if (this.jumpClient) {
      try {
        this.jumpClient.end();
      } catch {
        /* ignore */
      }
    }
  }
}

function connectClient(
  endpoint: Endpoint,
  readyTimeoutMs: number,
): Promise<{ client: Client; jumpClient: Client | null }> {
  const readyTimeout = readyTimeoutMs;

  // Direct (no jump).
  if (!endpoint.jump) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      client
        .on('ready', () => resolve({ client, jumpClient: null }))
        .on('error', (err) => reject(new SshConnectionError(endpoint.id, describe(err), err)))
        .connect({
          host: endpoint.conn.host,
          port: endpoint.conn.port,
          username: endpoint.conn.user,
          password: endpoint.conn.password,
          readyTimeout,
        });
    });
  }

  // Single jump hop: connect jump, forwardOut to the target, then SSH over it.
  const jump = endpoint.jump;
  return new Promise((resolve, reject) => {
    const jumpClient = new Client();
    // Tracks the inner (target) client so a late failure can tear it down too.
    let innerClient: Client | null = null;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (innerClient) {
        try {
          innerClient.end();
        } catch {
          /* ignore */
        }
      }
      try {
        jumpClient.end();
      } catch {
        /* ignore */
      }
      const wrapped =
        err instanceof SshConnectionError
          ? err
          : new SshConnectionError(endpoint.id, describe(err as Error), err);
      reject(wrapped);
    };

    jumpClient
      .on('ready', () => {
        jumpClient.forwardOut('127.0.0.1', 0, endpoint.conn.host, endpoint.conn.port, (err, stream) => {
          if (err) return fail(new SshConnectionError(endpoint.id, `jump forward failed: ${err.message}`, err));
          const client = new Client();
          innerClient = client;
          client
            .on('ready', () => {
              if (settled) return;
              settled = true;
              resolve({ client, jumpClient });
            })
            .on('error', (e) => fail(e))
            .connect({
              sock: stream,
              username: endpoint.conn.user,
              password: endpoint.conn.password,
              readyTimeout,
            });
        });
      })
      .on('error', (err) => fail(err))
      .connect({
        host: jump.host,
        port: jump.port,
        username: jump.user,
        password: jump.password,
        readyTimeout,
      });
  });
}

function describe(err: Error): string {
  const m = err.message || String(err);
  if (/authentication|All configured authentication methods failed/i.test(m)) {
    return `SSH authentication failed: ${m}`;
  }
  if (/ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|timed out/i.test(m)) {
    return `SSH connection failed: ${m}`;
  }
  return m;
}

function keyFor(endpoint: Endpoint): string {
  const j = endpoint.jump ? `${endpoint.jump.user}@${endpoint.jump.host}:${endpoint.jump.port}>` : '';
  return `${j}${endpoint.conn.user}@${endpoint.conn.host}:${endpoint.conn.port}`;
}

interface PooledEntry {
  session: SshSession;
  idleSince: number | null; // null => checked out
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Connection pool with handshake timeout, idle eviction, health checks, and a
 * per-endpoint concurrency cap. Satisfies the timeout/health-check/monitoring
 * requirements in CLAUDE.md so a dead remote never hangs the caller.
 */
export class SshPool {
  private readonly buckets = new Map<string, PooledEntry[]>();
  private readonly readyTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxPerKey: number;
  private closed = false;

  constructor(opts: PoolOptions = {}) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
    this.maxPerKey = opts.maxPerKey ?? DEFAULT_MAX_PER_KEY;
  }

  /** Acquire a healthy, OS-detected session for the endpoint. */
  async acquire(endpoint: Endpoint): Promise<SshSession> {
    if (this.closed) throw new SshConnectionError(endpoint.id, 'pool is closed');
    const key = keyFor(endpoint);
    const bucket = this.buckets.get(key) || [];

    // Reuse an idle, healthy session.
    while (bucket.length) {
      const entry = bucket.find((e) => e.idleSince !== null);
      if (!entry) break;
      const idx = bucket.indexOf(entry);
      bucket.splice(idx, 1);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.session.isAlive()) {
        entry.idleSince = null;
        entry.idleTimer = null;
        this.checkout(key, entry);
        return entry.session;
      }
      entry.session.end();
    }

    const { client, jumpClient } = await connectClient(endpoint, this.readyTimeoutMs);
    const session = new SshSession(endpoint, client, jumpClient);
    session.poolKey = key;
    await session.detectOs();
    await session.checkSftp();

    // closeAll() may have run while we were awaiting connect/detectOs. The new
    // session is not yet in any bucket, so closeAll() could not have reached it;
    // tear it down here instead of leaking it.
    if (this.closed) {
      session.end();
      throw new SshConnectionError(endpoint.id, 'pool is closed');
    }

    // Evict the session from the pool if the transport dies underneath us.
    client.on('close', () => this.evict(key, session));
    client.on('error', () => this.evict(key, session));

    const entry: PooledEntry = { session, idleSince: null, idleTimer: null };
    this.checkout(key, entry);
    return session;
  }

  private checkout(key: string, entry: PooledEntry): void {
    const bucket = this.buckets.get(key) || [];
    bucket.push(entry);
    this.buckets.set(key, bucket);
  }

  /** Return a session to the pool (or close it if over capacity / dead). */
  release(session: SshSession): void {
    const key = session.poolKey;
    const bucket = this.buckets.get(key);
    if (!bucket) {
      session.end();
      return;
    }
    const entry = bucket.find((e) => e.session === session);
    if (!entry) {
      session.end();
      return;
    }
    if (this.closed || !session.isAlive() || bucket.filter((e) => e.idleSince !== null).length >= this.maxPerKey) {
      this.evict(key, session);
      return;
    }
    entry.idleSince = Date.now();
    entry.idleTimer = setTimeout(() => this.evict(key, session), this.idleTimeoutMs);
    if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
  }

  private evict(key: string, session: SshSession): void {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      session.end();
      return;
    }
    const idx = bucket.findIndex((e) => e.session === session);
    if (idx >= 0) {
      const [entry] = bucket.splice(idx, 1);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    if (bucket.length === 0) this.buckets.delete(key);
    session.end();
  }

  closeAll(): void {
    this.closed = true;
    for (const [, bucket] of this.buckets) {
      for (const entry of bucket) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.session.end();
      }
    }
    this.buckets.clear();
  }

  /** Convenience: acquire, run, always release. */
  async withSession<T>(endpoint: Endpoint, fn: (s: SshSession) => Promise<T>): Promise<T> {
    const session = await this.acquire(endpoint);
    try {
      return await fn(session);
    } finally {
      this.release(session);
    }
  }
}
