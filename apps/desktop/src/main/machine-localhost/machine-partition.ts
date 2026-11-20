import { createHash } from "node:crypto";

/*
 * Each remote machine's own cookie and storage partition on this computer (ADR 0194), and the
 * proxy that sends its loopback to that machine. Pure.
 */

/**
 * The persistent partition a machine's device tabs open in, by the machine's stable id (its
 * listing id: the daemon's host id, or the relay host id of an account machine). Hashed, never
 * used as a directory name, and never shared with a thread's own browser partitions.
 */
export function machinePartition(machineId: string): string {
  const digest = createHash("sha256").update(`machine:${machineId}`).digest("hex").slice(0, 32);
  return `persist:machine-${digest}`;
}

/**
 * The partition's proxy: every host direct (`*`), then loopback taken back from Chromium's
 * built-in bypass (`<-loopback>`) and sent to the machine's HTTP proxy on `port`. The last
 * matching bypass rule wins, so the order matters: `<-loopback>,*` would send everything direct.
 * An HTTP proxy rather than SOCKS5, because Chromium's SOCKS5 has no authentication, and the
 * proxy must tell the partition's own browser from any other process on this computer.
 */
export function machineProxy(port: number): { proxyRules: string; proxyBypassRules: string } {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError("Bad proxy port");
  return { proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: "*,<-loopback>" };
}
