import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import {
  openCursorSession,
  HostRuntime,
  CursorLimitsSchema,
  type RuntimeSdkBoundary,
  createCursorAdapter,
  probeCursorSandbox,
} from "./index.ts";

test.each([
  { policy: "restricted", sandboxSupported: true, readOnly: false },
  { policy: "restricted", sandboxSupported: false, readOnly: false },
  { policy: "full-access", sandboxSupported: false, readOnly: false },
  { policy: "restricted", sandboxSupported: true, readOnly: true },
] as const)(
  "Cursor $policy launches and resumes with sandbox support=$sandboxSupported, read-only=$readOnly",
  async ({ policy, sandboxSupported, readOnly }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-permission-")));
    const boundary: RuntimeSdkBoundary = {
      ...sdk,
      sandboxSupport: (options) =>
        probeCursorSandbox(
          {
            ConfigurationError: sdk.ConfigurationError,
            async createAgentPlatform() {
              return {
                async prewarmLocalWorkspace() {
                  if (!sandboxSupported)
                    throw new sdk.ConfigurationError(
                      "Local SDK sandboxing was requested, but sandboxing is not supported in this environment.",
                    );
                  return async () => {};
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
          const guarded =
            options.local?.sandboxOptions?.enabled === true &&
            options.local?.autoReview === true &&
            options.local?.subagentInherit !== undefined;
          const unrestricted =
            options.local?.sandboxOptions?.enabled === false && options.local?.autoReview === false;
          const fallback =
            unrestricted &&
            JSON.stringify(options.tools) === JSON.stringify(["read", "grep", "glob", "ls"]);
          if (policy === "restricted" && sandboxSupported && !guarded)
            throw new Error("Missing sandbox");
          if (policy === "restricted" && !sandboxSupported && !fallback)
            throw new Error("Unsupported sandbox requested or tools unrestricted");
          if (!guarded && !unrestricted) throw new Error("Native policy was omitted");
          if (
            readOnly &&
            (JSON.stringify(options.tools) !== JSON.stringify(["read", "grep", "glob", "ls"]) ||
              options.mcpServers !== undefined)
          )
            throw new Error("Read-only admitted shell, writes, Task or MCP tools");
          const agentId = policy === "restricted" ? "restricted-native-agent" : "full-native-agent";
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
            agentId,
            async send() {
              throw new Error("No provider prompts");
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        async resume(nativeId, options) {
          const local = options?.local;
          if (
            (readOnly && options?.mcpServers !== undefined) ||
            local?.sandboxOptions?.enabled !== sandboxSupported ||
            local?.autoReview !== sandboxSupported ||
            local?.subagentInherit === undefined ||
            ((!sandboxSupported || readOnly) &&
              JSON.stringify(options?.tools) !== JSON.stringify(["read", "grep", "glob", "ls"]))
          )
            throw new Error("Resumed native agent lost its restricted policy");
          return {
            agentId: nativeId,
            async send() {
              throw new Error("No provider prompts");
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        async cancelRun() {
          throw new Error("No live run");
        },
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
          threadId: "permission",
          cwd: home,
          generation: "host",
          policy,
          autoReviewAvailable: false,
          limits: CursorLimitsSchema.parse({}),
          readOnly,
          ...(readOnly ? { mcp: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) } } : {}),
        }),
      ).toEqual({
        agentId: policy === "restricted" ? "restricted-native-agent" : "full-native-agent",
      });
      await host.close();
      const resumed = new HostRuntime(
        boundary,
        async () => {},
        () => home,
      );
      try {
        expect(
          await resumed.open({
            threadId: "permission",
            cwd: home,
            generation: "resumed-host",
            nativeSessionId:
              policy === "restricted" ? "restricted-native-agent" : "full-native-agent",
            policy: "restricted",
            autoReviewAvailable: false,
            limits: CursorLimitsSchema.parse({}),
            readOnly,
            ...(readOnly ? { mcp: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) } } : {}),
          }),
        ).toEqual({
          agentId: policy === "restricted" ? "restricted-native-agent" : "full-native-agent",
        });
      } finally {
        await resumed.close();
      }
    } finally {
      await host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("an explicit Cursor auto-review mode overrides legacy full-access policy at the supervised host boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-mode-"));
  const entry = join(home, "scripted-host.mjs");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='open') out({id:message.id,result:{agentId:message.params.policy==='restricted'?'restricted-agent':'unrestricted-agent'}});
 else if(message.method==='close') out({id:message.id,result:{disposed:true}});
});
`,
  );
  try {
    const session = await openCursorSession(
      {
        threadId: ThreadId.parse("permission"),
        cwd: home,
        permissionMode: "auto-review",
        runtimePolicy: "full-access",
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
      },
      {
        entry,
        env: { HOME: home },
        instanceId: "instance",
        policy: "full-access",
        generation: () => "host",
        now: () => 1,
      },
    );
    try {
      expect(session.nativeSessionId).toBe("restricted-agent");
    } finally {
      await session.close("shutdown");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Cursor capability previews disclose the read-only fallback until sandbox support is established", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-preview-"));
  const adapter = createCursorAdapter({ instance: { id: "private", homeDir: home } });
  try {
    const capabilities = adapter.capabilities({
      installed: true,
      version: "1.0.35",
      auth: "unknown",
      loginHint: "unused",
    });
    expect(capabilities.permissions?.modes).not.toContain("auto-review");
    expect(capabilities.permissions?.modes).toContain("read-only");
    expect(capabilities.permissions?.nativeAutoReview).toBe(false);
    expect(
      capabilities.permissions?.guarantees?.find((g) => g.mode === "auto-review"),
    ).toMatchObject({
      level: "tool-selection",
      gates: { writes: true, shell: true, network: true, protectedReads: false },
    });
  } finally {
    await adapter.close();
    await rm(home, { recursive: true, force: true });
  }
});
