import * as fs from 'fs';
import * as path from 'path';
import { SshSession } from '../connection';
import { RemoteFs } from '../fs';
import { TransferOptions, TransferProgress } from '../types';

function reportFactory(opts: TransferOptions, total: number | null) {
  let bytes = 0;
  return (delta: number, file: string) => {
    bytes += delta;
    if (opts.onProgress) opts.onProgress({ bytes, total, file });
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Transfer cancelled');
}

/** Minimal shape shared by Node streams and ssh2 SFTP streams we drive. */
interface DestroyableReadable {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy(): void;
  pipe(dest: unknown): unknown;
}
interface DestroyableWritable {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy(): void;
}

/**
 * Pipe `rs` -> `ws` to completion. Guarantees that:
 *  - an error on either side tears down BOTH streams (no leaked SFTP channel),
 *  - the AbortSignal listener is always removed,
 *  - the returned promise settles exactly once.
 */
function pipeStreams(
  rs: DestroyableReadable,
  ws: DestroyableWritable,
  report: (delta: number, file: string) => void,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const destroyBoth = () => {
      try {
        rs.destroy();
      } catch {
        /* ignore */
      }
      try {
        ws.destroy();
      } catch {
        /* ignore */
      }
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyBoth();
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    function onAbort(): void {
      fail(new Error('Transfer cancelled'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    rs.on('data', (c: unknown) => report((c as Buffer | string).length, name));
    rs.on('error', (e: unknown) => fail(e as Error));
    ws.on('error', (e: unknown) => fail(e as Error));
    ws.on('close', () => done());
    rs.pipe(ws);
  });
}

/**
 * Cross-machine transfer engine built on the SFTP baseline. Works uniformly for
 * POSIX and Windows endpoints. Remote-to-remote streams through the hub without
 * spilling to disk (the hub is the only machine guaranteed to reach both ends).
 */
export class TransferEngine {
  /** Upload a local file to a remote endpoint. */
  async hubToRemote(
    localPath: string,
    remoteSession: SshSession,
    remotePath: string,
    opts: TransferOptions = {},
  ): Promise<void> {
    throwIfAborted(opts.signal);
    const rfs = new RemoteFs(remoteSession);
    const stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      if (!opts.recursive) throw new Error('Source is a directory; pass recursive');
      await this.hubDirToRemote(localPath, rfs, remotePath, opts);
      return;
    }
    const report = reportFactory(opts, stat.size);
    await this.streamLocalToRemote(localPath, rfs, remotePath, report, opts.signal);
  }

  private async hubDirToRemote(
    localDir: string,
    rfs: RemoteFs,
    remoteDir: string,
    opts: TransferOptions,
  ): Promise<void> {
    await rfs.mkdirp(remoteDir);
    const report = reportFactory(opts, dirSize(localDir));
    const walk = async (lDir: string, rDir: string): Promise<void> => {
      const entries = fs.readdirSync(lDir, { withFileTypes: true });
      for (const e of entries) {
        throwIfAborted(opts.signal);
        const lp = path.join(lDir, e.name);
        const rp = rfs.path.join(rDir, e.name);
        if (e.isDirectory()) {
          await rfs.mkdirp(rp);
          await walk(lp, rp);
        } else if (e.isFile()) {
          await this.streamLocalToRemote(lp, rfs, rp, report, opts.signal);
        }
      }
    };
    await walk(localDir, remoteDir);
  }

  private streamLocalToRemote(
    localPath: string,
    rfs: RemoteFs,
    remotePath: string,
    report: (delta: number, file: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return rfs['session'].sftp().then((sftp) => {
      const name = path.basename(localPath);
      const rs = fs.createReadStream(localPath);
      const ws = sftp.createWriteStream(remotePath);
      return pipeStreams(rs as unknown as DestroyableReadable, ws as unknown as DestroyableWritable, report, name, signal);
    });
  }

  /** Download a remote file/dir to the hub. */
  async remoteToHub(
    remoteSession: SshSession,
    remotePath: string,
    localPath: string,
    opts: TransferOptions = {},
  ): Promise<void> {
    throwIfAborted(opts.signal);
    const rfs = new RemoteFs(remoteSession);
    const resolved = await rfs.expandHome(remotePath);
    const st = await rfs.stat(resolved);
    if (st.type === 'dir') {
      if (!opts.recursive) throw new Error('Source is a directory; pass recursive');
      await this.remoteDirToHub(rfs, resolved, localPath, opts);
      return;
    }
    const report = reportFactory(opts, st.size);
    await this.streamRemoteToLocal(rfs, resolved, localPath, report, opts.signal);
  }

  private async remoteDirToHub(
    rfs: RemoteFs,
    remoteDir: string,
    localDir: string,
    opts: TransferOptions,
  ): Promise<void> {
    fs.mkdirSync(localDir, { recursive: true });
    const entries = await rfs.list(remoteDir, { recursive: false, includeHidden: true });
    const report = reportFactory(opts, null);
    for (const e of entries) {
      throwIfAborted(opts.signal);
      const lp = path.join(localDir, e.name);
      if (e.type === 'dir') {
        await this.remoteDirToHub(rfs, e.path, lp, opts);
      } else if (e.type === 'file') {
        await this.streamRemoteToLocal(rfs, e.path, lp, report, opts.signal);
      }
    }
  }

  private streamRemoteToLocal(
    rfs: RemoteFs,
    remotePath: string,
    localPath: string,
    report: (delta: number, file: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return rfs['session'].sftp().then((sftp) => {
      const name = path.basename(remotePath);
      const rs = sftp.createReadStream(remotePath);
      const ws = fs.createWriteStream(localPath);
      return pipeStreams(rs as unknown as DestroyableReadable, ws as unknown as DestroyableWritable, report, name, signal);
    });
  }

  /**
   * Remote A -> remote B, relayed through the hub over SFTP with no disk spill.
   * Works regardless of OS or whether A can reach B directly.
   */
  async remoteToRemote(
    srcSession: SshSession,
    srcPath: string,
    dstSession: SshSession,
    dstPath: string,
    opts: TransferOptions = {},
  ): Promise<void> {
    throwIfAborted(opts.signal);
    const srcFs = new RemoteFs(srcSession);
    const dstFs = new RemoteFs(dstSession);
    const resolvedSrc = await srcFs.expandHome(srcPath);
    const st = await srcFs.stat(resolvedSrc);
    if (st.type === 'dir') {
      if (!opts.recursive) throw new Error('Source is a directory; pass recursive');
      await this.relayDir(srcFs, resolvedSrc, dstFs, dstPath, opts);
      return;
    }
    const report = reportFactory(opts, st.size);
    await this.relayFile(srcFs, resolvedSrc, dstFs, dstPath, report, opts.signal);
  }

  private async relayDir(
    srcFs: RemoteFs,
    srcDir: string,
    dstFs: RemoteFs,
    dstDir: string,
    opts: TransferOptions,
  ): Promise<void> {
    await dstFs.mkdirp(dstDir);
    const entries = await srcFs.list(srcDir, { recursive: false, includeHidden: true });
    const report = reportFactory(opts, null);
    for (const e of entries) {
      throwIfAborted(opts.signal);
      const dp = dstFs.path.join(dstDir, e.name);
      if (e.type === 'dir') {
        await this.relayDir(srcFs, e.path, dstFs, dp, opts);
      } else if (e.type === 'file') {
        await this.relayFile(srcFs, e.path, dstFs, dp, report, opts.signal);
      }
    }
  }

  private async relayFile(
    srcFs: RemoteFs,
    srcPath: string,
    dstFs: RemoteFs,
    dstPath: string,
    report: (delta: number, file: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const srcSftp = await srcFs['session'].sftp();
    const dstSftp = await dstFs['session'].sftp();
    const name = srcFs.path.basename(srcPath);
    const rs = srcSftp.createReadStream(srcPath);
    const ws = dstSftp.createWriteStream(dstPath);
    await pipeStreams(rs as unknown as DestroyableReadable, ws as unknown as DestroyableWritable, report, name, signal);
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}

export type { TransferProgress };
