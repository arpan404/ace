import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { Frame, ProviderSession } from "@ace/engine-api";
import { createOpenCodeAdapter, type ServerOptions } from "../index.ts";
import { harness } from "../replay.ts";
import { object } from "../data.ts";
export const cli = fileURLToPath(new URL("./cli-v2.mjs", import.meta.url));
const owners: ReturnType<typeof createOpenCodeAdapter>[] = [];
export function deferred<T>() {
  return Promise.withResolvers<T>();
}
export class Clock {
  now = 0;
  private timers = new Set<{ at: number; callback(): void }>();
  schedule = (callback: () => void, delay: number) => {
    const timer = { at: this.now + delay, callback };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  };
  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const timer of this.timers)
      if (timer.at <= this.now && this.timers.delete(timer)) timer.callback();
  }
}
export async function setup(extra: ServerOptions = {}) {
  let origin = "",
    authorization = "";
  const frames: Frame[] = [],
    projection = harness();
  const waiters = new Set<{ predicate(frame: Frame): boolean; resolve(frame: Frame): void }>();
  const seen = (predicate: (frame: Frame) => boolean, after = 0) => {
    const old = frames.slice(after).find(predicate);
    if (old) return Promise.resolve(old);
    return new Promise<Frame>((resolve) => waiters.add({ predicate, resolve }));
  };
  const onFrame = (frame: Frame) => {
    frames.push(frame);
    projection.feed(frame);
    for (const waiter of waiters)
      if (waiter.predicate(frame)) {
        waiters.delete(waiter);
        waiter.resolve(frame);
      }
  };
  const version = extra.discovery?.env?.ACE_TEST_OPENCODE_VERSION ?? "2.0.22";
  const network = extra.runtime?.fetch ?? fetch;
  const options: ServerOptions = {
    ...extra,
    runtime: {
      wallTime: () => 0,
      monotonic: () => 0,
      entropy: (bytes) => (bytes === 32 ? "ephemeral-test-secret" : "0123456789abcdef"),
      ...extra.runtime,
      discover: async () => ({
        opencode: {
          installed: true,
          path: cli,
          version,
          auth: "unknown",
          loginHint: "opencode auth login",
        },
        claude: { installed: false, auth: "unknown", loginHint: "" },
        codex: { installed: false, auth: "unknown", loginHint: "" },
        cursor: { installed: false, auth: "unknown", loginHint: "" },
      }),
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        origin = url.origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return network(input, init);
      },
    },
  };
  const adapter = createOpenCodeAdapter(options);
  owners.push(adapter);
  const controller = new AbortController(),
    exits: unknown[] = [];
  const open = (cwd = "/one", resume?: string): Promise<ProviderSession> =>
    adapter.openSession({
      threadId: ThreadId.parse("thread_v2"),
      rootKey: "root",
      cwd,
      model: "opencode-go/muse-spark-1.3-contributor",
      signal: controller.signal,
      onFrame,
      onExit: (exit) => exits.push(exit),
      ...(resume ? { resume: { nativeSessionId: resume } } : {}),
    });
  const control = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json();
  };
  const session = await open();
  const publish = async (type: string, data: Record<string, unknown> = {}, directory = "/one") => {
    const from = frames.length;
    await control("/test/events", [
      { type, directory, data: { sessionID: session.nativeSessionId, ...data } },
    ]);
    await seen((f) => f.channel === "sse" && object(f.data).type === type, from);
  };
  const recovered = (from = frames.length) =>
    seen((f) => f.channel === "lifecycle" && object(f.data).type === "resynced", from);
  return {
    adapter,
    options,
    transport: () => ({ url: origin, authorization, version }),
    frames,
    projection,
    exits,
    controller,
    open,
    session,
    control,
    publish,
    seen,
    recovered,
  };
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
});
