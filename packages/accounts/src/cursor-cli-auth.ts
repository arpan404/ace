import { Client, webSocketTransport, type CursorAuthQuery } from "@ace/client";
import { DeviceId, CursorAuthEvent } from "@ace/protocol";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export interface CursorCliAuth {
  request(input: CursorAuthQuery, signal: AbortSignal): Promise<CursorAuthEvent>;
  wait(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
function daemonAuthError(event: CursorAuthEvent, operation: string): Error {
  return new Error(
    event.type === "cursor.auth.error"
      ? `Daemon SDK ${operation} failed: ${event.code}`
      : `Daemon SDK ${operation} unavailable: unexpected ${event.type}`,
  );
}
/** The daemon owns login and host fences. The CLI only carries ephemeral safe events. */
export function cursorDaemonDriver(auth: CursorCliAuth) {
  const status = async (instance: ProviderInstance, signal: AbortSignal) => {
    const event = await auth.request(
      { type: "cursor.auth.status", instanceId: instance.id },
      signal,
    );
    if (event.type !== "cursor.auth.changed") throw daemonAuthError(event, "auth status");
    return event.auth;
  };
  return {
    status,
    async login(instance: ProviderInstance, signal: AbortSignal, url: (url: string) => void) {
      let event = await auth.request(
        { type: "cursor.auth.start", instanceId: instance.id, label: instance.label },
        signal,
      );
      let lastUrl: string | undefined;
      let loginId: string | undefined;
      try {
        for (;;) {
          signal.throwIfAborted();
          if (event.type !== "cursor.auth.login") throw daemonAuthError(event, "login");
          loginId = event.loginId;
          if (event.state === "complete" && event.auth) return event.auth;
          if (event.state === "failed" || event.state === "cancelled")
            throw new Error(`SDK login ${event.state}: ${event.error ?? event.state}`);
          if (event.url && event.url !== lastUrl) {
            url(event.url);
            lastUrl = event.url;
          }
          await auth.wait(signal);
          event = await auth.request({ type: "cursor.auth.poll", loginId }, signal);
        }
      } catch (error) {
        if (loginId)
          await auth
            .request({ type: "cursor.auth.cancel", loginId }, new AbortController().signal)
            .catch(() => {});
        throw error;
      }
    },
  };
}
const Endpoint = z
  .string()
  .max(8192)
  .transform((value) => new URL(value.trim()))
  .refine(
    (url) =>
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
export async function daemonCursorAuth(env: NodeJS.ProcessEnv): Promise<CursorCliAuth> {
  const root = env.ACE_HOME ?? join(homedir(), ".ace");
  const endpoint = Endpoint.parse(await readFile(join(root, "daemon-endpoint"), "utf8"));
  endpoint.protocol = "ws:";
  const token = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(await readFile(join(root, "daemon-token"), "utf8"));
  const client = new Client({
    deviceId: DeviceId.parse(`accounts-cli-${randomUUID()}`),
    credential: async () => token,
    transport: () => webSocketTransport(() => new WebSocket(endpoint)),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: Math.random,
    id: randomUUID,
  });
  const ready = Promise.withResolvers<void>();
  const unsubscribe = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
    else if (client.state === "fatal" || client.state === "offline")
      ready.reject(new Error("Daemon auth connection unavailable"));
  });
  const connectionTimer = setTimeout(
    () => ready.reject(new Error("Daemon auth connection unavailable")),
    15000,
  );
  try {
    await client.start();
    await ready.promise;
  } catch {
    await client.close();
    throw new Error("Start the daemon before Cursor SDK account login");
  } finally {
    clearTimeout(connectionTimer);
    unsubscribe();
  }
  return {
    request: (input, signal) => client.cursorAuth(input, { signal }),
    wait: (signal) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Login cancelled"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 250);
        signal.addEventListener("abort", abort, { once: true });
      }),
    close: () => client.close(),
  };
}
