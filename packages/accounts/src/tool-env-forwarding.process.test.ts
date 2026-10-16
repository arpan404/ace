import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { quotaPayload } from "./test-support.ts";
import { AccountService, openRegistry } from "./index.ts";
import { cleanup, homes } from "./test-support.ts";
afterEach(cleanup);
const context: SessionContext = {
  threadId: ThreadId.parse("thread"),
  cwd: "/tmp",
  signal: new AbortController().signal,
  onFrame: () => {},
  onExit: () => {},
};
test("per-session tool credentials reach the provider without widening its environment", async () => {
  const request = await homes("codex");
  const registry = await openRegistry(join(request.to.homeDir, "accounts.sqlite"));
  await registry.register(request.from);
  const service = new AccountService({
    registry,
    now: () => 1000,
    timeZone: "UTC",
    env: { GH_TOKEN: "ambient-token" },
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
          "console.log([process.env.GH_TOKEN,process.env.LD_PRELOAD??'',process.env.CODEX_HOME].join('|'));process.stdin.resume()",
        ],
        env: ctx.env ?? {},
        name: "fake-tool-env-adapter",
      });
      proc.stdout.on("line", (line) => {
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
          return request.nativeSessionId;
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
      {
        ...context,
        toolEnv: {
          GH_TOKEN: "session-token",
          LD_PRELOAD: "/evil.so",
          CODEX_HOME: "/evil",
        },
      },
      { instanceId: request.from.id, role: "worker", estimatedLoad: 1 },
    );
    try {
      expect(await ready).toBe(`session-token||${request.from.homeDir}`);
      expect(opened.session.nativeSessionId).toBe(request.nativeSessionId);
    } finally {
      await opened.session.close("shutdown");
    }
  } finally {
    await registry.close();
  }
});
