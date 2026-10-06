import { expect, test } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startDaemon, readConfig } from "@ace/daemon";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { AceMcpConnectionSchema, readPrivateMcpConfig } from "@ace/mcp-server";
import { AgentId } from "@ace/protocol";

test("Pi native registration retains the engine's scoped agent-control lease and revokes it on shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-pi-mcp-"));
  let issued = "",
    injected: NodeJS.ProcessEnv = {};
  const absent = { installed: false, auth: "unknown" as const, loginHint: "synthetic" };
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: {
      adapterDiscovery: async () => ({
        claude: absent,
        codex: absent,
        cursor: absent,
        opencode: absent,
      }),
      mcp(threadId, agentId, lifetime) {
        const lease = daemon.mcp.openSession(
          {
            sessionId: "engine-pi",
            threadId,
            agentId: AgentId.parse(agentId),
            capabilities: ["agents", "thread_control", "browser"],
          },
          lifetime,
        );
        issued = lease.bearer;
        return {
          url: daemon.mcp.url,
          bearer: lease.bearer,
          signal: lease.principal.signal,
          end: lease.end,
        };
      },
    },
    pi: {
      runtime: {
        discover: async () => ({
          installed: true,
          path: "synthetic-pi",
          version: "0.85.1",
          auth: "unknown",
          loginHint: "synthetic",
        }),
        spawn(options) {
          injected = options.env ?? {};
          return spawnTextSupervised({
            ...options,
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../testing/pi-mcp-peer.ts", import.meta.url)),
              ...(options.args ?? []),
            ],
          });
        },
      },
    },
    modelInstances: [],
  });
  try {
    const controls = daemon.agentControl;
    if (!controls || !daemon.engine) throw new Error("Missing owners");
    const workspaceId = daemon.store.createWorkspace(home, "pi");
    const created = controls.delegations.command("pi-create", {
      type: "thread.create",
      workspaceId,
      provider: "pi",
      permissionMode: "full-access",
      input: [{ type: "text", text: "synthetic" }],
    });
    expect(created.ok).toBe(true);
    await daemon.engine.flush();
    expect(issued).not.toBe("");
    const configuration = z
      .object({ mcp: AceMcpConnectionSchema })
      .parse(JSON.parse(readPrivateMcpConfig(z.string().parse(injected.ACE_PI_SESSION_FILE))));
    expect(configuration.mcp.bearer).toBe(issued);
    expect(JSON.stringify(injected)).not.toContain(issued);
    const response = await fetch(daemon.mcp.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "synthetic-pi", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const listed = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(await response.json());
    expect(listed.result.tools.map((tool) => tool.name)).toContain("ace_browser_open");
    expect(listed.result.tools.map((tool) => tool.name)).toContain("delegate_task");
    expect(listed.result.tools.map((tool) => tool.name)).toContain("ace_question_answer");
    await daemon.engine.close();
    expect(
      (await fetch(daemon.mcp.url, { headers: { Authorization: `Bearer ${issued}` } })).status,
    ).toBe(401);
  } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
