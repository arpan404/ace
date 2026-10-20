import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Capabilities, Command, McpStatus, ProviderKind } from "@ace/protocol";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import { developerInstructions } from "@ace/mcp-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { AdapterRegistry, readConfig, startDaemon } from "./index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Starts the daemon as production composes it and opens a thread through a scripted CLI. */
async function threadConnection() {
  const directory = await mkdtemp(join(tmpdir(), "ace-mcp-status-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const scripted = createScriptedAdapter({
    provider: "codex",
    steps: [],
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: false,
      backgroundTaskControl: false,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
  });
  let native: SessionContext | undefined;
  const registry = new AdapterRegistry();
  registry.register(
    {
      ...scripted,
      async openSession(ctx: SessionContext) {
        native = ctx;
        return scripted.openSession(ctx);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: directory, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: { registry },
  });
  cleanup.push(() => daemon.close());
  const engine = daemon.engine;
  if (!engine) throw new Error("Missing engine");
  const command = Command.parse({
    id: "create",
    deviceId: "human",
    payload: {
      type: "thread.create",
      workspaceId: daemon.store.createWorkspace(directory, "Greeting"),
      provider: "codex",
      input: [{ type: "text", text: "Make a small game" }],
    },
  });
  expect(
    daemon.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, daemon.store),
    ),
  ).toHaveProperty("ok", true);
  await engine.flush();
  const connection = native?.aceMcp;
  if (!connection) throw new Error("The provider session received no ace MCP connection");
  const client = new Client(
    { name: "status-test", version: "1" },
    { versionNegotiation: { mode: "legacy" } },
  );
  cleanup.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.bearer}` } },
    }),
  );
  // context's status adds the project; the groups and access are ace's status.
  const status = async () =>
    z
      .object({ status: z.looseObject(McpStatus.shape) })
      .parse(
        (await client.callTool({ name: "context", arguments: { topics: ["status"] } }))
          .structuredContent,
      ).status;
  return { daemon, client, status };
}

it("a new thread's context status names only the groups that are off, each with why", async () => {
  const { daemon, status } = await threadConnection();
  const reported = await status();
  const names = reported.groups.map((group) => group.name);
  // ace has no terminal, forge or file tools; listing them as disabled told agents they could not edit files.
  for (const missing of ["terminal", "forge", "preview", "files"])
    expect(names).not.toContain(missing);
  // Served groups are on, so they cost no words.
  for (const name of ["thread", "browser", "notify", "agents", "thread_control", "automations"])
    expect(names).not.toContain(name);
  for (const group of reported.groups) {
    expect(group.enabled).toBe(false);
    expect(["screen", "devices"]).toContain(group.name);
    expect(group.reason).not.toMatch(/backend|configure/i);
  }
  const thread = daemon.store.listThreads()[0];
  expect(reported.access).toBe(thread?.permission?.effective ?? null);
});

it("ace's guidance keeps agents on their own shell, file and web tools", async () => {
  const { client } = await threadConnection();
  expect(client.getInstructions()).toContain("Your shell, file and web tools work as usual");
  // Providers that opt out of server instructions get the same text in their own channel.
  for (const provider of ["codex", "cursor", "pi"] as const)
    expect(developerInstructions(provider)).toContain(
      "Your shell, file and web tools work as usual",
    );
  for (const provider of ProviderKind.options)
    expect(developerInstructions(provider)).not.toMatch(/terminal tools/i);
});
