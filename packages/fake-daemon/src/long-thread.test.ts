import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, ThreadId, type EventPayload } from "@ace/protocol";
import {
  FakeDaemon,
  ScenarioPlayer,
  fakeTransport,
  dedupeReconnect,
  multiDayDemo,
  multiDayThread,
} from "./index.ts";

async function connect(daemon: FakeDaemon, device = "phone") {
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse(device),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0,
    id: () => `${device}-${++id}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  return client;
}

test("fake catch-up keeps current agent counts after a subagent resumes and finishes", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, dedupeReconnect()).runThrough("follow-up");
  const client = await connect(daemon);
  try {
    expect((await client.threadCatchUp({ threadId: "thread-dedupe", sinceSeq: 0 })).status).toEqual(
      { state: "working", agents: 3 },
    );
    daemon.apply("thread-dedupe", [{ type: "turn.ended", agent: "audit", outcome: "completed" }]);
    expect((await client.threadCatchUp({ threadId: "thread-dedupe", sinceSeq: 0 })).status).toEqual(
      { state: "working", agents: 2 },
    );
  } finally {
    await client.close();
  }
});

// Mutation cases: count only approvals opened after the cutoff; omit descendant facts;
// include inclusive provider/model-session token samples; use sequence order as time order.
// Not executed (tests run at merge). These regressions are written before the fixes.
test("fake catch-up includes already pending approvals and later linked child commands", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  for (const id of ["family", "child"])
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: id,
      provider: "codex",
      permissionMode: "ask",
    });
  const root = {
    type: "agent.seen" as const,
    agent: "root",
    origin: "root" as const,
    fidelity: "full" as const,
    native: { provider: "codex" as const, nativeId: "root" },
    cwd: "/fake",
  };
  daemon.apply("family", [
    root,
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "agent.seen",
      agent: "proxy",
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: "codex", nativeId: "proxy" },
      cwd: "/fake",
    },
    {
      type: "agent.external",
      agent: "proxy",
      threadId: ThreadId.parse("child"),
      status: { state: "working", agents: 1 },
    },
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "pending",
      blocking: true,
      request: {
        kind: "approval",
        title: "Approve migration",
        options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
      },
    },
  ]);
  const sinceSeq = daemon.head;
  daemon.apply("child", [
    root,
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "command",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "Validate child",
          status: "failed",
          detail: { kind: "shell", command: "child-check", exitCode: 7 },
        },
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "Child validation failed" }],
      },
    },
  ]);
  const client = await connect(daemon);
  try {
    expect(await client.threadCatchUp({ threadId: "family", sinceSeq })).toMatchObject({
      digest: {
        approvalsAsked: 0,
        approvalsPending: 1,
        commandsRun: 1,
        commandsFailed: 1,
        errors: 1,
        commands: [{ command: "child-check", failed: true, exitCode: 7 }],
      },
      latestAgentMessagePreview: "Child validation failed",
    });
    daemon.apply("family", [
      {
        type: "interaction.closed",
        interaction: "pending",
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
      },
    ]);
    expect((await client.threadCatchUp({ threadId: "family", sinceSeq })).digest).toMatchObject({
      approvalsPending: 0,
      approvalsAnswered: 1,
      commandsRun: 1,
    });
  } finally {
    await client.close();
  }
});

test("fake turn usage excludes inclusive session totals and deduplicates model counters", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "usage-scope", workspaceId: "ace", title: "Usage", provider: "codex" });
  daemon.apply("usage-scope", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "usage",
      agent: "root",
      model: "model-a",
      inputTokens: 100,
      outputTokens: 25,
      counterMode: "cumulative",
      usageScope: "agent",
    },
    {
      type: "usage",
      agent: "root",
      model: "model-a",
      inputTokens: 100,
      outputTokens: 25,
      counterMode: "cumulative",
      usageScope: "provider_session",
      counterKey: "provider-session",
    },
    {
      type: "usage",
      agent: "root",
      model: "model-a",
      inputTokens: 100,
      outputTokens: 25,
      counterMode: "cumulative",
      usageScope: "model_session",
      counterKey: "model-session-a",
    },
    {
      type: "usage",
      agent: "root",
      model: "model-b",
      inputTokens: 40,
      outputTokens: 10,
      counterMode: "cumulative",
      usageScope: "agent",
    },
    {
      type: "usage",
      agent: "root",
      model: "model-a",
      inputTokens: 100,
      outputTokens: 25,
      counterMode: "cumulative",
      usageScope: "agent",
    },
  ]);
  const client = await connect(daemon);
  try {
    expect((await client.turnsPage({ threadId: "usage-scope" })).turns[0]?.digest).toMatchObject({
      inputTokens: 140,
      outputTokens: 35,
    });
    expect(
      (await client.threadCatchUp({ threadId: "usage-scope", sinceSeq: 0 })).digest,
    ).toMatchObject({ inputTokens: 140, outputTokens: 35 });
    // A known token counter has a zero delta after this cursor, rather than unknown usage.
    expect(
      (await client.threadCatchUp({ threadId: "usage-scope", sinceSeq: daemon.head })).digest,
    ).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  } finally {
    await client.close();
  }
});

test("fake catch-up uses event timestamps when a later append has an earlier timestamp", async () => {
  let now = 200;
  const daemon = new FakeDaemon({ clock: () => now });
  daemon.createThread({
    id: "unordered-time",
    workspaceId: "ace",
    title: "Time",
    provider: "codex",
  });
  daemon.apply("unordered-time", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "a",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "A",
          status: "succeeded",
          detail: { kind: "shell", command: "command-a" },
        },
      },
    },
  ]);
  now = 100;
  daemon.apply("unordered-time", [
    {
      type: "item.upsert",
      agent: "root",
      item: "b",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "B",
          status: "failed",
          detail: { kind: "shell", command: "command-b", exitCode: 1 },
        },
      },
    },
  ]);
  const client = await connect(daemon);
  try {
    const catchUp = await client.threadCatchUp({ threadId: "unordered-time", sinceTime: 150 });
    expect(catchUp.digest).toMatchObject({
      commandsRun: 1,
      commandsFailed: 0,
      commands: [{ command: "command-a", failed: false }],
    });
    expect(
      (await client.threadCatchUp({ threadId: "unordered-time", sinceTime: 100 })).digest
        .commandsRun,
    ).toBe(1);
  } finally {
    await client.close();
  }
});

// Mutation cases: count a replacement as another command/tool; retain removed file paths;
// keep the old command result in a cached aggregate; rescan the transcript for partial catch-up.
// Not executed (tests run at merge).
test("fake incremental digests replace command outcomes and changed files without duplicate facts", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "replace-digest",
    workspaceId: "ace",
    title: "Replace",
    provider: "codex",
  });
  daemon.apply("replace-digest", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "command",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "Validation",
          status: "running",
          detail: { kind: "shell", command: "validate" },
        },
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "edit",
      draft: {
        type: "tool_call",
        call: {
          kind: "file.edit",
          title: "Migration",
          status: "succeeded",
          detail: {
            kind: "file.edit",
            changes: [{ path: "old.ts", kind: "add", newText: "first\nsecond\n" }],
          },
        },
      },
    },
  ]);
  const sinceSeq = daemon.head;
  daemon.apply("replace-digest", [
    {
      type: "item.upsert",
      agent: "root",
      item: "command",
      draft: {
        type: "tool_call",
        complete: true,
        call: { status: "failed", detail: { kind: "shell", exitCode: 9 } },
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "edit",
      draft: {
        type: "tool_call",
        call: {
          detail: {
            kind: "file.edit",
            changes: [{ path: "new.ts", kind: "add", newText: "replacement\n" }],
          },
        },
      },
    },
  ]);
  const client = await connect(daemon);
  try {
    expect((await client.turnsPage({ threadId: "replace-digest" })).turns[0]?.digest).toMatchObject(
      {
        toolCounts: { shell: 1, "file.edit": 1 },
        commandsRun: 1,
        commandsFailed: 1,
        commands: [{ command: "validate", failed: true, exitCode: 9 }],
        files: [{ path: "new.ts", added: 1, removed: 0 }],
      },
    );
    expect(
      (await client.threadCatchUp({ threadId: "replace-digest", sinceSeq })).digest,
    ).toMatchObject({
      commandsRun: 0,
      commandsFailed: 1,
      commands: [{ command: "validate", failed: true, exitCode: 9 }],
      files: [{ path: "new.ts", added: 1, removed: 0 }],
    });
  } finally {
    await client.close();
  }
});

// Mutation cases: discard turn boundaries; double-count authoritative tool replacements;
// drop answered approvals; lose commands/files/tokens. Not executed (tests run at merge).
test("fake turn pages report outcomes and digest facts across five days", async () => {
  const daemon = new FakeDaemon({ clock: () => 10 * 24 * 60 * 60 * 1000 });
  new ScenarioPlayer(daemon, multiDayDemo()).runUntilBlocked();
  const client = await connect(daemon);
  try {
    const closed = daemon
      .replay({ kind: "thread", threadId: ThreadId.parse("thread-multi-day") }, 0)
      .filter((event) => event.payload.type === "interaction.closed" && event.payload.autoReviewed);
    expect(closed).toHaveLength(8);
    const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-multi-day") });
    if (view?.kind !== "thread") throw new Error("Expected thread snapshot");
    expect(
      Object.values(view.interactions).filter((interaction) => interaction.autoReviewed),
    ).toHaveLength(8);
    const page = await client.turnsPage({ threadId: "thread-multi-day", limit: 2 });
    expect(page.turns.map((turn) => turn.ordinal)).toEqual([23, 24]);
    expect(page.before).toBe(23);
    expect(page.after).toBeNull();
    expect(page.turns[1]).toMatchObject({
      outcome: "completed",
      status: { state: "done" },
      initiatingMessagePreview: "Migrate checkpoint 24, inspect files and report failures.",
      digest: {
        commandsRun: 1,
        commandsFailed: 0,
        approvalsAsked: 1,
        approvalsAnswered: 1,
        approvalsAutoReviewed: 1,
        approvalsPending: 0,
        inputTokens: 1000,
        outputTokens: 400,
        toolCounts: { shell: 1, "file.edit": 1 },
        files: [{ path: "src/checkpoint-0.ts", added: 2, removed: 1 }],
      },
    });
    const older = await client.turnsPage({
      threadId: "thread-multi-day",
      before: page.before ?? 0,
      limit: 2,
    });
    expect(older.turns.map((turn) => turn.ordinal)).toEqual([21, 22]);
    expect(older.after).toBe(22);
    const catchUp = await client.threadCatchUp({
      threadId: "thread-multi-day",
      sinceSeq: older.turns.at(-1)?.endSeq ?? 0,
    });
    expect(catchUp).toMatchObject({
      turnsCompleted: 2,
      status: { state: "done" },
      digest: { commandsRun: 2, approvalsAnswered: 2, inputTokens: 2000 },
    });
  } finally {
    await client.close();
  }
});

// Mutation cases: count only successful completions; omit interrupted/failed settled turns;
// ignore sequence/time cutoffs on current completion membership.
// Not executed (tests run at merge).
test("fake catch-up counts failed and interrupted turns once their trees settle", async () => {
  let now = 100;
  const daemon = new FakeDaemon({ clock: () => now });
  daemon.createThread({
    id: "settled-outcomes",
    workspaceId: "ace",
    title: "Outcomes",
    provider: "codex",
  });
  daemon.apply("settled-outcomes", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", nativeTurnId: "failed", trigger: "user" },
    {
      type: "turn.ended",
      agent: "root",
      nativeTurnId: "failed",
      outcome: "failed",
      error: { kind: "provider", message: "Failed validation" },
    },
  ]);
  const failedSeq = daemon.head;
  now = 200;
  daemon.apply("settled-outcomes", [
    { type: "turn.started", agent: "root", nativeTurnId: "interrupted", trigger: "user" },
    { type: "turn.ended", agent: "root", nativeTurnId: "interrupted", outcome: "interrupted" },
  ]);
  const client = await connect(daemon);
  try {
    expect(
      (await client.threadCatchUp({ threadId: "settled-outcomes", sinceSeq: 0 })).turnsCompleted,
    ).toBe(2);
    expect(
      (await client.threadCatchUp({ threadId: "settled-outcomes", sinceSeq: failedSeq }))
        .turnsCompleted,
    ).toBe(1);
    expect(
      (await client.threadCatchUp({ threadId: "settled-outcomes", sinceTime: 150 })).turnsCompleted,
    ).toBe(1);
    expect(
      (await client.turnsPage({ threadId: "settled-outcomes" })).turns.map((turn) => turn.outcome),
    ).toEqual(["failed", "interrupted"]);
  } finally {
    await client.close();
  }
});

// Mutation cases: search only the projected output tail; ignore filters/cursor binding;
// turn jumps land at the tail; jump requests overwrite live snapshots.
// Not executed (tests run at merge).
test("fake search finds older shell output and turns jump to a separate bounded item window", async () => {
  const daemon = new FakeDaemon({ clock: () => 10 * 24 * 60 * 60 * 1000 });
  new ScenarioPlayer(daemon, multiDayDemo()).runUntilBlocked();
  const client = await connect(daemon);
  try {
    const first = await client.threadSearch({
      threadId: "thread-multi-day",
      text: "Inspecting checkpoint",
      filter: "tool_output",
      limit: 2,
    });
    expect(first.hits).toHaveLength(2);
    expect(first.hits[0]?.snippet.text).toContain("Inspecting checkpoint 1");
    const snippet = first.hits[0]?.snippet;
    expect(snippet?.highlights).toEqual([{ start: 0, end: 21 }]);
    expect(snippet?.highlights.map((mark) => snippet.text.slice(mark.start, mark.end))).toEqual([
      "Inspecting checkpoint",
    ]);
    const next = await client.threadSearch({
      threadId: "thread-multi-day",
      text: "Inspecting checkpoint",
      filter: "tool_output",
      limit: 2,
      cursor: first.cursor ?? undefined,
    });
    expect(next.hits[0]?.turnOrdinal).toBe(3);
    expect(
      (
        await client.threadSearch({
          threadId: "thread-multi-day",
          text: "Inspecting checkpoint",
          filter: "messages",
        })
      ).hits,
    ).toEqual([]);
    await expect(
      client.threadSearch({
        threadId: "thread-multi-day",
        text: "other",
        cursor: first.cursor ?? undefined,
      }),
    ).rejects.toThrow();
    const before = daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse("thread-multi-day"),
    });
    const window = await client.itemsWindow({
      threadId: "thread-multi-day",
      turnOrdinal: 1,
      before: 0,
      after: 3,
    });
    expect(window.items).toHaveLength(4);
    expect(window.items[0]).toMatchObject({
      type: "message",
      role: "user",
      parts: [{ type: "text", text: "Migrate checkpoint 1, inspect files and report failures." }],
    });
    expect(window.itemsAfter).not.toBeNull();
    expect(
      daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-multi-day") }),
    ).toEqual(before);
  } finally {
    await client.close();
  }
});

// Mutation cases: share read positions across devices; permit cursor regression; lose read
// state on socket reconnect; trust future client sequences. Not executed (tests run at merge).
test("fake read state survives reconnect and advances independently for each device", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, multiDayDemo("thread-multi-day", 1)).runUntilBlocked();
  const first = await connect(daemon, "phone");
  const second = await connect(daemon, "laptop");
  try {
    await first.markThreadRead({ threadId: "thread-multi-day", lastSeenSeq: daemon.head + 500 });
    await first.markThreadRead({ threadId: "thread-multi-day", lastSeenSeq: 1 });
    expect((await first.threadReadState({ threadId: "thread-multi-day" })).lastSeenSeq).toBe(
      daemon.head,
    );
    expect((await second.threadReadState({ threadId: "thread-multi-day" })).lastSeenSeq).toBe(0);
    await first.close();
    const reconnected = await connect(daemon, "phone");
    try {
      expect(
        (await reconnected.threadReadState({ threadId: "thread-multi-day" })).lastSeenSeq,
      ).toBe(daemon.head);
    } finally {
      await reconnected.close();
    }
  } finally {
    await first.close();
    await second.close();
  }
});

// Mutation cases: reuse item ids; skip turns/approval closure; emit only a single day;
// omit subagent linkage or blob-sized text. Not executed (tests run at merge).
test("the streaming fixture produces deterministic multi-day work with approvals and linked children", () => {
  const options = { items: 40, turns: 4, subagents: 2 };
  const first = [...multiDayThread(options)];
  expect([...multiDayThread(options)]).toEqual(first);
  const main = first.filter((event) => event.threadId === "thread-multi-day");
  const items = main.flatMap((event) =>
    event.payload.type === "item.created" ? [event.payload.item] : [],
  );
  expect(items).toHaveLength(40);
  expect(new Set(items.map((item) => item.id)).size).toBe(40);
  expect(main.filter((event) => event.payload.type === "interaction.opened")).toHaveLength(4);
  expect(main.filter((event) => event.payload.type === "interaction.closed")).toHaveLength(4);
  expect(
    main.filter(
      (event) => event.payload.type === "agent.created" && event.payload.agent.childThreadId,
    ),
  ).toHaveLength(2);
  expect((main.at(-1)?.at ?? 0) - (main[0]?.at ?? 0)).toBeGreaterThan(4 * 24 * 60 * 60 * 1000);
  expect(items.some((item) => item.type === "reasoning" && item.text.length > 64_000)).toBe(true);
  const turns = main.flatMap((event): EventPayload[] =>
    event.payload.type === "run.started" ? [event.payload] : [],
  );
  expect(turns).toHaveLength(4);
});

// Mutation cases: count pre-cursor approval requests twice; use a device name as proof
// of auto-review; declare a thread done while a background shell runs.
// Not executed (tests run at merge).
test("fake catch-up counts an approval answer after the cursor and preserves background waiting", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "background",
    workspaceId: "ace",
    title: "Background migration",
    provider: "codex",
    permissionMode: "ask",
  });
  daemon.apply("background", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "Migration scan",
          status: "running",
          detail: { kind: "shell", command: "scan migrations" },
        },
      },
    },
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "approval",
      item: "shell",
      blocking: true,
      request: {
        kind: "approval",
        title: "Approve scan",
        options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
      },
    },
  ]);
  const sinceSeq = daemon.head;
  daemon.apply("background", [
    {
      type: "interaction.closed",
      interaction: "approval",
      state: "resolved",
      resolution: { kind: "approval", optionId: "allow" },
      resolvedBy: DeviceId.parse("pretend-auto-review"),
    },
    {
      type: "background.started",
      agent: "root",
      task: "scan",
      item: "shell",
      kind: "shell",
      title: "Migration scan",
      stoppable: true,
    },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  ]);
  const client = await connect(daemon);
  try {
    const summary = await client.threadCatchUp({ threadId: "background", sinceSeq });
    expect(summary).toMatchObject({
      status: { state: "waiting", on: "background_task" },
      turnsCompleted: 0,
      digest: {
        approvalsAsked: 0,
        approvalsAnswered: 1,
        approvalsAutoReviewed: 0,
        approvalsPending: 0,
      },
    });
    const turns = await client.turnsPage({ threadId: "background" });
    expect(turns.turns[0]?.status).toEqual({ state: "waiting", on: "background_task" });
    daemon.apply("background", [
      { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
    ]);
    daemon.apply("background", [
      {
        type: "item.upsert",
        agent: "root",
        item: "shell",
        draft: { type: "tool_call", call: { title: "Still scanning migration" } },
      },
    ]);
    const historical = await client.turnsPage({ threadId: "background", before: 2 });
    expect(historical.turns[0]?.status).toEqual({ state: "waiting", on: "background_task" });
    daemon.apply("background", [
      { type: "background.ended", task: "scan", status: "completed" },
      {
        type: "item.upsert",
        agent: "root",
        item: "shell",
        draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
      },
    ]);
    daemon.apply("background", [
      { type: "turn.ended", agent: "root", nativeTurnId: "second", outcome: "completed" },
    ]);
    expect((await client.threadCatchUp({ threadId: "background", sinceSeq })).status).toEqual({
      state: "done",
    });
  } finally {
    await client.close();
  }
});

// Mutation case: URI-encode a query into a cursor that exceeds the wire limit.
// Not executed (tests run at merge).
test("fake search pages long Unicode queries with a bounded cursor", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "unicode",
    workspaceId: "ace",
    title: "Unicode migration",
    provider: "codex",
  });
  const text = "雪".repeat(512);
  daemon.apply("unicode", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "one",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text }],
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "two",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text }],
      },
    },
  ]);
  const client = await connect(daemon);
  try {
    const first = await client.threadSearch({ threadId: "unicode", text, limit: 1 });
    expect(first.hits).toHaveLength(1);
    expect(first.cursor?.length).toBeLessThan(2048);
    const second = await client.threadSearch({
      threadId: "unicode",
      text,
      limit: 1,
      cursor: first.cursor ?? undefined,
    });
    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]?.itemId).not.toBe(first.hits[0]?.itemId);
    expect(second.cursor).toBeNull();
  } finally {
    await client.close();
  }
});

// Mutation case: remove an agent's failure from catch-up when a later turn recovers.
// Not executed (tests run at merge).
test("fake catch-up retains an agent failure after the agent recovers", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "recover",
    workspaceId: "ace",
    title: "Recover migration",
    provider: "codex",
  });
  daemon.apply("recover", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", nativeTurnId: "failed", trigger: "user" },
    {
      type: "turn.ended",
      agent: "root",
      nativeTurnId: "failed",
      outcome: "failed",
      error: { kind: "provider", message: "Migration scan failed" },
    },
  ]);
  const client = await connect(daemon);
  try {
    expect((await client.threadCatchUp({ threadId: "recover", sinceSeq: 0 })).digest.errors).toBe(
      1,
    );
    daemon.apply("recover", [
      { type: "turn.started", agent: "root", nativeTurnId: "recovered", trigger: "user" },
      { type: "turn.ended", agent: "root", nativeTurnId: "recovered", outcome: "completed" },
    ]);
    const catchUp = await client.threadCatchUp({ threadId: "recover", sinceSeq: 0 });
    expect(catchUp.status).toEqual({ state: "done" });
    expect(catchUp.digest.errors).toBe(1);
  } finally {
    await client.close();
  }
});

// Mutation case: replace a historical child's rate-limit reason with generic background waiting.
// Not executed (tests run at merge).
test("fake historical turns preserve a blocked child's rate-limit reason", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "limited-child",
    workspaceId: "ace",
    title: "Limited migration worker",
    provider: "codex",
  });
  daemon.apply("limited-child", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake",
    },
    { type: "turn.started", agent: "root", nativeTurnId: "first", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: {
        type: "tool_call",
        call: {
          kind: "agent.spawn",
          title: "Migration worker",
          status: "running",
          detail: { kind: "agent.spawn", childAgent: "worker" },
        },
      },
    },
    {
      type: "agent.seen",
      agent: "worker",
      parent: "root",
      spawnedBy: "spawn",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "codex", nativeId: "worker" },
      cwd: "/fake",
      background: true,
    },
    { type: "turn.started", agent: "worker", nativeTurnId: "worker", trigger: "spawn" },
    { type: "retry", agent: "worker", on: "rate_limit", until: 2000, message: "Resume at 2000" },
    { type: "turn.ended", agent: "root", nativeTurnId: "first", outcome: "completed" },
    { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: { type: "tool_call", call: { title: "Worker still awaiting quota" } },
    },
  ]);
  const client = await connect(daemon);
  try {
    const page = await client.turnsPage({ threadId: "limited-child", before: 2 });
    expect(page.turns[0]?.status).toEqual({ state: "limited", until: 2000 });
    expect(page.turns[0]?.subagents[0]?.status).toEqual({ state: "limited", until: 2000 });
  } finally {
    await client.close();
  }
});

// A late child approval belongs to the original root turn, even after a new turn starts.
test("fake human approvals count once on the original turn while a newer turn works", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "review-late",
    workspaceId: "ace",
    title: "Late worker review",
    provider: "codex",
    permissionMode: ":workspace",
  });
  daemon.apply("review-late", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/fake/ace",
    },
    { type: "turn.started", agent: "root", nativeTurnId: "first", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: {
        type: "tool_call",
        call: {
          kind: "agent.spawn",
          title: "Migration worker",
          status: "running",
          detail: { kind: "agent.spawn", childAgent: "worker" },
        },
      },
    },
    {
      type: "agent.seen",
      agent: "worker",
      parent: "root",
      spawnedBy: "spawn",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "codex", nativeId: "worker" },
      cwd: "/fake/ace",
      background: true,
    },
    { type: "turn.started", agent: "worker", nativeTurnId: "worker", trigger: "spawn" },
    { type: "turn.ended", agent: "root", nativeTurnId: "first", outcome: "completed" },
    { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
  ]);
  const sinceSeq = daemon.head;
  daemon.apply("review-late", [
    {
      type: "item.upsert",
      agent: "worker",
      item: "shell",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "Inspect working directory",
          status: "running",
          detail: { kind: "shell", command: "pwd" },
        },
      },
    },
    {
      type: "interaction.opened",
      agent: "worker",
      item: "shell",
      interaction: "approval",
      blocking: true,
      request: {
        kind: "approval",
        title: "Inspect working directory",
        target: { tool: "shell", command: "pwd", access: "execute" },
        options: [
          { id: "allow", label: "Allow once", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ]);
  daemon.apply("review-late", [
    {
      type: "interaction.closed",
      interaction: "approval",
      state: "resolved",
      resolution: { kind: "approval", optionId: "allow" },
    },
  ]);
  const events = daemon.replay(
    { kind: "thread", threadId: ThreadId.parse("review-late") },
    sinceSeq,
  );
  expect(events.filter((event) => event.payload.type === "permission.reviewed")).toHaveLength(0);
  const closed = events.find((event) => event.payload.type === "interaction.closed");
  if (closed?.payload.type !== "interaction.closed")
    throw new Error("Expected human approval closure");
  expect(closed.payload.autoReviewed).toBeUndefined();
  const client = await connect(daemon);
  try {
    const page = await client.turnsPage({ threadId: "review-late" });
    expect(page.turns[0]).toMatchObject({
      ordinal: 1,
      digest: {
        approvalsAsked: 1,
        approvalsAnswered: 1,
        approvalsAutoReviewed: 0,
        approvalsPending: 0,
      },
    });
    expect(page.turns[1]).toMatchObject({
      ordinal: 2,
      digest: { approvalsAsked: 0, approvalsAutoReviewed: 0 },
    });
    expect(
      (await client.threadCatchUp({ threadId: "review-late", sinceSeq })).digest,
    ).toMatchObject({ approvalsAsked: 1, approvalsAnswered: 1, approvalsAutoReviewed: 0 });
    daemon.apply("review-late", [
      {
        type: "interaction.closed",
        interaction: "approval",
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
      },
    ]);
    expect(
      (await client.turnsPage({ threadId: "review-late", before: 2 })).turns[0]?.digest
        .approvalsAnswered,
    ).toBe(1);
  } finally {
    await client.close();
  }
});
