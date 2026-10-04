import { expect, test } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter, codexCapabilities } from "@ace/adapter-codex";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, end } from "./test-support.ts";

function until(h: Awaited<ReturnType<typeof harness>>, condition: () => boolean): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = h.store.subscribe(() => {
      if (condition()) {
        stop();
        resolve();
      }
    });
  });
}
async function codexHarness() {
  const directory = await mkdtemp(join(tmpdir(), "ace-ux-codex-"));
  const binary = join(directory, "codex");
  // Public offline fixture process, isolated from installed provider CLIs.
  const script = new URL("../../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url);
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(script.href)};\n`);
  await chmod(binary, 0o755);
  const h = await harness([], scriptFrames(), {
    nativeAdapter: {
      ...createCodexAdapter({
        runtime: { stopGraceMs: 0 },
        discovery: {
          overrides: { codex: binary },
          env: { PATH: directory, ACE_FAKE_RESUME: "policy-boundary" },
        },
      }),
      capabilities: () =>
        codexCapabilities({
          installed: true,
          version: "0.159.1",
          auth: "logged_in",
          loginHint: "unused",
        }),
    },
  });
  return {
    h,
    async close() {
      await h.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a full-access change applies on the next turn/start while a background shell runs", async () => {
  const fixture = await codexHarness();
  const { h } = fixture;
  try {
    const id = await h.create();
    await until(h, () => h.store.getThread(id)?.status.state === "waiting");
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
    expect(h.contexts).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a rejected turn/start leaves the permission change pending", async () => {
  const fixture = await codexHarness();
  const { h } = fixture;
  try {
    const id = await h.create();
    await until(h, () => h.store.getThread(id)?.status.state === "waiting");
    await h.engine.flush();
    expect(
      h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" }).ok,
    ).toBe(true);
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "steer",
      input: [{ type: "text", text: "reject-policy" }],
    });
    await h.engine.flush();
    expect(h.store.getThread(id)?.permission).toMatchObject({
      effective: "auto-review",
      pending: true,
    });
  } finally {
    await fixture.close();
  }
});

function approval(command: string): Fact {
  return {
    type: "interaction.opened",
    agent: "root",
    interaction: "permission",
    blocking: true,
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
