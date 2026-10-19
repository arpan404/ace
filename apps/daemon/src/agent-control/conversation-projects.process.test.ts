import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { AgentControlOperation } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createConversationStarts } from "./conversations.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;
const start = (requestId: string, project?: string) =>
  AgentControlOperation.parse({
    op: "thread.start",
    requestId,
    title: "Dedicated",
    text: "Work on the landing page",
    provider: "claude",
    model: "chosen-model",
    workspace: { kind: "project" },
    ...(project ? { project } : {}),
  });

/** The control port with real thread starts, and a second project folder on this machine. */
async function harness() {
  const h = setup();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  const port = createAgentControlPort(h.store, h.service, {
    startConversation: createConversationStarts(
      { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
      h.service,
      h.service.conversations,
    ),
  });
  const folder = async (name: string) => {
    const path = join(h.home, "projects", name);
    await mkdir(path, { recursive: true });
    return path;
  };
  return { h, port, runtime, folder };
}

test("an agent opens a dedicated thread in another project by its name and keeps owning it", async () => {
  const { h, port, runtime, folder } = await harness();
  try {
    const other = h.store.createWorkspace(await folder("nivra-rij"), "nivra-rij");
    const parent = await h.parent();
    const reply = await port.execute(parent, start("dedicated", "Nivra-Rij"), signal());
    expect(reply).toMatchObject({ ok: true, data: { threadId: expect.any(String) } });
    const thread = h.store.listThreads().find((row) => row.id !== parent.threadId);
    if (!thread) throw new Error("Thread missing");
    expect(thread.workspaceId).toBe(other);
    expect(h.store.getThread(parent.threadId)?.workspaceId).not.toBe(other);
    await h.engine.flush();
    expect(h.inputs.get(thread.id)?.at(-1)).toBe("Work on the landing page");

    await h.complete(thread.id, "Landing page done");
    expect(
      await port.execute(
        parent,
        AgentControlOperation.parse({
          op: "thread.message",
          threadId: thread.id,
          requestId: "follow-up",
          text: "Now the footer",
        }),
        signal(),
      ),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.get(thread.id)?.at(-1)).toBe("Now the footer");
  } finally {
    await runtime.close();
  }
});

test("a project named by its folder path opens the thread there", async () => {
  const { h, port, runtime, folder } = await harness();
  try {
    const path = await folder("site");
    const other = h.store.createWorkspace(path, "Marketing site");
    const parent = await h.parent();
    expect((await port.execute(parent, start("by-path", `${path}/`), signal())).ok).toBe(true);
    expect(h.store.listThreads().map((row) => row.workspaceId)).toContain(other);
  } finally {
    await runtime.close();
  }
});

test("an unknown or ambiguous project starts nothing and says how to name it", async () => {
  const { h, port, runtime, folder } = await harness();
  try {
    h.store.createWorkspace(await folder("a/app"), "app");
    h.store.createWorkspace(await folder("b/app"), "app");
    const parent = await h.parent();
    expect(await port.execute(parent, start("missing", "nowhere"), signal())).toMatchObject({
      ok: false,
      code: "not_found",
      hint: expect.stringContaining("projects_find"),
    });
    expect(await port.execute(parent, start("twice", "app"), signal())).toMatchObject({
      ok: false,
      code: "invalid",
      hint: expect.stringContaining(join("a", "app")),
    });
    expect(h.store.listThreads()).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});

test("projects_find matches every word against name and folder and marks the caller's project", async () => {
  const { h, port, runtime, folder } = await harness();
  try {
    h.store.createWorkspace(await folder("nivra-rij"), "nivra-rij");
    h.store.createWorkspace(await folder("nivra-redesign"), "Nivra redesign");
    const parent = await h.parent();
    const find = (query: string) =>
      port.execute(parent, AgentControlOperation.parse({ op: "projects.list", query }), signal());
    const names = async (query: string) => {
      const result = await find(query);
      const data = result.data as { projects: { name: string; current?: boolean }[] };
      return data.projects.map((project) => project.name).toSorted();
    };
    expect(await names("nivra")).toEqual(["Nivra redesign", "nivra-rij"]);
    expect(await names("nivra rij")).toEqual(["nivra-rij"]);
    expect(await find("workspace")).toMatchObject({
      ok: true,
      data: { projects: [{ name: "workspace", current: true }] },
    });
  } finally {
    await runtime.close();
  }
});
