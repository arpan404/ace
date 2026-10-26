import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, test, vi } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { array, object } from "./data.ts";
import { cli, setup } from "./testing/v2-session.ts";
import { ended, stubbornTree, writeCmdShim } from "@ace/adapter-testkit";
import type { ServerOptions } from "./server.ts";
import { nativeLaunchedTree } from "./launched-tree.ts";

// npm installs OpenCode on Windows as `opencode.cmd`, so every case launches the fake through
// cmd.exe. The pid ace spawns is the shim's, never the server's own.
const windows = process.platform === "win32";
const dirs: string[] = [];
const others: (() => void)[] = [];
afterEach(async () => {
  for (const stop of others.splice(0)) stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function shimmed(
  env: NodeJS.ProcessEnv = {},
  preload?: (dir: string) => Promise<string>,
  runtime: ServerOptions["runtime"] = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "ace-opencode-shim-"));
  dirs.push(dir);
  const shim = await writeCmdShim(dir, "opencode", cli, await preload?.(dir));
  const spawned: ReturnType<typeof spawnSupervised>[] = [];
  const options: ServerOptions = {
    discovery: { env },
    runtime: {
      ...runtime,
      spawn: (spawnOptions) => {
        const proc = spawnSupervised({
          ...spawnOptions,
          command: spawnOptions.command === cli ? shim : spawnOptions.command,
        });
        spawned.push(proc);
        return proc;
      },
    },
  };
  return { dir, spawned, h: await setup(options) };
}
const serverPid = async (h: Awaited<ReturnType<typeof setup>>) =>
  Number(object(await h.control("/api/info")).pid);

test.runIf(windows)(
  "Windows OpenCode behind an npm .cmd shim starts, streams and stops its server tree on close",
  async () => {
    const { h, spawned } = await shimmed();
    const pid = await serverPid(h);
    expect(spawned[0]?.pid).not.toBe(pid);
    await h.session.send([{ type: "text", text: "through cmd.exe" }], "queue");
    await h.publish("session.execution.started");
    expect(h.projection.view.thread.status.state).toBe("working");
    const prompts = array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => String(r.path).endsWith("/prompt"));
    expect(prompts.map((p) => object(p.body).text)).toEqual(["through cmd.exe"]);
    expect(JSON.stringify(h.frames)).not.toContain("ephemeral-test-secret");
    await h.adapter.close();
    expect(h.exits).toHaveLength(1);
    expect(await ended(pid)).toBe(true);
  },
);

test.runIf(windows)(
  "Windows OpenCode interrupts through its HTTP protocol and answers a child approval on the owning session",
  async () => {
    const { h } = await shimmed();
    await h.publish("session.execution.started");
    await h.publish("session.tool.input.started", {
      assistantMessageID: "a",
      id: "tool",
      name: "shell",
    });
    await h.session.interrupt({ cascade: false });
    expect(
      array(await h.control("/test/requests"))
        .map(object)
        .some((r) => String(r.path).endsWith("/interrupt")),
    ).toBe(true);
    expect(h.projection.view.thread.status.state).toBe("working");
    await h.publish("session.execution.interrupted");
    await h.publish("session.created", {
      sessionID: "child",
      parentID: h.session.nativeSessionId,
      projectID: "project-one",
      location: { directory: "/one" },
    });
    await h.publish("permission.asked", {
      sessionID: "child",
      id: "ask",
      action: "edit",
      resources: ["file.ts"],
      save: ["*.ts"],
      source: { type: "tool", messageID: "a", id: "t" },
    });
    expect(h.projection.view.thread.status.state).toBe("needs_you");
    await h.session.resolve("permission:child:ask", { kind: "approval", optionId: "once" });
    const reply = array(await h.control("/test/requests"))
      .map(object)
      .find((r) => r.path === "/api/session/child/permission/ask/reply");
    expect(reply?.body).toEqual({ decision: "once" });
  },
);

test.runIf(windows)(
  "Windows OpenCode recovers a dropped event stream from the same shimmed server, keeping the thread unsettled",
  async () => {
    const { h } = await shimmed();
    const root = h.session.nativeSessionId;
    const pid = await serverPid(h);
    await h.control("/test/state", {
      sessions: [
        {
          id: "child",
          parentID: root,
          location: { directory: "/one" },
          projectID: "project-one",
          time: { created: 1, updated: 2, idle: 2 },
          outcome: "succeeded",
        },
      ],
      active: { child: { type: "running" } },
      permissions: [{ sessionID: "child", id: "ask", action: "edit", resources: ["x"] }],
    });
    const recovery = h.recovered();
    await h.control("/test/drop", {});
    await recovery;
    expect(Object.values(h.projection.view.agents).map((a) => a.native.nativeId)).toContain(
      "child",
    );
    expect(h.projection.view.thread.status.state).toBe("needs_you");
    expect(await serverPid(h)).toBe(pid);
  },
);

test.runIf(windows)(
  "Windows OpenCode selects a variant, then resumes the same native session with a new effort",
  async () => {
    const { h } = await shimmed();
    const nativeId = h.session.nativeSessionId;
    if (!h.session.configure) throw new Error("Live model configuration unavailable");
    await h.session.configure({
      provider: "opencode",
      model: "opencode-go/muse-spark-1.3-contributor",
      options: { effort: "high" },
    });
    await h.session.send([{ type: "text", text: "with high variant" }], "queue");
    await h.open("/two");
    await h.session.close("shutdown");
    await h.open("/one", nativeId, undefined, "opencode-go/muse-spark-1.3-contributor", {
      effort: "low",
    });
    const requests = array(await h.control("/test/requests")).map(object);
    const switches = requests.filter((r) => String(r.path).endsWith("/model"));
    expect(switches.map((r) => object(r.body).model)).toEqual([
      { providerID: "opencode-go", id: "muse-spark-1.3-contributor", variant: "high" },
      expect.objectContaining({ variant: "low" }),
    ]);
    // Resume reuses /one's native session; only /two creates another.
    expect(
      requests
        .filter((r) => r.path === "/api/session" && r.method === "POST")
        .map((r) => object(object(r.body).location).directory),
    ).toEqual(["/one", "/two"]);
  },
);

test.runIf(windows)(
  "Windows OpenCode close ends a server that outlives its stdin lease, with its grandchild",
  async () => {
    const pids = join(await mkdtemp(join(tmpdir(), "ace-opencode-tree-")), "pids.json");
    dirs.push(join(pids, ".."));
    const { h, spawned } = await shimmed({ ACE_TEST_TREE_PIDS: pids }, stubbornTree);
    const tree = object(JSON.parse(await readFile(pids, "utf8")));
    expect(tree.agent).toBe(await serverPid(h));
    await h.adapter.close();
    expect(await spawned[0]?.exited).toMatchObject({ reason: "stopped" });
    expect(await ended(Number(tree.agent))).toBe(true);
    expect(await ended(Number(tree.child))).toBe(true);
  },
);

/** A compatible OpenCode server ace did not launch, answering to the password tests use. */
async function otherServer() {
  const child = spawn(process.execPath, [cli, "serve", "--stdio", "--port", "0"], {
    env: { ...process.env, OPENCODE_PASSWORD: "ephemeral-test-secret" },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  others.push(() => child.kill());
  for await (const line of createInterface({ input: child.stdout })) {
    const url = String(object(JSON.parse(line)).url);
    const authorization = `Basic ${Buffer.from("opencode:ephemeral-test-secret").toString("base64")}`;
    const info = async () =>
      object(await (await fetch(new URL("/api/info", url), { headers: { authorization } })).json());
    return { url, pid: Number((await info()).pid), info };
  }
  throw new Error("The other OpenCode server never announced its URL");
}
/** Rewrites the launched fake's readiness line to announce `ACE_TEST_READY_URL` instead. */
async function staleReadiness(dir: string): Promise<string> {
  const path = join(dir, "stale-readiness.mjs");
  await writeFile(
    path,
    [
      "const log = console.log;",
      "console.log = (...args) =>",
      '  typeof args[0] === "string" && args[0].startsWith(\'{"url"\')',
      "    ? log(JSON.stringify({ url: process.env.ACE_TEST_READY_URL }))",
      "    : log(...args);",
      "",
    ].join("\n"),
  );
  return path;
}

test.runIf(windows)(
  "Windows OpenCode refuses a readiness URL that names a compatible server outside its launch, leaving that server running",
  async () => {
    const other = await otherServer();
    const launched: ReturnType<typeof spawnSupervised>[] = [];
    const dir = await mkdtemp(join(tmpdir(), "ace-opencode-stale-"));
    dirs.push(dir);
    const shim = await writeCmdShim(dir, "opencode", cli, await staleReadiness(dir));
    await expect(
      setup({
        discovery: { env: { ACE_TEST_READY_URL: other.url } },
        runtime: {
          spawn: (options) => {
            const proc = spawnSupervised({ ...options, command: shim });
            launched.push(proc);
            return proc;
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "unreachable",
      detail: expect.stringMatching(/outside the process tree ace launched/),
    });
    // ace stops only its own launch; the server the stale URL named keeps answering.
    expect(await launched[0]?.exited).toBeDefined();
    expect(await ended(other.pid, 500)).toBe(false);
    expect((await other.info()).pid).toBe(other.pid);
  },
);

test.runIf(windows)(
  "Windows OpenCode accepts its own shimmed server, then refuses it on recovery once that pid carries another creation time",
  async () => {
    const real = await nativeLaunchedTree();
    let reused: number | undefined;
    const { h } = await shimmed({}, undefined, {
      launchedTree: {
        leader: (pid) => real.leader(pid),
        members: (leader) =>
          real
            .members(leader)
            .map((m) => (m.pid === reused ? { pid: m.pid, start: `${BigInt(m.start) + 1n}` } : m)),
      },
    });
    const pid = await serverPid(h);
    await h.session.send([{ type: "text", text: "verified" }], "queue");
    expect(h.exits).toHaveLength(0);
    reused = pid;
    await h.control("/test/drop", {});
    await vi.waitFor(() => expect(h.exits).toHaveLength(1), { timeout: 10_000 });
    expect(await ended(pid)).toBe(true);
  },
);
