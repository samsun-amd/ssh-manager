export type RemoteOs = 'posix' | 'windows';

export interface SshCredentials {
  host: string;
  port: number;
  user: string;
  password?: string;
}

/**
 * A fully resolved SSH target. Flattens the sshm inventory shapes
 * (client / server-bmc / server-host / smc) into one object with an
 * optional single jump hop (the BMC for host/smc targets).
 */
export interface Endpoint {
  /** Stable label, e.g. "client" or "server1/host2" or "server1/smc". */
  id: string;
  /** Final destination credentials. */
  conn: SshCredentials;
  /** Optional single jump hop (BMC). */
  jump?: SshCredentials;
  /** Known OS, if declared in config; otherwise probed on first connect. */
  os?: RemoteOs;
}

/** A raw entry in ssh_remote.json (subset of fields we read). */
export interface InventoryNode {
  type: 'client' | 'server' | 'smc';
  name: string;
  ip?: string;
  user?: string;
  pass?: string;
  port?: number;
  os?: RemoteOs;
  note?: string;
  bmc?: { ip: string; user: string; pass?: string; port?: number; os?: RemoteOs };
  hosts?: Array<{ ip: string; user: string; pass?: string; port?: number; os?: RemoteOs }>;
}

/** Summary row for listing the inventory (mirrors `sshm -l`). */
export interface InventorySummary {
  num: number;
  type: string;
  name: string;
  endpoint: string;
}

export interface DirEntry {
  name: string;
  /** Full path of the entry on the remote, in the remote's path style. */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  /** Modification time in epoch milliseconds, or null if unknown. */
  mtime: number | null;
  mode: number;
}

export interface ListOptions {
  /** When set, only files whose name matches are returned (dirs always kept). */
  extensions?: string[];
  recursive?: boolean;
  /** Include dotfiles. Default false. */
  includeHidden?: boolean;
}

export interface PoolOptions {
  /** ssh2 handshake timeout in ms. Default 15000. */
  readyTimeoutMs?: number;
  /** Idle connection eviction in ms. Default 60000. */
  idleTimeoutMs?: number;
  /** Max concurrently pooled sessions per endpoint key. Default 4. */
  maxPerKey?: number;
}

export type TransferDirection = 'hubToRemote' | 'remoteToHub' | 'remoteToRemote';

export interface TransferProgress {
  bytes: number;
  total: number | null;
  file: string;
}

export interface TransferOptions {
  recursive?: boolean;
  onProgress?: (p: TransferProgress) => void;
  /** Abort signal so the server can cancel a queued/active job. */
  signal?: AbortSignal;
}

/** A structured connection error so callers can map to HTTP status. */
export class SshConnectionError extends Error {
  readonly endpointId: string;
  readonly cause?: unknown;
  constructor(endpointId: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'SshConnectionError';
    this.endpointId = endpointId;
    this.cause = cause;
  }
}
