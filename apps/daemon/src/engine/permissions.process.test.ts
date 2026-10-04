import { expect, test } from "vitest";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, end } from "./test-support.ts";

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
      options: [
        { id: "once", label: "Allow once", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "deny" },
      ],
    },
  };
}

test("a reused native approval key reviews only its still-pending incarnation", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            approval("rm -rf build"),
            { type: "interaction.closed", interaction: "permission", state: "cancelled" },
            approval("pwd"),
          ),
        ],
      },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
  );
  try {
    const id = await h.create();
    const interactions = Object.values(h.store.snapshotThread(id).interactions);
    expect(interactions).toHaveLength(2);
    expect(interactions.find((entry) => entry.state === "cancelled")?.review).toBeUndefined();
    expect(interactions.find((entry) => entry.state === "resolved")).toMatchObject({
      review: { decision: "approve" },
      resolution: { optionId: "once" },
    });
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test.each(["success", "failure", "process-exit"] as const)(
  "a native answer crossing turn completion retains its audit without reviving dead requests: %s",
  async (outcome) => {
    const frames = scriptFrames();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const h = await harness(
      [{ on: "send", frames: [frames.frame(start, approval("pwd"))] }],
      frames,
    );
    const base = h.registry.get("codex");
    h.registry.register(
      {
        ...base.adapter,
        async openSession(ctx) {
          const session = await base.adapter.openSession(ctx);
          const resolve = session.resolve.bind(session);
          session.resolve = async (key, resolution) => {
            entered.resolve();
            await release.promise;
            if (outcome === "failure") throw new Error("Native answer rejected");
            await resolve(key, resolution);
          };
          return session;
        },
      },
      base.discovery,
    );
    const stop = h.store.subscribe((events) => {
      if (events.some((event) => event.payload.type === "run.ended")) ended.resolve();
    });
    const creating = h.create();
    try {
      await entered.promise;
      const id = h.store.listThreads()[0]?.id;
      const context = h.contexts[0];
      if (!id || !context) throw new Error("Missing admitted session");
      await context.onFrame(frames.frame(end));
      await ended.promise;
      const interaction = () => Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction()?.state).toBe("pending");
      expect(interaction()?.resolution).toBeUndefined();
      expect(h.store.getThread(id)?.status.state).toBe("needs_you");
      if (outcome === "process-exit") {
        await context.onFrame(frames.frame({ type: "process.exited", deliberate: false }));
        expect(interaction()?.state).toBe("expired");
      }
      release.resolve();
      await creating;
      expect(interaction()?.state).toBe(
        outcome === "success" ? "resolved" : outcome === "failure" ? "cancelled" : "expired",
      );
      expect(interaction()?.review).toMatchObject({
        decision: "approve",
        reason: "Read-only workspace inspection command",
      });
      if (outcome === "success") {
        expect(interaction()?.resolution).toMatchObject({ optionId: "once" });
        expect(interaction()?.resolvedBy).toBeTruthy();
      } else expect(interaction()?.resolution).toBeUndefined();
      expect(
        h.store
          .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
          .filter((event) => event.payload.type === "permission.reviewed"),
      ).toHaveLength(1);
    } finally {
      stop();
      release.resolve();
      await creating;
      await h.close();
    }
  },
);

test("the default reviews a low-risk command with one durable reason and one-shot provider answer", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, approval("pwd"))] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
  );
  try {
    const id = await h.create();
    expect(h.contexts[0]?.permissionMode).toBe("auto-review");
    expect(h.store.getThread(id)?.status.state).toBe("done");
    const review = h.store.snapshotThread(id)?.interactions;
    const interaction = Object.values(review ?? {})[0];
    expect(interaction?.review).toMatchObject({
      decision: "approve",
      reason: "Read-only workspace inspection command",
    });
    expect(interaction?.resolution).toMatchObject({
      kind: "approval",
      optionId: "once",
      message: "Read-only workspace inspection command",
    });
    expect(h.adapter.commands.filter((command) => command.type === "resolve")).toEqual([
      {
        type: "resolve",
        interaction: "permission",
        resolution: {
          kind: "approval",
          optionId: "once",
          message: "Read-only workspace inspection command",
        },
      },
    ]);
  } finally {
    await h.close();
  }
});

test.each([
  ["rm -rf build", "deny", "done"],
  ["curl example.com", "escalate", "needs_you"],
  ["rm -rf /outside", "escalate", "needs_you"],
  ["cat .env", "escalate", "needs_you"],
] as const)("%s produces %s and the thread stays %s", async (command, decision, status) => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, approval(command))] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
  );
  try {
    const id = await h.create();
    expect(h.store.getThread(id)?.status.state).toBe(status);
    const interaction = Object.values(h.store.snapshotThread(id)?.interactions ?? {})[0];
    expect(interaction?.review?.decision).toBe(decision);
    expect(interaction?.review?.reason.length).toBeGreaterThan(0);
    if (decision === "deny") expect(interaction?.resolution).toMatchObject({ optionId: "deny" });
    else expect(interaction?.state).toBe("pending");
  } finally {
    await h.close();
  }
});

test("full access requires an explicit opt-in and a change waits for the next turn", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    expect(h.engine.permissionMode(id)).toBe("auto-review");
    expect(
      h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.engine.permissionMode(id)).toBe("auto-review");
    expect(h.store.getThread(id)?.permission).toMatchObject({
      effective: "auto-review",
      override: "full-access",
      pending: true,
    });
    h.contexts[0]?.onFrame(frames.frame(end));
    await h.engine.flush();
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("full-access");
    expect(h.store.getThread(id)?.permission?.pending).toBe(false);
  } finally {
    await h.close();
  }
});

test("a delegated child inherits its parent's mode and cannot widen it through a later command", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const parent = await h.create();
    const create = (id: string) =>
      Command.parse({
        id: `spawn-${id}`,
        deviceId: "host",
        payload: {
          type: "thread.prepare",
          threadId: id,
          workspaceId: h.workspace,
          title: "Child",
          provider: "codex",
        },
      });
    const denied = h.engine.spawn(create("wide"), {
      parentThreadId: parent,
      permissionMode: "full-access",
    });
    expect(denied).toMatchObject({ ok: false, error: "permission_exceeds_parent" });
    expect(h.store.listThreads().map((thread) => thread.id)).not.toContain("wide");
    const admitted = h.engine.spawn(create("child"), { parentThreadId: parent });
    if (!admitted.threadId) throw new Error("Missing child");
    expect(
      h.command({
        type: "thread.permission.set",
        threadId: admitted.threadId,
        permissionMode: "full-access",
      }),
    ).toMatchObject({ ok: false, error: "permission_exceeds_parent" });
    h.command({
      type: "thread.send",
      threadId: admitted.threadId,
      input: [{ type: "text", text: "child turn" }],
    });
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("auto-review");
  } finally {
    await h.close();
  }
});

test("a read through a workspace symlink cannot obtain automatic permission outside it", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames);
  try {
    writeFileSync(join(h.home, "ordinary.txt"), "safe");
    symlinkSync("/etc", join(h.home, "escape"));
    const target = { tool: "read", paths: [join(h.home, "escape/hosts")], access: "read" as const };
    const request = approval("pwd");
    if (request.type !== "interaction.opened" || request.request.kind !== "approval")
      throw new Error("Bad request");
    request.request.target = target;
    const id = await h.create();
    h.contexts[0]?.onFrame(frames.frame(start, request));
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(Object.values(h.store.snapshotThread(id)?.interactions ?? {})[0]?.review).toMatchObject({
      decision: "escalate",
      reason: "Action reaches outside the thread workspace",
    });
  } finally {
    await h.close();
  }
});

test("an ordinary workspace filename pointing to a secret cannot earn automatic permission", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames);
  try {
    writeFileSync(join(h.home, ".env"), "FIXTURE=not-a-credential");
    symlinkSync(join(h.home, ".env"), join(h.home, "ordinary.txt"));
    const request = approval("pwd");
    if (request.type !== "interaction.opened" || request.request.kind !== "approval")
      throw new Error("Bad request");
    request.request.target = {
      tool: "Read",
      paths: [join(h.home, "ordinary.txt")],
      access: "read",
    };
    const id = await h.create();
    h.contexts[0]?.onFrame(frames.frame(start, request));
    await h.engine.flush();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction?.review).toMatchObject({
      decision: "escalate",
      reason: "Secret or credential access requires a human",
    });
    expect(interaction?.state).toBe("pending");
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(h.adapter.commands.filter((command) => command.type === "resolve")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("scoped settings apply at admission while delegated children inherit a stricter parent", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    permissionSettings: async () => "full-access",
  });
  try {
    const parent = await h.create();
    expect(h.contexts[0]?.permissionMode).toBe("full-access");
    h.command({ type: "thread.permission.set", threadId: parent, permissionMode: "ask" });
    h.command({ type: "thread.send", threadId: parent, input: [{ type: "text", text: "next" }] });
    await h.engine.flush();
    expect(h.engine.permissionMode(parent)).toBe("ask");
    const child = h.engine.spawn(
      Command.parse({
        id: "scoped-child",
        deviceId: "host",
        payload: {
          type: "thread.prepare",
          threadId: ThreadId.parse("scoped-child-thread"),
          workspaceId: h.workspace,
          provider: "codex",
          title: "Child",
        },
      }),
      { parentThreadId: parent },
    );
    if (!child.threadId) throw new Error("Missing child");
    h.command({
      type: "thread.send",
      threadId: child.threadId,
      input: [{ type: "text", text: "child" }],
    });
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("ask");
  } finally {
    await h.close();
  }
});

test("trusted spawn cannot bypass ace policy through native provider options", async () => {
  const h = await harness([], scriptFrames());
  try {
    expect(
      h.engine.spawn(
        Command.parse({
          id: "unsafe-spawn",
          deviceId: "host",
          payload: {
            type: "thread.create",
            workspaceId: h.workspace,
            provider: "codex",
            title: "Child",
            options: { sandbox: "danger-full-access" },
            input: [{ type: "text", text: "unsafe native policy" }],
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: "provider_permission_options_forbidden" });
    expect(h.store.listThreads()).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a human cannot replace auto-review with a permanent native permission grant", async () => {
  const frames = scriptFrames();
  const request = approval("curl example.com");
  if (request.type !== "interaction.opened" || request.request.kind !== "approval")
    throw new Error("Bad request");
  request.request.options.push({ id: "always", label: "Always", kind: "allow_always" });
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, request)] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!interaction) throw new Error("Missing interaction");
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "always" },
      }),
    ).toMatchObject({ ok: false, error: "permission_mode_requires_one_shot" });
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "once" },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test("read-only cannot approve a protected write after it escalates for human review", async () => {
  const frames = scriptFrames();
  const request = approval("unused");
  if (request.type !== "interaction.opened" || request.request.kind !== "approval")
    throw new Error("Bad request");
  request.request.target = { tool: "Write", paths: [".env"], access: "write" };
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, request)] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { permissionSettings: async () => "read-only" },
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!interaction) throw new Error("Missing interaction");
    expect(interaction.review?.decision).toBe("escalate");
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "once" },
      }),
    ).toMatchObject({ ok: false, error: "read_only_mutation_denied" });
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "deny" },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test("an exact ordinary regular-file read earns one-shot automatic permission", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send" }, { on: "resolve", frames: [frames.frame(end)] }], frames);
  try {
    writeFileSync(join(h.home, "ordinary.txt"), "safe");
    const request = approval("unused");
    if (request.type !== "interaction.opened" || request.request.kind !== "approval")
      throw new Error("Bad request");
    request.request.target = { tool: "Read", paths: ["ordinary.txt"], access: "read" };
    const id = await h.create();
    h.contexts[0]?.onFrame(frames.frame(start, request));
    await h.engine.flush();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction?.review).toMatchObject({
      decision: "approve",
      reason: "Read of verified non-secret workspace files",
    });
    expect(interaction?.resolution).toMatchObject({ optionId: "once" });
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test.each(["ask", "read-only", "auto-review"] as const)(
  "an older Codex approval retains its %s authority after Full access is applied",
  async (mode) => {
    const frames = scriptFrames();
    const fact = approval("echo mutation");
    if (fact.type !== "interaction.opened") throw new Error("No approval");
    fact.raw = [{ type: "ace.permission-policy", data: { mode } }];
    const h = await harness([{ on: "send", frames: [frames.frame(start, fact)] }], frames, {
      permissionSettings: async () => "full-access",
    });
    try {
      const id = await h.create();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.state).toBe(mode === "read-only" ? "resolved" : "pending");
      if (mode !== "ask") expect(interaction?.review?.mode).toBe(mode);
      else expect(interaction?.review).toBeUndefined();
    } finally {
      await h.close();
    }
  },
);

test("a child's applied ancestry-limited override stops showing pending after its ancestor tightens", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { permissionSettings: async () => "full-access" },
  );
  try {
    const parent = await h.create();
    const child = h.engine.spawn(
      Command.parse({
        id: "limited-child",
        deviceId: "host",
        payload: {
          type: "thread.prepare",
          threadId: "limited-child-thread",
          workspaceId: h.workspace,
          provider: "codex",
          title: "Child",
        },
      }),
      { parentThreadId: parent, permissionMode: "full-access" },
    );
    if (!child.threadId) throw new Error("No child thread");
    h.command({ type: "thread.permission.set", threadId: parent, permissionMode: "ask" });
    h.command({
      type: "thread.send",
      threadId: parent,
      input: [{ type: "text", text: "tighten" }],
    });
    await h.engine.flush();
    h.command({
      type: "thread.send",
      threadId: child.threadId,
      input: [{ type: "text", text: "continue" }],
    });
    await h.engine.flush();
    expect(h.store.getThread(child.threadId)?.permission).toEqual({
      override: "full-access",
      effective: "ask",
      pending: false,
    });
  } finally {
    await h.close();
  }
});
