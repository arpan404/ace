import { z } from "zod";
import { Client, ClientError, webSocketTransport, type Selection } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { cliStorage } from "./storage.ts";
import { CliFailure } from "./output.ts";
import { timeoutMs, type Args } from "./args.ts";

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
      reject(new CliFailure("timeout", "Observation timed out"));
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
export async function connectCli(home: string, args: Args) {
  const connection = hostConnection(home);
  const persistence = cliStorage(home);
  const lifetime = new AbortController();
  const interrupt = () => lifetime.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(() => lifetime.abort(), timeoutMs(args));
  const client = new Client({
    deviceId: DeviceId.parse("ace-cli"),
    transport: () =>
      webSocketTransport(() => new WebSocket(connection.origin.replace("http:", "ws:"))),
    credential: async () => connection.token,
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
      lifetime.signal,
    );
    if (state === "fatal") throw client.error ?? new ClientError("auth");
    return { client, signal: lifetime.signal, close };
  } catch (error) {
    await close();
    throw error;
  }
}
