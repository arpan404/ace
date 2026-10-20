import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "./index.ts";
import type { Scheduler } from "./index.ts";
import { deferred, scope } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A server whose progress timer the test fires by hand, with one tool that runs until released. */
async function longCall() {
  const beats: (() => void)[] = [];
  const scheduler: Scheduler = {
    after(_ms, run) {
      beats.push(run);
      return () => {};
    },
  };
  const release = deferred<void>();
  const started = deferred<void>();
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  registry.register({
    name: "ace_long",
    description: "Runs until released",
    input: z.strictObject({}),
    output: z.strictObject({ done: z.boolean() }),
    capability: null,
    timeoutMs: 60_000,
    async run() {
      started.resolve();
      await release.promise;
      return { done: true };
    },
  });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  const server = await startMcpServer({ registry, credentials, scheduler });
  cleanups.push(() => server.close());
  const lease = credentials.issue(scope(), new AbortController().signal);
  return { server, lease, beats, release, started };
}

it.each([
  { mode: "legacy" as const, headers: { "X-Ace-Notifications": "stream" } },
  { mode: "modern" as const, headers: {} },
])(
  "a long call keeps reporting progress to a $mode client that asked for it, so the client never drops it as silent",
  async ({ mode, headers }) => {
    const { server, lease, beats, release, started } = await longCall();
    const client = new Client(
      { name: "test", version: "1" },
      { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
    );
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.bearer}`, ...headers } },
      }),
    );
    const progress: number[] = [];
    const result = client.callTool(
      { name: "ace_long", arguments: {} },
      { onprogress: (update) => progress.push(update.progress), resetTimeoutOnProgress: true },
    );
    await started.promise;
    beats.shift()?.();
    beats.shift()?.();
    await expect.poll(() => progress).toEqual([1, 2]);
    release.resolve();
    expect(await result).toMatchObject({ structuredContent: { done: true } });
    // Settled: the beat scheduled last does nothing.
    beats.shift()?.();
    expect(progress).toEqual([1, 2]);
  },
);
