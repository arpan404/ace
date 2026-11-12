import { expect, test } from "vitest";
import { AgentId, ItemId, RunId, ThreadId, ToolCall, type AgentModelRoster } from "@ace/protocol";
import { subscriptionsFrom } from "./brain-sessions.ts";
import { BrainWatch, failureReason, startFailure } from "./brain-watch.ts";

const roster = (providers: AgentModelRoster["providers"]): AgentModelRoster => ({
  providers,
  caller: { provider: "codex", access: "read-only" },
});
const sets = [{ ids: ["m1", "m2"], names: { m1: "Model one" } }];

test("subscriptions leave out providers that aren't installed, are turned off or signed out", () => {
  const listed = subscriptionsFrom(
    roster([
      { provider: "codex", accounts: [{ id: "work", label: "Work" }, { id: "home" }], sets },
      { provider: "claude", accounts: [{ id: "c", installed: false }], sets },
      { provider: "cursor", accounts: [{ id: "k", enabled: false }], sets },
      { provider: "opencode", accounts: [{ id: "o", auth: "logged_out" }], sets },
      { provider: "pi", accounts: [{ id: "p", auth: "unknown" }], sets: [] },
    ]),
  );
  expect(listed).toEqual({
    providers: [
      {
        provider: "codex",
        name: "Codex",
        accounts: [
          { id: "work", label: "Work" },
          { id: "home", label: null },
        ],
        models: [
          { id: "m1", name: "Model one" },
          { id: "m2", name: "m2" },
        ],
      },
    ],
  });
});

test("a failed run is named by why: signed out, out of quota, rate-limited, or otherwise", () => {
  const cases = [
    [{ kind: "auth", message: "x" }, "signed_out"],
    [{ kind: "provider", message: "x", code: "authentication_failed" }, "signed_out"],
    [{ kind: "quota", message: "x" }, "quota"],
    [
      { kind: "provider", message: "x", details: { code: "usage_limit", provider: "codex" } },
      "quota",
    ],
    [{ kind: "provider", message: "x", code: "rate_limit" }, "rate_limited"],
    [{ kind: "process_exit", message: "x" }, "failed"],
  ] as const;
  for (const [error, reason] of cases) expect(failureReason(error)).toBe(reason);
});

test("a reply sent whole after it streamed adds only what is new, and a provider question ends the turn", () => {
  const root = AgentId.parse("01a1ceeb-4c59-77b0-b615-357c46c0000f");
  const watch = new BrainWatch(root, "codex");
  watch.next({
    type: "run.started",
    run: {
      id: RunId.parse("run-1"),
      threadId: ThreadId.parse("6711171d-5874-4f4e-90ef-5fcc410e487a"),
      agentId: root,
      trigger: "user",
      state: "active",
      startedAt: 1,
    },
  });
  const item = (text: string) => ({
    id: ItemId.parse("i1"),
    agentId: root,
    createdAt: 1,
    complete: true,
    type: "message" as const,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text }],
    synthetic: false,
    raw: [],
  });
  const texts = [
    ...watch.next({ type: "item.created", item: item("Hel") }),
    ...watch.next({
      type: "item.delta",
      itemId: ItemId.parse("i1"),
      agentId: root,
      field: "text",
      append: "lo",
    }),
    ...watch.next({ type: "item.updated", item: item("Hello, there") }),
  ].flatMap((frame) => (frame.type === "text" ? [frame.text] : []));
  expect(texts.join("")).toBe("Hello, there");
  const asked = watch.next({
    type: "interaction.opened",
    interaction: { id: "q" } as never,
  });
  expect(asked).toEqual([expect.objectContaining({ type: "failed", reason: "needs_permission" })]);
  expect(watch.ended).toBe(true);
});

const toolCall = (root: AgentId, id: string, detail: ToolCall["detail"], agent = root) => ({
  type: "item.created" as const,
  item: {
    id: ItemId.parse(id),
    agentId: agent,
    createdAt: 1,
    complete: true,
    type: "tool_call" as const,
    call: ToolCall.parse({
      id,
      agentId: agent,
      kind: detail.kind,
      title: "a call",
      status: "running",
      detail,
      startedAt: 1,
      raw: [],
    }),
  },
});

test("every native tool the watcher doesn't know to be trusted taints the turn, from any agent", () => {
  const root = AgentId.parse("01a1ceeb-4c59-77b0-b615-357c46c0000f");
  const child = AgentId.parse("01a1ceeb-4c59-77b0-b615-357c46c0ffff");
  const tainting: ToolCall["detail"][] = [
    { kind: "file.read", path: "notes.md" },
    { kind: "search", query: "todo" },
    { kind: "shell", command: "cat notes.md" },
    { kind: "web.fetch", url: "https://example.com" },
    { kind: "mcp", server: "ace", tool: "agents_status" },
    { kind: "mcp", server: "github", tool: "issue_read" },
    { kind: "custom" },
  ];
  for (const detail of tainting) {
    const parsed = ToolCall.shape.detail.safeParse(detail);
    if (!parsed.success) throw new Error(`fixture ${detail.kind} doesn't parse`);
    for (const agent of [root, child]) {
      const watch = new BrainWatch(root, "opencode");
      const frames = watch.next(toolCall(root, "a", parsed.data, agent));
      expect(
        frames.some((frame) => frame.type === "read"),
        `${detail.kind}`,
      ).toBe(true);
    }
  }
  const trusted = new BrainWatch(root, "opencode");
  const quiet = [
    toolCall(root, "t", { kind: "todo", todos: [] }),
    toolCall(root, "s", { kind: "mcp", server: "ace", tool: "spade_call" }),
  ].flatMap((event) => trusted.next(event).filter((frame) => frame.type === "read"));
  expect(quiet).toEqual([]);
});

test("only providers with a read-only mode are offered, since a bot's session runs read-only", () => {
  const listed = subscriptionsFrom(
    roster([
      { provider: "claude", accounts: [{ id: "c" }], sets },
      { provider: "cursor", accounts: [{ id: "k" }], sets },
      { provider: "antigravity", accounts: [{ id: "a" }], sets },
      { provider: "acp", accounts: [{ id: "x" }], sets },
    ]),
  );
  expect(listed.providers.map((entry) => entry.provider)).toEqual(["claude"]);
});

test("a provider that can't run read-only is unavailable, with the reason in one line", () => {
  expect(startFailure("cursor", "permission_mode_unsupported")).toEqual({
    reason: "unavailable",
    message: "Cursor has no read-only mode, which Spade's bots need. Choose another subscription.",
  });
  expect(startFailure("codex", "provider_unavailable").reason).toBe("not_installed");
});

test("only this turn's runs reach the reply: an earlier run's text is dropped, an early one waits for its run", () => {
  const root = AgentId.parse("01a1ceeb-4c59-77b0-b615-357c46c0000f");
  const watch = new BrainWatch(root, "codex");
  const message = (id: string, run: string, text: string) => ({
    type: "item.created" as const,
    item: {
      id: ItemId.parse(id),
      agentId: root,
      runId: RunId.parse(run),
      createdAt: 1,
      complete: true,
      type: "message" as const,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text }],
      synthetic: false,
      raw: [],
    },
  });
  const started = (run: string) => ({
    type: "run.started" as const,
    run: {
      id: RunId.parse(run),
      threadId: ThreadId.parse("6711171d-5874-4f4e-90ef-5fcc410e487a"),
      agentId: root,
      trigger: "user" as const,
      state: "active" as const,
      startedAt: 1,
    },
  });
  const texts = [
    // The last turn's run is still ending when this turn is sent.
    message("old-reply", "run-old", "Earlier answer"),
    // This turn's reply arrives before its run is announced.
    message("new-reply", "run-new", "This answer"),
    started("run-new"),
  ]
    .flatMap((event) => watch.next(event))
    .flatMap((frame) => (frame.type === "text" ? [frame.text] : []));
  expect(texts).toEqual(["This answer"]);
});
