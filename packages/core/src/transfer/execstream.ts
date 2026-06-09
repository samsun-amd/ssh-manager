import { PassThrough, Readable, Writable } from 'stream';
import { SshSession } from '../connection';
import { SshConnectionError } from '../types';

/** Single-quote a path for POSIX sh, escaping embedded single quotes. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * A binary-safe read stream over `cat` for endpoints without SFTP. Stdout is
 * piped through a PassThrough; the stream ends only when the remote `cat`
 * finishes, and a nonzero exit (e.g. missing file) surfaces as an error rather
 * than a silent empty read.
 */
export async function execReadStream(session: SshSession, path: string): Promise<Readable> {
  const ch = await session.execChannel(`cat -- ${shQuote(path)}`);
  const out = new PassThrough();
  let stderr = '';
  ch.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  // Drive end/error from the channel exit, not the stdout EOF, so a failed cat
  // cannot look like a clean empty file.
  ch.pipe(out, { end: false });
  ch.on('error', (e: Error) => out.destroy(e));
  ch.on('close', (code: number | string) => {
    const c = Number(code) || 0;
    if (c !== 0) {
      out.destroy(new SshConnectionError(session.endpoint.id, stderr.trim() || `cat exit ${c}`));
    } else {
      out.end();
    }
  });
  // Tearing down the consumer must also kill the remote channel.
  out.on('close', () => {
    try {
      ch.close();
    } catch {
      /* ignore */
    }
  });
  return out;
}

/**
 * A binary-safe write stream over `cat > file` for endpoints without SFTP.
 * Critically, 'close' is emitted only after the remote process exits with code
 * 0 — never on stdin flush alone — so an upload can never be silently
 * truncated. A nonzero exit surfaces as an error.
 */
export async function execWriteStream(session: SshSession, path: string): Promise<Writable> {
  const ch = await session.execChannel(`cat > ${shQuote(path)}`);
  // `cat > file` produces no stdout, but an ssh2 channel will not emit 'close'
  // / 'exit' until its stdout side is drained. Resume it (and discard the
  // bytes) so the remote exit status is delivered after stdin EOF.
  ch.resume();
  let stderr = '';
  let exitCb: ((err?: Error) => void) | null = null;
  let exit: { code: number } | null = null;
  ch.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

  const settle = (): void => {
    if (!exitCb || !exit) return;
    const cb = exitCb;
    exitCb = null;
    if (exit.code !== 0) {
      cb(new SshConnectionError(session.endpoint.id, stderr.trim() || `cat exit ${exit.code}`));
    } else {
      cb();
    }
  };

  ch.on('close', (code: number | string) => {
    exit = { code: Number(code) || 0 };
    settle();
  });

  return new Writable({
    write(chunk, _enc, cb): void {
      if (ch.write(chunk)) cb();
      else ch.once('drain', cb);
    },
    final(cb): void {
      // Close stdin, then resolve only once the remote confirms exit status.
      exitCb = cb;
      ch.end();
      settle();
    },
    destroy(err, cb): void {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
      cb(err);
    },
  });
}
