import { once } from "node:events";
import { execFile } from "node:child_process";
import { spawnGitProcess as spawn } from "@ace/git";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Command,
  ProjectsRequest,
  DeviceId,
  type CommandPayload,
  type ProjectsRequest as Request,
  type ServerMessage,
} from "@ace/protocol";
import { Store } from "./store.ts";
import { Projects, type ProjectsOptions } from "./projects.ts";
import { startServer } from "./server.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { stubHandler } from "./commands.ts";
import { Client, token } from "./socket-test-support.ts";
import type { ServerOptions } from "./server-options.ts";
import type { GitProcessRuntime } from "@ace/git";

const execute = promisify(execFile);
export async function projectFixture(options: ProjectsOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-projects-test-")));
  const config = join(root, "gitconfig");
  await writeFile(config, "[init]\n\tdefaultBranch = trunk\n");
  const gitOptions = {
    ...options.git,
    processRuntime: {
      ...options.git?.processRuntime,
      spawn: (command: string, args: string[], input: Parameters<GitProcessRuntime["spawn"]>[2]) =>
        (options.git?.processRuntime?.spawn ?? spawn)(command, args, {
          ...input,
          env: { ...input?.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
        }),
    },
  };
  const store = new Store(join(root, "events.sqlite"), undefined, { now: () => 1000 });
  const projects = new Projects(store, () => 1000, {
    home: root,
    roots: async () => [root],
    ...options,
    git: gitOptions,
  });
  let sequence = 0;
  return {
    root,
    store,
    projects,
    git: (cwd: string, args: string[]) =>
      execute("git", args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
      }),
    command: (payload: CommandPayload, id = `command-${++sequence}`, deviceId = "owner") =>
      projects.execute(Command.parse({ id, deviceId, payload })),
    read: (operation: Request["operation"], device = "owner") =>
      projects.read(
        ProjectsRequest.parse({
          type: "projects.request",
          requestId: `read-${++sequence}`,
          operation,
        }),
        device,
      ),
    async close() {
      await projects.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function projectServer(
  f: Awaited<ReturnType<typeof projectFixture>>,
  options: Partial<ServerOptions> = {},
) {
  const runtime = new WorkspaceRuntime(f.store, f.root, () => 1000);
  const server = await startServer({
    store: f.store,
    port: 0,
    hostId: "host",
    token,
    projects: f.projects,
    workspaceActions: runtime,
    handler: stubHandler(),
    ...options,
  });
  const clients: Client[] = [];
  return {
    ...server,
    async connect(hello: { deviceId?: string; ticket?: string; token?: string } = {}) {
      const client = new Client(server.url);
      clients.push(client);
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse(hello.deviceId ?? "owner"),
        ...(hello.ticket ? { ticket: hello.ticket } : { token: hello.token ?? token }),
      });
      expectWelcome(await client.next());
      return client;
    },
    async close() {
      for (const client of clients) await client.close();
      await server.close();
      await runtime.close();
    },
  };
}
function expectWelcome(message: ServerMessage): void {
  if (message.type !== "welcome") throw new Error("Expected welcome");
}
export async function until(
  client: Client,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}
