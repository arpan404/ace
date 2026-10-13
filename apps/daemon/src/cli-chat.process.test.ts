import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke, openCli } from "./cli-test-support.ts";

const record = z.object({ type: z.string() }).passthrough();
type ChatRecord = z.infer<typeof record>;
function chat(home: string, args: string[]) {
  const invocation = openCli(home, ["chat", ...args, "--stream", "jsonl"]);
  let buffer = "";
  const records: ChatRecord[] = [];
  const waiters = new Set<{ match: (entry: ChatRecord) => boolean; settle: () => void }>();
  invocation.child.stdout.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const entry = record.parse(JSON.parse(line));
      records.push(entry);
      for (const waiter of waiters) if (waiter.match(entry)) waiter.settle();
    }
  });
  /** Resolves on the CLI's own output rather than a wall-clock poll. */
  const next = (match: (entry: ChatRecord) => boolean) =>
    new Promise<void>((resolve, reject) => {
      if (records.some(match)) return resolve();
      const waiter = {
        match,
        settle: () => {
          waiters.delete(waiter);
          resolve();
        },
      };
      waiters.add(waiter);
      void invocation.exited.then((output) => {
        if (waiters.delete(waiter)) reject(new Error(`CLI exited first: ${output.stderr}`));
      });
    });
  return { ...invocation, records, next };
}

test("terminal chat creates and resumes one shared daemon thread with its live transcript", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const session = chat(home, ["--project", f.workspace, "--provider", "claude"]);
  try {
    await session.next((entry) => entry.type === "ready");
    session.child.stdin.write("First shared prompt\n");
    await session.next((entry) => entry.type === "thread");
    const thread = z
      .object({ threadId: ThreadId })
      .parse(session.records.find((entry) => entry.type === "thread")).threadId;
    await expect.poll(() => f.h.inputs.get(thread)).toEqual(["First shared prompt"]);
    await f.h.complete(thread, "Shared answer");
    await session.next((entry) => entry.type === "message" && entry.text === "Shared answer");
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
      await resumed.next((entry) => entry.type === "message" && entry.text === "Shared answer");
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
    await session.next((entry) => entry.type === "interaction");
    expect(session.records).toContainEqual(
      expect.objectContaining({ type: "status", status: "needs-human" }),
    );
    expect(session.records).not.toContainEqual(
      expect.objectContaining({ type: "status", status: "ok" }),
    );
    session.child.stdin.write("y\n");
    await session.next((entry) => entry.type === "receipt");
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
  const session = chat(join(f.h.home, "daemon"), ["--project", f.workspace, "--provider", "claude"]);
  try {
    await session.next((entry) => entry.type === "ready");
    // Stop a turn that is still working, as a person would.
    session.child.stdin.write("Long running prompt\n");
    await session.next((entry) => entry.type === "thread");
    const threadId = z
      .object({ threadId: ThreadId })
      .parse(session.records.find((entry) => entry.type === "thread")).threadId;
    await expect.poll(() => f.h.inputs.get(threadId)).toEqual(["Long running prompt"]);
    session.child.stdin.write("/stop\n");
    await expect.poll(() => f.daemon.engine?.queue(threadId).reason).toBe("stopped");
    await session.next((entry) => entry.type === "status" && entry.status === "needs-human");
    session.child.stdin.write("Held chat input\n");
    await expect.poll(() => f.daemon.engine?.queue(threadId).pendingCount).toBe(1);
    session.child.stdin.write("/resume\n");
    await expect
      .poll(() => f.h.inputs.get(threadId)?.includes("Held chat input"))
      .toBe(true);
    const receipts = () => session.records.filter((entry) => entry.type === "receipt").length;
    const before = receipts();
    session.child.stdin.write("/model chosen-model\n");
    await expect
      .poll(() => f.daemon.store.getThread(threadId)?.execution?.model)
      .toBe("chosen-model");
    // Quit once the model change is acknowledged; quitting mid-receipt is uncertain by design.
    await session.next(() => receipts() > before);
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
    const session = openCli(join(f.h.home, "daemon"), ["chat", "--thread", f.caller.threadId]);
    let rendered = "";
    session.child.stdout.on("data", (bytes: Buffer) => {
      rendered += bytes.toString();
    });
    // Quit after the attached transcript renders; an earlier quit detaches uncertain.
    await expect.poll(() => rendered.includes("Visible transcript")).toBe(true);
    session.child.stdin.end("/quit\n");
    const output = await session.exited;
    expect(output.code, output.stderr).toBe(0);
    expect(output.stdout).toContain("Visible transcript");
    expect(output.stdout).not.toContain("\u001b");
    expect(output.stdout).not.toContain("fake-title");
  } finally {
    await f.daemon.close();
  }
});
