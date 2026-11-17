import { selectedProfile } from "./profiles.ts";
import { accessRequest, pinnedSocketTransport } from "../client-access.ts";
import { z } from "zod";
import {
  Client,
  ClientError,
  ticketCredential,
  webSocketTransport,
  type Selection,
} from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import { cliStorage } from "./storage.ts";
import { agentShell, localDevice } from "./person-gate.ts";
import { CliFailure } from "./output.ts";
import { timeoutMs, option, type Args } from "./args.ts";

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

export type Probe = (host: string, port: number, ms: number) => Promise<boolean>;

/** Whether something accepts a TCP connection on `host:port` within `ms`. */
export const tcpProbe: Probe = (host, port, ms) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (up: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(up);
    };
    const timer = setTimeout(() => done(false), ms);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
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
  if (!(await probe(url.hostname, Number(url.port || 80), probeMs))) throw daemonDown();
  return connection;
}
export function waitSelection<T>(
  selection: Selection<T>,
  accept: (value: T) => boolean,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    const finish = () => {
      stop?.();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(
        signal.reason instanceof CliFailure
          ? signal.reason
          : new CliFailure("timeout", "Observation timed out"),
      );
    };
    const check = () => {
      const value = selection.getSnapshot();
      if (accept(value)) {
        finish();
        resolve(value);
      }
    };
    stop = selection.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}
/** Queue-only descendant facts do not necessarily advance the parent's cursor. */
export async function waitSelectionOrRefresh<T>(
  selection: Selection<T>,
  accept: (value: T) => boolean,
  signal: AbortSignal,
): Promise<void> {
  const observation = new AbortController();
  const abort = () => observation.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 500);
  try {
    await waitSelection(selection, accept, observation.signal);
  } catch (error) {
    if (signal.aborted || !observation.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export function connectCli(home: string, args: Args) {
  return connectWithLifetime(home, args, timeoutMs(args));
}
export function connectChat(home: string, args: Args) {
  return connectWithLifetime(home, args, option(args, "timeout") ? timeoutMs(args) : undefined);
}
async function connectWithLifetime(home: string, args: Args, duration: number | undefined) {
  const profile = selectedProfile(home, option(args, "remote"));
  const connection = profile ? undefined : await reachLocalDaemon(home);
  // On a remote the paired device's id is the only one its ticket admits.
  const local = localDevice(agentShell(process.env));
  const persistence = cliStorage(
    profile ? join(home, "cli-remotes", profile.id) : join(home, local.outbox),
  );
  const lifetime = new AbortController();
  const interrupt = () =>
    lifetime.abort(
      new CliFailure(
        "uncertain",
        "Chat or command observation was interrupted; work state is unconfirmed",
      ),
    );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer =
    duration === undefined
      ? undefined
      : setTimeout(
          () => lifetime.abort(new CliFailure("timeout", "Observation timed out")),
          duration,
        );
  const client = new Client({
    deviceId: profile?.deviceId ?? DeviceId.parse(local.id),
    transport: () =>
      profile
        ? pinnedSocketTransport(profile.origin.replace("https:", "wss:"), profile.fingerprint)
        : webSocketTransport(() => new WebSocket(connection?.origin.replace("http:", "ws:") ?? "")),
    credential: profile
      ? ticketCredential(
          async () => profile.token,
          (token) =>
            accessRequest(profile.origin, "/v1/tickets", {
              method: "POST",
              token,
              fingerprint: profile.fingerprint,
            }),
        )
      : async () => connection?.token ?? "",
    storage: persistence.storage,
    scheduler: {
      set(ms, callback) {
        const scheduled = setTimeout(callback, ms);
        return () => clearTimeout(scheduled);
      },
    },
    random: Math.random,
    id: randomUUID,
    now: Date.now,
  });
  const close = async () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    clearTimeout(timer);
    lifetime.abort();
    await client.close();
    persistence.close();
  };
  try {
    await client.start();
    const state = await waitSelection(
      client.connectionState(),
      (candidate) => candidate === "ready" || candidate === "fatal",
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    );
    if (state === "fatal") throw client.error ?? new ClientError("auth");
    return {
      client,
      signal: lifetime.signal,
      close,
      remote: profile !== undefined,
      origin: profile?.origin ?? connection?.origin ?? "",
    };
  } catch (error) {
    await close();
    throw error;
  }
}
