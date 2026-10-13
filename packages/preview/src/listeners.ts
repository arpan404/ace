import { PreviewPort } from "@ace/protocol/preview";

/*
 * Pure parsers for the OS tables that say which process listens where, what its parent is and
 * which directory it runs in. Malformed rows are skipped: these tables are snapshots read from
 * tools whose output varies by version, never something to fail a scan over.
 */

/** Where a listener accepts connections: loopback only, every address, or one other address. */
export type ListenerReach = "loopback" | "any" | "other";
export interface Listener {
  pid: number;
  port: number;
  reach: ListenerReach;
}

const tableLimit = 4_194_304;
const pidOf = (value: string): number | undefined => {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/** How an address reported by lsof (`127.0.0.1`, `[::1]`, `*`) can be reached. */
export function reachOf(host: string): ListenerReach {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "*" || bare === "0.0.0.0" || bare === "::" || bare === "::ffff:0.0.0.0")
    return "any";
  if (bare === "localhost" || bare === "::1" || /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/.test(bare))
    return "loopback";
  return "other";
}

function dedupe(listeners: Listener[]): Listener[] {
  const seen = new Map<string, Listener>();
  for (const listener of listeners) {
    const key = `${listener.pid}:${listener.port}`;
    const known = seen.get(key);
    // One process listening on loopback and on every address counts as every address.
    if (!known || (known.reach !== "any" && listener.reach !== "other")) seen.set(key, listener);
  }
  return [...seen.values()];
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: `p<pid>` starts a process, `n<host>:<port>` a socket. */
export function parseLsofListeners(text: string): Listener[] {
  if (text.length > tableLimit) throw new Error("Listener table exceeds limit");
  const listeners: Listener[] = [];
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = pidOf(line.slice(1));
    if (!line.startsWith("n") || pid === undefined) continue;
    const match = /^n(.*):(\d+)$/.exec(line.trim());
    const port = PreviewPort.safeParse(Number(match?.[2]));
    if (!match?.[1] || !port.success) continue;
    listeners.push({ pid, port: port.data, reach: reachOf(match[1]) });
  }
  return dedupe(listeners);
}

/** A listening socket from `/proc/net/tcp{,6}`; its process is found through the inode. */
export interface SocketRow {
  inode: string;
  port: number;
  reach: ListenerReach;
}

function procReach(hex: string): ListenerReach {
  const address = hex.toUpperCase();
  if (/^0+$/.test(address)) return "any";
  // IPv4 words are little-endian, so 127.x.x.x ends in 7F.
  if (address.length === 8) return address.endsWith("7F") ? "loopback" : "other";
  if (address === "00000000000000000000000001000000") return "loopback";
  if (address === "0000000000000000FFFF000000000000") return "any";
  if (address.startsWith("0000000000000000FFFF0000") && address.endsWith("7F")) return "loopback";
  return "other";
}

/** `/proc/net/tcp` and `tcp6` rows in the LISTEN state (`0A`). */
export function parseProcSockets(text: string): SocketRow[] {
  if (text.length > tableLimit) throw new Error("Listener table exceeds limit");
  const rows: SocketRow[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A") continue;
    const [address, portHex] = fields[1]?.split(":") ?? [];
    const port = PreviewPort.safeParse(Number.parseInt(portHex ?? "", 16));
    const inode = fields[9];
    if (!address || !port.success || !inode || !/^\d+$/.test(inode) || inode === "0") continue;
    rows.push({ inode, port: port.data, reach: procReach(address) });
  }
  return rows;
}

/** Joins `/proc` socket rows with the inodes each process holds open. */
export function joinProcListeners(
  rows: readonly SocketRow[],
  inodesByPid: ReadonlyMap<number, ReadonlySet<string>>,
): Listener[] {
  const owners = new Map<string, number>();
  for (const [pid, inodes] of inodesByPid) for (const inode of inodes) owners.set(inode, pid);
  const listeners: Listener[] = [];
  for (const row of rows) {
    const pid = owners.get(row.inode);
    if (pid !== undefined) listeners.push({ pid, port: row.port, reach: row.reach });
  }
  return dedupe(listeners);
}

/** `ps -A -o pid=,ppid=`: each process's parent. */
export function parseProcessParents(text: string): Map<number, number> {
  if (text.length > tableLimit) throw new Error("Process table exceeds limit");
  const parents = new Map<number, number>();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/);
    const child = pidOf(pid ?? "");
    const parent = Number(ppid);
    if (child !== undefined && Number.isSafeInteger(parent) && parent >= 0)
      parents.set(child, parent);
  }
  return parents;
}

/** `lsof -a -d cwd -p <pids> -Fpn`: each process's working directory. */
export function parseLsofCwds(text: string): Map<number, string> {
  if (text.length > tableLimit) throw new Error("Directory table exceeds limit");
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = pidOf(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && line.length > 1)
      cwds.set(pid, line.slice(1));
  }
  return cwds;
}
