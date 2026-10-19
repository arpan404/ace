import { afterEach, expect, test } from "vitest";
import { readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { ThreadId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { quotaPayload } from "./test-support.ts";
import { AccountService, openRegistry } from "./index.ts";
import { cleanup, hash, homes, idle, rollout } from "./test-support.ts";
afterEach(cleanup);
const context: SessionContext = {
  threadId: ThreadId.parse("thread"),
  cwd: "/tmp",
  signal: new AbortController().signal,
  onFrame: () => {},
  onExit: () => {},
};
test("adapter sessions preserve live native IDs, assigned environments and isolated quota", async () => {
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
      let nativeSessionId = "initializing";
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
        nativeSessionId = request.nativeSessionId;
        const payload = quotaPayload({
          auth: "logged_in",
          rateLimits: { primary: { usedPercent: 100 } },
        });
        ctx.onFrame({
          seq: 1,
          t: 0,
          dir: "recv",
          channel: "stdio",
          data: payload.data,
          payload,
        });
        report(line);
      });
      return {
        get nativeSessionId() {
          return nativeSessionId;
        },
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
      expect(opened.session.nativeSessionId).toBe(request.nativeSessionId);
      expect(registry.summaries(1000).find((a) => a.id === request.from.id)?.availability).toBe(
        "exhausted",
      );
      expect(registry.summaries(1000).find((a) => a.id === request.to.id)?.availability).toBe(
        "unknown",
      );
    } finally {
      await opened.session.close("shutdown");
    }
  } finally {
    registry.close();
  }
});
const wire = (request: Awaited<ReturnType<typeof homes>>) => ({
  type: "accounts.migrate",
  requestId: "m",
  provider: request.provider,
  nativeSessionId: request.nativeSessionId,
  from: request.from.id,
  to: request.to.id,
});
const unused = {
  capabilities: () => {
    throw new Error("unused");
  },
  createTranslator: () => {
    throw new Error("unused");
  },
};
test("without a provider lease a session hands over instead of copying, and with one it copies", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3);
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  await registry.register(request.to);
  const options = { registry, now: () => 1, timeZone: "UTC", env: {} };
  try {
    expect(await new AccountService(options).handle(wire(request))).toMatchObject({
      result: { status: "unsupported" },
    });
    expect(await readdir(request.to.homeDir)).toEqual(["accounts.sqlite"]);
    expect(
      await new AccountService({ ...options, safety: idle }).handle(wire(request)),
    ).toMatchObject({ result: { status: "migrated", copiedFiles: 1 } });
  } finally {
    registry.close();
  }
});
test.each(["codex", "claude", "opencode", "pi"] as const)(
  "a normal %s CLI login is never written as the destination of a switch",
  async (provider) => {
    const request = await homes(provider);
    if (provider === "codex") await rollout(request.from.homeDir, 3);
    const registry = await openRegistry(join(request.from.homeDir, "accounts.sqlite"));
    try {
      await registry.register(request.from);
      await registry.register({ ...request.to, implicit: true, env: {} });
      const result = await new AccountService({
        registry,
        now: () => 1,
        timeZone: "UTC",
        env: {},
        safety: idle,
      }).handle(wire(request));
      expect(result).toMatchObject({ result: { status: "unsupported" } });
      expect(await readdir(request.to.homeDir)).toEqual([]);
    } finally {
      registry.close();
    }
  },
);
test("a normal Codex CLI login is copied from, under the lease, without changing its files", async () => {
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  const before = await hash(source);
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  try {
    await registry.register({ ...request.from, implicit: true, env: {} });
    await registry.register(request.to);
    const result = await new AccountService({
      registry,
      now: () => 1,
      timeZone: "UTC",
      env: {},
      safety: idle,
    }).handle(wire(request));
    expect(result).toMatchObject({ result: { status: "migrated", copiedFiles: 1 } });
    expect(await hash(source)).toBe(before);
    expect(await hash(join(request.to.homeDir, relative(request.from.homeDir, source)))).toBe(
      before,
    );
  } finally {
    registry.close();
  }
});
test("while a copy runs, other threads keep opening sessions on both accounts and a sign-in waits", async () => {
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
        return { status: "held", release: async () => {} };
      },
    },
  });
  const adapter: ProviderAdapter = {
    provider: "codex",
    ...unused,
    openSession: async () => ({
      nativeSessionId: "neighbour",
      send: async () => {},
      interrupt: async () => {},
      resolve: async () => {},
      stopTask: async () => {},
      close: async () => {},
    }),
  };
  const copying = service.handle(wire(request));
  try {
    await ready;
    for (const instanceId of [request.from.id, request.to.id]) {
      const opened = await service.openSession(adapter, context, {
        instanceId,
        role: "worker",
        estimatedLoad: 1,
      });
      expect(opened.instanceId).toBe(instanceId);
      await opened.session.close("idle");
    }
    await expect(service.reserveAuthChange(request.from.id)).rejects.toThrow(
      "A thread is moving to or from this account",
    );
    grant();
    expect(await copying).toMatchObject({ result: { status: "migrated" } });
    (await service.reserveAuthChange(request.from.id))();
  } finally {
    grant();
    await copying;
    registry.close();
  }
});
test("a switch during a sign-in on either account is refused without copying", async () => {
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
    safety: idle,
  });
  try {
    const release = await service.reserveAuthChange(request.to.id);
    expect(await service.handle(wire(request))).toMatchObject({
      result: { status: "refused", reason: expect.stringContaining("signing in") },
    });
    expect(await readdir(request.to.homeDir)).toEqual(["accounts.sqlite"]);
    release();
    expect(await service.handle(wire(request))).toMatchObject({ result: { status: "migrated" } });
  } finally {
    registry.close();
  }
});
