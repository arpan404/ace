import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Agent, McpScope, McpCapability } from "@ace/protocol";
import { ToolRegistry, nodeScheduler, developerInstructions } from "@ace/mcp-server";
import { ScreenManager } from "@ace/screen";
import { startDaemon, readConfig, createDevThread } from "../src/index.ts";
import { z } from "zod";

// Isolated catalogue measurement. No provider, browser or native-helper process is started.
const root = new URL("../../../", import.meta.url).pathname;
const home = await mkdtemp(join(tmpdir(), "ace-tool-list-"));
const baselineBrowserPath = join(root, "packages/browser/src/.baseline-mcp.ts");
const baselineScreenPath = join(root, "packages/screen/src/.baseline-tools.ts");
const ref = process.argv[2] ?? "origin/main";
const read = (path: string) =>
  execFileSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8" });
let registry: ToolRegistry | undefined;
const screen = new ScreenManager({
  command: process.execPath,
  args: [],
  platform: "win32",
  endpoint: `unix:${join(home, "unused")}`,
  nextId: () => "unused",
  recordingDirectory: home,
  publishArtifact: async () => {},
});
const daemon = await startDaemon({
  config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  screen,
  modelInstances: [],
  history: { instances: [] },
  toolkits: [
    {
      register(value) {
        registry = value;
      },
    },
  ],
});
try {
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(home, "Measurement"));
  const agent = Agent.parse({
    id: "measurement",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    cwd: home,
    fidelity: "full",
    status: { state: "working", activity: "thinking" },
    createdAt: 1,
    native: { provider: "codex", nativeId: "measurement" },
  });
  daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  const scope = McpScope.parse({
    threadId: thread.id,
    agentId: agent.id,
    sessionId: "measurement",
    capabilities: McpCapability.options,
  });
  if (!daemon.mcp || !registry) throw new Error("Missing measurement catalogue");
  const lease = daemon.mcp.openSession(scope, new AbortController().signal);
  const response = await fetch(daemon.mcp.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lease.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await response.text();
  const payload = body.startsWith("event:")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : body;
  const tool = z
    .object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    })
    .passthrough();
  const after = z
    .object({ result: z.object({ tools: z.array(tool) }) })
    .parse(JSON.parse(payload ?? "")).result.tools;
  registry.setAvailability(() => () => true);
  const full = registry.list(lease.principal);
  await writeFile(baselineBrowserPath, read("packages/browser/src/mcp.ts"));
  await writeFile(baselineScreenPath, read("packages/screen/src/tools.ts"));
  const baselineBrowser = await import(baselineBrowserPath);
  const baselineScreen = await import(baselineScreenPath);
  const oldRegistry = new ToolRegistry({ scheduler: nodeScheduler });
  baselineBrowser
    .browserToolkit({
      execute: async () => {
        throw new Error("No browser effects");
      },
      screenshot: async () => {
        throw new Error("No browser effects");
      },
    })
    .register(oldRegistry);
  const oldDescriptions = new Map(
    oldRegistry.list(lease.principal).map((entry) => [entry.name, entry.description]),
  );
  const oldScreen = z
    .array(z.object({ name: z.string(), description: z.string() }))
    .parse(baselineScreen.computerUseTools);
  for (const entry of oldScreen) oldDescriptions.set(entry.name, entry.description);
  const oldOpen = read("apps/daemon/src/browser-toolkit.ts").match(
    /name: "ace_browser_open",\s*description:\s*("[^\n]+")/,
  );
  if (!oldOpen?.[1]) throw new Error("Missing baseline browser open");
  oldDescriptions.set("ace_browser_open", z.string().parse(JSON.parse(oldOpen[1])));
  const instructions = read("packages/mcp-server/src/status.ts").match(
    /export const aceInstructions =\s*("[^\n]+")/,
  );
  if (!instructions?.[1]) throw new Error("Missing baseline instructions");
  const before = [
    after.find((entry) => entry.name === "ace_status"),
    ...full.map((entry) => ({
      ...entry,
      description: `${oldDescriptions.get(entry.name) ?? entry.description}${registry?.capability(entry.name) === "screen" ? " Computer use is disabled. Ask the person to enable it in Settings → Computer use." : registry?.capability(entry.name) === "devices" ? " Devices are disabled. Ask the person to enable devices in the thread's Devices panel." : ""}`,
    })),
  ].filter((entry) => entry !== undefined);
  const staged = [
    after.find((entry) => entry.name === "ace_status"),
    ...full.filter(
      (entry) =>
        registry?.capability(entry.name) !== "devices" &&
        (registry?.capability(entry.name) !== "screen" || entry.name === "screen_request_app"),
    ),
  ].filter((entry) => entry !== undefined);
  const approved = [
    after.find((entry) => entry.name === "ace_status"),
    ...full.filter((entry) => registry?.capability(entry.name) !== "devices"),
  ].filter((entry) => entry !== undefined);
  console.log(
    JSON.stringify({
      reference: ref,
      before,
      after,
      staged,
      approved,
      fullyEnabled: full,
      oldInstructions: z.string().parse(JSON.parse(instructions[1])),
      instructions: Object.fromEntries(
        ["codex", "claude", "opencode", "cursor", "pi", "acp"].map((provider) => [
          provider,
          developerInstructions(
            z.enum(["codex", "claude", "opencode", "cursor", "pi", "acp"]).parse(provider),
          ),
        ]),
      ),
    }),
  );
} finally {
  await daemon.close();
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(baselineBrowserPath, { force: true }),
    rm(baselineScreenPath, { force: true }),
  ]);
}
