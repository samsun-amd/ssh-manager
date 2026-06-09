import { RemoteOs } from '../types';

/**
 * Path helper that picks separator / drive semantics by remote OS. The UI must
 * never mis-split a Windows `C:\...` path with POSIX rules. ssh2's SFTP accepts
 * forward slashes on Windows OpenSSH too, so we normalize *display* to the OS
 * style but always send forward slashes over the wire.
 */
export class RemotePath {
  readonly os: RemoteOs;

  constructor(os: RemoteOs) {
    this.os = os;
  }

  get sep(): string {
    return this.os === 'windows' ? '\\' : '/';
  }

  /** True when path is absolute for this OS. */
  isAbsolute(p: string): boolean {
    if (this.os === 'windows') {
      return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p);
    }
    return p.startsWith('/');
  }

  /** Split into segments, drive-aware for Windows. */
  split(p: string): string[] {
    const norm = p.replace(/\\/g, '/');
    return norm.split('/').filter((s) => s.length > 0);
  }

  basename(p: string): string {
    const parts = this.split(p);
    return parts.length ? parts[parts.length - 1] : '';
  }

  dirname(p: string): string {
    const norm = p.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    if (idx <= 0) return this.os === 'windows' ? this.driveRoot(p) : '/';
    const head = norm.slice(0, idx);
    // On Windows, a slice that lands right after the drive (e.g. "C:") is a
    // drive-relative path, not the drive root. Keep the root separator.
    if (this.os === 'windows' && /^[a-zA-Z]:$/.test(head)) return `${head}/`;
    return head;
  }

  private driveRoot(p: string): string {
    const m = /^([a-zA-Z]:)/.exec(p);
    return m ? `${m[1]}/` : '/';
  }

  /** Join segments using forward slashes (wire format, valid on both OSes). */
  join(...parts: string[]): string {
    const cleaned: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      let seg = parts[i].replace(/\\/g, '/');
      if (i > 0) seg = seg.replace(/^\/+/, '');
      seg = seg.replace(/\/+$/, '');
      if (seg.length) cleaned.push(seg);
    }
    const joined = cleaned.join('/');
    // Preserve a leading slash for POSIX absolute inputs.
    if (this.os !== 'windows' && parts[0]?.startsWith('/')) {
      return `/${joined}`.replace(/\/{2,}/g, '/');
    }
    return joined;
  }

  /**
   * Normalize to the wire format (forward slashes) and collapse `.`/`..`.
   * Used for the security boundary check, so `..` cannot escape a root.
   */
  normalize(p: string): string {
    const isAbs = this.isAbsolute(p);
    let drive = '';
    let body = p.replace(/\\/g, '/');
    if (this.os === 'windows') {
      const m = /^([a-zA-Z]:)(.*)$/.exec(body);
      if (m) {
        drive = m[1];
        body = m[2];
      }
    }
    const segs = body.split('/').filter((s) => s.length > 0);
    const out: string[] = [];
    for (const s of segs) {
      if (s === '.') continue;
      if (s === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!isAbs) out.push('..');
        continue;
      }
      out.push(s);
    }
    const joined = out.join('/');
    if (drive) return joined ? `${drive}/${joined}` : `${drive}/`;
    return isAbs ? `/${joined}` : joined;
  }

  /** True if child is at or below parent (string-prefix boundary check). */
  isUnder(parent: string, child: string): boolean {
    const np = this.normalize(parent).replace(/\/+$/, '');
    const nc = this.normalize(child).replace(/\/+$/, '');
    const cmpP = this.os === 'windows' ? np.toLowerCase() : np;
    const cmpC = this.os === 'windows' ? nc.toLowerCase() : nc;
    return cmpC === cmpP || cmpC.startsWith(`${cmpP}/`);
  }
}
