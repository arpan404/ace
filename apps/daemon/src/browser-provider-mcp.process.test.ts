import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AgentId } from "@ace/protocol";
import { z } from "zod";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createAcpAdapter, genericQuirks, cursorQuirks, antigravityQuirks } from "@ace/adapter-acp";
import { acpInjection, acpStdioInjection } from "@ace/mcp-server";
import type { ProviderAdapter, Frame } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { withDaemonMcp } from "./services/provider-mcp.ts";
import { setup, cleanups, invoke } from "./browser-mcp-test-support.ts";

const proof = z.object({
  tools: z.array(z.string()),
  opened: z.object({ isError: z.boolean().optional() }).passthrough(),
});
const envelope = z.object({
  result: z
    .object({
      thread: z.object({ mcpProof: proof }).optional(),
      mcpProof: proof.optional(),
    })
    .passthrough(),
});
const openCodeResponse = z.object({
  body: z.object({ mcpProof: proof, preservedModel: z.string() }).passthrough(),
});
const cases = [
  { provider: "codex", http: true, resume: false },
  { provider: "codex", http: true, resume: true },
  { provider: "opencode", http: true, resume: false },
  { provider: "cursor", http: true, resume: false },
  { provider: "antigravity", http: true, resume: false },
  { provider: "acp", http: true, resume: false },
  { provider: "acp", http: true, resume: true },
  { provider: "acp", http: false, resume: false },
  { provider: "acp", http: false, resume: true },
] as const;

it.each(cases)(
  "$provider CLI consumes injected MCP configuration, http=$http resume=$resume, and calls its thread's browser",
  async ({ provider, http, resume }) => {
    const f = await setup(provider);
    const cli = join(f.home, "fake-provider.mjs");
    const entry = fileURLToPath(new URL("./testing/browser-mcp-cli.ts", import.meta.url));
    await writeFile(
      cli,
      `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/browser-mcp-cli.ts", import.meta.url).href)};\n`,
      { mode: 0o700 },
    );
    await chmod(cli, 0o700);
    const configured =
      '{ "model": "retained-model", "mcp": { "user": { "type": "local", "command": ["user-mcp"] } } }';
    const destination = `http://localhost:3000/${provider}-${http ? "http" : "stdio"}-${resume ? "load" : "new"}`;
    const env = {
      PATH: f.home,
      ACE_TEST_BROWSER_PROVIDER: provider,
      ACE_TEST_BROWSER_URL: destination,
      ACE_TEST_ACP_HTTP: http ? "1" : "0",
      OPENCODE_CONFIG_CONTENT: configured,
    };
    const installed: DiscoveryResult = {
      installed: true,
      path: cli,
      version: "1.18.33",
      auth: "unknown",
      loginHint: "synthetic",
    };
    const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "synthetic" };
    let source: ProviderAdapter;
    if (provider === "codex")
      source = createCodexAdapter({
        cli: { ...installed, version: "0.159.1" },
        runtime: { stopGraceMs: 0 },
      });
    else if (provider === "opencode") {
      const owner = createOpenCodeAdapter({
        runtime: {
          discover: async () => ({
            claude: absent,
            codex: absent,
            cursor: absent,
            opencode: installed,
          }),
        },
      });
      cleanups.push(() => owner.close());
      source = owner;
    } else
      source = createAcpAdapter(
        provider === "cursor"
          ? cursorQuirks
          : provider === "antigravity"
            ? antigravityQuirks
            : genericQuirks,
        {
          command: provider === "cursor" ? cli : process.execPath,
          args: provider === "cursor" ? ["acp"] : [entry],
          env,
        },
      );
    const adapter = withDaemonMcp(
      { store: f.store, services: { mcp: f.mcp }, id: () => "fake-cli-session" },
      source,
    );
    const frames: Frame[] = [];
    // Generic ACP's main integration owns this pre-existing negotiated lease.
    const lease =
      provider === "acp"
        ? f.mcp.openSession(
            {
              sessionId: "negotiated",
              threadId: f.thread.id,
              agentId: AgentId.parse("root"),
              capabilities: ["browser"],
            },
            new AbortController().signal,
          )
        : undefined;
    const connection = lease ? { url: f.mcp.url, bearer: lease.bearer } : undefined;
    const session = await adapter.openSession({
      threadId: f.thread.id,
      cwd: f.home,
      env,
      signal: new AbortController().signal,
      ...(resume ? { resume: { nativeSessionId: "native" } } : {}),
      ...(connection && lease
        ? {
            mcp: {
              httpServers: acpInjection(connection).mcpServers,
              stdioServers: acpStdioInjection(connection).mcpServers,
              secrets: [lease.bearer],
              end: lease.end,
            },
          }
        : {}),
      onFrame(frame) {
        frames.push(frame);
      },
      onExit() {},
    });
    cleanups.push(() => session.close("shutdown"));
    expect(f.browser.state(f.thread.id)).toMatchObject({ backend: "headless", url: destination });
    expect(session.nativeSessionId).toBe("native");
    const observed = frames.flatMap((frame) => {
      const rpc = envelope.safeParse(frame.data);
      const httpReply = openCodeResponse.safeParse(frame.data);
      return rpc.success
        ? [rpc.data.result.mcpProof ?? rpc.data.result.thread?.mcpProof].filter(
            (value) => value !== undefined,
          )
        : httpReply.success
          ? [httpReply.data.body.mcpProof]
          : [];
    });
    expect(observed).toContainEqual(
      expect.objectContaining({
        tools: expect.arrayContaining([
          "ace_browser_open",
          "ace_browser_snapshot",
          "ace_browser_close",
        ]),
      }),
    );
    if (provider === "opencode")
      expect(
        frames.some(
          (frame) =>
            openCodeResponse.safeParse(frame.data).data?.body.preservedModel === "retained-model",
        ),
      ).toBe(true);
    if (connection) expect(JSON.stringify(frames)).not.toContain(connection.bearer);
    await session.close("shutdown");
    if (connection) expect((await invoke(connection, "ace_browser_open", {})).status).toBe(401);
  },
);
