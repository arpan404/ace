import { mkdirSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { newSpadeNonce, spadeHealth } from "@ace/service/spade";
import { spadeRequest, type SpadeConnection } from "./forward.ts";
import type { SpadeAceCall } from "./delivery.ts";
import type { SpadeLinkRuntime } from "./link.ts";
import type { SpadeServiceControl } from "./service-control.ts";

/** The link's real edges: files, `/health`, the service manager and timers. */
export function nodeSpadeLinkRuntime(input: {
  service: Pick<SpadeServiceControl, "state">;
  now(): number;
}): SpadeLinkRuntime {
  return {
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    health: (endpoint, nonce, signal) => spadeHealth(endpoint, signal, nonce),
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // Gone, or (EPERM) another user's process: Spade runs as this user, so not Spade.
        return false;
      }
    },
    nonce: newSpadeNonce,
    serviceState: () => input.service.state(),
    watch(directory, changed) {
      // Spade writes here once it starts; the folder is made first so it can be watched now.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const watcher = watch(directory, { persistent: false }, () => changed());
        watcher.on("error", () => {});
        return () => watcher.close();
      } catch {
        // Polling still notices every change, only later.
        return () => {};
      }
    },
    now: input.now,
    after(ms, run) {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
}

/** `/v1/ace` on Spade's API with Spade's token; undefined when Spade couldn't be reached. */
export const spadeAceCall: SpadeAceCall = async (connection: SpadeConnection, method, body) => {
  try {
    const answer = await spadeRequest(
      connection,
      {
        method,
        path: "/v1/ace",
        ...(body ? { body: Buffer.from(JSON.stringify(body)) } : {}),
      },
      { signal: AbortSignal.timeout(5000), maxBytes: 64 * 1024 },
    );
    if (answer.kind !== "response") return undefined;
    const text = answer.body.toString("utf8");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: answer.status, body: parsed };
  } catch {
    return undefined;
  }
};
