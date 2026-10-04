import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  HostRuntime,
  probeCursorSandbox,
  CursorLimitsSchema,
  type RuntimeSdkBoundary,
} from "./index.ts";

function executorKey(options: sdk.AgentOptions): string {
  return JSON.stringify({
    local: {
      cwd: options.local?.cwd,
      sandbox: options.local?.sandboxOptions,
      autoReview: options.local?.autoReview,
      settings: options.local?.settingSources,
      children: options.local?.subagentInherit,
    },
    tools: options.tools,
    mcpServers: options.mcpServers,
  });
}

test.each(["normal close", "create failure", "dispose failure", "close during admission"] as const)(
  "Cursor retains its executor until %s and releases it even on failure",
  async (ending) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-executor-")));
    let live = false,
      cacheKey = "";
    const warming = Promise.withResolvers<void>();
    const continueAdmission = Promise.withResolvers<void>();
    const boundary: RuntimeSdkBoundary = {
      ...sdk,
      sandboxSupport: (options) =>
        probeCursorSandbox(
          {
            ConfigurationError: sdk.ConfigurationError,
            async createAgentPlatform() {
              return {
                async prewarmLocalWorkspace(optionsToWarm) {
                  live = true;
                  cacheKey = executorKey(optionsToWarm);
                  warming.resolve();
                  if (ending === "close during admission") await continueAdmission.promise;
                  return async () => {
                    if (!live) throw new Error("Executor lease released twice");
                    live = false;
                    await writeFile(join(home, "released.txt"), "executor closed");
                  };
                },
              };
            },
          },
          options,
        ),
      Cursor: {
        auth: {
          async status() {
            return { status: "logged-in", backendUrl: "https://synthetic.invalid" };
          },
        },
      },
      Agent: {
        async create(options) {
          if (ending === "close during admission")
            await writeFile(join(home, "late-agent.txt"), "agent started after close");
          if (ending === "create failure") throw new Error("synthetic setup failure");
          return {
            agentId: "owned",
            async send() {
              if (!live || executorKey(options) !== cacheKey)
                throw new Error("First send must rebuild a cold executor");
              await writeFile(join(home, "executor-used.txt"), "warm executor used");
              return {
                id: "run",
                async *stream() {
                  yield { type: "system" as const, agent_id: "owned", run_id: "run" };
                },
                async wait() {
                  return { id: "run", status: "finished" as const };
                },
                async cancel() {},
              };
            },
            async [Symbol.asyncDispose]() {
              if (ending === "dispose failure") throw new Error("synthetic disposal failure");
            },
          };
        },
        async resume() {
          throw new Error("Unexpected resume");
        },
        async cancelRun() {},
      },
    };
    const finished = Promise.withResolvers<void>();
    const host = new HostRuntime(
      boundary,
      async (frame) => {
        if (frame.kind === "result") finished.resolve();
      },
      () => home,
      {},
    );
    try {
      const opening = host.open({
        threadId: "lease",
        generation: "host",
        cwd: home,
        policy: "restricted",
        limits: CursorLimitsSchema.parse({}),
        mcp: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
      });
      if (ending === "close during admission") {
        const rejected = expect(opening).rejects.toThrow("SDK setup failed");
        await warming.promise;
        const closing = host.close();
        continueAdmission.resolve();
        await Promise.all([rejected, closing]);
        expect(await readFile(join(home, "late-agent.txt"), "utf8").catch(() => "missing")).toBe(
          "missing",
        );
      } else if (ending === "create failure")
        await expect(opening).rejects.toThrow("SDK setup failed");
      else {
        await opening;
        expect(await readFile(join(home, "released.txt"), "utf8").catch(() => "pending")).toBe(
          "pending",
        );
        await host.send({
          operationId: "send",
          segment: 0,
          input: [{ type: "text", text: "synthetic" }],
        });
        await finished.promise;
        expect(await readFile(join(home, "executor-used.txt"), "utf8")).toBe("warm executor used");
      }
      if (ending === "dispose failure")
        await expect(host.close()).rejects.toThrow("synthetic disposal failure");
      else {
        await host.close();
        await host.close();
      }
      expect(await readFile(join(home, "released.txt"), "utf8")).toBe("executor closed");
    } finally {
      await host.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  },
);
