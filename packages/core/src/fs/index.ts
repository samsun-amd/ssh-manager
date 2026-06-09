import { Stats, SFTPWrapper } from 'ssh2';
import { SshSession } from '../connection';
import { DirEntry, ListOptions, RemoteOs } from '../types';
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

  /** Resolve the remote home directory (for `~` expansion). Cached. */
  async home(): Promise<string> {
    if (this.homeCache) return this.homeCache;
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
    const sftp = await this.sftp();
    const raw = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list as never)));
    });

    const exts = opts.extensions?.map((e) => e.toLowerCase().replace(/^\./, ''));
    const out: DirEntry[] = [];
    for (const item of raw) {
      const name = item.filename;
      if (!opts.includeHidden && name.startsWith('.')) continue;
      const full = this.path.join(dir, name);
      const type = entryType(item.attrs.mode);
      if (type === 'file' && exts && exts.length) {
        const dot = name.lastIndexOf('.');
        const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
        if (!exts.includes(ext)) continue;
      }
      const entry: DirEntry = {
        name,
        path: full,
        type,
        size: item.attrs.size ?? 0,
        mtime: item.attrs.mtime ? item.attrs.mtime * 1000 : null,
        mode: item.attrs.mode,
      };
      out.push(entry);
      if (opts.recursive && type === 'dir') {
        const children = await this.listResolved(full, opts);
        out.push(...children);
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  async readFile(p: string): Promise<Buffer> {
    const target = await this.expandHome(p);
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
    const sftp = await this.sftp();
    return new Promise<void>((resolve, reject) => {
      sftp.rename(src, dst, (err) => (err ? reject(err) : resolve()));
    });
  }

  async remove(p: string): Promise<void> {
    const target = await this.expandHome(p);
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
