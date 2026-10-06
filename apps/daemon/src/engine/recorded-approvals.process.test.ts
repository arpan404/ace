import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createPiTranslator } from "@ace/adapter-pi";
import { createAcpTranslator } from "@ace/adapter-acp";
import { ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cases = [
  [createCodexAdapter(), "codex/0.159.1/approval-edit.jsonl"],
  [createClaudeAdapter(), "claude/2.1.286/approval-edit.jsonl"],
  [createOpenCodeAdapter(), "opencode/2.0.22/muse-spark-1.3-contributor/approval-edit.jsonl"],
] as const;
const frameSchema = z.object({
  seq: z.number(),
  t: z.number(),
  dir: z.enum(["send", "recv", "note"]),
  channel: z.string(),
  data: z.unknown(),
});
for (const [adapter, fixture] of cases) {
  test(`${adapter.provider} recorded workspace action is auto-approved once and audited`, async () => {
    const frames = scriptFrames();
    const h = await harness(
      [{ on: "send" }, { on: "resolve", frames: [frames.frame(end)] }],
      frames,
      { provider: adapter.provider },
    );
    try {
      mkdirSync(join(h.home, "src"));
      writeFileSync(
        join(h.home, "src/math.ts"),
        "export const multiply = (a: number, b: number) => a * b;\n",
      );
      const translator = adapter.createTranslator({
        threadId: ThreadId.parse("recorded"),
        rootKey: "root",
      });
      const source = readFileSync(
        new URL(`../../../../fixtures/${fixture}`, import.meta.url),
        "utf8",
      ).replaceAll("<WORKSPACE>", h.home);
      let approval;
      for (const line of source.trim().split("\n")) {
        const parsed = frameSchema.safeParse(JSON.parse(line));
        if (!parsed.success) continue;
        const frame = parsed.data;
        approval = translator
          .translate(frame, frame.t)
          .find(
            (f) =>
              f.type === "interaction.opened" &&
              f.request.kind === "approval" &&
              f.request.options.length > 0,
          );
        if (approval) break;
      }
      if (!approval || approval.type !== "interaction.opened")
        throw new Error("Recording contains no approval");
      const id = await h.create();
      await h.contexts[0]?.onFrame(
        frames.frame(start, { ...approval, agent: "root", interaction: "recorded-approval" }),
      );
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.review).toMatchObject({ decision: "approve" });
      expect(interaction?.state).toBe("resolved");
      expect(h.adapter.commands.filter((c) => c.type === "resolve")).toHaveLength(1);
      expect(
        h.store
          .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
          .filter((e) => e.payload.type === "permission.reviewed"),
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
}

test.each([
  { path: "ordinary.txt", secret: false },
  { path: ".env", secret: true },
  { path: "escape/file.txt", secret: true },
])("workspace write to $path respects physical containment", async ({ path, secret }) => {
  const { symlinkSync } = await import("node:fs");
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send" }, { on: "resolve", frames: [frames.frame(end)] }],
    frames,
    { provider: "claude" },
  );
  try {
    symlinkSync("/tmp", join(h.home, "escape"));
    const id = await h.create();
    await h.contexts[0]?.onFrame(
      frames.frame(start, {
        type: "interaction.opened",
        agent: "root",
        interaction: "write",
        blocking: true,
        request: {
          kind: "approval",
          title: "Write",
          target: { tool: "Write", access: "write", paths: [path] },
          options: [
            { id: "once", kind: "allow_once", label: "Once" },
            { id: "always", kind: "allow_always", label: "Always" },
          ],
        },
      }),
    );
    await h.engine.flush();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction?.review?.decision).toBe(secret ? "escalate" : "approve");
    expect(interaction?.state).toBe(secret ? "pending" : "resolved");
    expect(h.store.getThread(id)?.status.state).toBe(secret ? "needs_you" : "done");
  } finally {
    await h.close();
  }
});

test.each(["pwd", "cat ordinary.txt", "curl example.com", "cat .env"])(
  "OpenCode reviews the completed input before permission.asked for %s",
  async (command) => {
    const frames = scriptFrames();
    const h = await harness(
      [{ on: "send" }, { on: "resolve", frames: [frames.frame(end)] }],
      frames,
      { provider: "opencode" },
    );
    try {
      writeFileSync(join(h.home, "ordinary.txt"), "hello\n");
      const id = await h.create();
      const translator = createOpenCodeAdapter().createTranslator({
        threadId: id,
        rootKey: "root",
      });
      const feed = (seq: number, channel: string, data: unknown) =>
        translator.translate({ seq, t: seq, dir: "recv", channel, data }, seq);
      feed(1, "http", {
        method: "POST",
        path: "/api/session",
        body: { data: { id: "native", projectID: "sandbox", location: { directory: h.home } } },
      });
      feed(2, "sse", {
        id: "input-start",
        type: "session.tool.input.started",
        data: { sessionID: "native", assistantMessageID: "message", id: "call", name: "shell" },
      });
      feed(3, "sse", {
        id: "input-end",
        type: "session.tool.input.ended",
        data: {
          sessionID: "native",
          assistantMessageID: "message",
          id: "call",
          text: JSON.stringify({ command }),
        },
      });
      const facts = feed(4, "sse", {
        id: "approval",
        type: "permission.asked",
        data: {
          id: "permission",
          sessionID: "native",
          action: "shell",
          resources: [command],
          save: ["*"],
          source: { type: "tool", messageID: "message", id: "call" },
        },
      });
      const approval = facts.find((f) => f.type === "interaction.opened");
      if (!approval || approval.type !== "interaction.opened") throw new Error("Missing approval");
      await h.contexts[0]?.onFrame(
        frames.frame(start, { ...approval, agent: "root", interaction: "permission" }),
      );
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      const decision =
        command.startsWith("curl") || command.includes(".env") ? "escalate" : "approve";
      expect(interaction?.review?.decision).toBe(decision);
      expect(interaction?.state).toBe(decision === "approve" ? "resolved" : "pending");
      expect(h.store.getThread(id)?.status.state).toBe(
        decision === "approve" ? "done" : "needs_you",
      );
    } finally {
      await h.close();
    }
  },
);

test("safe review never substitutes a permanent provider grant for a missing one-shot option", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames, { provider: "claude" });
  try {
    const id = await h.create();
    await h.contexts[0]?.onFrame(
      frames.frame(start, {
        type: "interaction.opened",
        agent: "root",
        interaction: "permanent-only",
        blocking: true,
        request: {
          kind: "approval",
          title: "Shell",
          target: { tool: "Bash", command: "pwd", access: "execute" },
          options: [{ id: "always", label: "Always", kind: "allow_always" }],
        },
      }),
    );
    await h.engine.flush();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction?.review).toMatchObject({
      decision: "escalate",
      reason: "Provider offers no matching one-shot approval or denial",
    });
    expect(interaction?.state).toBe("pending");
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  } finally {
    await h.close();
  }
});

test("a workspace executable shadowing cat cannot earn automatic command authority", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames, { provider: "claude" });
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(h.home, "cat"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(h.home, "ordinary.txt"), "hello\n");
    process.env.PATH = `${h.home}:${previousPath ?? ""}`;
    const id = await h.create();
    await h.contexts[0]?.onFrame(
      frames.frame(start, {
        type: "interaction.opened",
        agent: "root",
        interaction: "shadowed",
        blocking: true,
        request: {
          kind: "approval",
          title: "Read",
          target: { tool: "Bash", access: "execute", command: "cat ordinary.txt" },
          options: [{ id: "once", label: "Once", kind: "allow_once" }],
        },
      }),
    );
    await h.engine.flush();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction?.review?.decision).toBe("escalate");
    expect(interaction?.state).toBe("pending");
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await h.close();
  }
});

test.each(["deleted", "future-status"])(
  "OpenCode %s file metadata cannot borrow an ordinary edit target",
  async (status) => {
    const frames = scriptFrames();
    const h = await harness([], frames, { provider: "opencode" });
    try {
      writeFileSync(join(h.home, "ordinary.txt"), "hello\n");
      const id = await h.create();
      const translator = createOpenCodeAdapter().createTranslator({
        threadId: id,
        rootKey: "root",
      });
      const feed = (seq: number, channel: string, data: unknown) =>
        translator.translate({ seq, t: seq, dir: "recv", channel, data }, seq);
      feed(1, "http", {
        method: "POST",
        path: "/api/session",
        body: { data: { id: "native", projectID: "sandbox", location: { directory: h.home } } },
      });
      const facts = feed(2, "sse", {
        id: "approval",
        type: "permission.asked",
        data: {
          id: "permission",
          sessionID: "native",
          action: "edit",
          metadata: { input: { path: "ordinary.txt" }, files: [{ file: "ordinary.txt", status }] },
          resources: ["ordinary.txt"],
        },
      });
      const approval = facts.find((f) => f.type === "interaction.opened");
      if (!approval || approval.type !== "interaction.opened") throw new Error("Missing approval");
      await h.contexts[0]?.onFrame(
        frames.frame(start, { ...approval, agent: "root", interaction: "permission" }),
      );
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.review?.decision).toBe("escalate");
      expect(interaction?.state).toBe("pending");
      expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    } finally {
      await h.close();
    }
  },
);

test.each([
  { tool: "read", access: "read", paths: ["ordinary.txt"], decision: "approve" },
  { tool: "edit", access: "write", paths: ["ordinary.txt"], decision: "approve" },
  { tool: "bash", access: "execute", command: "pwd", decision: "approve" },
  { tool: "bash", access: "execute", command: "curl example.com", decision: "escalate" },
  { tool: "read", access: "read", paths: [".env"], decision: "escalate" },
])("Pi's blocking $tool approval reaches the durable reviewer: $decision", async (target) => {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send" }, { on: "resolve", frames: [frames.frame(end)] }],
    frames,
    { provider: "pi" },
  );
  try {
    writeFileSync(join(h.home, "ordinary.txt"), "hello\n");
    const id = await h.create();
    const translator = createPiTranslator({ threadId: id, rootKey: "root" });
    const { decision, ...action } = target;
    const facts = translator.translate(
      {
        seq: 1,
        t: 1,
        dir: "recv",
        channel: "stdio",
        data: {
          type: "extension_ui_request",
          id: "tool-gate",
          method: "confirm",
          title: "ace tool approval v1",
          message: JSON.stringify({ ...action, cwd: h.home }),
        },
      },
      1,
    );
    const approval = facts.find((f) => f.type === "interaction.opened");
    if (!approval || approval.type !== "interaction.opened") throw new Error("Missing approval");
    await h.contexts[0]?.onFrame(frames.frame(start, { ...approval, agent: "root" }));
    await h.engine.flush();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction?.review?.decision).toBe(decision);
    expect(interaction?.state).toBe(decision === "approve" ? "resolved" : "pending");
    expect(h.store.getThread(id)?.status.state).toBe(decision === "approve" ? "done" : "needs_you");
  } finally {
    await h.close();
  }
});

test.each([
  { kind: "execute", command: "pwd", decision: "approve" },
  { kind: "execute", command: "curl example.com", decision: "escalate" },
  { kind: "read", command: undefined, decision: "escalate" },
])(
  "ACP $kind approval reviews exact shell input without treating locations as authority",
  async ({ kind, command, decision }) => {
    const frames = scriptFrames();
    const h = await harness(
      [{ on: "send" }, { on: "resolve", frames: [frames.frame(end)] }],
      frames,
      { provider: "acp" },
    );
    try {
      writeFileSync(join(h.home, "ordinary.txt"), "hello\n");
      const id = await h.create();
      const translator = createAcpTranslator({
        threadId: id,
        rootKey: "root",
        identity: { generation: "test", cursor: 0 },
      });
      const facts = translator.translate(
        {
          seq: 1,
          t: 1,
          dir: "recv",
          channel: "stdio",
          data: {
            jsonrpc: "2.0",
            id: 1,
            method: "session/request_permission",
            params: {
              sessionId: "native",
              toolCall: {
                toolCallId: "call",
                title: "Inspection",
                kind,
                rawInput: command ? { command } : { path: "ordinary.txt" },
                locations: [{ path: "ordinary.txt" }],
              },
              options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
            },
          },
        },
        1,
      );
      const approval = facts.find((f) => f.type === "interaction.opened");
      if (!approval || approval.type !== "interaction.opened") throw new Error("Missing approval");
      await h.contexts[0]?.onFrame(frames.frame(start, { ...approval, agent: "root" }));
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.review?.decision).toBe(decision);
      expect(interaction?.state).toBe(decision === "approve" ? "resolved" : "pending");
      expect(h.store.getThread(id)?.status.state).toBe(
        decision === "approve" ? "done" : "needs_you",
      );
    } finally {
      await h.close();
    }
  },
);
