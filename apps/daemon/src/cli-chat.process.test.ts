import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke, openCli } from "./cli-test-support.ts";

const record = z.object({ type: z.string() }).passthrough();
function chat(home: string, args: string[]) {
  const invocation = openCli(home, ["chat", ...args, "--stream", "jsonl"]);
  let buffer = "";
  const records: z.infer<typeof record>[] = [];
  invocation.child.stdout.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      records.push(record.parse(JSON.parse(line)));
    }
  });
  return { ...invocation, records };
}

test("terminal chat creates and resumes one shared daemon thread with its live transcript", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const session = chat(home, ["--project", f.workspace, "--provider", "claude"]);
  try {
    await expect.poll(() => session.records.some((entry) => entry.type === "ready")).toBe(true);
    session.child.stdin.write("First shared prompt\n");
    await expect.poll(() => session.records.find((entry) => entry.type === "thread")).toBeDefined();
    const thread = z
      .object({ threadId: ThreadId })
      .parse(session.records.find((entry) => entry.type === "thread")).threadId;
    await expect.poll(() => f.h.inputs.get(thread)).toEqual(["First shared prompt"]);
    await f.h.complete(thread, "Shared answer");
    await expect
      .poll(() =>
        session.records.some((entry) => entry.type === "message" && entry.text === "Shared answer"),
      )
      .toBe(true);
    const guiView = await invoke(home, ["thread", "read", thread, "--json"]);
    expect(guiView.code, guiView.stderr).toBe(0);
    expect(JSON.parse(guiView.stdout)).toMatchObject({
      thread: { id: thread },
      items: expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          parts: [{ type: "text", text: "Shared answer" }],
        }),
      ]),
    });
    session.child.stdin.end("/quit\n");
    expect((await session.exited).code).toBe(0);
    const resumed = chat(home, ["--thread", thread]);
    try {
      await expect
        .poll(() =>
          resumed.records.some(
            (entry) => entry.type === "message" && entry.text === "Shared answer",
          ),
        )
        .toBe(true);
      resumed.child.stdin.write("Second shared prompt\n");
      await expect
        .poll(() => f.h.inputs.get(thread))
        .toEqual(["First shared prompt", "Second shared prompt"]);
      resumed.child.stdin.end("/quit\n");
      expect((await resumed.exited).code).toBe(0);
      expect(f.daemon.store.getThread(thread)?.status.state).toBe("working");
    } finally {
      resumed.child.kill("SIGKILL");
      await resumed.exited;
    }
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
    await f.daemon.close();
  }
});

test("chat shows descendant human attention and resolves its approval inline without claiming completion", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const spawned = await invoke(home, [
    "task",
    "spawn",
    "child",
    "--parent",
    f.caller.threadId,
    "--provider",
    "claude",
    "--json",
  ]);
  const child = z
    .object({ data: z.object({ threadId: ThreadId }) })
    .parse(JSON.parse(spawned.stdout)).data.threadId;
  await f.daemon.engine?.flush();
  await f.h.emit(child, {
    type: "interaction.opened",
    agent: "root",
    interaction: "chat-permission",
    blocking: true,
    request: {
      kind: "approval",
      title: "Run a check?",
      options: [
        { id: "yes", label: "Allow once", kind: "allow_once" },
        { id: "no", label: "Deny", kind: "deny" },
      ],
    },
  });
  const session = chat(home, ["--thread", f.caller.threadId]);
  try {
    await expect
      .poll(() => session.records.some((entry) => entry.type === "interaction"))
      .toBe(true);
    expect(session.records).toContainEqual(
      expect.objectContaining({ type: "status", status: "needs-human" }),
    );
    expect(session.records).not.toContainEqual(
      expect.objectContaining({ type: "status", status: "ok" }),
    );
    session.child.stdin.write("y\n");
    await expect.poll(() => session.records.some((entry) => entry.type === "receipt")).toBe(true);
    const read = await invoke(home, ["thread", "read", child, "--json"]);
    expect(JSON.parse(read.stdout).interactions).not.toContainEqual(
      expect.objectContaining({ state: "pending" }),
    );
    session.child.stdin.end("/quit\n");
    expect((await session.exited).code).toBe(0);
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
    await f.daemon.close();
  }
});

test("chat stop and resume use the shared queue and model selection rather than a private session", async () => {
  const f = await daemonFixture();
  const session = chat(join(f.h.home, "daemon"), ["--thread", f.caller.threadId]);
  try {
    await expect.poll(() => session.records.some((entry) => entry.type === "thread")).toBe(true);
    session.child.stdin.write("/stop\n");
    await expect.poll(() => f.daemon.engine?.queue(f.caller.threadId).reason).toBe("stopped");
    await expect
      .poll(() =>
        session.records.some((entry) => entry.type === "status" && entry.status === "needs-human"),
      )
      .toBe(true);
    session.child.stdin.write("Held chat input\n");
    await expect.poll(() => f.daemon.engine?.queue(f.caller.threadId).pendingCount).toBe(1);
    session.child.stdin.write("/resume\n");
    await expect
      .poll(() => f.h.inputs.get(f.caller.threadId)?.includes("Held chat input"))
      .toBe(true);
    session.child.stdin.write("/model chosen-model\n");
    await expect
      .poll(() => f.daemon.store.getThread(f.caller.threadId)?.execution?.model)
      .toBe("chosen-model");
    session.child.stdin.end("/quit\n");
    const output = await session.exited;
    expect(output.code, output.stderr).toBe(0);
    expect(session.records.filter((entry) => entry.type === "error")).toEqual([]);
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
    await f.daemon.close();
  }
});

test("human chat rendering strips terminal controls from the shared transcript", async () => {
  const f = await daemonFixture();
  try {
    await f.h.complete(f.caller.threadId, "Visible\u001b[2J transcript\u001b]0;fake-title\u0007");
    const output = await invoke(
      join(f.h.home, "daemon"),
      ["chat", "--thread", f.caller.threadId],
      "/quit\n",
    );
    expect(output.code, output.stderr).toBe(0);
    expect(output.stdout).toContain("Visible transcript");
    expect(output.stdout).not.toContain("\u001b");
    expect(output.stdout).not.toContain("fake-title");
  } finally {
    await f.daemon.close();
  }
});
