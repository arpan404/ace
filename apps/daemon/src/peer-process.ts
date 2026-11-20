import { execFile } from "node:child_process";
import { readlinkSync, readdirSync, readFileSync } from "node:fs";
import type { ProcessListing } from "@ace/provider-kit/process-listing";
import type { TreeMember } from "@ace/provider-kit/process-tree";

/*
 * Who is on the other end of a local request. The daemon listens on loopback TCP, which carries
 * no peer credentials (SO_PEERCRED and LOCAL_PEERPID are Unix-socket options), so a claimed
 * caller is checked instead: the claimed process must hold the client end of this exact
 * connection, its local port being the server's remote port and its remote port the server's
 * local one. Linux: the claimed process's own /proc view of its TCP sockets and its open
 * descriptors. macOS: `lsof`, asked about that one process only. Anything else verifies nobody.
 */

/** A loopback connection as the server sees it. */
export type Connection = { remotePort: number; localPort: number };

/** A `/proc/net/tcp` address's port: the hex after its colon. */
const procPort = (address: string) => Number.parseInt(address.slice(address.indexOf(":") + 1), 16);

/** `/proc/<pid>/net/tcp` or `tcp6`: established sockets' ports and inodes. */
export function parseProcTcp(
  text: string,
): { localPort: number; remotePort: number; inode: string }[] {
  const rows: { localPort: number; remotePort: number; inode: string }[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [local, remote, state, inode] = [fields[1], fields[2], fields[3], fields[9]];
    // 01: TCP_ESTABLISHED.
    if (!local || !remote || state !== "01" || !inode || !/^\d+$/.test(inode)) continue;
    rows.push({ localPort: procPort(local), remotePort: procPort(remote), inode });
  }
  return rows;
}

/** `lsof -F n` names of TCP sockets: each `local->remote` pair's ports. */
export function parseLsofTcp(text: string): { localPort: number; remotePort: number }[] {
  const pairs: { localPort: number; remotePort: number }[] = [];
  for (const line of text.split("\n")) {
    const match = /^n.*:(\d+)->.*:(\d+)$/.exec(line.trim());
    if (match) pairs.push({ localPort: Number(match[1]), remotePort: Number(match[2]) });
  }
  return pairs;
}

export interface PeerIo {
  platform: NodeJS.Platform;
  read(path: string): string | undefined;
  list(path: string): string[] | undefined;
  link(path: string): string | undefined;
  lsof(pid: number): Promise<string | undefined>;
}

export const systemPeerIo: PeerIo = {
  platform: process.platform,
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return undefined;
    }
  },
  link(path) {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  },
  lsof: (pid) =>
    new Promise((resolve) => {
      execFile(
        "/usr/sbin/lsof",
        ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"],
        { timeout: 2_000, maxBuffer: 1_048_576 },
        (error, stdout) => resolve(error && !stdout ? undefined : stdout),
      );
    }),
};

/** Whether process `pid` holds the client end of `connection`. */
export async function holdsConnection(
  pid: number,
  connection: Connection,
  io: PeerIo = systemPeerIo,
): Promise<boolean> {
  const client = { localPort: connection.remotePort, remotePort: connection.localPort };
  if (io.platform === "linux") {
    const rows = [
      ...parseProcTcp(io.read(`/proc/${pid}/net/tcp`) ?? ""),
      ...parseProcTcp(io.read(`/proc/${pid}/net/tcp6`) ?? ""),
    ].filter((row) => row.localPort === client.localPort && row.remotePort === client.remotePort);
    if (!rows.length) return false;
    const held = new Set(
      (io.list(`/proc/${pid}/fd`) ?? []).map((fd) => io.link(`/proc/${pid}/fd/${fd}`)),
    );
    return rows.some((row) => held.has(`socket:[${row.inode}]`));
  }
  if (io.platform === "darwin") {
    const text = await io.lsof(pid);
    return parseLsofTcp(text ?? "").some(
      (pair) => pair.localPort === client.localPort && pair.remotePort === client.remotePort,
    );
  }
  return false;
}

/** `pid` and its real ancestors, by kernel identity, up to init. */
export function realChain(pid: number, listing: ProcessListing): TreeMember[] {
  const chain: TreeMember[] = [];
  const seen = new Set<number>();
  for (let next: number | undefined = pid; next !== undefined && next > 1 && !seen.has(next);) {
    seen.add(next);
    const info = listing.info(next);
    if (!info || info.zombie) break;
    chain.push({ pid: next, start: info.start });
    next = info.parent;
  }
  return chain;
}

/**
 * The caller chain a stop request may spare: the real ancestry of the process holding this
 * connection, read by the daemon itself. The client's list is only a hint naming that process;
 * it must match the real chain exactly, or nothing is spared.
 */
export async function verifiedCaller(
  hint: readonly TreeMember[] | undefined,
  connection: Connection,
  listing: ProcessListing,
  io: PeerIo = systemPeerIo,
): Promise<TreeMember[]> {
  const claimed = hint?.[0];
  if (!hint || !claimed) return [];
  if (!(await holdsConnection(claimed.pid, connection, io))) return [];
  const chain = realChain(claimed.pid, listing);
  const matches =
    chain.length === hint.length &&
    chain.every((member, index) => {
      const told = hint[index];
      return told?.pid === member.pid && told.start === member.start;
    });
  return matches ? chain : [];
}
