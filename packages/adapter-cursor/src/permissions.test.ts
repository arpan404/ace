import * as sdk from "@cursor/sdk";
import { mkdtemp, rm, realpath } from "node:fs/promises";
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
          // The fake harness reports the actual options it received through the native identity.
          return {
            agentId: `native-${options.local?.sandboxOptions?.enabled}-${options.local?.autoReview}`,
            async send() {
              throw new Error("No real prompts");
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        async resume() {
          throw new Error("Unused");
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
        }),
      ).toEqual({ agentId: `native-${enabled}-${autoReview}` });
    } finally {
      await host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
