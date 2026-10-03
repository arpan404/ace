import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import type { Frame, ProviderAdapter } from "@ace/engine-api";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createAcpAdapter, antigravityQuirks, cursorQuirks, genericQuirks } from "@ace/adapter-acp";
import { detectChromium } from "@ace/browser";
import { providerFeatures } from "./testing/provider-features.ts";
import { Agent, ThreadId } from "@ace/protocol";
import { createDevThread } from "./index.ts";
import { bindMcpSession } from "./services/mcp-session.ts";

for (const provider of ["claude", "codex", "opencode", "cursor", "antigravity", "acp"] as const)
  it(`${provider} receives scoped ace tools through its native session configuration without a prompt`, async (test) => {
    const chromium = await detectChromium();
    if (!chromium) {
      test.skip();
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "ace-provider-mcp-"));
    const features = await providerFeatures(directory, chromium);
    onTestFinished(async () => {
      try {
        await features.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const { store, mcp } = features.daemon;
    const binary = join(directory, provider);
    const script = new URL("./testing/mcp-provider.ts", import.meta.url).href;
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.env.ACE_TEST_PROVIDER=${JSON.stringify(provider)}; await import(${JSON.stringify(script)});\n`,
    );
    await chmod(binary, 0o755);
    const thread = createDevThread(store, store.createWorkspace(directory, "MCP"));
    store.appendEvents(
      thread.id,
      [
        {
          type: "agent.created",
          agent: Agent.parse({
            id: "root",
            threadId: thread.id,
            parentId: null,
            origin: "root",
            native: { provider },
            fidelity: "full",
            cwd: directory,
            status: { state: "idle" },
            createdAt: 1,
          }),
        },
      ],
      1,
    );
    await features.approve(thread.id);
    const discovery = {
      overrides: { codex: binary, claude: binary, opencode: binary, cursor: binary },
    };
    const adapter: ProviderAdapter & { close?(): Promise<void> } =
      provider === "claude"
        ? createClaudeAdapter({ executable: binary })
        : provider === "codex"
          ? createCodexAdapter({ discovery })
          : provider === "opencode"
            ? createOpenCodeAdapter({ discovery })
            : createAcpAdapter(
                provider === "cursor"
                  ? cursorQuirks
                  : provider === "antigravity"
                    ? antigravityQuirks
                    : genericQuirks,
                { command: binary, args: [] },
              );
    const observed = Promise.withResolvers<string>();
    const frames: Frame[] = [];
    let session;
    try {
      session = await bindMcpSession(
        adapter,
        {
          threadId: thread.id,
          cwd: directory,
          env: {
            PATH: directory,
            ACE_TEST_FEATURE_URL: features.browserUrl,
            ACE_TEST_FEATURE_DEVICE: features.deviceId,
          },
          signal: new AbortController().signal,
          onExit() {},
          onFrame(frame) {
            frames.push(frame);
            const encoded = JSON.stringify(frame.data);
            if (encoded.includes('"mcpProof":')) observed.resolve(encoded);
          },
        },
        {
          mcp,
          store,
          id: () => "provider-session",
          capabilities: ["agents", "notify", "browser", "screen", "devices"],
        },
      );
      expect(await observed.promise).toContain(thread.id);
      expect(session.nativeSessionId).toBeTruthy();
      expect(JSON.stringify(frames)).not.toMatch(/Bearer [a-f0-9]{64}/);
      expect(JSON.stringify(frames)).toMatch(/<ACE_MCP_CREDENTIAL>|\[ace lease redacted\]/);
      expect(await features.effects(thread.id)).toEqual({
        browser: "provider-input",
        screen: '{"ref":"save","action":"press"}\n',
        device: expect.stringContaining("'input' 'tap' '3' '4'"),
      });
    } finally {
      await session?.close("shutdown");
      await adapter.close?.();
    }
  });

it("rejects configured HTTP MCP when the installed ACP provider only advertises stdio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-acp-mcp-missing-"));
  const binary = join(directory, "acp");
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.env.ACE_TEST_PROVIDER="acp"; await import(${JSON.stringify(new URL("./testing/mcp-provider.ts", import.meta.url).href)});\n`,
  );
  await chmod(binary, 0o755);
  try {
    await expect(
      createAcpAdapter(genericQuirks, { command: binary, args: ["--no-mcp"] }).openSession({
        threadId: ThreadId.parse("unsupported"),
        cwd: directory,
        signal: new AbortController().signal,
        mcp: {
          configuredServers: [
            { type: "http", name: "user-server", url: "http://127.0.0.1:12345/mcp", headers: [] },
          ],
          httpServers: [],
          stdioServers: [],
          secrets: [],
          end() {},
        },
        onFrame() {},
        onExit() {},
      }),
    ).rejects.toThrow("does not advertise HTTP MCP");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
