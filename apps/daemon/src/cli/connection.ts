import { selectedProfile } from "./profiles.ts";
import { accessRequest, pinnedSocketTransport } from "../client-access.ts";
import {
  Client,
  ClientError,
  ticketCredential,
  webSocketTransport,
  type ClientOptions,
  type Selection,
} from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { cliStorage } from "./storage.ts";
import { agentShell, localDevice } from "./person-gate.ts";
import { reachLocalDaemon } from "./daemon-endpoint.ts";
import { CliFailure } from "./output.ts";
import { timeoutMs, option, type Args } from "./args.ts";

export {
  daemonDown,
  hostConnection,
  reachLocalDaemon,
  tcpProbe,
  type Probe,
  type ProbeAnswer,
} from "./daemon-endpoint.ts";

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
  const client = cliClient({
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
    await untilReady(client, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]));
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

/**
 * A read-only connection to this machine's daemon, for tab completion (ADR 0176 §6): no outbox,
 * so nothing is written, and given up when `signal` aborts. Throws when a remote picked with
 * `ace remote use` is where commands go, as this daemon's references aren't its.
 */
export async function peekLocalDaemon(
  home: string,
  connection: { origin: string; token: string },
  signal: AbortSignal,
): Promise<{ client: Client; close: () => Promise<void> }> {
  // Opening the profile store creates it; with no store there is no remote to have picked.
  if (existsSync(join(home, "cli-profiles.sqlite")) && selectedProfile(home))
    throw new CliFailure("refused", "A remote is selected.");
  const client = cliClient({
    deviceId: DeviceId.parse(localDevice(agentShell(process.env)).id),
    transport: () =>
      webSocketTransport(() => new WebSocket(connection.origin.replace("http:", "ws:"))),
    credential: async () => connection.token,
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  });
  try {
    await untilReady(client, signal);
  } catch (error) {
    await client.close();
    throw error;
  }
  return { client, close: () => client.close() };
}

function cliClient(
  parts: Pick<ClientOptions, "deviceId" | "transport" | "credential" | "storage">,
): Client {
  return new Client({
    ...parts,
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
}

/** Starts the client and waits for it to be ready; a fatal connection throws its error. */
async function untilReady(client: Client, signal: AbortSignal): Promise<void> {
  await client.start();
  const state = await waitSelection(
    client.connectionState(),
    (candidate) => candidate === "ready" || candidate === "fatal",
    signal,
  );
  if (state === "fatal") throw client.error ?? new ClientError("auth");
}
