import { describe, expect, test } from "vitest";
import {
  CliRequestList,
  InteractionId,
  ThreadId,
  WorkspaceId,
  type Interaction,
  type Thread,
} from "@ace/protocol";
import { openRequests, type RequestSource } from "./cli-requests.ts";

const at = 1_700_000_000_000;

function thread(id: string, asking: string[], state: Thread["status"]["state"] = "needs_you") {
  return {
    id: ThreadId.parse(id),
    workspaceId: WorkspaceId.parse("w_project"),
    title: `Thread ${id}`,
    provider: "codex",
    status: { state },
    createdAt: at,
    updatedAt: at,
    live: { asking: asking.map((ask) => ({ id: InteractionId.parse(ask), kind: "approval" })) },
  } as unknown as Thread;
}

function interaction(
  id: string,
  threadId: string,
  createdAt: number,
  state: Interaction["state"] = "pending",
): Interaction {
  return {
    id: InteractionId.parse(id),
    threadId: ThreadId.parse(threadId),
    agentId: "root",
    blocking: true,
    state,
    createdAt,
    raw: [{ provider: "codex", payload: { secret: "native frame" } }],
    request: {
      kind: "approval",
      title: "Run bun test",
      options: [{ id: "yes", label: "Allow once", kind: "allow_once" }],
    },
  } as unknown as Interaction;
}

function source(
  threads: Thread[],
  interactions: Interaction[],
  descendants: Record<string, string[]> = {},
): RequestSource {
  return {
    needsYouThreads: (limit) =>
      threads
        .filter((each) => each.status.state === "needs_you")
        .map((each) => each.id)
        .slice(0, limit),
    thread: (id) => threads.find((each) => each.id === id),
    interaction: (id) => interactions.find((each) => each.id === id),
    descendants: (id) => (descendants[id] ?? []).map((child) => ThreadId.parse(child)),
  };
}

const all = () => true;

describe("open requests across threads", () => {
  test("lists every pending request from every waiting thread, oldest first", () => {
    const list = openRequests(
      source(
        [thread("t_aaaaaa", ["i_late"]), thread("t_bbbbbb", ["i_early", "i_done"])],
        [
          interaction("i_late", "t_aaaaaa", at + 20),
          interaction("i_early", "t_bbbbbb", at + 10),
          interaction("i_done", "t_bbbbbb", at + 5, "resolved"),
        ],
      ),
      { canRead: all },
    );
    expect(CliRequestList.parse(list)).toEqual(list);
    expect(list.requests.map((each) => [each.threadId, each.interaction.id])).toEqual([
      ["t_bbbbbb", "i_early"],
      ["t_aaaaaa", "i_late"],
    ]);
    expect(list.truncated).toBe(false);
  });

  test("leaves out threads the caller can't read", () => {
    const list = openRequests(
      source(
        [thread("t_aaaaaa", ["i_one"]), thread("t_secret", ["i_two"])],
        [interaction("i_one", "t_aaaaaa", at), interaction("i_two", "t_secret", at)],
      ),
      { canRead: (id) => id !== "t_secret" },
    );
    expect(list.requests.map((each) => each.threadId)).toEqual(["t_aaaaaa"]);
  });

  test("one thread's list includes the requests of its delegated children", () => {
    const list = openRequests(
      source(
        [thread("t_parent", [], "working"), thread("t_child1", ["i_child"])],
        [interaction("i_child", "t_child1", at)],
        { t_parent: ["t_child1"] },
      ),
      { threadId: ThreadId.parse("t_parent"), canRead: all },
    );
    expect(list.requests.map((each) => each.interaction.id)).toEqual(["i_child"]);
  });

  test("a list over its limit says it was cut", () => {
    const list = openRequests(
      source(
        [thread("t_aaaaaa", ["i_1", "i_2", "i_3"])],
        ["i_1", "i_2", "i_3"].map((id, index) => interaction(id, "t_aaaaaa", at + index)),
      ),
      { canRead: all, limit: 2 },
    );
    expect(list.requests.map((each) => each.interaction.id)).toEqual(["i_1", "i_2"]);
    expect(list.truncated).toBe(true);
  });

  test("never carries the provider's raw frames", () => {
    const list = openRequests(
      source([thread("t_aaaaaa", ["i_1"])], [interaction("i_1", "t_aaaaaa", at)]),
      { canRead: all },
    );
    expect(list.requests[0]?.interaction.raw).toEqual([]);
  });
});
