import * as sdk from "@cursor/sdk";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HostRuntime, CursorLimitsSchema, type RuntimeSdkBoundary } from "./index.ts";
import { cursorMode } from "@ace/provider-kit/permission-modes";
test.each([
  [false, false],
  [true, false],
  [true, true],
  [false, true],
])(
  "Cursor passes native sandbox=%s autoReview=%s unchanged to its SDK",
  async (enabled, autoReview) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-permission-")));
    const boundary: RuntimeSdkBoundary = {
      ...sdk,
      sandboxSupport: async () => ({ supported: true, release: async () => {} }),
      Cursor: {
        auth: {
          status: async () => ({ status: "logged-in", backendUrl: "https://synthetic.invalid" }),
        },
      },
      Agent: {
        async create(options) {
          const directory = options.local?.dirs?.[0];
          if (!directory) throw new Error("Missing native rule workspace");
          expect(await readFile(join(directory, ".cursor/rules/ace.mdc"), "utf8")).toContain(
            "Never drive Safari/Chrome/Arc/Firefox with screen_*",
          );
          expect(options.systemPrompt).toBeUndefined();
          const agentId = `native-${options.local?.sandboxOptions?.enabled}-${options.local?.autoReview}`;
          const store = options.local?.store;
          if (!store) throw new Error("Missing local checkpoint store");
          const blobId = "ab".repeat(32);
          await store.agents.create({
            agent: {
              agentId,
              cwd: home,
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
              latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId },
            },
          });
          await store.checkpoints.create({ agentId, blobId, data: new Uint8Array([1, 2, 3]) });
          return {
            agentId: `native-${options.local?.sandboxOptions?.enabled}-${options.local?.autoReview}`,
            async send() {
              throw new Error("No real prompts");
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        async resume(nativeId, options) {
          const directory = options?.local?.dirs?.[0];
          if (!directory) throw new Error("Missing resumed native rule workspace");
          expect(await readFile(join(directory, ".cursor/rules/ace.mdc"), "utf8")).toContain(
            "Any website or web app, including localhost",
          );
          expect(options?.systemPrompt).toBeUndefined();
          expect(options?.local?.sandboxOptions?.enabled).toBe(enabled);
          expect(options?.local?.autoReview).toBe(autoReview);
          return {
            agentId: nativeId,
            async send() {
              throw new Error("No real prompts");
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        async cancelRun() {},
      },
    };
    const host = new HostRuntime(
      boundary,
      async () => {},
      () => home,
    );
    try {
      expect(
        await host.open({
          threadId: "native",
          cwd: home,
          generation: "host",
          permissionMode: cursorMode(Boolean(enabled), Boolean(autoReview)),
          limits: CursorLimitsSchema.parse({}),
          mcp: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
        }),
      ).toEqual({ agentId: `native-${enabled}-${autoReview}` });
      await host.close();
      const resumed = new HostRuntime(
        boundary,
        async () => {},
        () => home,
      );
      try {
        expect(
          await resumed.open({
            threadId: "native",
            cwd: home,
            generation: "resumed-host",
            nativeSessionId: `native-${enabled}-${autoReview}`,
            permissionMode: cursorMode(Boolean(enabled), Boolean(autoReview)),
            limits: CursorLimitsSchema.parse({}),
            mcp: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
          }),
        ).toEqual({ agentId: `native-${enabled}-${autoReview}` });
      } finally {
        await resumed.close();
      }
    } finally {
      await host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
