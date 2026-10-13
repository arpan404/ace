import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import {
  DeviceId,
  Thread,
  ThreadId,
  type PreviewSuggestion,
  type ServerMessage,
} from "@ace/protocol";
import { stubHandler } from "../commands.ts";
import { PreviewClient } from "../preview-client.ts";
import { startServer } from "../server.ts";
import { Client, token } from "../socket-test-support.ts";
import { Store } from "../store.ts";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createPreviewSuggestions } from "./service.ts";

/** A tiny dev server: serves a titled page and prints its address once it listens. */
const serverScript = `
const http = require("node:http");
const title = process.argv[2];
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>" + title + "</title><h1>" + title + "</h1>");
});
server.listen(0, "127.0.0.1", () => {
  console.log("  Local:   http://localhost:" + server.address().port + "/");
});
process.on("SIGTERM", () => process.exit(0));
`;

/** Runs the server under `sh` (so the daemon is not its parent) in `cwd`; resolves its port. */
async function backgroundServer(cwd: string, title: string, children: ChildProcess[]) {
  const child = spawn(
    "/bin/sh",
    ["-c", `${JSON.stringify(process.execPath)} ../server.cjs ${JSON.stringify(title)}; :`],
    { cwd, detached: true, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const port = /localhost:(\d+)/.exec(line)?.[1];
    if (port) return Number(port);
  }
  throw new Error(`${title} exited before listening`);
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-suggest-"));
  const project = join(home, "project");
  const outside = join(home, "outside");
  await mkdir(join(project, "web"), { recursive: true });
  await mkdir(join(outside, "web"), { recursive: true });
  await writeFile(join(project, "server.cjs"), serverScript);
  await writeFile(join(outside, "server.cjs"), serverScript);
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => 1000 });
  const workspaceId = store.createWorkspace(project, "Dev server project");
  const thread = Thread.parse({
    id: "thread-suggest",
    workspaceId,
    provider: "codex",
    title: "Suggest",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, project, () => 1000);
  const suggestions = createPreviewSuggestions(
    { store, runtime: () => runtime, now: () => Date.now(), daemonPorts: () => new Set() },
    { minDelay: 200, maxDelay: 800 },
  );
  const previews = new PreviewClient();
  const server = await startServer({
    store,
    port: 0,
    token,
    hostId: "host",
    now: () => 1000,
    handler: stubHandler(),
    workspaceActions: runtime,
    previewClient: previews,
    previewSuggestions: suggestions,
    preview: { host: "127.0.0.1", wildcardHost: "preview.test" },
    canReadThread: (_device, id) => store.getThread(id) !== undefined,
  });
  if (server.preview) previews.bind(server.preview);
  const client = new Client(server.url);
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, token, deviceId: DeviceId.parse("desktop") });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  const children: ChildProcess[] = [];
  return {
    project,
    outside,
    client,
    threadId: ThreadId.parse(thread.id),
    children,
    async close() {
      for (const child of children)
        if (child.pid && child.exitCode === null)
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // Already gone.
          }
      await client.close();
      suggestions.close();
      await server.close();
      await runtime.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Reads messages until `match` returns a value; a reply or push that doesn't match is skipped. */
async function until<T>(
  client: Client,
  match: (message: ServerMessage) => T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Timed out waiting for a message");
    const message = await Promise.race([
      client.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for a message")), left),
      ),
    ]);
    const value = match(message);
    if (value !== undefined) return value;
  }
}

let requests = 0;
async function listSuggestions(client: Client, threadId: ThreadId): Promise<PreviewSuggestion[]> {
  const requestId = `list-${++requests}`;
  client.send({
    type: "preview.request",
    requestId,
    threadId,
    operation: { op: "list", suggestions: true },
  });
  return until(client, (message) =>
    message.type === "preview.result" && message.requestId === requestId
      ? (message.suggestions ?? [])
      : undefined,
  );
}

const pushed =
  (threadId: ThreadId, accept: (list: PreviewSuggestion[]) => boolean) =>
  (message: ServerMessage) =>
    message.type === "preview.suggestions" &&
    message.threadId === threadId &&
    accept(message.suggestions)
      ? message.suggestions
      : undefined;

test("a dev server started in a project terminal is suggested with its title, then removed after it stops; one outside the project never is", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const outsidePort = await backgroundServer(join(f.outside, "web"), "Other Project", f.children);
  expect(await listSuggestions(f.client, f.threadId)).toEqual([]);

  f.client.send({
    type: "terminal.request",
    requestId: "open",
    operation: { op: "open", threadId: f.threadId, name: "dev", cols: 80, rows: 24 },
  });
  const terminalId = await until(f.client, (message) =>
    message.type === "terminal.result" && message.requestId === "open"
      ? message.terminal?.id
      : undefined,
  );
  f.client.send({
    type: "terminal.request",
    requestId: "run",
    operation: {
      op: "write",
      threadId: f.threadId,
      terminalId,
      data: `${JSON.stringify(process.execPath)} server.cjs "Terminal App"\r`,
    },
  });
  const started = await until(
    f.client,
    pushed(f.threadId, (list) => list.some((entry) => entry.title === "Terminal App")),
  );
  const terminalServer = started.find((entry) => entry.title === "Terminal App");
  expect(terminalServer).toMatchObject({
    url: `http://localhost:${terminalServer?.port}/`,
    source: "terminal",
  });

  // A server in the project but not started from a terminal is found by its directory.
  const projectPort = await backgroundServer(join(f.project, "web"), "Project API", f.children);
  const both = await until(
    f.client,
    pushed(f.threadId, (list) => list.some((entry) => entry.port === projectPort)),
  );
  expect(both.find((entry) => entry.port === projectPort)).toMatchObject({
    title: "Project API",
    source: "listener",
  });
  const listed = await listSuggestions(f.client, f.threadId);
  expect(listed.map((entry) => entry.port).toSorted()).toEqual(
    [terminalServer?.port, projectPort].toSorted(),
  );
  expect(listed.map((entry) => entry.port)).not.toContain(outsidePort);

  // Ctrl-C in the terminal stops its server; the suggestion goes with it.
  f.client.send({
    type: "terminal.request",
    requestId: "stop",
    operation: { op: "write", threadId: f.threadId, terminalId, data: "\x03" },
  });
  const after = await until(
    f.client,
    pushed(f.threadId, (list) => !list.some((entry) => entry.port === terminalServer?.port)),
  );
  expect(after.map((entry) => entry.port)).toEqual([projectPort]);
  expect((await listSuggestions(f.client, f.threadId)).map((entry) => entry.port)).not.toContain(
    outsidePort,
  );
});
