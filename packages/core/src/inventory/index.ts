import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Endpoint,
  InventoryNode,
  InventorySummary,
  SshCredentials,
} from '../types';

const DEFAULT_PORT = 22;

/**
 * Resolve the inventory file path, mirroring sshm precedence:
 *   $SSH_REMOTE_JSON  >  ~/note/ssh_remote.json
 * No hardcoded absolute paths (CLAUDE.md portability).
 */
export function resolveInventoryPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SSH_REMOTE_JSON) return process.env.SSH_REMOTE_JSON;
  return path.join(os.homedir(), 'note', 'ssh_remote.json');
}

function credsFrom(
  src: { ip?: string; user?: string; pass?: string; port?: number } | undefined,
): SshCredentials | null {
  if (!src || !src.ip || !src.user) return null;
  return {
    host: src.ip,
    user: src.user,
    password: src.pass,
    port: src.port && src.port > 0 ? src.port : DEFAULT_PORT,
  };
}

export class Inventory {
  private readonly nodes: InventoryNode[];

  constructor(nodes: InventoryNode[]) {
    this.nodes = nodes;
  }

  static load(explicitPath?: string): Inventory {
    const file = resolveInventoryPath(explicitPath);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Inventory must be a JSON array: ${file}`);
    }
    return new Inventory(parsed as InventoryNode[]);
  }

  raw(): InventoryNode[] {
    return this.nodes;
  }

  /** Mirror of `sshm -l`. */
  list(): InventorySummary[] {
    return this.nodes.map((n, i) => {
      const num = i + 1;
      if (n.type === 'client') {
        return { num, type: 'Client', name: n.name, endpoint: endpointStr(n.ip, n.port) };
      }
      if (n.type === 'server') {
        const hosts = (n.hosts || []).map((h) => endpointStr(h.ip, h.port)).join(',');
        const smc = n.smc ? `, SMC: ${endpointStr(n.smc.ip, n.smc.port)} (via BMC)` : '';
        return {
          num,
          type: 'Server',
          name: n.name,
          endpoint: `BMC: ${endpointStr(n.bmc?.ip, n.bmc?.port)}, Hosts: ${hosts}${smc}`,
        };
      }
      return { num, type: 'Unknown', name: n.name || 'unnamed', endpoint: 'Unsupported' };
    });
  }

  private findNode(selector: string): { node: InventoryNode; index: number } | null {
    // Number (1-based), matching sshm.
    if (/^[0-9]+$/.test(selector)) {
      const idx = parseInt(selector, 10) - 1;
      if (idx >= 0 && idx < this.nodes.length) return { node: this.nodes[idx], index: idx };
      return null;
    }
    // Name.
    const byName = this.nodes.findIndex((n) => n.name === selector);
    if (byName >= 0) return { node: this.nodes[byName], index: byName };
    return null;
  }

  /**
   * Resolve a selector (+ optional sub-target) into an Endpoint, mirroring sshm:
   *   resolve("client")            -> client direct
   *   resolve("3")                 -> 3rd node, default connection
   *   resolve("1.2.3.4")           -> IP search across client/smc/bmc/hosts
   *   resolve("server1", "bmc")    -> the BMC directly
   *   resolve("server1", "host2")  -> host #2 directly (no jump)
   *   resolve("server1", "smc")    -> this server's embedded SMC via its BMC jump
   */
  resolve(selector: string, sub?: string): Endpoint {
    // IP search has no sub-target.
    if (!sub && /^[0-9.]+$/.test(selector) && selector.includes('.')) {
      const ep = this.resolveByIp(selector);
      if (ep) return ep;
      throw new Error(`No inventory entry with IP ${selector}`);
    }

    const found = this.findNode(selector);
    if (!found) throw new Error(`Target '${selector}' not found in inventory`);
    const { node } = found;
    const label = node.name || selector;

    if (!sub) return defaultEndpoint(node, label);

    if (sub === 'bmc') {
      const conn = credsFrom(node.bmc);
      if (!conn) throw new Error(`'${label}' has no BMC connection`);
      return { id: `${label}/bmc`, conn, os: node.bmc?.os };
    }

    if (sub === 'smc') {
      const jump = credsFrom(node.bmc);
      if (!jump) throw new Error(`'${label}' is not a server with BMC; SMC needs a BMC jump`);
      const conn = credsFrom(node.smc);
      if (!conn) throw new Error(`'${label}' has no embedded SMC`);
      return { id: `${label}/smc`, conn, jump, os: node.smc?.os };
    }

    const hostMatch = /^host([0-9]+)$/.exec(sub);
    if (hostMatch) {
      const hi = parseInt(hostMatch[1], 10) - 1;
      const host = node.hosts && node.hosts[hi];
      const conn = credsFrom(host);
      if (!conn) throw new Error(`${label} ${sub} not defined`);
      // Hosts are reachable directly (their ip is a routable address); only the
      // SMC sits on an internal net behind the BMC jump.
      return { id: `${label}/${sub}`, conn, os: host?.os };
    }

    throw new Error(`Unknown sub-target '${sub}' for '${label}'`);
  }

  private resolveByIp(ip: string): Endpoint | null {
    for (const node of this.nodes) {
      if (node.type === 'client' && node.ip === ip) {
        const conn = credsFrom(node);
        if (conn) return { id: node.name, conn, os: node.os };
      }
      if (node.type === 'server') {
        if (node.bmc?.ip === ip) {
          const conn = credsFrom(node.bmc);
          if (conn) return { id: `${node.name}/bmc`, conn, os: node.bmc?.os };
        }
        if (node.smc?.ip === ip) {
          const conn = credsFrom(node.smc);
          const jump = credsFrom(node.bmc) || undefined;
          if (conn) return { id: `${node.name}/smc`, conn, jump, os: node.smc?.os };
        }
        for (let h = 0; h < (node.hosts?.length || 0); h += 1) {
          const host = node.hosts![h];
          if (host.ip === ip) {
            const conn = credsFrom(host);
            if (conn) {
              // Hosts connect directly; no BMC jump.
              return { id: `${node.name}/host${h + 1}`, conn, os: host.os };
            }
          }
        }
      }
    }
    return null;
  }
}

/**
 * The "bare name" behavior of sshm: client/smc use their top-level creds,
 * server uses its BMC.
 */
function defaultEndpoint(node: InventoryNode, label: string): Endpoint {
  if (node.type === 'client') {
    const conn = credsFrom(node);
    if (!conn) throw new Error(`Incomplete connection config for '${label}'`);
    return { id: label, conn, os: node.os };
  }
  if (node.type === 'server') {
    const conn = credsFrom(node.bmc);
    if (!conn) throw new Error(`Incomplete BMC config for '${label}'`);
    return { id: `${label}/bmc`, conn, os: node.bmc?.os };
  }
  throw new Error(`Unsupported node type '${node.type}' for '${label}'`);
}

function endpointStr(ip?: string, port?: number): string {
  if (!ip) return '';
  if (!port || port === DEFAULT_PORT) return ip;
  return `${ip}:${port}`;
}

/** Build an ad-hoc endpoint from explicit fields (not persisted to config). */
export function adhocEndpoint(input: {
  host: string;
  port?: number;
  user: string;
  password?: string;
  os?: 'posix' | 'windows';
  jump?: { host: string; port?: number; user: string; password?: string };
  label?: string;
}): Endpoint {
  const conn: SshCredentials = {
    host: input.host,
    port: input.port && input.port > 0 ? input.port : DEFAULT_PORT,
    user: input.user,
    password: input.password,
  };
  const jump = input.jump
    ? {
        host: input.jump.host,
        port: input.jump.port && input.jump.port > 0 ? input.jump.port : DEFAULT_PORT,
        user: input.jump.user,
        password: input.jump.password,
      }
    : undefined;
  return { id: input.label || `adhoc:${input.host}`, conn, jump, os: input.os };
}
