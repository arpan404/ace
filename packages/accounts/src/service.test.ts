import { afterEach, expect, test } from "vitest";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
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
test("adapter launches use the assigned home and update only that account quota", async () => {
  const request = await homes("codex");
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const service = new AccountService({
    registry,
    now: () => 1000,
    timeZone: "UTC",
    env: { CODEX_HOME: "/wrong", OPENAI_API_KEY: "ambient" },
  });
  const { promise: ready, resolve: report } = Promise.withResolvers<string>();
  const adapter: ProviderAdapter = {
    provider: "codex",
    capabilities: () => {
      throw new Error("unused");
    },
    createTranslator: () => {
      throw new Error("unused");
    },
    openSession: async (ctx) => {
      const proc = spawnSupervised({
        command: process.execPath,
        args: [
          "-e",
          "console.log(process.env.CODEX_HOME+'|'+(process.env.OPENAI_API_KEY??'')+'|'+process.env.ACE_SESSION_LABEL);process.stdin.resume()",
        ],
        env: ctx.env ?? {},
        name: "fake-account-adapter",
      });
      proc.stdout.on("line", (line) => {
        ctx.onFrame({
          seq: 1,
          t: 0,
          dir: "recv",
          channel: "stdio",
          data: { auth: "logged_in", rateLimits: { primary: { usedPercent: 100 } } },
        });
        report(line);
      });
      return {
        nativeSessionId: request.nativeSessionId,
        send: async () => {},
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
      { ...context, env: { ACE_SESSION_LABEL: "session-only", CODEX_HOME: "/wrong/session" } },
      {
        instanceId: request.from.id,
        role: "worker",
        estimatedLoad: 1,
      },
    );
    try {
      expect(await ready).toBe(`${await realpath(request.from.homeDir)}||session-only`);
      expect(registry.summaries(1000).find((a) => a.id === request.from.id)?.availability).toBe(
        "exhausted",
      );
      expect(registry.summaries(1000).find((a) => a.id === request.to.id)?.availability).toBe(
        "unknown",
      );
      expect(
        await service.handle({
          type: "accounts.migrate",
          requestId: "m",
          provider: "codex",
          nativeSessionId: request.nativeSessionId,
          from: request.from.id,
          to: request.to.id,
        }),
      ).toMatchObject({
        result: {
          status: "refused",
          reason: "Source or destination has an active writer or migration",
        },
      });
    } finally {
      await opened.session.close("shutdown");
    }
  } finally {
    registry.close();
  }
});
test("default migration refuses independent-writer uncertainty and verified offline safety can publish", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3);
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const options = { registry, now: () => 1, timeZone: "UTC", env: {} };
  const wire = {
    type: "accounts.migrate",
    requestId: "m",
    provider: "codex",
    nativeSessionId: request.nativeSessionId,
    from: request.from.id,
    to: request.to.id,
  };
  try {
    expect(await new AccountService(options).handle(wire)).toMatchObject({
      result: {
        status: "refused",
        reason: "Source or destination is live, or exclusive quiescence cannot be proven",
      },
    });
    expect(await new AccountService({ ...options, safety: idle }).handle(wire)).toMatchObject({
      result: { status: "migrated", copiedFiles: 1 },
    });
  } finally {
    registry.close();
  }
});
test("concurrent migration and new adapter starts cannot enter homes under a lease", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3);
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const { promise: barrier, resolve: grant } = Promise.withResolvers<void>();
  const { promise: ready, resolve: acquired } = Promise.withResolvers<void>();
  const service = new AccountService({
    registry,
    now: () => 1,
    timeZone: "UTC",
    env: {},
    safety: {
      acquire: async () => {
        acquired();
        await barrier;
        return { release: async () => {} };
      },
    },
  });
  const wire = {
    type: "accounts.migrate",
    requestId: "m",
    provider: "codex",
    nativeSessionId: request.nativeSessionId,
    from: request.from.id,
    to: request.to.id,
  };
  const first = service.handle(wire);
  try {
    await ready;
    expect(await service.handle(wire)).toMatchObject({
      result: {
        status: "refused",
        reason: "Source or destination has an active writer or migration",
      },
    });
    const adapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => {
        throw new Error("unused");
      },
      createTranslator: () => {
        throw new Error("unused");
      },
      openSession: async () => {
        throw new Error("Unexpected launch");
      },
    };
    await expect(
      service.openSession(adapter, context, {
        instanceId: request.to.id,
        role: "worker",
        estimatedLoad: 1,
      }),
    ).rejects.toThrow("Instance is migrating");
  } finally {
    grant();
    await first;
    registry.close();
  }
});
test("failed lease release keeps both instances blocked after successful publication", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3);
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const service = new AccountService({
    registry,
    now: () => 1,
    timeZone: "UTC",
    env: {},
    safety: {
      acquire: async () => ({
        release: async () => {
          throw new Error("Not released");
        },
      }),
    },
  });
  const wire = {
    type: "accounts.migrate",
    requestId: "m",
    provider: "codex",
    nativeSessionId: request.nativeSessionId,
    from: request.from.id,
    to: request.to.id,
  };
  try {
    expect(await service.handle(wire)).toMatchObject({
      result: { status: "migrated", cleanupWarnings: ["lease_release_failed"] },
    });
    expect(await service.handle(wire)).toMatchObject({
      result: {
        status: "refused",
        reason: "Source or destination has an active writer or migration",
      },
    });
  } finally {
    registry.close();
  }
});
