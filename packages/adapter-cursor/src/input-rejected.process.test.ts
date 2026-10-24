import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { InputRejected } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import {
  CursorLimitsSchema,
  HostRuntime,
  openCursorSession,
  type RuntimeSdkBoundary,
} from "./index.ts";
import { HostRefusal } from "./host-refusal.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cursor-rejected-")));
  homes.push(directory);
  return directory;
}

// A host on the real wire: "refuse" is turned down before the SDK, anything else fails inside it.
async function wireSession() {
  const directory = await home();
  const entry = join(directory, "host.mjs");
  const module = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  await writeFile(
    entry,
    `import {hostWire} from ${module("./host-wire.ts")};
import {HostRefusal} from ${module("./host-refusal.ts")};
hostWire(async (method, params) => {
  if (method === 'open') return {agentId: 'native'};
  if (method === 'send') {
    if (params.input[0].text === 'refuse') throw new HostRefusal('Host not ready for send');
    throw new Error('SDK send uncertain');
  }
  if (method === 'cancel') return {settled: true};
  if (method === 'close') return {disposed: true};
}, () => process.exit(0));`,
  );
  return openCursorSession(
    {
      threadId: ThreadId.parse("rejected"),
      cwd: directory,
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    },
    { instanceId: "instance", env: { HOME: directory }, entry },
  );
}

test("a send the Cursor host refuses before the SDK is reported as never taken", async () => {
  const session = await wireSession();
  try {
    const refused = session.send([{ type: "text", text: "refuse" }], "queue", "command-1");
    await expect(refused).rejects.toBeInstanceOf(InputRejected);
  } finally {
    await session.close("user");
  }
});

test("a send that fails inside the Cursor SDK may have run, and later sends are refused unsent", async () => {
  const session = await wireSession();
  try {
    const failed = session.send([{ type: "text", text: "sdk" }], "queue", "command-1");
    await expect(failed).rejects.toThrow("delivery may be uncertain");
    await expect(failed).rejects.not.toBeInstanceOf(InputRejected);
    // The session holds further input until reconciled, without sending any of it.
    const held = session.send([{ type: "text", text: "next" }], "steer", "command-2");
    await expect(held).rejects.toThrow("uncertain");
    await expect(held).rejects.toBeInstanceOf(InputRejected);
  } finally {
    await session.close("user");
  }
});

test("a Cursor host refuses a second send while one is in flight, before the SDK sees it", async () => {
  const directory = await home();
  const sent: unknown[] = [];
  const release = Promise.withResolvers<void>();
  const agent = {
    agentId: "created-agent",
    async [Symbol.asyncDispose]() {},
    async send(input: unknown) {
      sent.push(input);
      await release.promise;
      return {
        id: "created-run",
        async *stream() {
          yield { type: "system" as const, agent_id: "created-agent", run_id: "created-run" };
        },
        async wait() {
          return { id: "created-run", status: "finished" as const };
        },
        async cancel() {},
      };
    },
  };
  const boundary: RuntimeSdkBoundary = {
    ...sdk,
    Cursor: {
      auth: {
        async status() {
          return { status: "logged-in", backendUrl: "https://synthetic.invalid" };
        },
      },
    },
    Agent: {
      async create() {
        return agent;
      },
      async resume() {
        return agent;
      },
      async cancelRun() {},
    },
  };
  const host = new HostRuntime(
    boundary,
    async () => {},
    () => directory,
    {},
  );
  try {
    await host.open({
      threadId: ThreadId.parse("rejected"),
      cwd: directory,
      generation: "host",
      policy: "full-access",
      limits: CursorLimitsSchema.parse({}),
    });
    const first = host.send({
      operationId: "first",
      segment: 0,
      input: [{ type: "text", text: "first" }],
    });
    await expect.poll(() => sent.length).toBe(1);
    await expect(
      host.send({ operationId: "second", segment: 0, input: [{ type: "text", text: "second" }] }),
    ).rejects.toBeInstanceOf(HostRefusal);
    release.resolve();
    await first;
    expect(sent).toHaveLength(1);
  } finally {
    release.resolve();
    await host.close().catch(() => {});
  }
});
