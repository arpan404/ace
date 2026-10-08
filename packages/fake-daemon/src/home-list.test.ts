import { CommandId, DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { FakeDaemon } from "./daemon.ts";
import { ScenarioPlayer } from "./scenario.ts";
import { homeList } from "./scenarios/home-list.ts";

const hour = 60 * 60 * 1000;

function listView(daemon: FakeDaemon) {
  const view = daemon.snapshot({ kind: "threads" });
  if (view?.kind !== "threads") throw new Error("expected the thread list");
  return Object.values(view.threads);
}

test("the Home list plays each thread at its age, with the finished history days old", () => {
  const now = 100 * 24 * hour;
  let ago = 0;
  const daemon = new FakeDaemon({ clock: () => now - ago });
  for (const aged of homeList()) {
    ago = aged.agoMs;
    new ScenarioPlayer(daemon, aged.scenario).runUntilBlocked();
  }
  const threads = listView(daemon);
  const byTitle = new Map(threads.map((t) => [t.title, t]));
  expect(byTitle.get("Resumable relay streams")).toMatchObject({
    status: { state: "working", agents: 5 },
    updatedAt: now - 3 * hour,
  });
  const history = threads.filter((t) => now - t.updatedAt >= 24 * hour);
  expect(history).toHaveLength(12);
  expect(history.every((t) => t.status.state === "done")).toBe(true);
});

test("the hero thread moved last of the busy threads, so Home lists it right after needs-you", () => {
  const now = 100 * 24 * hour;
  let ago = 0;
  const daemon = new FakeDaemon({ clock: () => now - ago });
  for (const aged of homeList()) {
    ago = aged.agoMs;
    new ScenarioPlayer(daemon, aged.scenario).runUntilBlocked();
  }
  const busy = listView(daemon)
    .filter((t) => t.status.state === "working" || t.status.state === "waiting")
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  expect(busy[0]?.title).toBe("Dedupe thread events after reconnect");
  expect(now - (busy[0]?.updatedAt ?? 0)).toBeLessThan(60_000);
});

const command = (id: string, payload: Parameters<FakeDaemon["command"]>[0]["payload"]) => ({
  id: CommandId.parse(id),
  deviceId: DeviceId.parse("device"),
  payload,
});

test("thread.create starts a working thread from the request without any provider", () => {
  const daemon = new FakeDaemon({ clock: () => 1 });
  const result = daemon.command(
    command("c1", {
      type: "thread.create",
      workspaceId: WorkspaceId.parse("relay"),
      provider: "codex",
      input: [{ type: "text", text: "Log every restart with its backoff delay\nand the cause" }],
    }),
  );
  expect(result.ok).toBe(true);
  expect(listView(daemon)).toMatchObject([
    {
      workspaceId: "relay",
      provider: "codex",
      title: "Log every restart with its backoff delay",
      status: { state: "working" },
    },
  ]);
  // A retried command is applied once.
  daemon.command(command("c1", { type: "thread.archive", threadId: ThreadId.parse("x") }));
  expect(listView(daemon)).toHaveLength(1);
});

test("thread.archive marks the thread archived and rejects unknown threads", () => {
  let now = 5;
  const daemon = new FakeDaemon({ clock: () => ++now });
  const [first] = homeList();
  if (!first) throw new Error("empty list");
  new ScenarioPlayer(daemon, first.scenario).runUntilBlocked();
  const threadId = ThreadId.parse(first.scenario.thread.id);
  expect(daemon.command(command("a1", { type: "thread.archive", threadId })).ok).toBe(true);
  expect(listView(daemon)[0]?.archivedAt).toBeDefined();
  const missing = daemon.command(
    command("a2", { type: "thread.archive", threadId: ThreadId.parse("nope") }),
  );
  expect(missing).toMatchObject({ ok: false, error: "thread_not_found" });
});
