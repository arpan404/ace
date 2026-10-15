import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { HostRuntime, CursorLimitsSchema, type RuntimeSdkBoundary } from "./index.ts";

test("a Full access Cursor agent loads every native settings layer and runs unsandboxed beside ace's MCP server", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-tools-")));
  const created: sdk.AgentOptions[] = [];
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
        created.push(options);
        return {
          agentId: "native-tools",
          async send() {
            throw new Error("No real prompts");
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      async resume() {
        throw new Error("No resume");
      },
      async cancelRun() {},
    },
  };
  const fullAccess = accessModeOffers({ provider: "cursor" }).find(
    (offer) => offer.mode === "full-access",
  )?.native;
  const host = new HostRuntime(
    boundary,
    async () => {},
    () => home,
  );
  try {
    await host.open({
      threadId: "native-tools",
      cwd: home,
      generation: "host",
      ...(fullAccess ? { permissionMode: fullAccess } : {}),
      limits: CursorLimitsSchema.parse({}),
      mcp: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
    });
    const options = created[0];
    // Project and user rules, skills, hooks, plugins and the person's MCP servers all load.
    expect(options?.local?.settingSources).toEqual(["all"]);
    expect(options?.local?.sandboxOptions).toEqual({ enabled: false });
    expect(options?.local?.autoReview).toBe(false);
    // ace adds its own server inline; nothing replaces Cursor's tools or system prompt.
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(["ace"]);
    expect(options?.tools).toBeUndefined();
    expect(options?.systemPrompt).toBeUndefined();
    expect(options?.local?.customTools).toBeUndefined();
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
