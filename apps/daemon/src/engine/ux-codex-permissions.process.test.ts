import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { expect, test } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter, codexCapabilities } from "@ace/adapter-codex";
import type { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, end } from "./test-support.ts";

function until(h: Awaited<ReturnType<typeof harness>>, condition: () => boolean): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          JSON.stringify(
            h.store.listThreads().map((thread) => ({
              title: thread.title,
              status: thread.status,
              runs: Object.values(h.store.snapshotThread(thread.id).runs).map((run) => ({
                nativeId: run.nativeId,
                state: run.state,
              })),
            })),
          ),
        ),
      );
    }, 10_000);
    const stop = h.store.subscribe(() => {
      if (condition()) {
        stop();
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
function backgroundShell(h: Awaited<ReturnType<typeof harness>>, id: ThreadId): boolean {
  const view = h.store.snapshotThread(id);
  return (
    Object.values(view.backgroundTasks).some(
      (task) => task.kind === "shell" && task.status === "running",
    ) && Object.values(view.runs).every((run) => run.state !== "active")
  );
}
async function codexHarness() {
  const directory = await mkdtemp(join(tmpdir(), "ace-ux-codex-"));
  const binary = join(directory, "codex");
  // Public offline fixture process, isolated from installed provider CLIs.
  const script = new URL("../../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url);
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(script.href)};\n`);
  await chmod(binary, 0o755);
  const accounts = await openRegistry(join(directory, "accounts.sqlite"));
  await accounts.register(
    createInstance({
      id: "codex-scripted",
      provider: "codex",
      label: "Scripted",
      homeDir: directory,
    }),
  );
  const env = { PATH: directory, ACE_FAKE_RESUME: "policy-boundary" };
  const service = new AccountService({ registry: accounts, now: () => 1000, timeZone: "UTC", env });
  const native = createCodexAdapter({
    runtime: { stopGraceMs: 0 },
    discovery: { overrides: { codex: binary }, env },
  });
  const bound = service.bindAdapter(
    {
      ...native,
      capabilities: () =>
        codexCapabilities({
          installed: true,
          version: "0.159.1",
          auth: "logged_in",
          loginHint: "unused",
        }),
      create: () => native,
    },
    () => ({ instanceId: "codex-scripted", role: "worker", estimatedLoad: 1 }),
  );
  const h = await harness([], scriptFrames(), { nativeAdapter: bound });
  return {
    h,
    async close() {
      await h.close();
      accounts.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a full-access change applies on the next turn/start while a background shell runs", async () => {
  const fixture = await codexHarness();
  const { h } = fixture;
  try {
    const id = await h.create();
    await until(h, () => backgroundShell(h, id));
    await h.engine.flush();
    expect(h.store.getThread(id)?.permission?.effective).toBe("auto-review");
    expect(
      Object.values(h.store.snapshotThread(id).backgroundTasks).some(
        (task) => task.status === "running",
      ),
    ).toBe(true);
    expect(
      h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" }).ok,
    ).toBe(true);
    expect(h.store.getThread(id)?.permission).toMatchObject({
      effective: "auto-review",
      pending: true,
    });
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "steer",
      input: [{ type: "text", text: "next" }],
    });
    await until(h, () =>
      Object.values(h.store.snapshotThread(id).items).some(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text.includes('"text":"next"')),
      ),
    );
    await h.engine.flush();
    expect(h.store.getThread(id)?.permission).toMatchObject({
      effective: "full-access",
      pending: false,
    });
    const proof = Object.values(h.store.snapshotThread(id).items).find(
      (item) =>
        item.type === "message" &&
        item.parts.some((part) => part.type === "text" && part.text.includes('"text":"next"')),
    );
    const text =
      proof?.type === "message"
        ? proof.parts.find((part) => part.type === "text")?.text
        : undefined;
    expect(JSON.parse(text ?? "null")).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(
      Object.values(h.store.snapshotThread(id).backgroundTasks).some(
        (task) => task.status === "running",
      ),
    ).toBe(true);
    expect(h.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test.each(["reject-policy", "invalid-policy"])(
  "a rejected or malformed turn/start leaves the permission change pending: %s",
  async (text) => {
    const fixture = await codexHarness();
    const { h } = fixture;
    try {
      const id = await h.create();
      await until(h, () => backgroundShell(h, id));
      await h.engine.flush();
      expect(
        h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" })
          .ok,
      ).toBe(true);
      h.command({
        type: "thread.send",
        threadId: id,
        delivery: "steer",
        input: [{ type: "text", text }],
      });
      await h.engine.flush();
      expect(h.store.getThread(id)?.permission).toMatchObject({
        effective: "auto-review",
        pending: true,
      });
    } finally {
      await fixture.close();
    }
  },
);

function approval(command: string): Fact {
  return {
    type: "interaction.opened",
    agent: "root",
    interaction: "permission",
    blocking: true,
    raw: [{ type: "ace.permission-policy", data: { mode: "full-access" } }],
    request: {
      kind: "approval",
      title: command,
      target: { tool: "shell", command, access: "execute" },
      options: [{ id: "once", label: "Allow once", kind: "allow_once" }],
    },
  };
}
test("an approval under full access is approved by ace with a durable notice", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, approval("rm -rf /outside"))] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { permissionSettings: async () => "full-access" },
  );
  try {
    const id = await h.create();
    expect(Object.values(h.store.snapshotThread(id).interactions)[0]).toMatchObject({
      state: "resolved",
      resolution: { optionId: "once" },
      review: { mode: "full-access", decision: "approve", reason: "Full access" },
    });
    expect(
      Object.values(h.store.snapshotThread(id).items).some(
        (item) => item.type === "notice" && item.text === "Approved · Full access",
      ),
    ).toBe(true);
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});
test("a full-access secret read still waits for a person", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, approval("cat .env"))] }],
    frames,
    { permissionSettings: async () => "full-access" },
  );
  try {
    const id = await h.create();
    expect(Object.values(h.store.snapshotThread(id).interactions)[0]).toMatchObject({
      state: "pending",
      review: { decision: "escalate", reason: "Secret or credential access requires a human" },
    });
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  } finally {
    await h.close();
  }
});

test("a fixed-session provider reports why a permission change is waiting", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
    provider: "claude",
  });
  try {
    const id = await h.create();
    expect(
      h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getThread(id)?.permission).toMatchObject({
      effective: "auto-review",
      pending: true,
    });
    expect(Object.values(h.store.snapshotThread(id).items)).toContainEqual(
      expect.objectContaining({
        type: "notice",
        code: "permission_change_pending",
        raw: [
          {
            type: "permission.pending",
            data: { pending_reason: "busy", permissionMode: "full-access" },
          },
        ],
      }),
    );
  } finally {
    await h.close();
  }
});

test("an account-bound Codex session applies a new policy without reopening at an idle boundary", async () => {
  const fixture = await codexHarness();
  const { h } = fixture;
  try {
    const id = await h.create();
    await until(h, () => backgroundShell(h, id));
    const task = Object.values(h.store.snapshotThread(id).backgroundTasks).find(
      (candidate) => candidate.kind === "shell",
    );
    if (!task) throw new Error("No background shell");
    expect(h.command({ type: "background_task.stop", taskId: task.id }).ok).toBe(true);
    await until(h, () => h.store.getThread(id)?.status.state === "done");
    h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" });
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] });
    await until(h, () => h.store.getThread(id)?.permission?.effective === "full-access");
    await h.engine.flush();
    expect(h.store.getThread(id)?.live?.account).toBe("codex-scripted");
    expect(h.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
