import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { findExecutable } from "@ace/provider-kit/discovery";
import { ServerMessage, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke, startCli } from "./cli-test-support.ts";

test("missing jq refuses a run before admission", async () => {
  const f = await daemonFixture();
  try {
    const before = f.daemon.store.listThreads().map((thread) => thread.id);
    const output = await invoke(
      join(f.h.home, "daemon"),
      ["run", "must not run", "--project", f.workspace, "--jq", ".", "--json"],
      "",
      { PATH: "" },
    );
    expect(output.code).toBe(4);
    expect(f.daemon.store.listThreads().map((thread) => thread.id)).toEqual(before);
  } finally {
    await f.daemon.close();
  }
});

test("invalid jq syntax refuses before admission and a data-dependent filter compiles safely", async ({
  skip,
}) => {
  if (!(await findExecutable("jq"))) skip();
  const f = await daemonFixture();
  try {
    const home = join(f.h.home, "daemon");
    const before = f.daemon.store.listThreads().length;
    const bad = await invoke(home, [
      "run",
      "must not run",
      "--project",
      f.workspace,
      "--jq",
      "(",
      "--json",
    ]);
    expect(bad.code).toBe(4);
    expect(f.daemon.store.listThreads()).toHaveLength(before);
    const good = await invoke(home, [
      "run",
      "synthetic",
      "--project",
      f.workspace,
      "--jq",
      '.threadId | split("-")',
      "--json",
    ]);
    expect(good.code, good.stderr).toBe(0);
    expect(JSON.parse(good.stdout)).toContain("cli");
  } finally {
    await f.daemon.close();
  }
});

test("a jq evaluation failure after admission returns uncertain with the admitted identity and retry key", async ({
  skip,
}) => {
  if (!(await findExecutable("jq"))) skip();
  const f = await daemonFixture();
  try {
    const home = join(f.h.home, "daemon");
    const output = await invoke(home, [
      "run",
      "synthetic",
      "--project",
      f.workspace,
      "--idempotency-key",
      "format-once",
      "--jq",
      'error("synthetic formatting failure")',
      "--json",
    ]);
    expect(output.code).toBe(5);
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "uncertain",
      admission: { idempotencyKey: "format-once", threadId: expect.any(String) },
    });
    const retry = await invoke(home, [
      "run",
      "synthetic",
      "--project",
      f.workspace,
      "--idempotency-key",
      "format-once",
      "--json",
    ]);
    expect(JSON.parse(retry.stdout).threadId).toBe(JSON.parse(output.stdout).admission.threadId);
    await f.daemon.engine?.flush();
    expect(f.h.inputs.get(ThreadId.parse(JSON.parse(retry.stdout).threadId))).toEqual([
      "synthetic",
    ]);
  } finally {
    await f.daemon.close();
  }
});

test("a killed CLI replays a lost-reply outbox entry after process restart without running twice", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const endpoint = join(home, "daemon-endpoint");
  const origin = await readFile(endpoint, "utf8");
  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  const admitted = Promise.withResolvers<void>();
  const upstreams = new Set<WebSocket>();
  proxy.on("connection", (downstream) => {
    const upstream = new WebSocket(origin.replace("http:", "ws:"));
    upstreams.add(upstream);
    const opened = once(upstream, "open");
    downstream.on("message", (frame, binary) => {
      void opened.then(() => upstream.send(frame, { binary }));
    });
    upstream.on("message", (frame, binary) => {
      if (!binary) {
        const parsed = ServerMessage.safeParse(JSON.parse(frame.toString()));
        if (
          parsed.success &&
          parsed.data.type === "commandResult" &&
          parsed.data.commandId === "crash-once"
        ) {
          admitted.resolve();
          return;
        }
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(frame, { binary });
    });
    downstream.on("close", () => upstream.terminate());
    upstream.on("error", (error) => admitted.reject(error));
  });
  let running: ReturnType<typeof startCli> | undefined;
  try {
    await writeFile(endpoint, `http://127.0.0.1:${address.port}`);
    const args = [
      "run",
      "synthetic restart",
      "--project",
      f.workspace,
      "--idempotency-key",
      "crash-once",
      "--json",
    ];
    running = startCli(home, args);
    await admitted.promise;
    running.child.kill("SIGKILL");
    await running.exited;
    await writeFile(endpoint, origin);
    const recovered = await invoke(home, args);
    expect(recovered.code, recovered.stderr).toBe(0);
    await f.daemon.engine?.flush();
    expect(f.h.inputs.get(ThreadId.parse(JSON.parse(recovered.stdout).threadId))).toEqual([
      "synthetic restart",
    ]);
    expect(
      f.daemon.store
        .listThreads()
        .filter((thread) => thread.id === JSON.parse(recovered.stdout).threadId),
    ).toHaveLength(1);
  } finally {
    running?.child.kill("SIGKILL");
    for (const socket of proxy.clients) socket.terminate();
    for (const socket of upstreams) socket.terminate();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.daemon.close();
  }
});
