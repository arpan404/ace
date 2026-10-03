import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { ThreadId } from "@ace/protocol";
import type { SessionContext, ProviderAdapter } from "@ace/engine-api";
import { spawnSupervised } from "@ace/provider-kit/process";
import { AccountService, openRegistry } from "./index.ts";
import { cleanup, homes, idle, rollout } from "./test-support.ts";
afterEach(cleanup);
const context: SessionContext = {
  threadId: ThreadId.parse("thread"),
  cwd: "/tmp",
  signal: new AbortController().signal,
  onFrame: () => {},
  onExit: () => {},
};

test("natural provider exit releases its writer so a later offline migration can publish", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3);
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const { promise: exited, resolve: exit } = Promise.withResolvers<void>();
  let leaseRevoked = false;
  const service = new AccountService({
    registry,
    now: () => 1,
    timeZone: "UTC",
    env: {},
    safety: idle,
  });
  const adapter: ProviderAdapter = {
    provider: "codex",
    capabilities: () => {
      throw new Error("unused");
    },
    createTranslator: () => {
      throw new Error("unused");
    },
    openSession: async (ctx) => {
      ctx.signal.addEventListener(
        "abort",
        () => {
          leaseRevoked = true;
        },
        { once: true },
      );
      const proc = spawnSupervised({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        env: ctx.env ?? {},
        name: "natural-account-exit",
      });
      void proc.exited.then(() => {
        ctx.onExit({ deliberate: false });
      });
      return {
        nativeSessionId: request.nativeSessionId,
        send: async () => {
          proc.stdin.end();
        },
        interrupt: async () => {},
        resolve: async () => {},
        stopTask: async () => {},
        close: async () => {
          await proc.stop({ graceMs: 0 });
        },
      };
    },
  };
  try {
    const opened = await service.openSession(
      adapter,
      { ...context, onExit: () => exit() },
      { instanceId: request.from.id, role: "worker", estimatedLoad: 1 },
    );
    try {
      await opened.session.send([], "queue");
      await exited;
      expect(leaseRevoked).toBe(true);
      expect(
        await service.handle({
          type: "accounts.migrate",
          requestId: "after-exit",
          provider: "codex",
          nativeSessionId: request.nativeSessionId,
          from: request.from.id,
          to: request.to.id,
        }),
      ).toMatchObject({ result: { status: "migrated" } });
    } finally {
      await opened.session.close("shutdown");
    }
  } finally {
    registry.close();
  }
});

test("an engine-compatible binding constructs option-based launches in the selected homes", async () => {
  const request = await homes("codex");
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const service = new AccountService({
    registry,
    now: () => 1,
    timeZone: "UTC",
    env: { CODEX_HOME: "/ambient", OPENAI_API_KEY: "ambient" },
  });
  const output: string[] = [];
  const pending: Promise<void>[] = [];
  const bound = service.bindAdapter({
    provider: "codex",
    capabilities: () => {
      throw new Error("unused");
    },
    createTranslator: () => {
      throw new Error("unused");
    },
    create: (env) => ({
      openSession: async () => {
        // Deliberately uses constructor options, exactly like the pending native adapters.
        const { promise: ready, resolve: report } = Promise.withResolvers<void>();
        pending.push(ready);
        const proc = spawnSupervised({
          command: process.execPath,
          args: [
            "-e",
            "console.log(process.env.CODEX_HOME+'|'+(process.env.OPENAI_API_KEY??'')+'|'+process.env.ACE_MCP_URL);process.stdin.resume()",
          ],
          env,
          name: "constructor-account-env",
        });
        proc.stdout.on("line", (line) => {
          output.push(line);
          report();
        });
        return {
          nativeSessionId: "native",
          send: async () => {},
          interrupt: async () => {},
          resolve: async () => {},
          stopTask: async () => {},
          close: async () => {
            await proc.stop({ graceMs: 0 });
          },
        };
      },
    }),
  });
  try {
    for (const instance of [request.from, request.to]) {
      const session = await bound.openSession({
        ...context,
        instanceId: instance.id,
        env: { ACE_MCP_URL: "http://127.0.0.1/toolkit", CODEX_HOME: "/session-override" },
      });
      try {
        await pending.at(-1);
        expect(session.instanceId).toBe(instance.id);
        expect(output.at(-1)).toBe(`${await realpath(instance.homeDir)}||http://127.0.0.1/toolkit`);
      } finally {
        await session.close("shutdown");
      }
    }
    await expect(
      bound.openSession({ ...context, resume: { nativeSessionId: "native" } }),
    ).rejects.toThrow("Resuming requires a pinned provider instance");
  } finally {
    registry.close();
  }
});
