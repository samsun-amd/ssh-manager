import { Stats, SFTPWrapper } from 'ssh2';
import { SshSession } from '../connection';
import { DirEntry, ListOptions, RemoteOs, SshConnectionError } from '../types';
import { RemotePath } from './pathutil';

export { RemotePath } from './pathutil';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function entryType(mode: number): DirEntry['type'] {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFLNK) return 'symlink';
  if (t === S_IFREG) return 'file';
  return 'other';
}

/** Map BusyBox/coreutils `stat -c %F` text to a DirEntry type. */
function fileTypeFromStat(desc: string): DirEntry['type'] {
  const d = desc.trim().toLowerCase();
  if (d === 'directory') return 'dir';
  if (d === 'symbolic link') return 'symlink';
  if (d === 'regular file' || d === 'regular empty file') return 'file';
  return 'other';
}

/** Single-quote a path for POSIX sh, escaping embedded single quotes. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Promisified, OS-aware SFTP file operations over a live session. */
export class RemoteFs {
  private readonly session: SshSession;
  readonly path: RemotePath;
  private homeCache: string | null = null;

  constructor(session: SshSession) {
    this.session = session;
    const os: RemoteOs = session.os || 'posix';
    this.path = new RemotePath(os);
  }

  private sftp(): Promise<SFTPWrapper> {
    return this.session.sftp();
  }

  /** True when this session has no SFTP subsystem and must use exec fallback. */
  private get execOnly(): boolean {
    return this.session.sftpAvailable === false;
  }

  /** Run an exec command, throwing a structured error on nonzero exit. */
  private async run(command: string): Promise<string> {
    const res = await this.session.exec(command);
    if (res.code !== 0) {
      const detail = res.stderr.trim() || `exit ${res.code}`;
      throw new SshConnectionError(this.session.endpoint.id, detail);
    }
    return res.stdout;
  }

  /** Resolve the remote home directory (for `~` expansion). Cached. */
  async home(): Promise<string> {
    if (this.homeCache) return this.homeCache;
    if (this.execOnly) {
      const out = await this.run('printf %s "${HOME:-$(pwd)}"');
      this.homeCache = out.trim().replace(/\\/g, '/') || '/';
      return this.homeCache;
    }
    // SFTP realpath('.') resolves to the login directory on both POSIX and
    // Windows OpenSSH — no shell needed, so it works for Windows too.
    const sftp = await this.sftp();
    this.homeCache = await new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, abs) => {
        if (err) return reject(err);
        resolve(abs.replace(/\\/g, '/'));
      });
    });
    return this.homeCache;
  }

  /** Expand a leading `~` against the remote home (never the local home). */
  async expandHome(p: string): Promise<string> {
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
      const home = await this.home();
      const rest = p.slice(1).replace(/^[\\/]/, '');
      return rest ? this.path.join(home, rest) : home;
    }
    return p;
  }

  async stat(p: string): Promise<DirEntry> {
    const target = await this.expandHome(p);
    if (this.execOnly) {
      const out = await this.run(`stat -c '%F|%s|%Y' -- ${shQuote(target)}`);
      const [desc, size, mtime] = out.trim().split('|');
      return {
        name: this.path.basename(target),
        path: target,
        type: fileTypeFromStat(desc || ''),
        size: Number(size) || 0,
        mtime: mtime ? Number(mtime) * 1000 : null,
        mode: 0,
      };
    }
    const sftp = await this.sftp();
    const st = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(target, (err, s) => (err ? reject(err) : resolve(s)));
    });
    return {
      name: this.path.basename(target),
      path: target,
      type: entryType(st.mode),
      size: st.size ?? 0,
      mtime: st.mtime ? st.mtime * 1000 : null,
      mode: st.mode,
    };
  }

  async list(dir: string, opts: ListOptions = {}): Promise<DirEntry[]> {
    const target = await this.expandHome(dir);
    return this.listResolved(target, opts);
  }

  private async listResolved(dir: string, opts: ListOptions): Promise<DirEntry[]> {
    const raw = this.execOnly ? await this.readdirExec(dir) : await this.readdirSftp(dir);

    const exts = opts.extensions?.map((e) => e.toLowerCase().replace(/^\./, ''));
    const out: DirEntry[] = [];
    for (const item of raw) {
      const name = item.name;
      if (!opts.includeHidden && name.startsWith('.')) continue;
      const type = item.type;
      if (type === 'file' && exts && exts.length) {
        const dot = name.lastIndexOf('.');
        const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
        if (!exts.includes(ext)) continue;
      }
      out.push({ name, path: item.path, type, size: item.size, mtime: item.mtime, mode: item.mode });
      if (opts.recursive && type === 'dir') {
        const children = await this.listResolved(item.path, opts);
        out.push(...children);
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  /** Raw one-level read over SFTP. */
  private async readdirSftp(dir: string): Promise<DirEntry[]> {
    const sftp = await this.sftp();
    const raw = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list as never)));
    });
    return raw.map((item) => ({
      name: item.filename,
      path: this.path.join(dir, item.filename),
      type: entryType(item.attrs.mode),
      size: item.attrs.size ?? 0,
      mtime: item.attrs.mtime ? item.attrs.mtime * 1000 : null,
      mode: item.attrs.mode,
    }));
  }

  /**
   * Raw one-level read over exec (no SFTP). One round trip lists the dir and
   * stats every child. The path field (%n) is last so spaces/`|` in names stay
   * intact — only the first three `|` are significant. Filenames containing a
   * literal newline are not supported (line-based parsing); acceptable for the
   * embedded targets this path serves.
   */
  private async readdirExec(dir: string): Promise<DirEntry[]> {
    const cmd =
      `find ${shQuote(dir)} -maxdepth 1 -mindepth 1 ` +
      `-exec stat -c '%F|%s|%Y|%n' -- {} ';'`;
    const out = await this.run(cmd);
    const entries: DirEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const i1 = line.indexOf('|');
      const i2 = line.indexOf('|', i1 + 1);
      const i3 = line.indexOf('|', i2 + 1);
      if (i1 < 0 || i2 < 0 || i3 < 0) continue;
      const desc = line.slice(0, i1);
      const size = line.slice(i1 + 1, i2);
      const mtime = line.slice(i2 + 1, i3);
      const full = line.slice(i3 + 1);
      entries.push({
        name: this.path.basename(full),
        path: full,
        type: fileTypeFromStat(desc),
        size: Number(size) || 0,
        mtime: mtime ? Number(mtime) * 1000 : null,
        mode: 0,
      });
    }
    return entries;
  }

  async readFile(p: string): Promise<Buffer> {
    const target = await this.expandHome(p);
    if (this.execOnly) {
      const ch = await this.session.execChannel(`cat -- ${shQuote(target)}`);
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let stderr = '';
        ch.on('data', (c: Buffer) => chunks.push(c));
        ch.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        ch.on('error', reject);
        ch.on('close', (code: number | string) => {
          const c = Number(code) || 0;
          if (c !== 0) {
            return reject(new SshConnectionError(this.session.endpoint.id, stderr.trim() || `cat exit ${c}`));
          }
          resolve(Buffer.concat(chunks));
        });
      });
    }
    const sftp = await this.sftp();
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(target);
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    const target = await this.expandHome(p);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (this.execOnly) {
      const ch = await this.session.execChannel(`cat > ${shQuote(target)}`);
      ch.resume(); // drain empty stdout so 'close' fires after stdin EOF
      return new Promise<void>((resolve, reject) => {
        let stderr = '';
        ch.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        ch.on('error', reject);
        ch.on('close', (code: number | string) => {
          const c = Number(code) || 0;
          if (c !== 0) {
            return reject(new SshConnectionError(this.session.endpoint.id, stderr.trim() || `cat exit ${c}`));
          }
          resolve();
        });
        ch.end(buf);
      });
    }
    const sftp = await this.sftp();
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(target);
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(buf);
    });
  }

  async mkdirp(p: string): Promise<void> {
    const target = await this.expandHome(p);
    if (this.execOnly) {
      await this.run(`mkdir -p -- ${shQuote(target)}`);
      return;
    }
    const sftp = await this.sftp();
    const parts = this.path.split(target);
    const absolute = this.path.isAbsolute(target);
    let prefix = '';
    if (absolute && this.path.os === 'windows') {
      // Keep the drive (e.g. "C:") as the first prefix segment.
      prefix = parts.shift() || '';
    } else if (absolute) {
      prefix = '';
    }
    let cur = prefix;
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : absolute && this.path.os !== 'windows' ? `/${seg}` : seg;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        sftp.mkdir(cur, () => resolve()); // ignore "exists" errors
      });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.expandHome(from);
    const dst = await this.expandHome(to);
    if (this.execOnly) {
      await this.run(`mv -- ${shQuote(src)} ${shQuote(dst)}`);
      return;
    }
    const sftp = await this.sftp();
    return new Promise<void>((resolve, reject) => {
      sftp.rename(src, dst, (err) => (err ? reject(err) : resolve()));
    });
  }

  async remove(p: string): Promise<void> {
    const target = await this.expandHome(p);
    if (this.execOnly) {
      await this.run(`rm -rf -- ${shQuote(target)}`);
      return;
    }
    const st = await this.stat(target);
    if (st.type === 'dir') {
      await this.removeDir(target);
    } else {
      const sftp = await this.sftp();
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(target, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  private async removeDir(dir: string): Promise<void> {
    const children = await this.listResolved(dir, { includeHidden: true });
    for (const child of children) {
      if (child.type === 'dir') {
        // eslint-disable-next-line no-await-in-loop
        await this.removeDir(child.path);
      } else {
        const sftp = await this.sftp();
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(child.path, (err) => (err ? reject(err) : resolve()));
        });
      }
    }
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(dir, (err) => (err ? reject(err) : resolve()));
    });
  }
}
