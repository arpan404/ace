import { describe, expect, it } from "vitest";
import { SearchHit } from "./search.ts";
import { ThreadStatus } from "./thread-status.ts";
import { ThreadListEntry } from "./wire-core.ts";

const entry = (status: unknown) => ({
  id: "t",
  workspaceId: "w",
  title: "Login bug",
  provider: "claude",
  status,
  createdAt: 1,
  updatedAt: 1,
});

describe("thread status from a newer daemon", () => {
  it("reads a state this build doesn't know as unknown, keeping what it said", () => {
    expect(ThreadStatus.parse({ state: "paused", until: 5 })).toEqual({
      state: "unknown",
      raw: { state: "paused", until: 5 },
    });
  });

  it("keeps the thread around it instead of failing it", () => {
    const parsed = ThreadListEntry.safeParse(entry({ state: "handed_off", to: "x" }));
    expect(parsed.success && parsed.data.status.state).toBe("unknown");
  });

  it("reads a status it already turned into unknown the same way again", () => {
    const once = ThreadStatus.parse({ state: "paused" });
    expect(ThreadStatus.parse(once)).toEqual(once);
  });

  it("still refuses a known state that is malformed", () => {
    expect(ThreadStatus.safeParse({ state: "working" }).success).toBe(false);
    expect(ThreadStatus.safeParse({ state: "" }).success).toBe(false);
    expect(ThreadStatus.safeParse({}).success).toBe(false);
  });

  it("reads a search hit's unknown state as unknown", () => {
    const hit = SearchHit.parse({
      threadId: "t",
      threadTitle: "Login bug",
      workspaceId: "w",
      provider: "claude",
      status: "paused",
      statusSeq: 1,
      kind: "message",
      createdAt: 1,
      title: { text: "Login bug", highlights: [] },
      snippet: { text: "login", highlights: [] },
      score: 1,
    });
    expect(hit.status).toBe("unknown");
  });
});
