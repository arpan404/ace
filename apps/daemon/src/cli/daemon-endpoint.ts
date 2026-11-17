import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { CliFailure } from "./output.ts";

/**
 * Where this machine's daemon listens and whether anything does: the endpoint and token files
 * and a TCP probe. Light on purpose (no client, no protocol schemas), so a caller that only needs
 * to know whether ace is up, like tab completion, pays for nothing more.
 */

const HostConnection = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
export function hostConnection(home: string) {
  return HostConnection.parse({
    origin: readFileSync(join(home, "daemon-endpoint"), "utf8"),
    token: readFileSync(join(home, "daemon-token"), "utf8"),
  });
}
/** How long a local daemon has to accept a TCP connection before it counts as down. */
const probeMs = 1_000;

/**
 * What a TCP probe of the daemon's endpoint learned: something accepted (`up`), the connection
 * was refused (`down`: nothing listens there), or no answer in time (`unknown`: a busy machine,
 * not a stopped daemon).
 */
export type ProbeAnswer = "up" | "down" | "unknown";
export type Probe = (host: string, port: number, ms: number) => Promise<ProbeAnswer>;

export const tcpProbe: Probe = (host, port, ms) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (answer: ProbeAnswer) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done("unknown"), ms);
    socket.once("connect", () => done("up"));
    socket.once("error", (error) => {
      const code = Reflect.get(error, "code");
      done(code === "ECONNREFUSED" || code === "ECONNRESET" ? "down" : "unknown");
    });
  });

/** "ace isn't running.", code `daemon_down`, exit 4 (ADR 0176 §4). */
export function daemonDown(): CliFailure {
  return new CliFailure("refused", "ace isn't running.", undefined, {
    code: "daemon_down",
    hint: "Start it with ace start, or open the app.",
  });
}

/**
 * This machine's daemon, or `daemonDown` at once: no endpoint file, a file a stopped daemon
 * left behind, or nothing listening there. Never a file error and never a 15-second wait.
 */
export async function reachLocalDaemon(
  home: string,
  probe: Probe = tcpProbe,
): Promise<{ origin: string; token: string }> {
  let connection: { origin: string; token: string };
  try {
    connection = hostConnection(home);
  } catch {
    throw daemonDown();
  }
  const url = new URL(connection.origin);
  // Only a refusal says ace is down; a slow answer goes on to the connect, which has its own
  // deadline, so a loaded machine never reads as a stopped daemon.
  if ((await probe(url.hostname, Number(url.port || 80), probeMs)) === "down") throw daemonDown();
  return connection;
}
