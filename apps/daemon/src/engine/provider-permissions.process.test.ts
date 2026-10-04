import { expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createPiAdapter } from "@ace/adapter-pi";
import { createAcpAdapter, genericQuirks, antigravityQuirks } from "@ace/adapter-acp";
import { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { ProviderAdapter, Frame } from "@ace/engine-api";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const providers = [
  {
    adapter: createCodexAdapter(),
    version: "0.159.1",
    level: "sandbox",
    gates: [true, true, false, true],
  },
  {
    adapter: createClaudeAdapter(),
    version: "2.1.286",
    level: "tool-gate",
    gates: [true, true, true, true],
  },
  {
    adapter: createOpenCodeAdapter(),
    version: "2.0.22",
    level: "tool-gate",
    gates: [true, true, true, true],
  },
  {
    adapter: createCursorAdapter(),
    version: "1.0.35",
    level: "tool-selection",
    gates: [true, true, false, true],
  },
  {
    adapter: createPiAdapter(),
    version: "0.85.1",
    level: "tool-selection",
    gates: [true, true, false, true],
  },
  {
    adapter: createAcpAdapter(genericQuirks),
    version: "1.0.0",
    level: "permission-requests",
    gates: [false, false, false, false],
  },
  {
    adapter: createAcpAdapter(antigravityQuirks),
    version: "1.2.1",
    level: "permission-requests",
    gates: [false, false, false, false],
  },
];

test.each(providers)(
  "$adapter.provider metadata admits auto-review through a scripted engine and exposes coverage before and after creation",
  async ({ adapter, version, level, gates }) => {
    const frames = scriptFrames();
    const capabilities = adapter.capabilities({
      installed: true,
      version,
      auth: "logged_in",
      loginHint: "unused",
    });
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider: adapter.provider,
      capabilities,
    });
    try {
      const client = await h.connect("preview");
      client.send({
        type: "permissions.capabilities",
        requestId: "preview",
        provider: adapter.provider,
      });
      const response = await client.next();
      if (response.type !== "permissions.capabilities.result")
        throw new Error("Missing capability response");
      expect(response.ok).toBe(true);
      expect(h.contexts).toHaveLength(0);
      const guarantee = response.permissions?.guarantees?.find(
        (entry) => entry.mode === "auto-review",
      );
      expect(guarantee?.level).toBe(level);
      expect(guarantee?.gates).toEqual({
        writes: gates[0],
        network: gates[1],
        protectedReads: gates[2],
        shell: gates[3],
      });
      expect(guarantee?.limitations.length).toBeGreaterThan(0);
      const id = await h.create();
      expect(h.contexts[0]?.permissionMode).toBe("auto-review");
      expect(h.store.getThread(id)?.status.state).toBe("done");
      expect(
        h.store
          .getThread(id)
          ?.capabilities?.permissions?.guarantees?.find((entry) => entry.mode === "auto-review"),
      ).toEqual(guarantee);
      expect(
        response.permissions?.guarantees?.find((entry) => entry.mode === "full-access"),
      ).toBeUndefined();
    } finally {
      await h.close();
    }
  },
);

function nativeApproval(
  adapter: ProviderAdapter,
  command: string,
  permissionsEscalation = false,
): Fact {
  const translator = adapter.createTranslator({
    threadId: ThreadId.parse("native-test"),
    rootKey: "root",
  });
  let seq = 0;
  const feed = (data: unknown, channel: string, dir: Frame["dir"] = "recv") =>
    translator.translate({ seq: ++seq, t: seq, dir, channel, data }, seq);
  let facts: Fact[];
  if (adapter.provider === "codex") {
    feed({ id: 1, method: "thread/start", params: {} }, "stdio", "send");
    feed({ id: 1, result: { thread: { id: "native" } } }, "stdio");
    facts = feed(
      {
        id: 100,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "native",
          command,
          ...(permissionsEscalation
            ? {
                networkApprovalContext: { host: "example.com", protocol: "https" },
                additionalPermissions: { network: { enabled: true } },
              }
            : {}),
          availableDecisions: ["accept", "cancel"],
        },
      },
      "stdio",
    );
  } else if (adapter.provider === "claude") {
    feed({ type: "system", subtype: "init", session_id: "native" }, "sdk");
    facts = feed(
      { toolName: "Bash", input: { command }, options: { requestId: "permission" } },
      "can_use_tool",
    );
  } else if (adapter.provider === "opencode") {
    feed(
      {
        method: "POST",
        path: "/api/session",
        body: {
          data: { id: "native", projectID: "project", location: { directory: "/workspace" } },
        },
      },
      "http",
    );
    facts = feed(
      {
        id: "event",
        type: "permission.asked",
        data: {
          id: "permission",
          sessionID: "native",
          action: "bash",
          metadata: { input: { command } },
        },
      },
      "sse",
    );
  } else {
    feed({ id: 1, method: "session/new", params: {} }, "stdio", "send");
    feed({ id: 1, result: { sessionId: "native" } }, "stdio");
    facts = feed(
      {
        id: 100,
        method: "session/request_permission",
        params: {
          sessionId: "native",
          toolCall: {
            toolCallId: "shell",
            kind: "execute",
            title: "scripted action",
            rawInput: { command },
          },
          options: [
            { optionId: "once", kind: "allow_once", name: "Once" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        },
      },
      "stdio",
    );
  }
  const opened = facts.find((fact) => fact.type === "interaction.opened");
  if (!opened || opened.type !== "interaction.opened")
    throw new Error("Native approval was not routed");
  return {
    type: "interaction.opened",
    agent: "root",
    interaction: "permission",
    blocking: true,
    request: opened.request,
  };
}

const reviewers = providers.filter(({ adapter }) =>
  ["codex", "claude", "opencode", "acp"].includes(adapter.provider),
);
for (const { adapter, version } of reviewers) {
  test.each([
    ["pwd", "approve"],
    ["rm -rf build", "deny"],
    ["curl example.com", "escalate"],
    ["cat .env", "escalate"],
  ] as const)(
    `${adapter.provider} native %s enters ace's durable %s path`,
    async (command, decision) => {
      const frames = scriptFrames();
      const h = await harness(
        [
          { on: "send", frames: [frames.frame(start, nativeApproval(adapter, command))] },
          { on: "resolve", frames: [frames.frame(end)] },
        ],
        frames,
        {
          provider: adapter.provider,
          capabilities: adapter.capabilities({
            installed: true,
            version,
            auth: "logged_in",
            loginHint: "unused",
          }),
        },
      );
      try {
        const id = await h.create();
        const interaction = Object.values(h.store.snapshotThread(id)?.interactions ?? {})[0];
        expect(interaction?.review?.decision).toBe(decision);
        if (adapter.provider === "codex" && decision === "deny")
          expect(interaction?.resolution).toMatchObject({ kind: "approval", optionId: "cancel" });
        expect(interaction?.review?.reason.length).toBeGreaterThan(0);
        expect(h.store.getThread(id)?.status.state).toBe(
          decision === "escalate" ? "needs_you" : "done",
        );
        expect(interaction?.state).toBe(decision === "escalate" ? "pending" : "resolved");
        expect(
          Object.values(h.store.snapshotThread(id)?.items ?? {}).some(
            (item) =>
              item.type === "notice" && item.text.includes(`Permission review ${decision}:`),
          ),
        ).toBe(true);
      } finally {
        await h.close();
      }
    },
  );
}

test("a Codex network escalation cannot earn approval from an otherwise low-risk command", async () => {
  const frames = scriptFrames();
  const adapter = createCodexAdapter();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, nativeApproval(adapter, "pwd", true))] }],
    frames,
    {
      capabilities: adapter.capabilities({
        installed: true,
        version: "0.159.1",
        auth: "logged_in",
        loginHint: "unused",
      }),
    },
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id)?.interactions ?? {})[0];
    expect(interaction?.review?.decision).toBe("escalate");
    expect(interaction?.state).toBe("pending");
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(h.adapter.commands.filter((command) => command.type === "resolve")).toEqual([]);
  } finally {
    await h.close();
  }
});

test.each([
  { toolName: "Grep", input: { pattern: ".", path: ".", glob: "*", output_mode: "content" } },
  { toolName: "Read", input: { file_path: "." } },
  { toolName: "Read", input: { file_path: "missing.txt" } },
])(
  "Claude $toolName cannot auto-approve a broad or unverified file target",
  async ({ toolName, input }) => {
    const frames = scriptFrames();
    const adapter = createClaudeAdapter();
    const translator = adapter.createTranslator({
      threadId: ThreadId.parse("native-test"),
      rootKey: "root",
    });
    translator.translate(
      {
        seq: 1,
        t: 1,
        dir: "recv",
        channel: "sdk",
        data: { type: "system", subtype: "init", session_id: "native" },
      },
      1,
    );
    const opened = translator
      .translate(
        {
          seq: 2,
          t: 2,
          dir: "recv",
          channel: "can_use_tool",
          data: { toolName, input, options: { requestId: "permission" } },
        },
        2,
      )
      .find((f) => f.type === "interaction.opened");
    if (!opened || opened.type !== "interaction.opened")
      throw new Error("Missing native permission");
    const h = await harness([], frames, { provider: "claude" });
    try {
      writeFileSync(join(h.home, "secrets.json"), '{"secret":"fixture"}');
      const id = await h.create();
      h.contexts[0]?.onFrame(
        frames.frame(start, { ...opened, agent: "root", interaction: "permission" }),
      );
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.review).toMatchObject({ decision: "escalate" });
      expect(interaction?.review?.reason.length).toBeGreaterThan(0);
      expect(interaction?.state).toBe("pending");
      expect(h.store.getThread(id)?.status.state).toBe("needs_you");
      expect(h.adapter.commands.filter((c) => c.type === "resolve")).toEqual([]);
    } finally {
      await h.close();
    }
  },
);

test.each([
  { description: "wildcard", input: { paths: ["**/*"] } },
  { description: "absent", input: undefined },
  { description: "mismatched", input: { path: "other.txt" } },
  { description: "apparently exact", input: { path: "ordinary.txt" } },
])(
  "ACP $description read input cannot earn permission from follow-along locations",
  async ({ input }) => {
    const frames = scriptFrames();
    const h = await harness([], frames, { provider: "acp" });
    try {
      writeFileSync(join(h.home, "ordinary.txt"), "ordinary fixture");
      writeFileSync(join(h.home, "secrets.json"), '{"secret":"fixture"}');
      const id = await h.create();
      const translator = createAcpAdapter(genericQuirks).createTranslator({
        threadId: id,
        rootKey: "root",
      });
      translator.translate(
        {
          seq: 1,
          t: 1,
          dir: "send",
          channel: "stdio",
          data: { id: 1, method: "session/new", params: {} },
        },
        1,
      );
      translator.translate(
        {
          seq: 2,
          t: 2,
          dir: "recv",
          channel: "stdio",
          data: { id: 1, result: { sessionId: "native" } },
        },
        2,
      );
      const facts = translator.translate(
        {
          seq: 3,
          t: 3,
          dir: "recv",
          channel: "stdio",
          data: {
            id: 100,
            method: "session/request_permission",
            params: {
              sessionId: "native",
              toolCall: {
                toolCallId: "bulk",
                kind: "read",
                title: "Read workspace files",
                ...(input ? { rawInput: input } : {}),
                locations: [{ path: join(h.home, "ordinary.txt") }],
              },
              options: [
                { optionId: "once", kind: "allow_once", name: "Once" },
                { optionId: "no", kind: "reject_once", name: "Deny" },
              ],
            },
          },
        },
        3,
      );
      const opened = facts.find((fact) => fact.type === "interaction.opened");
      if (!opened || opened.type !== "interaction.opened") throw new Error("Missing ACP approval");
      h.contexts[0]?.onFrame(
        frames.frame(start, { ...opened, agent: "root", interaction: "permission" }),
      );
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.review).toMatchObject({
        decision: "escalate",
        reason: "Tool effects are not proven low risk",
      });
      expect(interaction?.state).toBe("pending");
      expect(h.store.getThread(id)?.status.state).toBe("needs_you");
      expect(h.adapter.commands.filter((command) => command.type === "resolve")).toEqual([]);
      expect(
        h.store
          .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
          .filter((event) => event.payload.type === "permission.reviewed"),
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
);
