import { mkdtemp, chmod, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { AgentId, ThreadId, type McpAttribution } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { seedScriptedModels, scriptedModelInstance } from "../testing/models.ts";

const Result = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.unknown().optional(),
});
export async function cliDaemon(parentProvider: "claude" | "codex" | "opencode" = "opencode") {
  const home = await mkdtemp(join(tmpdir(), "ace-delegation-cli-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  await mkdir(repo);
  const git = promisify(execFile);
  await git("git", ["init", "-q"], { cwd: repo });
  await git(
    "git",
    [
      "-c",
      "user.name=ace-test",
      "-c",
      "user.email=ace@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "Sandbox",
    ],
    { cwd: repo },
  );
  const registry = new AdapterRegistry();
  for (const provider of ["claude", "codex", "opencode"] as const) {
    const binary = join(home, provider);
    const source = new URL(
      `../../../../packages/adapter-${provider}/src/testing/${provider === "opencode" ? "cli-v2.mjs" : "cli.ts"}`,
      import.meta.url,
    ).href;
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.env.ACE_TEST_COMPLETE_INPUT="1"; process.env.ACE_TEST_DELEGATION_RESULT="1"; await import(${JSON.stringify(source)});\n`,
    );
    await chmod(binary, 0o700);
    const env = { ...process.env, ACE_TEST_COMPLETE_INPUT: "1", ACE_TEST_DELEGATION_RESULT: "1" };
    const discovery = {
      installed: true,
      auth: "logged_in" as const,
      loginHint: "synthetic",
      path: binary,
      version: provider === "claude" ? "2.1.286" : provider === "codex" ? "0.159.1" : "2.0.22",
    };
    registry.register(
      provider === "claude"
        ? createClaudeAdapter({ executable: binary, env })
        : provider === "codex"
          ? createCodexAdapter({ cli: discovery, discovery: { env } })
          : createOpenCodeAdapter({ discovery: { overrides: { opencode: binary }, env } }),
      discovery,
    );
  }
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(home, "daemon"), ACE_PORT: "0", ACE_LOG_LEVEL: "error" }),
    engine: { registry },
    modelInstances: [],
  });
  onTestFinished(() => daemon.close());
  for (const provider of ["claude", "codex", "opencode"] as const)
    await seedScriptedModels(
      daemon.models,
      scriptedModelInstance(provider, repo),
      provider === "opencode" ? "opencode-go/muse-spark-1.3-contributor" : "chosen-model",
    );
  const controls = daemon.agentControl,
    engine = daemon.engine;
  if (!controls || !engine) throw new Error("Missing agent control owners");
  const workspaceId = daemon.store.createWorkspace(repo, "Sandbox");
  const created = controls.delegations.command("create-parent", {
    type: "thread.create",
    workspaceId,
    provider: parentProvider,
    permissionMode: "read-only",
    input: [{ type: "text", text: "Hello" }],
  });
  if (!created.ok || !created.threadId) throw new Error(`Parent refused: ${created.error}`);
  await engine.flush();
  const threadId = created.threadId;
  async function settled(id = threadId) {
    if (["done", "failed"].includes(daemon.store.getThread(id)?.status.state ?? "")) return;
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(10000);
      const abort = () => {
        stop();
        reject(new Error("Provider did not settle"));
      };
      const stop = daemon.store.subscribe((events) => {
        if (
          events.some((e) => e.threadId === id && e.payload.type === "thread.updated") &&
          ["done", "failed"].includes(daemon.store.getThread(id)?.status.state ?? "")
        ) {
          stop();
          signal.removeEventListener("abort", abort);
          resolve();
        }
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  await settled();
  const parent = daemon.store.getThread(threadId);
  if (!parent?.rootAgentId) throw new Error("Missing root agent");
  const caller: McpAttribution = {
    threadId,
    agentId: AgentId.parse(parent.rootAgentId),
    sessionId: "test-parent",
  };
  const lease = daemon.mcp.openSession(
    { ...caller, capabilities: ["agents", "thread_control"] },
    new AbortController().signal,
  );
  async function call(name: string, args: unknown) {
    const response = await fetch(daemon.mcp.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    if (response.status !== 200) throw new Error(`MCP transport ${response.status}`);
    return z.object({ result: Result }).parse(await response.json()).result;
  }
  return {
    home,
    daemon,
    controls,
    engine,
    caller,
    workspaceId,
    call,
    settled,
    child: (data: unknown) => z.object({ threadId: ThreadId }).parse(data).threadId,
  };
}
