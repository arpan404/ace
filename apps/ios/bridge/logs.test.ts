import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { followLogs, logPage, LogsQuery } from "./logs.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function opened(threadId: string, seed: Fact[]) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: threadId, workspaceId: "ace", title: "Logs", provider: "codex" });
  daemon.apply(threadId, seed);
  await client.start();
  const lease = client.thread(threadId);
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  return { daemon, store: lease.store };
}
interface Shown {
  lines: { key: string; text: string; level: string; source: string }[];
  earlier: number;
  total: number;
  all: number;
  agents: { id: string; name: string }[];
}
const shown = (sink: RecordingSink) => sink.read("thread:logs") as unknown as Shown | undefined;
const time = (at: number) => String(at);

const shell = (agent: string, item: string, command: string, exitCode: number): Fact[] => [
  facts.tool(agent, item, {
    kind: "shell",
    title: command,
    detail: { kind: "shell", command, exitCode },
  }),
  facts.toolDone(agent, item, exitCode === 0 ? "succeeded" : "failed"),
];

describe("Logs on the phone", () => {
  test("the thread's log lists commands with their exits, and the level and scope filters narrow it", async () => {
    const { daemon, store } = await opened("logs", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      ...shell("root", "lint", "bun run lint", 0),
      facts.subagent("codex", "tester", "Tester", "spawn"),
      facts.turn("tester", "spawn"),
      ...shell("tester", "test", "bun run test", 1),
      facts.endTurn("root"),
    ]);
    const sink = new RecordingSink();
    const logs = followLogs(store, "logs", 1, sink, plainPreview, time, LogsQuery.parse({}));
    await until(
      () => !!shown(sink)?.lines.some((line) => line.text.includes("exit 1")),
      "the failed exit",
    );
    const all = shown(sink);
    expect(all?.lines.map((line) => line.text)).toEqual(
      expect.arrayContaining(["$ bun run lint", "bun run lint · exit 0", "bun run test · exit 1"]),
    );
    expect(all?.lines.find((line) => line.text === "bun run test · exit 1")?.level).toBe("error");
    // Errors only.
    logs.query(LogsQuery.parse({ level: "error" }));
    await until(() => !!shown(sink)?.lines.every((line) => line.level === "error"), "errors only");
    expect(shown(sink)?.lines.map((line) => line.text)).toEqual(["bun run test · exit 1"]);
    expect(shown(sink)?.all).toBe(all?.all);
    // One agent's log: the tester and nothing the main agent ran.
    const tester = shown(sink)?.agents.find((agent) => agent.name === "Tester");
    expect(tester).toBeDefined();
    logs.query(LogsQuery.parse({ agentId: tester?.id }));
    await until(
      () => !!shown(sink)?.lines.some((line) => line.text === "$ bun run test (Tester)"),
      "the tester's log",
    );
    expect(shown(sink)?.lines.some((line) => line.text.includes("lint"))).toBe(false);
    // A new command logs a line as it happens.
    logs.query(LogsQuery.parse({}));
    daemon.apply("logs", [facts.turn("root"), ...shell("root", "build", "bun run build", 0)]);
    await until(
      () => !!shown(sink)?.lines.some((line) => line.text === "$ bun run build"),
      "the new line",
    );
    expect(logs.copy()).toContain("$ bun run build");
    logs.stop();
    expect(shown(sink)).toBeUndefined();
  });

  test("a long log shows its newest page and reads earlier pages on request", async () => {
    const seed: Fact[] = [facts.rootAgent("codex"), facts.turn("root")];
    for (let index = 0; index < 150; index++)
      seed.push(...shell("root", `run-${index}`, `step ${index}`, 0));
    seed.push(facts.endTurn("root"));
    const { store } = await opened("long", seed);
    const sink = new RecordingSink();
    const logs = followLogs(store, "long", 1, sink, plainPreview, time, LogsQuery.parse({}));
    await until(() => (shown(sink)?.total ?? 0) > logPage, "the whole log");
    const first = shown(sink);
    expect(first?.lines).toHaveLength(logPage);
    expect(first?.earlier).toBe((first?.total ?? 0) - logPage);
    expect(first?.lines.at(-1)?.text).toContain("step 149");
    logs.earlier();
    await until(() => shown(sink)?.earlier === 0, "earlier lines");
    expect(shown(sink)?.lines).toHaveLength(first?.total ?? 0);
  });

  test("a command's streamed output never rebuilds the log; its start and its exit do", async () => {
    const { daemon, store } = await opened("stream", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.tool("root", "build", {
        kind: "shell",
        title: "bun run build",
        detail: { kind: "shell", command: "bun run build" },
      }),
    ]);
    const sink = new RecordingSink();
    followLogs(store, "stream", 1, sink, plainPreview, time, LogsQuery.parse({}));
    await until(
      () => !!shown(sink)?.lines.some((line) => line.text === "$ bun run build"),
      "the start",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = sink.puts;
    for (let index = 0; index < 40; index++)
      daemon.apply("stream", [facts.output("root", "build", `line ${index}\n`)]);
    await until(
      () => JSON.stringify(store.item(store.order.at(-1) ?? "")).includes("line 39"),
      "the output",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sink.puts).toBe(before);
    daemon.apply("stream", [facts.toolDone("root", "build")]);
    await until(
      () => !!shown(sink)?.lines.some((line) => line.text.startsWith("bun run build ·")),
      "the exit",
    );
  });

  test("after Show earlier, the first line shown stays put while new lines arrive", async () => {
    const seed: Fact[] = [facts.rootAgent("codex"), facts.turn("root")];
    for (let index = 0; index < 60; index++)
      seed.push(...shell("root", `run-${index}`, `step ${index}`, 0));
    const { daemon, store } = await opened("anchor", seed);
    const sink = new RecordingSink();
    const logs = followLogs(store, "anchor", 1, sink, plainPreview, time, LogsQuery.parse({}), 20);
    await until(() => (shown(sink)?.total ?? 0) > 60, "the whole log");
    logs.earlier();
    await until(() => (shown(sink)?.lines.length ?? 0) > 20, "an earlier page");
    const first = shown(sink)?.lines[0]?.key;
    const count = shown(sink)?.lines.length ?? 0;
    daemon.apply("anchor", [
      ...shell("root", "late-1", "late one", 0),
      ...shell("root", "late-2", "late two", 0),
    ]);
    await until(() => !!shown(sink)?.lines.some((line) => line.text === "$ late two"), "new lines");
    expect(shown(sink)?.lines[0]?.key).toBe(first);
    expect(shown(sink)?.lines.length).toBe(count + 4);
  });
});
